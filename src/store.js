/**
 * src/store.js
 *
 * 設定・テンプレート・プロパティ型の永続化。
 *
 *   Settings     … 拡張全体の設定 + propertyTypes（プロパティ名 → 型 / 既定値）
 *   Template     … ノート名・保存先・プロパティ・本文フォーマットの組
 *   PropertyType … Obsidian の .obsidian/types.json と同じ「名前 → 型」の対応。
 *                  型はフロントマターの書き方（引用符・リスト・真偽値）を決める。
 *
 * 保存先は chrome.storage.local。sync は 1 項目 8KB の制限があり、
 * ノート本文フォーマットを含むテンプレートが収まらないため使わない。
 */

export const PROPERTY_TYPES = ['text', 'multitext', 'number', 'checkbox', 'date', 'datetime'];

export const PROPERTY_TYPE_LABELS = {
  text: 'テキスト',
  multitext: 'リスト',
  number: '数値',
  checkbox: 'チェックボックス',
  date: '日付',
  datetime: '日時',
};

export const BEHAVIOR_LABELS = {
  create: '新規ノートを作成',
  append: '既存ノートの末尾に追加',
  prepend: '既存ノートの先頭に追加',
  overwrite: 'ノートを上書き',
};

export const DEFAULT_SETTINGS = {
  schemaVersion: 2,

  // ---- 保存方法 -------------------------------------------------------
  outputMode: 'vault', // 'vault' = File System Access で直接書き込み / 'downloads'
  vaults: [], // URI 方式で使う Vault 名の一覧（先頭が既定）
  saveBehavior: 'addToObsidian', // 'addToObsidian' | 'saveFile' | 'copyToClipboard'
  showMoreActions: true,
  openAfterSave: true,
  uriMode: 'new', // 'new' | 'advanced' | 'none'
  downloadMd: true,
  clipboard: true,
  savePdf: true,

  // ---- 解析 -----------------------------------------------------------
  ocr: true,
  threshold: 20,
  lang: 'jpn+eng',
  width: 1600,
  maxPages: 0,
  imageQuality: 0.82,

  // ---- 出力形式 -------------------------------------------------------
  embedMode: 'image', // 'image' | 'pdf'
  textBlock: 'callout', // 'callout' | 'details' | 'plain'

  // ---- プロパティ型 ---------------------------------------------------
  propertyTypes: [],
};

/** 初期状態で登録しておくプロパティ型。既定値には変数を使う。 */
export const DEFAULT_PROPERTY_TYPES = [
  { name: 'title', type: 'text', defaultValue: '{{title}}' },
  { name: 'author', type: 'multitext', defaultValue: '{{author}}' },
  { name: 'source', type: 'text', defaultValue: '{{url}}' },
  { name: 'published', type: 'date', defaultValue: '{{published}}' },
  { name: 'created', type: 'date', defaultValue: '{{date}}' },
  { name: 'description', type: 'text', defaultValue: '{{description}}' },
  { name: 'slides', type: 'number', defaultValue: '{{slideCount}}' },
  { name: 'pdf', type: 'text', defaultValue: '{{pdfUrl}}' },
  { name: 'tags', type: 'multitext', defaultValue: 'slide, speakerdeck' },
];

export const DEFAULT_NOTE_CONTENT = [
  '# {{title}}',
  '',
  '## 概要',
  '{{description}}',
  '',
  '---',
  '',
  '## スライド一覧',
  '',
  '{{slides}}',
  '',
].join('\n');

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 11);
}

export function createDefaultTemplate() {
  return {
    id: generateId(),
    name: '既定のテンプレート',
    behavior: 'create',
    noteNameFormat: '{{title}}',
    path: 'Clippings',
    pdfPath: '',
    vault: '',
    triggers: [],
    noteContentFormat: DEFAULT_NOTE_CONTENT,
    properties: DEFAULT_PROPERTY_TYPES.filter((pt) => pt.name !== 'slides').map((pt) => ({
      id: generateId(),
      name: pt.name,
      value: pt.defaultValue,
    })),
  };
}

// ------------------------------------------------------------------ 状態
export const store = {
  settings: { ...DEFAULT_SETTINGS, propertyTypes: [] },
  templates: [],
};

// ------------------------------------------------------------------ 読み書き
export async function loadAll() {
  const data = await chrome.storage.local.get(['settings', 'templates']);
  const hadTemplates = Array.isArray(data.templates) && data.templates.length > 0;

  store.settings = migrateSettings(data.settings);
  store.templates = hadTemplates
    ? data.templates.map(normalizeTemplate)
    : [migrateLegacyTemplate(data.settings)];
  ensurePropertyTypes();

  // 初回起動と旧形式からの移行では、作った内容をそのまま確定させる
  if (!hadTemplates) await saveAll();

  return store;
}

export async function saveSettings() {
  await chrome.storage.local.set({ settings: store.settings });
}

export async function saveTemplates() {
  await chrome.storage.local.set({ templates: store.templates });
}

export async function saveAll() {
  await chrome.storage.local.set({ settings: store.settings, templates: store.templates });
}

function normalizeTemplate(raw) {
  const t = { ...createDefaultTemplate(), ...raw };
  t.properties = (Array.isArray(raw.properties) ? raw.properties : []).map((p) => ({
    id: p.id || generateId(),
    name: String(p.name || ''),
    value: String(p.value == null ? '' : p.value),
  }));
  t.triggers = Array.isArray(raw.triggers) ? raw.triggers : [];
  return t;
}

/** v1（フラットな設定 1 個だけ）から v2 への移行 */
function migrateSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, propertyTypes: [], ...(raw || {}) };
  if (!Array.isArray(s.vaults)) s.vaults = [];
  // v1 の `vault`（単一の Vault 名）を vaults に畳み込む
  if (raw && typeof raw.vault === 'string' && raw.vault.trim() && !s.vaults.includes(raw.vault.trim())) {
    s.vaults.unshift(raw.vault.trim());
  }
  delete s.vault;
  // v1 の notePath / pdfPath はテンプレート側へ移すのでここでは持たない
  delete s.notePath;
  delete s.pdfPath;
  if (typeof raw?.openAfter === 'boolean') s.openAfterSave = raw.openAfter;
  delete s.openAfter;
  s.propertyTypes = Array.isArray(s.propertyTypes) ? s.propertyTypes : [];
  s.schemaVersion = 2;
  return s;
}

/** v1 の設定からテンプレートを 1 個作る（保存先パスを引き継ぐ） */
function migrateLegacyTemplate(rawSettings) {
  const t = createDefaultTemplate();
  if (rawSettings) {
    if (typeof rawSettings.notePath === 'string') t.path = rawSettings.notePath;
    if (typeof rawSettings.pdfPath === 'string') t.pdfPath = rawSettings.pdfPath;
    if (typeof rawSettings.vault === 'string') t.vault = rawSettings.vault;
  }
  return t;
}

// ------------------------------------------------------------------ プロパティ型
/** テンプレートで使われているプロパティ名を propertyTypes に取り込む */
export function ensurePropertyTypes() {
  const known = new Set(store.settings.propertyTypes.map((pt) => pt.name));

  for (const preset of DEFAULT_PROPERTY_TYPES) {
    if (!known.has(preset.name)) {
      store.settings.propertyTypes.push({ ...preset });
      known.add(preset.name);
    }
  }

  for (const template of store.templates) {
    for (const property of template.properties) {
      const name = (property.name || '').trim();
      if (!name || known.has(name)) continue;
      store.settings.propertyTypes.push({ name, type: 'text', defaultValue: '' });
      known.add(name);
    }
  }

  // tags は Obsidian 側の仕様に合わせて必ず multitext
  const tags = store.settings.propertyTypes.find((pt) => pt.name === 'tags');
  if (tags) tags.type = 'multitext';
}

export function getPropertyType(name) {
  const found = store.settings.propertyTypes.find((pt) => pt.name === name);
  return found ? found.type : 'text';
}

export function getPropertyTypeEntry(name) {
  return store.settings.propertyTypes.find((pt) => pt.name === name) || null;
}

export async function upsertPropertyType(name, type, defaultValue) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  const existing = store.settings.propertyTypes.find((pt) => pt.name === trimmed);
  if (existing) {
    if (type) existing.type = type;
    if (defaultValue !== undefined) {
      if (defaultValue) existing.defaultValue = defaultValue;
      else delete existing.defaultValue;
    }
  } else {
    const entry = { name: trimmed, type: type || 'text' };
    if (defaultValue) entry.defaultValue = defaultValue;
    store.settings.propertyTypes.push(entry);
  }
  await saveSettings();
}

export async function removePropertyType(name) {
  store.settings.propertyTypes = store.settings.propertyTypes.filter((pt) => pt.name !== name);
  await saveSettings();
}

/** プロパティ名 → 使用しているテンプレート数 */
export function countPropertyUsage() {
  const counts = {};
  for (const template of store.templates) {
    for (const property of template.properties) {
      counts[property.name] = (counts[property.name] || 0) + 1;
    }
  }
  return counts;
}

/** 型マップ（フロントマター生成に渡す） */
export function propertyTypeMap() {
  const map = {};
  for (const pt of store.settings.propertyTypes) map[pt.name] = pt.type;
  return map;
}

// ------------------------------------------------------------------ テンプレート
export function findTemplateById(id) {
  return store.templates.find((t) => t.id === id) || null;
}

/** URL に対応するテンプレートを選ぶ。triggers は 1 行 1 パターンの前方一致か /正規表現/。 */
export function findTemplateForUrl(url) {
  if (!url) return store.templates[0] || null;
  for (const template of store.templates) {
    for (const trigger of template.triggers || []) {
      const pattern = trigger.trim();
      if (!pattern) continue;
      if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
        // /正規表現/ 形式
        const lastSlash = pattern.lastIndexOf('/');
        try {
          const re = new RegExp(pattern.slice(1, lastSlash), pattern.slice(lastSlash + 1));
          if (re.test(url)) return template;
        } catch (_) {
          /* 壊れた正規表現は無視 */
        }
      } else if (url.startsWith(pattern)) {
        return template;
      }
    }
  }
  return store.templates[0] || null;
}

export function duplicateTemplate(id) {
  const original = findTemplateById(id);
  if (!original) return null;
  const copy = JSON.parse(JSON.stringify(original));
  copy.id = generateId();
  copy.name = uniqueTemplateName(original.name);
  copy.properties = copy.properties.map((p) => ({ ...p, id: generateId() }));
  store.templates.unshift(copy);
  return copy;
}

export function uniqueTemplateName(baseName) {
  const base = baseName.replace(/\s\d+$/, '');
  const existing = new Set(store.templates.map((t) => t.name));
  if (!existing.has(base)) return base;
  let counter = 2;
  while (existing.has(`${base} ${counter}`)) counter += 1;
  return `${base} ${counter}`;
}

// ------------------------------------------------------------------ Vault ディレクトリ（File System Access）
// FileSystemDirectoryHandle は構造化複製できるが chrome.storage には入らないので IndexedDB を使う。
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('speakerdeck-obsidian', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getVaultDirHandle() {
  try {
    return (await idbGet('vaultDir')) || null;
  } catch (err) {
    console.warn('Vault ディレクトリハンドルを復元できませんでした', err);
    return null;
  }
}

export async function setVaultDirHandle(handle) {
  await idbSet('vaultDir', handle);
}

export async function hasVaultPermission(handle) {
  if (!handle) return false;
  return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
}

/** 権限が無ければ要求する。ユーザー操作（クリック）の直後に呼ぶこと。 */
export async function ensureVaultPermission(handle) {
  if (await hasVaultPermission(handle)) return true;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}
