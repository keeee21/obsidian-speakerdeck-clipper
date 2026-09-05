/**
 * popup/popup.js
 *
 * 処理の流れ:
 *   1. content.js を注入して Speaker Deck のメタデータ + PDF URL を取得
 *   2. 選ばれたテンプレートを変数で展開し、ノート名・保存先・プロパティを表示
 *   3. 「スライドを解析」で PDF を取得し、ページごとにテキスト抽出（不足分は OCR）
 *   4. 解析結果を {{slides}} などの変数に入れて本文を組み立てる
 *   5. Vault へ直接書き込み、またはダウンロード + obsidian:// で送出
 *
 * 設定項目はすべて settings.html 側にあり、ここでは store の値を読むだけ。
 * すべてブラウザローカルで完結し、生成 AI / 外部 API は一切利用しない。
 */
import {
  ensureVaultPermission,
  findTemplateById,
  findTemplateForUrl,
  getPropertyType,
  getVaultDirHandle,
  loadAll,
  propertyTypeMap,
  store,
} from '../src/store.js';
import { createIcon, getPropertyTypeIcon, initializeIcons } from '../src/icons.js';
import {
  formatDate,
  generateFrontmatter,
  joinPath,
  renderTemplate,
  sanitizeFileName,
  sanitizeFolder,
} from '../src/template.js';

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
 * これを超えた場合は clipboard=true に切り替え、Obsidian 側にクリップボードから
 * 本文を読ませる。日本語は 1 文字が %XX%XX%XX（9 文字）に膨らむため、
 * 見た目 1 万文字のノートでも URI は 6〜7 万文字になる。
 */
const MAX_URI_LENGTH = 8000;

const SAVE_BEHAVIOR_LABELS = {
  addToObsidian: 'Obsidian に追加',
  saveFile: 'ファイルとして保存',
  copyToClipboard: 'クリップボードにコピー',
};

const SAVE_BEHAVIOR_ICONS = {
  addToObsidian: 'import',
  saveFile: 'file-text',
  copyToClipboard: 'copy',
};

const isStandalone = new URLSearchParams(location.search).has('standalone');

// ------------------------------------------------------------------ DOM
const $ = (id) => document.getElementById(id);

const el = {
  templateSelect: $('template-select'),
  openInTab: $('open-in-tab'),
  openSettings: $('open-settings'),
  errorMessage: document.querySelector('.error-message'),
  clipper: document.querySelector('.clipper'),
  noteName: $('note-name-field'),
  propertiesHeader: document.querySelector('.metadata-properties-header'),
  properties: document.querySelector('.metadata-properties'),
  noteContent: $('note-content-field'),
  progress: $('progress'),
  progressFill: $('progress-fill'),
  progressText: $('progress-text'),
  vaultContainer: $('vault-container'),
  vaultSelect: $('vault-select'),
  pathField: $('path-name-field'),
  clipBtn: $('clip-btn'),
  moreBtn: $('more-btn'),
  moreDropdown: $('more-dropdown'),
};

const state = {
  deck: null,
  template: null,
  variables: {},
  pages: [],
  images: [],
  pdfBytes: null,
  analyzed: false,
  running: false,
  lastGeneratedContent: '',
};

// ------------------------------------------------------------------ 表示ヘルパ
function setStatus(message, kind = '') {
  el.progress.hidden = false;
  el.progressText.textContent = message;
  el.progressText.className = kind ? `is-${kind}` : '';
}

function setProgress(ratio, text) {
  el.progress.hidden = false;
  el.progressFill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  if (text) setStatus(text);
}

function showFatalError(message) {
  el.errorMessage.textContent = message;
  el.errorMessage.hidden = false;
  el.clipper.hidden = true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeDate(raw) {
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? String(raw) : formatDate(date, 'YYYY-MM-DD');
}

// ------------------------------------------------------------------ ページの解析（メタデータ）
async function findSpeakerDeckTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && /^https:\/\/(www\.)?speakerdeck\.com\//.test(active.url || '')) return active;

  const tabs = await chrome.tabs.query({ url: 'https://speakerdeck.com/*' });
  const deckTabs = tabs.filter((t) => /^https:\/\/speakerdeck\.com\/[^/]+\/[^/]+/.test(t.url || ''));
  return deckTabs[0] || tabs[0] || null;
}

async function scrapeDeck() {
  const tab = await findSpeakerDeckTab();
  if (!tab) {
    throw new Error('Speaker Deck のスライドページが見つかりません。該当タブを開いてから実行してください。');
  }

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
    console.warn('PDF の直接取得に失敗。ホスト権限を要求します', err);
    if (!(await ensureHostPermission(url))) {
      throw new Error(`PDF を取得できませんでした（${new URL(url).host} へのアクセス許可が必要です）`);
    }
    return attempt();
  }
}

// ------------------------------------------------------------------ テキスト抽出
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

// ------------------------------------------------------------------ OCR
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

async function ocrCanvas(canvas, lang) {
  const worker = await getTesseractWorker(lang);
  const { data } = await worker.recognize(canvas);
  return (data.text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('画像の書き出しに失敗しました'))),
      'image/webp',
      quality
    );
  });
}

// ------------------------------------------------------------------ 解析パイプライン
async function analyze() {
  const settings = store.settings;

  if (typeof pdfjsLib === 'undefined') {
    throw new Error('lib/pdf.js が見つかりません。setup-libs.sh を実行してください。');
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = LIB.pdfWorker;

  const pdfUrl = state.variables.pdfUrl || (state.deck && state.deck.pdfUrl);
  if (!pdfUrl) {
    throw new Error('PDF の URL を検出できませんでした。');
  }

  setProgress(0.05, 'PDF を取得中…');
  const bytes = await fetchPdf(pdfUrl);
  state.pdfBytes = bytes;

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
      console.warn(`p.${i}: テキスト抽出に失敗`, err);
    }

    const needsOcr = source !== 'text' && settings.ocr;
    // 画像書き出しと OCR で同じ canvas を使い回す（ラスタライズは 1 回だけ）
    let canvas = null;
    if (needsOcr || wantImages) {
      canvas = await renderPage(page, settings.width);
    }

    if (needsOcr && canvas) {
      setProgress(0.1 + (0.85 * (i - 0.5)) / total, `${i}/${total} ページを OCR 中…`);
      try {
        const ocrText = await ocrCanvas(canvas, settings.lang);
        if (ocrText.length > text.length) {
          text = ocrText;
          source = 'ocr';
        } else if (text) {
          source = 'text';
        }
      } catch (err) {
        console.warn(`p.${i}: OCR に失敗`, err);
      }
    } else if (source !== 'text' && text) {
      source = 'text';
    }

    if (wantImages && canvas) {
      try {
        images.push({ page: i, blob: await canvasToBlob(canvas, settings.imageQuality) });
      } catch (err) {
        console.warn(`p.${i}: 画像の書き出しに失敗`, err);
      }
    }

    releaseCanvas(canvas);
    page.cleanup();
    pages.push({ page: i, text: text.trim(), source });

    await sleep(0); // UI を描画させるために 1 tick 譲る
  }

  await doc.destroy();
  await terminateTesseract();

  state.pages = pages;
  state.images = images;
  state.analyzed = true;

  const ocrCount = pages.filter((p) => p.source === 'ocr').length;
  setProgress(1, `解析完了: ${pages.length} ページ（OCR ${ocrCount} ページ）`);
}

// ------------------------------------------------------------------ スライドの Markdown
const SUMMARY_LABEL = '📄 抽出テキスト / OCR';
const EMPTY_TEXT = '（このページからテキストは抽出できませんでした）';

const htmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 抽出テキストを折りたたみブロックにする。
 *
 * <details> に空行を含む Markdown を入れると、CommonMark の規則で
 * 最初の空行が HTML ブロックの終わりと解釈され、以降の本文が
 * <details> の外に出てしまう（＝トグルに収まらない）。
 * 既定の callout は全行が > で始まるためこの問題が起きない。
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

  const lines = (body || EMPTY_TEXT).split('\n').map((line) => {
    const trimmed = line.trimEnd();
    if (!trimmed) return '>';
    // 引用内の "---" は水平線になってしまうのでエスケープする
    return `> ${trimmed.replace(/^(-{3,}|\*{3,}|_{3,})$/, '\\$1')}`;
  });
  return [`> [!quote]- ${SUMMARY_LABEL}`, ...lines].join('\n');
}

const slideImageName = (page) => `slide-${String(page).padStart(3, '0')}.webp`;

/** ページ画像を置くフォルダ。デッキごとにサブフォルダを切る。 */
function imageDirFor(template, baseName) {
  const base = sanitizeFolder(template.pdfPath) || sanitizeFolder(template.path);
  return joinPath(base, baseName);
}

function buildSlidesMarkdown(baseName) {
  const template = state.template;
  const settings = store.settings;
  const useImages = settings.embedMode === 'image' && state.images.length > 0;
  const imageDir = imageDirFor(template, baseName);
  const pdfFileName = `${baseName}.pdf`;

  const embedFor = (page) =>
    useImages
      ? `![[${joinPath(imageDir, slideImageName(page))}]]`
      : `![[${pdfFileName}#page=${page}]]`;

  return state.pages
    .map((p) =>
      [`### Slide ${p.page}`, embedFor(p.page), '', foldedTextBlock(p.text, settings.textBlock), '', '---', ''].join('\n')
    )
    .join('\n');
}

// ------------------------------------------------------------------ 変数
function buildVariables() {
  const deck = state.deck || {};
  const now = new Date();
  let domain = '';
  try {
    domain = deck.url ? new URL(deck.url).hostname : '';
  } catch (_) {
    domain = '';
  }

  const variables = {
    title: deck.title || '',
    author: deck.author || '',
    url: deck.url || '',
    domain,
    description: deck.description || '',
    published: normalizeDate(deck.publishedAt),
    date: formatDate(now, 'YYYY-MM-DD'),
    time: now.toISOString(),
    pdfUrl: deck.pdfUrl || '',
    deckId: deck.deckId || '',
    thumbnail: deck.thumbnail || '',
    slideCount: state.pages.length || deck.slideCountGuess || '',
    ocrCount: state.pages.filter((p) => p.source === 'ocr').length,
    textCount: state.pages.filter((p) => p.source === 'text').length,
    allText: state.pages.map((p) => p.text).filter(Boolean).join('\n\n'),
    firstText: state.pages.length ? state.pages[0].text : '',
    noteName: '',
    slides: '',
    content: '',
    pdfLink: '',
  };

  // ノート名は他の変数から作るので、確定してから変数表に入れ直す
  const baseName = sanitizeFileName(
    renderTemplate(state.template.noteNameFormat || '{{title}}', variables) || deck.title
  );
  variables.noteName = baseName;
  variables.pdfLink = `![[${baseName}.pdf]]`;

  if (state.pages.length) {
    variables.slides = buildSlidesMarkdown(baseName);
    variables.content = variables.slides;
  }

  return variables;
}

// ------------------------------------------------------------------ テンプレートの反映
function renderPropertyRows() {
  const container = el.properties;
  container.textContent = '';

  // フロントマターは同名のプロパティを最初の 1 個しか書き出さない。
  // 出力されない行をここに出すと編集しても反映されず混乱するので、同じ規則で間引く。
  const shown = new Set();

  for (const property of state.template.properties) {
    const name = (property.name || '').trim();
    if (!name || shown.has(name)) continue;
    shown.add(name);

    const inputId = `property-${property.id || name}`;
    const type = getPropertyType(name);
    const value = renderTemplate(property.value, state.variables);

    const row = document.createElement('div');
    row.className = 'metadata-property';

    const key = document.createElement('div');
    key.className = 'metadata-property-key';

    const icon = document.createElement('span');
    icon.className = 'metadata-property-icon';
    icon.appendChild(createIcon(getPropertyTypeIcon(type)));
    key.appendChild(icon);

    const label = document.createElement('label');
    label.setAttribute('for', inputId);
    label.textContent = name;
    label.title = name;
    key.appendChild(label);

    const valueBox = document.createElement('div');
    valueBox.className = 'metadata-property-value';

    const input = document.createElement('input');
    input.id = inputId;
    input.type = type === 'checkbox' ? 'checkbox' : 'text';
    input.dataset.name = name;
    input.dataset.type = type;
    if (type === 'checkbox') input.checked = value === 'true';
    else input.value = value;
    // 解析後に値を作り直すとき、ユーザーが手で直した欄は上書きしない
    input.dataset.generated = value;
    valueBox.appendChild(input);

    row.appendChild(key);
    row.appendChild(valueBox);
    container.appendChild(row);
  }
}

/** 解析結果を反映するため、手を入れていない欄だけ作り直す */
function refreshGeneratedValues() {
  for (const input of el.properties.querySelectorAll('input')) {
    const property = state.template.properties.find((p) => p.name === input.dataset.name);
    if (!property) continue;
    const next = renderTemplate(property.value, state.variables);
    const isUntouched =
      input.type === 'checkbox'
        ? String(input.checked) === input.dataset.generated
        : input.value === input.dataset.generated;
    if (!isUntouched) continue;
    if (input.type === 'checkbox') input.checked = next === 'true';
    else input.value = next;
    input.dataset.generated = next;
  }

  if (el.noteName.value === el.noteName.dataset.generated) {
    el.noteName.value = state.variables.noteName;
    el.noteName.dataset.generated = state.variables.noteName;
  }

  const path = renderTemplate(state.template.path, state.variables);
  if (el.pathField.value === el.pathField.dataset.generated) {
    el.pathField.value = path;
    el.pathField.dataset.generated = path;
  }
}

function applyTemplate({ forceContent = false } = {}) {
  state.variables = buildVariables();

  el.noteName.value = state.variables.noteName;
  el.noteName.dataset.generated = state.variables.noteName;

  const path = renderTemplate(state.template.path, state.variables);
  el.pathField.value = path;
  el.pathField.dataset.generated = path;

  renderPropertyRows();

  if (state.analyzed) updateNoteContent(forceContent);
}

/**
 * 本文欄を作り直す。手で直した内容は残す（force のときだけ捨てる）。
 * 空欄のときは「まだ何も入っていない」とみなして常に入れ直す。
 */
function updateNoteContent(force = false) {
  const generated = renderTemplate(state.template.noteContentFormat, state.variables).trimEnd() + '\n';
  const untouched = !el.noteContent.value.trim() || el.noteContent.value === state.lastGeneratedContent;
  if (!force && !untouched) return;
  el.noteContent.value = generated;
  state.lastGeneratedContent = generated;
}

// ------------------------------------------------------------------ 出力
function collectProperties() {
  return [...el.properties.querySelectorAll('input')].map((input) => ({
    name: input.dataset.name,
    value: input.type === 'checkbox' ? String(input.checked) : input.value,
  }));
}

function buildMarkdown() {
  const frontmatter = generateFrontmatter(collectProperties(), propertyTypeMap());
  return `${frontmatter}\n${el.noteContent.value.trimEnd()}\n`;
}

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
 * content を渡すと本文を直接載せる。省略すると clipboard=true を付け、
 * Obsidian にクリップボードの中身を本文として使わせる（URI 長制限の回避）。
 */
function buildObsidianUri(mode, { vault, filePath, content, behavior }) {
  const query = new URLSearchParams();
  if (vault) query.set('vault', vault);

  if (mode === 'advanced') {
    query.set('filepath', filePath);
    query.set('mode', behavior === 'create' ? 'new' : behavior);
    if (content === undefined) query.set('clipboard', 'true');
    else query.set('data', content);
    return `obsidian://advanced-uri?${query.toString()}`;
  }

  query.set('file', filePath);
  if (behavior === 'append') query.set('append', 'true');
  else if (behavior === 'prepend') query.set('prepend', 'true');
  else if (behavior === 'overwrite') query.set('overwrite', 'true');
  if (content === undefined) query.set('clipboard', 'true');
  else query.set('content', content);
  return `obsidian://new?${query.toString()}`;
}

/** 拡張機能ページから外部プロトコルを起動する */
function openExternalUri(uri) {
  const anchor = document.createElement('a');
  anchor.href = uri;
  anchor.target = '_self';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function ensureDir(root, relDir) {
  let dir = root;
  for (const segment of sanitizeFolder(relDir).split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  return dir;
}

async function writeIntoVault(root, relPath, data) {
  const parts = relPath.split('/');
  const name = parts.pop();
  const dir = await ensureDir(root, parts.join('/'));
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function readFromVault(root, relPath) {
  const parts = relPath.split('/');
  const name = parts.pop();
  try {
    const dir = await ensureDir(root, parts.join('/'));
    const handle = await dir.getFileHandle(name, { create: false });
    return await (await handle.getFile()).text();
  } catch (_) {
    return null;
  }
}

/** 既存ノートとの関係（追記・上書き・別名で作成）を解決して書き込む */
async function writeNote(root, relPath, markdown, behavior) {
  const existing = await readFromVault(root, relPath);

  if (existing === null || behavior === 'overwrite') {
    await writeIntoVault(root, relPath, markdown);
    return relPath;
  }

  if (behavior === 'append') {
    await writeIntoVault(root, relPath, `${existing.trimEnd()}\n\n${markdown}`);
    return relPath;
  }

  if (behavior === 'prepend') {
    await writeIntoVault(root, relPath, `${markdown}\n${existing}`);
    return relPath;
  }

  // create: 同名ノートがあるときは連番を付けて別ファイルにする
  const base = relPath.replace(/\.md$/, '');
  for (let i = 1; i < 100; i += 1) {
    const candidate = `${base} ${i}.md`;
    if ((await readFromVault(root, candidate)) === null) {
      await writeIntoVault(root, candidate, markdown);
      return candidate;
    }
  }
  await writeIntoVault(root, relPath, markdown);
  return relPath;
}

async function saveAttachments({ mode, root, baseName, template }) {
  const settings = store.settings;
  const notices = [];
  const attachmentDir = sanitizeFolder(template.pdfPath) || sanitizeFolder(template.path);

  if (settings.embedMode === 'image' && state.images.length) {
    const imageDir = imageDirFor(template, baseName);
    let done = 0;
    for (const image of state.images) {
      const relPath = joinPath(imageDir, slideImageName(image.page));
      if (mode === 'vault') await writeIntoVault(root, relPath, image.blob);
      else await downloadBlob(image.blob, relPath);
      done += 1;
      setProgress(done / state.images.length, `ページ画像を保存中… ${done}/${state.images.length}`);
    }
    notices.push(`画像 ${state.images.length} 枚`);
  }

  if (settings.savePdf && state.pdfBytes) {
    const relPath = joinPath(attachmentDir, `${baseName}.pdf`);
    const blob = new Blob([state.pdfBytes], { type: 'application/pdf' });
    if (mode === 'vault') await writeIntoVault(root, relPath, blob);
    else await downloadBlob(blob, relPath);
    notices.push('PDF');
  }

  return notices;
}

async function copyToClipboard(markdown) {
  try {
    await navigator.clipboard.writeText(markdown);
    return true;
  } catch (err) {
    console.warn('クリップボードへのコピーに失敗', err);
    return false;
  }
}

function currentVaultName() {
  if (el.vaultSelect.value) return el.vaultSelect.value;
  return state.template.vault || store.settings.vaults[0] || '';
}

async function saveToVault(markdown, baseName) {
  const root = await getVaultDirHandle();
  if (!root) {
    throw new Error('Vault フォルダが未選択です。設定画面から選んでください。');
  }
  if (!(await ensureVaultPermission(root))) {
    throw new Error('Vault フォルダへの書き込みが許可されませんでした。');
  }

  const template = state.template;
  const noteFolder = sanitizeFolder(el.pathField.value);
  const notePath = joinPath(noteFolder, `${baseName}.md`);

  const writtenPath = await writeNote(root, notePath, markdown, template.behavior);
  const notices = [`ノート → ${writtenPath}`];
  notices.push(...(await saveAttachments({ mode: 'vault', root, baseName, template })));

  if (store.settings.clipboard) await copyToClipboard(markdown);

  if (store.settings.openAfterSave) {
    const query = new URLSearchParams();
    const vault = currentVaultName() || root.name;
    if (vault) query.set('vault', vault);
    query.set('file', writtenPath.replace(/\.md$/, ''));
    openExternalUri(`obsidian://open?${query.toString()}`);
  }

  return notices;
}

async function saveViaDownloads(markdown, baseName) {
  const template = state.template;
  const settings = store.settings;
  const noteFolder = sanitizeFolder(el.pathField.value);
  const filePath = joinPath(noteFolder, baseName);
  const notices = [];

  notices.push(...(await saveAttachments({ mode: 'downloads', baseName, template })));

  if (settings.downloadMd) {
    const target = joinPath(noteFolder, `${baseName}.md`);
    await downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), target);
    notices.push(`Markdown → ${target}`);
  }

  // 長い Markdown は clipboard=true で受け渡すため、設定が OFF でも
  // Obsidian 送出が有効ならコピーしておく。
  let clipboardOk = false;
  if (settings.clipboard || settings.uriMode !== 'none') {
    clipboardOk = await copyToClipboard(markdown);
  }

  if (settings.uriMode !== 'none') {
    const vault = currentVaultName();
    const full = buildObsidianUri(settings.uriMode, {
      vault,
      filePath,
      content: markdown,
      behavior: template.behavior,
    });

    if (full.length <= MAX_URI_LENGTH) {
      openExternalUri(full);
      notices.push(`Obsidian に送信 → ${filePath}`);
    } else if (clipboardOk) {
      openExternalUri(
        buildObsidianUri(settings.uriMode, { vault, filePath, behavior: template.behavior })
      );
      notices.push(`Obsidian に送信（クリップボード経由）→ ${filePath}`);
    } else {
      notices.push('Obsidian へ送れませんでした（クリップボード不可 + URI 長すぎ）');
    }

    if (noteFolder) {
      console.info(`Vault 内に "${noteFolder}" フォルダが無いと Obsidian 側でノートを作成できません`);
    }
  }

  return notices;
}

async function saveFileOnly(markdown, baseName) {
  const template = state.template;
  const notices = [];
  const target = joinPath(sanitizeFolder(el.pathField.value), `${baseName}.md`);
  await downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), target);
  notices.push(`Markdown → ${target}`);
  notices.push(...(await saveAttachments({ mode: 'downloads', baseName, template })));
  return notices;
}

async function performSave(behavior) {
  const markdown = buildMarkdown();
  const baseName = sanitizeFileName(el.noteName.value);

  if (behavior === 'copyToClipboard') {
    if (!(await copyToClipboard(markdown))) throw new Error('クリップボードにコピーできませんでした');
    setStatus('クリップボードにコピーしました', 'success');
    return;
  }

  if (behavior === 'saveFile') {
    const notices = await saveFileOnly(markdown, baseName);
    setStatus(notices.join(' / '), 'success');
    return;
  }

  const notices =
    store.settings.outputMode === 'vault'
      ? await saveToVault(markdown, baseName)
      : await saveViaDownloads(markdown, baseName);
  setStatus(notices.join(' / '), 'success');
}

// ------------------------------------------------------------------ ボタンとメニュー
function updateActionButtons() {
  if (!state.analyzed) {
    el.clipBtn.textContent = 'スライドを解析';
    el.moreBtn.hidden = true;
    return;
  }
  el.clipBtn.textContent = SAVE_BEHAVIOR_LABELS[store.settings.saveBehavior];
  el.moreBtn.hidden = false;
  renderMoreMenu();
}

function renderMoreMenu() {
  el.moreDropdown.textContent = '';

  const actions = Object.keys(SAVE_BEHAVIOR_LABELS)
    .filter((behavior) => behavior !== store.settings.saveBehavior)
    .map((behavior) => ({
      icon: SAVE_BEHAVIOR_ICONS[behavior],
      label: SAVE_BEHAVIOR_LABELS[behavior],
      run: () => runSave(behavior),
    }));

  actions.push({ icon: 'refresh-cw', label: 'もう一度解析', run: runAnalyze });

  for (const action of actions) {
    const item = document.createElement('div');
    item.className = 'menu-item';

    const icon = document.createElement('div');
    icon.className = 'menu-item-icon';
    icon.appendChild(createIcon(action.icon));
    item.appendChild(icon);

    const title = document.createElement('div');
    title.className = 'menu-item-title';
    title.textContent = action.label;
    item.appendChild(title);

    item.addEventListener('click', () => {
      el.moreDropdown.classList.remove('show');
      action.run();
    });
    el.moreDropdown.appendChild(item);
  }
}

async function runAnalyze() {
  if (state.running) return;
  state.running = true;
  el.clipBtn.disabled = true;
  el.moreBtn.disabled = true;

  try {
    await analyze();
    state.variables = buildVariables();
    refreshGeneratedValues();
    updateNoteContent();
    updateActionButtons();
  } catch (err) {
    console.error(err);
    setStatus(err.message, 'error');
    await terminateTesseract();
  } finally {
    state.running = false;
    el.clipBtn.disabled = false;
    el.moreBtn.disabled = false;
  }
}

async function runSave(behavior) {
  if (state.running) return;
  state.running = true;
  el.clipBtn.disabled = true;

  try {
    await performSave(behavior);
  } catch (err) {
    console.error(err);
    setStatus(err.message, 'error');
  } finally {
    state.running = false;
    el.clipBtn.disabled = false;
  }
}

// ------------------------------------------------------------------ テンプレート選択
function renderTemplateSelect() {
  el.templateSelect.textContent = '';
  for (const template of store.templates) {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = template.name;
    el.templateSelect.appendChild(option);
  }
  el.templateSelect.value = state.template.id;
}

function renderVaultSelect() {
  const vaults = store.settings.vaults;
  el.vaultContainer.hidden = vaults.length < 2;
  el.vaultSelect.textContent = '';
  for (const vault of vaults) {
    const option = document.createElement('option');
    option.value = vault;
    option.textContent = vault;
    el.vaultSelect.appendChild(option);
  }
  el.vaultSelect.value = state.template.vault || vaults[0] || '';
}

// ------------------------------------------------------------------ 起動
async function initialize() {
  if (isStandalone) document.body.classList.add('standalone');
  initializeIcons(document);

  await loadAll();

  el.openSettings.addEventListener('click', (event) => {
    event.preventDefault();
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    window.close();
  });

  el.openInTab.hidden = isStandalone;
  el.openInTab.addEventListener('click', async (event) => {
    event.preventDefault();
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?standalone=1') });
    window.close();
  });

  el.propertiesHeader.addEventListener('click', () => {
    el.propertiesHeader.classList.toggle('collapsed');
    el.properties.classList.toggle('collapsed');
  });

  el.moreBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    el.moreDropdown.classList.toggle('show');
  });
  document.addEventListener('click', () => el.moreDropdown.classList.remove('show'));

  el.clipBtn.addEventListener('click', () => {
    if (state.analyzed) runSave(store.settings.saveBehavior);
    else runAnalyze();
  });

  el.templateSelect.addEventListener('change', () => {
    const template = findTemplateById(el.templateSelect.value);
    if (!template) return;
    state.template = template;
    applyTemplate({ forceContent: true });
    renderVaultSelect();
  });

  try {
    state.deck = await scrapeDeck();
  } catch (err) {
    showFatalError(err.message);
    return;
  }

  state.template = findTemplateForUrl(state.deck.url) || store.templates[0];
  renderTemplateSelect();
  renderVaultSelect();
  applyTemplate();
  updateActionButtons();

  if (!state.deck.pdfUrl) {
    setStatus('PDF の URL を検出できませんでした。ページを再読み込みしてみてください。', 'error');
  } else {
    setStatus('PDF を検出しました。「スライドを解析」を押してください。');
    el.progressFill.style.width = '0%';
  }
}

initialize().catch((err) => {
  console.error(err);
  showFatalError(err.message);
});
