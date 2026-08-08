/**
 * popup/popup.js
 *
 * 1. content.js を注入して Speaker Deck のメタデータ + PDF URL を取得
 * 2. PDF を fetch → PDF.js でページごとにテキスト抽出
 * 3. テキストが少ないページは canvas にレンダリングして Tesseract.js で OCR
 * 4. Obsidian のページ埋め込み形式 Markdown を生成
 * 5. Vault へ直接書き込み（File System Access API）、
 *    または ダウンロード + obsidian:// URI で送出
 *
 * すべてブラウザローカルで完結し、生成 AI / 外部 API は一切利用しない。
 */
'use strict';

// ------------------------------------------------------------------ 定数
const LIB = {
  pdfWorker: chrome.runtime.getURL('lib/pdf.worker.js'),
  cMapUrl: chrome.runtime.getURL('lib/cmaps/'),
  stdFontUrl: chrome.runtime.getURL('lib/standard_fonts/'),
  tessWorker: chrome.runtime.getURL('lib/tesseract/worker.min.js'),
  tessCore: chrome.runtime.getURL('lib/tesseract/'),
  tessLang: chrome.runtime.getURL('lib/tesseract/lang'),
};

/**
 * obsidian:// URI に本文を直接載せる最大長（エンコード後）。
 * これを超えた場合は `clipboard=true` に切り替え、Obsidian 側にクリップボードから
 * 本文を読ませる。日本語は 1 文字が %XX%XX%XX（9 文字）に膨らむため、
 * 見た目 1 万文字のノートでも URI は 6〜7 万文字になる。
 */
const MAX_URI_LENGTH = 8000;

const DEFAULT_SETTINGS = {
  outputMode: 'vault', // 'vault' | 'downloads'
  vault: '',
  notePath: '',
  pdfPath: '',
  ocr: true,
  threshold: 20,
  lang: 'jpn+eng',
  width: 1600,
  maxPages: 0,
  embedMode: 'image', // 'image' = ページ画像を書き出す / 'pdf' = ![[x.pdf#page=N]]
  textBlock: 'callout', // 'callout' | 'details' | 'plain'
  savePdf: true,
  openAfter: true,
  uriMode: 'new',
  downloadMd: true,
  clipboard: true,
};

const isStandalone = new URLSearchParams(location.search).has('standalone');

// ------------------------------------------------------------------ DOM
const $ = (id) => document.getElementById(id);

const el = {
  deckTitleTop: $('deckTitleTop'),
  openInTabBtn: $('openInTabBtn'),
  toggleSettingsBtn: $('toggleSettingsBtn'),
  settingsPanel: $('settingsPanel'),

  outputMode: $('outputMode'),
  rowVaultDir: $('rowVaultDir'),
  rowVaultName: $('rowVaultName'),
  vaultDirLabel: $('vaultDirLabel'),
  vaultDirHint: $('vaultDirHint'),
  pickVaultBtn: $('pickVaultBtn'),
  vault: $('vault'),
  noteName: $('noteName'),
  notePath: $('notePath'),
  notePathHint: $('notePathHint'),
  pdfPath: $('pdfPath'),
  pdfPathHint: $('pdfPathHint'),

  propTitle: $('propTitle'),
  propAuthor: $('propAuthor'),
  propSource: $('propSource'),
  propDate: $('propDate'),
  propTags: $('propTags'),
  propPdfUrl: $('propPdfUrl'),

  progressBox: $('progressBox'),
  progressFill: $('progressFill'),
  progressText: $('progressText'),
  logArea: $('logArea'),

  previewMeta: $('previewMeta'),
  markdown: $('markdown'),

  optOcr: $('optOcr'),
  optThreshold: $('optThreshold'),
  optLang: $('optLang'),
  optWidth: $('optWidth'),
  optMaxPages: $('optMaxPages'),
  optEmbedMode: $('optEmbedMode'),
  optTextBlock: $('optTextBlock'),
  rowSavePdf: $('rowSavePdf'),
  optSavePdf: $('optSavePdf'),
  optOpenAfter: $('optOpenAfter'),
  optUriMode: $('optUriMode'),
  optDownloadMd: $('optDownloadMd'),
  optClipboard: $('optClipboard'),
  rowOpenAfter: $('rowOpenAfter'),
  rowUriMode: $('rowUriMode'),
  rowDownloadMd: $('rowDownloadMd'),

  status: $('status'),
  extractBtn: $('extractBtn'),
  sendBtn: $('sendBtn'),
};

const state = {
  deck: null,
  pages: [],
  images: [], // [{ page, blob }] embedMode === 'image' のときだけ埋まる
  pdfBytes: null,
  lastGenerated: '',
  vaultDir: null, // FileSystemDirectoryHandle
  running: false,
};

// ------------------------------------------------------------------ ユーティリティ
function setStatus(message, kind = '') {
  el.status.textContent = message;
  el.status.className = 'footer__status' + (kind ? ` is-${kind}` : '');
}

function log(message) {
  const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  el.logArea.textContent += `[${time}] ${message}\n`;
  el.logArea.scrollTop = el.logArea.scrollHeight;
}

function setProgress(ratio, text) {
  el.progressBox.hidden = false;
  el.progressFill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  if (text) el.progressText.textContent = text;
}

function sanitizeFileName(name) {
  return (
    (name || 'untitled')
      .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'untitled'
  );
}

/** 相対パスとして安全な形に整える（先頭 / と .. を落とす） */
function sanitizeFolder(folder) {
  return (folder || '')
    .split('/')
    .map((seg) => seg.replace(/[\\:*?"<>|]/g, ' ').replace(/^\.+$/, '').trim())
    .filter(Boolean)
    .join('/');
}

function joinPath(folder, file) {
  const dir = sanitizeFolder(folder);
  return dir ? `${dir}/${file}` : file;
}

function yamlString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function normalizeDate(raw) {
  if (!raw) return todayISO();
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return raw;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ IndexedDB（ディレクトリハンドルの保管）
// FileSystemDirectoryHandle は構造化複製できるが chrome.storage には入らないので IndexedDB を使う。
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('speakerdeck-obsidian', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ------------------------------------------------------------------ File System Access
async function hasPermission(handle) {
  return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
}

/** 権限が無ければ要求する。ユーザー操作（クリック）の直後に呼ぶこと。 */
async function ensurePermission(handle) {
  if (await hasPermission(handle)) return true;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

async function pickVaultDir() {
  if (!isStandalone) {
    // ポップアップでファイルピッカーを開くとポップアップ自体が閉じてしまうため、
    // タブに切り替えてから選ばせる。
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?standalone=1&pick=1') });
    window.close();
    return;
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'obsidian-vault' });
  if (!(await ensurePermission(handle))) throw new Error('フォルダへの書き込みが許可されませんでした。');
  state.vaultDir = handle;
  await idbSet('vaultDir', handle);
  el.vaultDirLabel.value = handle.name;
  // Vault のルートを選んだ場合、フォルダ名がそのまま Vault 名になる
  if (!el.vault.value.trim()) el.vault.value = handle.name;
  await saveSettings();
  setStatus(`Vault フォルダを設定しました: ${handle.name}`, 'ok');
}

async function restoreVaultDir() {
  try {
    const handle = await idbGet('vaultDir');
    if (!handle) return;
    state.vaultDir = handle;
    el.vaultDirLabel.value = handle.name;
    if (!(await hasPermission(handle))) {
      el.vaultDirHint.textContent = '再認可が必要です（「Obsidian に追加」を押すと確認が出ます）';
    }
  } catch (err) {
    console.warn('ディレクトリハンドルを復元できませんでした', err);
  }
}

/** vault 直下からの相対パスでディレクトリを掘る（無ければ作成） */
async function ensureDir(root, relDir) {
  let dir = root;
  for (const seg of sanitizeFolder(relDir).split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}

async function writeIntoVault(relPath, data) {
  const parts = relPath.split('/');
  const name = parts.pop();
  const dir = await ensureDir(state.vaultDir, parts.join('/'));
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

// ------------------------------------------------------------------ 設定の保存 / 復元
async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  el.outputMode.value = s.outputMode;
  el.vault.value = s.vault;
  el.notePath.value = s.notePath;
  el.pdfPath.value = s.pdfPath;
  el.optOcr.checked = s.ocr;
  el.optThreshold.value = s.threshold;
  el.optLang.value = s.lang;
  el.optWidth.value = s.width;
  el.optMaxPages.value = s.maxPages;
  el.optEmbedMode.value = s.embedMode;
  el.optTextBlock.value = s.textBlock;
  el.optSavePdf.checked = s.savePdf;
  el.optOpenAfter.checked = s.openAfter;
  el.optUriMode.value = s.uriMode;
  el.optDownloadMd.checked = s.downloadMd;
  el.optClipboard.checked = s.clipboard;
  return s;
}

function currentSettings() {
  return {
    outputMode: el.outputMode.value,
    vault: el.vault.value.trim(),
    notePath: el.notePath.value.trim(),
    pdfPath: el.pdfPath.value.trim(),
    ocr: el.optOcr.checked,
    threshold: Number(el.optThreshold.value) || 0,
    lang: el.optLang.value,
    width: Number(el.optWidth.value) || 1600,
    maxPages: Number(el.optMaxPages.value) || 0,
    embedMode: el.optEmbedMode.value,
    textBlock: el.optTextBlock.value,
    savePdf: el.optSavePdf.checked,
    openAfter: el.optOpenAfter.checked,
    uriMode: el.optUriMode.value,
    downloadMd: el.optDownloadMd.checked,
    clipboard: el.optClipboard.checked,
  };
}

async function saveSettings() {
  await chrome.storage.local.set({ settings: currentSettings() });
}

/** 出力方式に応じて関係ない入力欄を隠す */
function syncModeUi() {
  const vaultMode = el.outputMode.value === 'vault';
  el.rowVaultDir.hidden = !vaultMode;
  el.rowVaultName.hidden = vaultMode;
  el.rowOpenAfter.hidden = !vaultMode;
  el.rowUriMode.hidden = vaultMode;
  el.rowDownloadMd.hidden = vaultMode;

  if (vaultMode) {
    el.notePathHint.textContent = 'Vault 内のパス。無ければ自動で作成します';
    el.pdfPathHint.textContent = 'Vault 内のパス。空欄ならノートと同じ場所';
    el.pdfPath.placeholder = '（空欄 = ノートと同じ場所）';
  } else {
    el.notePathHint.textContent = 'Vault 内の既存フォルダのみ（obsidian:// はフォルダを作れません）';
    el.pdfPathHint.textContent = 'ダウンロードフォルダからの相対パス（Chrome の制約）';
    el.pdfPath.placeholder = 'SpeakerDeck/';
  }
}

// ------------------------------------------------------------------ Speaker Deck のタブを探す
async function findSpeakerDeckTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && /^https:\/\/(www\.)?speakerdeck\.com\//.test(active.url || '')) return active;

  const tabs = await chrome.tabs.query({ url: 'https://speakerdeck.com/*' });
  const deckTabs = tabs.filter((t) => /^https:\/\/speakerdeck\.com\/[^/]+\/[^/]+/.test(t.url || ''));
  return deckTabs[0] || tabs[0] || null;
}

async function scrapeDeck() {
  const tab = await findSpeakerDeckTab();
  if (!tab) throw new Error('Speaker Deck のスライドページが見つかりません。該当タブを開いてから実行してください。');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['scripts/content.js'],
  });

  const deck = results && results[0] && results[0].result;
  if (!deck || !deck.ok) throw new Error('ページからメタデータを取得できませんでした。');
  return deck;
}

// ------------------------------------------------------------------ PDF の取得
async function ensureHostPermission(url) {
  try {
    const origin = new URL(url).origin + '/*';
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (_) {
    return false;
  }
}

async function fetchPdf(url) {
  const attempt = async () => {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`PDF の取得に失敗しました (HTTP ${res.status})`);
    return res.arrayBuffer();
  };

  try {
    return await attempt();
  } catch (err) {
    log(`直接取得に失敗: ${err.message} — ホスト権限を要求します`);
    if (!(await ensureHostPermission(url))) {
      throw new Error(`PDF を取得できませんでした（${new URL(url).host} へのアクセス許可が必要です）`);
    }
    return attempt();
  }
}

// ------------------------------------------------------------------ PDF.js のテキスト抽出
/** textContent の item 群を、Y 座標でグルーピングして行テキストに戻す */
function textContentToString(textContent) {
  const lines = [];
  let current = null;

  for (const item of textContent.items) {
    const str = item.str || '';
    if (!str.trim()) {
      if (item.hasEOL) current = null;
      continue;
    }

    const x = item.transform[4];
    const y = item.transform[5];
    const width = item.width || 0;
    const charWidth = str.length ? width / str.length : 0;

    if (current && Math.abs(current.y - y) < 3) {
      const gap = x - current.endX;
      current.parts.push(gap > Math.max(charWidth, 1) * 0.4 ? ` ${str}` : str);
      current.endX = x + width;
    } else {
      current = { y, parts: [str], endX: x + width };
      lines.push(current);
    }

    if (item.hasEOL) current = null;
  }

  return lines
    .map((line) => line.parts.join('').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// ------------------------------------------------------------------ Tesseract.js（遅延初期化）
let tesseractWorker = null;
let tesseractLang = null;

async function getTesseractWorker(lang) {
  if (tesseractWorker && tesseractLang === lang) return tesseractWorker;
  if (tesseractWorker) {
    await tesseractWorker.terminate();
    tesseractWorker = null;
  }

  if (typeof Tesseract === 'undefined') {
    throw new Error('lib/tesseract.min.js が見つかりません。setup-libs.sh を実行してください。');
  }

  log(`Tesseract worker を初期化中（${lang}）…`);
  tesseractWorker = await Tesseract.createWorker(lang, 1, {
    workerPath: LIB.tessWorker,
    corePath: LIB.tessCore,
    langPath: LIB.tessLang,
    gzip: true,
    workerBlobURL: false,
    // LSTM 専用コアだと tessdata に埋め込まれた legacy エンジン用パラメータが
    // 「Parameter not found」警告として毎回出る。combined コアを使えば
    // それらの変数も登録されるため警告が消える（OEM=1 なので認識は引き続き LSTM のみ）。
    legacyCore: true,
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        el.progressText.textContent = `OCR 実行中… ${Math.round(m.progress * 100)}%`;
      }
    },
  });
  tesseractLang = lang;
  return tesseractWorker;
}

async function terminateTesseract() {
  if (tesseractWorker) {
    await tesseractWorker.terminate().catch(() => {});
    tesseractWorker = null;
    tesseractLang = null;
  }
}

// ------------------------------------------------------------------ ページのラスタライズ
/** PDF の 1 ページを canvas に描く。OCR と画像書き出しの両方でこの結果を使い回す。 */
async function renderPage(pdfPage, targetWidth) {
  const base = pdfPage.getViewport({ scale: 1 });
  const scale = Math.max(1, Math.min(4, targetWidth / base.width));
  const viewport = pdfPage.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // 透過 PDF に備えて白背景を敷く（OCR 精度と見た目の両方に効く）
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

/** canvas の裏のピクセルバッファを即座に解放する */
function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function canvasToBlob(canvas, type = 'image/webp', quality = 0.82) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画像の書き出しに失敗しました'))), type, quality);
  });
}

async function ocrCanvas(canvas, lang) {
  const worker = await getTesseractWorker(lang);
  const { data } = await worker.recognize(canvas);
  return (data.text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ------------------------------------------------------------------ 解析パイプライン
async function analyze() {
  const settings = currentSettings();

  if (typeof pdfjsLib === 'undefined') {
    throw new Error('lib/pdf.js が見つかりません。setup-libs.sh を実行してください。');
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = LIB.pdfWorker;

  setProgress(0.02, 'Speaker Deck のページを解析中…');
  // prefill 済みならユーザーの編集を上書きしないよう再取得しない
  const deck = state.deck || (await scrapeDeck());
  if (!state.deck) {
    state.deck = deck;
    applyDeckToForm(deck);
  }
  log(`スライド: ${deck.title}`);

  const pdfUrl = el.propPdfUrl.value.trim() || deck.pdfUrl;
  if (!pdfUrl) {
    throw new Error('PDF の URL を検出できませんでした。プロパティの pdf 欄に手動で指定してください。');
  }

  setProgress(0.05, 'PDF 取得中…');
  log(`PDF: ${pdfUrl}`);
  const bytes = await fetchPdf(pdfUrl);
  state.pdfBytes = bytes;
  log(`PDF 取得完了 (${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB)`);

  setProgress(0.1, 'PDF を読み込み中…');
  // PDF.js は渡した ArrayBuffer を worker へ transfer して detach するため、
  // 保存用に元データを残せるようコピーを渡す。
  const doc = await pdfjsLib.getDocument({
    data: bytes.slice(0),
    cMapUrl: LIB.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: LIB.stdFontUrl,
    isEvalSupported: false,
  }).promise;

  const total = settings.maxPages > 0 ? Math.min(settings.maxPages, doc.numPages) : doc.numPages;
  log(`${doc.numPages} ページ（処理対象 ${total} ページ）`);

  const wantImages = settings.embedMode === 'image';
  const pages = [];
  const images = [];

  for (let i = 1; i <= total; i += 1) {
    setProgress(0.1 + (0.85 * (i - 1)) / total, `${i}/${total} ページ解析中…`);

    const page = await doc.getPage(i);
    let text = '';
    let source = 'empty';

    try {
      const content = await page.getTextContent();
      text = textContentToString(content);
      if (text.length >= settings.threshold) source = 'text';
    } catch (err) {
      log(`p.${i}: テキスト抽出に失敗 (${err.message})`);
    }

    const needsOcr = source !== 'text' && settings.ocr;
    // 画像書き出しと OCR で同じ canvas を使い回す（ラスタライズは 1 回だけ）
    let canvas = null;
    if (needsOcr || wantImages) {
      setProgress(0.1 + (0.85 * (i - 0.5)) / total, `${i}/${total} ページ描画中…`);
      canvas = await renderPage(page, settings.width);
    }

    if (needsOcr && canvas) {
      setProgress(0.1 + (0.85 * (i - 0.5)) / total, `${i}/${total} ページ OCR 中…`);
      try {
        const ocrText = await ocrCanvas(canvas, settings.lang);
        if (ocrText.length > text.length) {
          text = ocrText;
          source = 'ocr';
        } else if (text) {
          source = 'text';
        }
      } catch (err) {
        log(`p.${i}: OCR に失敗 (${err.message})`);
      }
    } else if (source !== 'text' && text) {
      source = 'text';
    }

    if (wantImages && canvas) {
      try {
        images.push({ page: i, blob: await canvasToBlob(canvas) });
      } catch (err) {
        log(`p.${i}: 画像の書き出しに失敗 (${err.message})`);
      }
    }

    releaseCanvas(canvas);
    page.cleanup();
    pages.push({ page: i, text: text.trim(), source });
    log(`p.${i}: ${source} / ${text.trim().length} 文字`);

    await sleep(0); // UI を描画させるために 1 tick 譲る
  }

  await doc.destroy();
  await terminateTesseract();

  state.pages = pages;
  state.images = images;
  if (images.length) {
    const totalBytes = images.reduce((sum, img) => sum + img.blob.size, 0);
    log(`ページ画像 ${images.length} 枚（合計 ${(totalBytes / 1024 / 1024).toFixed(1)} MB）`);
  }
  setProgress(1, `完了：${pages.length} ページ（OCR ${pages.filter((p) => p.source === 'ocr').length} ページ）`);
  return pages;
}

// ------------------------------------------------------------------ Markdown 生成
const SUMMARY_LABEL = '📄 抽出テキスト / OCR';
const EMPTY_TEXT = '（このページからテキストは抽出できませんでした）';

const htmlEscape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 抽出テキストを折りたたみブロックにする。
 *
 * `<details>` に空行を含む Markdown を入れると、CommonMark の規則で
 * 最初の空行が HTML ブロックの終わりと解釈され、以降の本文が
 * <details> の外に出てしまう（＝トグルに収まらない）。
 * 既定の callout はこの問題が原理的に起きない Obsidian ネイティブ記法。
 */
function foldedTextBlock(text, mode) {
  const body = (text || '').trim();

  if (mode === 'plain') {
    return body ? body : `_${EMPTY_TEXT}_`;
  }

  if (mode === 'details') {
    // HTML ブロックを途切れさせないため、空行を潰したうえで <pre> に入れる
    const inner = htmlEscape(body || EMPTY_TEXT).replace(/\n{2,}/g, '\n');
    return `<details><summary>${SUMMARY_LABEL}</summary><pre>\n${inner}\n</pre></details>`;
  }

  // callout（既定）: 折りたたみ表示は [!quote]- の "-"
  const lines = (body || EMPTY_TEXT)
    .split('\n')
    .map((line) => {
      const trimmed = line.trimEnd();
      if (!trimmed) return '>';
      // 引用内の "---" は水平線になってしまうのでエスケープする
      return `> ${trimmed.replace(/^(-{3,}|\*{3,}|_{3,})$/, '\\$1')}`;
    });
  return [`> [!quote]- ${SUMMARY_LABEL}`, ...lines].join('\n');
}

const slideImageName = (page) => `slide-${String(page).padStart(3, '0')}.webp`;

/** ページ画像を置く Vault 内フォルダ。デッキごとにサブフォルダを切る。 */
function imageDirFor(settings, baseName) {
  if (settings.outputMode !== 'vault') return baseName;
  return joinPath(sanitizeFolder(settings.pdfPath) || sanitizeFolder(settings.notePath), baseName);
}

function buildMarkdown() {
  const settings = currentSettings();
  const title = el.propTitle.value.trim() || '（無題）';
  const author = el.propAuthor.value.trim();
  const source = el.propSource.value.trim();
  const date = el.propDate.value.trim() || todayISO();
  const tags = el.propTags.value
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const description = (state.deck && state.deck.description) || '';
  const baseName = sanitizeFileName(el.noteName.value.trim() || title);
  const pdfFileName = `${baseName}.pdf`;

  // 画像モードでも、解析時に画像を書き出していなければ PDF 埋め込みにフォールバックする
  const useImages = settings.embedMode === 'image' && state.images.length > 0;
  const imageDir = imageDirFor(settings, baseName);
  const embedFor = (page) =>
    useImages ? `![[${joinPath(imageDir, slideImageName(page))}]]` : `![[${pdfFileName}#page=${page}]]`;

  const front = [
    '---',
    `title: ${yamlString(title)}`,
    `author: ${yamlString(author)}`,
    `source: ${yamlString(source)}`,
    `date: ${yamlString(date)}`,
    `tags: [${(tags.length ? tags : ['slide', 'speakerdeck']).join(', ')}]`,
    '---',
    '',
  ].join('\n');

  const head = [
    `# ${title}`,
    '',
    '## 概要',
    description || '_（概要は取得できませんでした）_',
    '',
    // 画像モードでも PDF を保存するなら、原本へのリンクを 1 本だけ残す
    ...(useImages && settings.savePdf ? ['', `📎 元 PDF: [[${pdfFileName}]]`] : []),
    '',
    '---',
    '',
    '## スライド一覧',
    '',
  ].join('\n');

  const body = state.pages
    .map((p) =>
      [
        `### Slide ${p.page}`,
        embedFor(p.page),
        '',
        foldedTextBlock(p.text, settings.textBlock),
        '',
        '---',
        '',
      ].join('\n')
    )
    .join('');

  return `${front}${head}${body}`.trimEnd() + '\n';
}

function refreshPreview() {
  if (!state.pages.length) return;
  // ユーザーが本文を手で直していたら上書きしない
  if (state.lastGenerated && el.markdown.value !== state.lastGenerated) return;
  el.markdown.value = buildMarkdown();
  state.lastGenerated = el.markdown.value;
  const ocrCount = state.pages.filter((p) => p.source === 'ocr').length;
  el.previewMeta.textContent = `${state.pages.length} ページ / OCR ${ocrCount} / ${el.markdown.value.length.toLocaleString()} 文字`;
}

// ------------------------------------------------------------------ 出力
async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const id = await chrome.downloads.download({ url, filename, saveAs: false });
  const onChanged = (delta) => {
    if (delta.id === id && delta.state && delta.state.current !== 'in_progress') {
      URL.revokeObjectURL(url);
      chrome.downloads.onChanged.removeListener(onChanged);
    }
  };
  chrome.downloads.onChanged.addListener(onChanged);
  return id;
}

/**
 * content を渡すと本文を直接載せる。省略すると `clipboard=true` を付け、
 * Obsidian にクリップボードの中身を本文として使わせる（URI 長制限の回避）。
 */
function buildObsidianUri(mode, { vault, filePath, content }) {
  const q = new URLSearchParams();
  if (vault) q.set('vault', vault);

  if (mode === 'advanced') {
    q.set('filepath', filePath);
    q.set('mode', 'new');
    if (content === undefined) q.set('clipboard', 'true');
    else q.set('data', content);
    return `obsidian://advanced-uri?${q.toString()}`;
  }

  q.set('file', filePath);
  if (content === undefined) q.set('clipboard', 'true');
  else q.set('content', content);
  return `obsidian://new?${q.toString()}`;
}

/** 拡張機能ページから外部プロトコルを起動する */
function openExternalUri(uri) {
  const a = document.createElement('a');
  a.href = uri;
  a.target = '_self';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// --------------------------------------------- 方式 A: Vault へ直接書き込み
async function sendToVault(settings, markdown, baseName) {
  if (!state.vaultDir) {
    throw new Error('Vault フォルダが未選択です。「選択…」から Vault のルートを指定してください。');
  }
  if (!(await ensurePermission(state.vaultDir))) {
    throw new Error('Vault フォルダへの書き込みが許可されませんでした。');
  }

  const noteFolder = sanitizeFolder(settings.notePath);
  const pdfFolder = sanitizeFolder(settings.pdfPath) || noteFolder;
  const notices = [];

  const notePath = joinPath(noteFolder, `${baseName}.md`);
  await writeIntoVault(notePath, markdown);
  notices.push(`ノート → ${notePath}`);
  log(`Vault に書き込み: ${notePath}`);

  if (settings.embedMode === 'image' && state.images.length) {
    const imageDir = imageDirFor(settings, baseName);
    let done = 0;
    for (const img of state.images) {
      await writeIntoVault(joinPath(imageDir, slideImageName(img.page)), img.blob);
      done += 1;
      setProgress(done / state.images.length, `ページ画像を書き込み中… ${done}/${state.images.length}`);
    }
    notices.push(`画像 ${state.images.length} 枚 → ${imageDir}/`);
    log(`Vault に書き込み: ${imageDir}/ (${state.images.length} 枚)`);
  }

  if (settings.savePdf && state.pdfBytes) {
    const pdfPath = joinPath(pdfFolder, `${baseName}.pdf`);
    await writeIntoVault(pdfPath, new Blob([state.pdfBytes], { type: 'application/pdf' }));
    notices.push(`PDF → ${pdfPath}`);
    log(`Vault に書き込み: ${pdfPath}`);
  }

  if (settings.clipboard) {
    try {
      await navigator.clipboard.writeText(markdown);
      notices.push('クリップボードにコピー');
    } catch (err) {
      log(`クリップボードへのコピーに失敗: ${err.message}`);
    }
  }

  if (settings.openAfter) {
    const q = new URLSearchParams();
    // Vault 名が未入力なら、選択したフォルダ名を Vault 名とみなす
    q.set('vault', settings.vault || state.vaultDir.name);
    q.set('file', joinPath(noteFolder, baseName));
    openExternalUri(`obsidian://open?${q.toString()}`);
    log('Obsidian でノートを開きました');
  }

  return notices;
}

// --------------------------------------------- 方式 B: ダウンロード + obsidian:// URI
async function sendViaDownloads(settings, markdown, baseName) {
  const noteFolder = sanitizeFolder(settings.notePath);
  const filePath = joinPath(noteFolder, baseName);
  const notices = [];

  if (settings.savePdf) {
    const target = joinPath(settings.pdfPath, `${baseName}.pdf`);
    try {
      if (state.pdfBytes) {
        await downloadBlob(new Blob([state.pdfBytes], { type: 'application/pdf' }), target);
      } else if (el.propPdfUrl.value.trim()) {
        await chrome.downloads.download({ url: el.propPdfUrl.value.trim(), filename: target, saveAs: false });
      }
      notices.push(`PDF → ${target}`);
      log(`PDF を保存: ${target}`);
    } catch (err) {
      log(`PDF の保存に失敗: ${err.message}`);
      notices.push('PDF 保存に失敗');
    }
  }

  if (settings.embedMode === 'image' && state.images.length) {
    const imageDir = joinPath(settings.pdfPath, baseName);
    for (const img of state.images) {
      await downloadBlob(img.blob, joinPath(imageDir, slideImageName(img.page)));
    }
    notices.push(`画像 ${state.images.length} 枚 → ${imageDir}/`);
    log(`画像を保存: ${imageDir}/ (${state.images.length} 枚)`);
  }

  if (settings.downloadMd) {
    const target = joinPath(settings.pdfPath, `${baseName}.md`);
    try {
      await downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), target);
      notices.push(`Markdown → ${target}`);
      log(`Markdown を保存: ${target}`);
    } catch (err) {
      log(`.md の保存に失敗: ${err.message}`);
    }
  }

  // 長い Markdown は obsidian:// の clipboard=true で受け渡すため、
  // 設定が OFF でも Obsidian 送出が有効なら必ずコピーしておく。
  let clipboardOk = false;
  if (settings.clipboard || settings.uriMode !== 'none') {
    try {
      await navigator.clipboard.writeText(markdown);
      clipboardOk = true;
      if (settings.clipboard) notices.push('クリップボードにコピー');
      log('Markdown をクリップボードにコピーしました');
    } catch (err) {
      log(`クリップボードへのコピーに失敗: ${err.message}`);
    }
  }

  if (settings.uriMode !== 'none') {
    const full = buildObsidianUri(settings.uriMode, { vault: settings.vault, filePath, content: markdown });

    if (full.length <= MAX_URI_LENGTH) {
      openExternalUri(full);
      notices.push(`Obsidian に送信 → ${filePath}`);
      log(`obsidian URI を送出しました (${full.length} 文字)`);
    } else if (clipboardOk) {
      openExternalUri(buildObsidianUri(settings.uriMode, { vault: settings.vault, filePath }));
      notices.push(`Obsidian に送信（クリップボード経由）→ ${filePath}`);
      log(`URI が長い (${full.length} 文字) ため clipboard=true で送出しました`);
    } else {
      notices.push('Obsidian へ送れません（クリップボード不可 + URI 長すぎ）');
    }

    if (noteFolder) {
      log(`※ Vault 内に "${noteFolder}" フォルダが無いと Obsidian 側でノートを作成できません`);
    }
  }

  return notices;
}

async function send() {
  const settings = currentSettings();
  await saveSettings();

  const markdown = el.markdown.value;
  if (!markdown.trim()) throw new Error('送出する Markdown がありません。先に解析を実行してください。');

  const baseName = sanitizeFileName(el.noteName.value.trim() || el.propTitle.value.trim());
  const notices =
    settings.outputMode === 'vault'
      ? await sendToVault(settings, markdown, baseName)
      : await sendViaDownloads(settings, markdown, baseName);

  setStatus(notices.join(' / ') || '出力先が選択されていません', 'ok');
}

// ------------------------------------------------------------------ フォーム反映
function applyDeckToForm(deck) {
  el.deckTitleTop.textContent = deck.title || 'Speaker Deck → Obsidian';
  el.deckTitleTop.title = deck.title || '';
  if (!el.noteName.value.trim()) el.noteName.value = sanitizeFileName(deck.title);
  el.propTitle.value = deck.title || '';
  el.propAuthor.value = deck.author || '';
  el.propSource.value = deck.url || '';
  el.propDate.value = normalizeDate(deck.publishedAt);
  if (!el.propTags.value.trim()) el.propTags.value = 'slide, speakerdeck';
  el.propPdfUrl.value = deck.pdfUrl || '';
}

/** ポップアップを開いた直後に、解析はせずメタデータだけ先読みする */
async function prefill() {
  try {
    const deck = await scrapeDeck();
    state.deck = deck;
    applyDeckToForm(deck);
    setStatus(
      deck.pdfUrl
        ? 'PDF を検出しました。「スライドを解析」を押してください。'
        : 'PDF URL が見つかりません。プロパティの pdf 欄に手動入力できます。',
      deck.pdfUrl ? '' : 'error'
    );
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

// ------------------------------------------------------------------ イベント
el.extractBtn.addEventListener('click', async () => {
  if (state.running) return;
  state.running = true;
  el.extractBtn.disabled = true;
  el.sendBtn.disabled = true;
  el.logArea.textContent = '';
  state.lastGenerated = '';
  state.images = []; // 前回の解析結果を持ち越さない
  setStatus('解析中…');

  try {
    await saveSettings();
    await analyze();
    refreshPreview();
    el.sendBtn.disabled = false;
    setStatus('解析が完了しました。内容を確認して「Obsidian に追加」を押してください。', 'ok');
  } catch (err) {
    console.error(err);
    log(`エラー: ${err.message}`);
    setStatus(err.message, 'error');
    await terminateTesseract();
  } finally {
    state.running = false;
    el.extractBtn.disabled = false;
  }
});

el.sendBtn.addEventListener('click', async () => {
  el.sendBtn.disabled = true;
  try {
    await send();
  } catch (err) {
    console.error(err);
    setStatus(err.message, 'error');
  } finally {
    el.sendBtn.disabled = false;
  }
});

el.pickVaultBtn.addEventListener('click', async () => {
  try {
    await pickVaultDir();
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(err.message, 'error');
  }
});

el.outputMode.addEventListener('change', async () => {
  syncModeUi();
  await saveSettings();
});

el.toggleSettingsBtn.addEventListener('click', () => {
  el.settingsPanel.hidden = !el.settingsPanel.hidden;
});

el.openInTabBtn.addEventListener('click', async () => {
  await saveSettings();
  await chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?standalone=1') });
  window.close();
});

for (const input of [el.propTitle, el.propAuthor, el.propSource, el.propDate, el.propTags, el.noteName]) {
  input.addEventListener('change', refreshPreview);
}

for (const input of [
  el.vault, el.notePath, el.pdfPath, el.optOcr, el.optThreshold, el.optLang, el.optWidth,
  el.optMaxPages, el.optSavePdf, el.optOpenAfter, el.optUriMode, el.optDownloadMd, el.optClipboard,
]) {
  input.addEventListener('change', saveSettings);
}

// 表示形式を変えたらプレビューを作り直す
el.optTextBlock.addEventListener('change', async () => {
  await saveSettings();
  refreshPreview();
});

// 埋め込み形式を変えたらプレビューも作り直す（画像パス ⇄ PDF ページ指定）
el.optEmbedMode.addEventListener('change', async () => {
  await saveSettings();
  if (el.optEmbedMode.value === 'image' && state.pages.length && !state.images.length) {
    setStatus('画像を書き出すには「スライドを解析」をもう一度実行してください。', 'error');
  }
  refreshPreview();
});

// ------------------------------------------------------------------ 起動
(async () => {
  if (isStandalone) {
    document.body.classList.add('standalone');
    el.openInTabBtn.hidden = true;
  }
  await loadSettings();
  syncModeUi();
  await restoreVaultDir();

  if (new URLSearchParams(location.search).has('pick')) {
    setStatus('「選択…」を押して Vault のルートフォルダを指定してください。');
  }

  await prefill();
})();
