/**
 * settings/settings.js
 *
 * 設定画面（chrome-extension://<id>/settings.html）の実装。
 *
 * 画面は「サイドバーで選んだセクションだけ .active にする」構成で、
 * 選択中のセクションは location.hash に持たせている（#templates/<id> など）。
 * 入力は変更のたびに chrome.storage へ書き戻すので保存ボタンは無い。
 */
import {
  BEHAVIOR_LABELS,
  DEFAULT_NOTE_CONTENT,
  PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS,
  countPropertyUsage,
  createDefaultTemplate,
  duplicateTemplate,
  ensurePropertyTypes,
  findTemplateById,
  generateId,
  getPropertyTypeEntry,
  getVaultDirHandle,
  hasVaultPermission,
  loadAll,
  removePropertyType,
  saveAll,
  saveSettings,
  saveTemplates,
  setVaultDirHandle,
  store,
  uniqueTemplateName,
  upsertPropertyType,
} from '../src/store.js';
import { createIcon, getPropertyTypeIcon, initializeIcons } from '../src/icons.js';
import {
  SUPPORTED_FILTERS,
  VARIABLE_DEFINITIONS,
  VARIABLE_NAMES,
  validateTemplateString,
} from '../src/template.js';

const $ = (id) => document.getElementById(id);

/** 編集中のテンプレート。テンプレートセクション以外を開いているときは null。 */
let editingTemplate = null;

// ------------------------------------------------------------------ 汎用ヘルパ
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(iconName, className, label) {
  const button = el('button', `clickable-icon ${className}`);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(createIcon(iconName));
  return button;
}

let toastTimer = null;
function toast(message, kind = '') {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast${kind ? ` is-${kind}` : ''}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2600);
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const saveTemplatesDebounced = debounce(() => {
  saveTemplates().catch((err) => toast(`保存に失敗しました: ${err.message}`, 'error'));
}, 300);

function downloadJson(data, fileName) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = el('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 値の変更を storage に書き戻す入力をつくる。
 * @param {string} id 要素 ID
 * @param {'value'|'checked'|'number'} kind 読み書きするプロパティ
 * @param {string} key settings のキー
 */
function bindSetting(id, kind, key, afterChange) {
  const input = $(id);
  if (!input) return;

  if (kind === 'checked') {
    input.checked = Boolean(store.settings[key]);
    syncToggle(input);
  } else if (kind === 'number') {
    input.value = String(store.settings[key]);
  } else {
    input.value = store.settings[key] ?? '';
  }

  const handler = async () => {
    if (kind === 'checked') {
      store.settings[key] = input.checked;
      syncToggle(input);
    } else if (kind === 'number') {
      store.settings[key] = Number(input.value);
    } else {
      store.settings[key] = input.value;
    }
    await saveSettings();
    if (afterChange) afterChange();
  };

  input.addEventListener('change', handler);
}

/** トグルの見た目は親要素のクラスで表現しているので checked と同期させる */
function syncToggle(input) {
  const container = input.closest('.checkbox-container');
  if (container) container.classList.toggle('is-enabled', input.checked);
}

/**
 * リストをドラッグで並べ替えられるようにする。
 * 並べ替え後の DOM 順を onReorder に渡すので、呼び出し側でデータを並べ替える。
 */
function makeSortable(container, itemSelector, onReorder) {
  let dragged = null;

  container.addEventListener('dragstart', (event) => {
    const item = event.target.closest(itemSelector);
    if (!item) return;
    dragged = item;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.dataset.id || '');
    setTimeout(() => item.classList.add('dragging'), 0);
  });

  container.addEventListener('dragover', (event) => {
    if (!dragged) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const target = event.target.closest(itemSelector);
    if (!target || target === dragged) return;
    const rect = target.getBoundingClientRect();
    const insertBefore = event.clientY < rect.top + rect.height / 2;
    target.parentNode.insertBefore(dragged, insertBefore ? target : target.nextSibling);
  });

  const finish = (event) => {
    if (!dragged) return;
    if (event) event.preventDefault();
    dragged.classList.remove('dragging');
    dragged.removeAttribute('draggable');
    dragged = null;
    onReorder([...container.querySelectorAll(itemSelector)]);
  };

  container.addEventListener('drop', finish);
  container.addEventListener('dragend', finish);
}

/** ハンドルを掴んでいる間だけ draggable にする（入力欄のテキスト選択を邪魔しないため） */
function attachDragHandle(handle, item) {
  handle.addEventListener('mousedown', () => {
    item.setAttribute('draggable', 'true');
  });
  handle.addEventListener('mouseup', () => {
    item.removeAttribute('draggable');
  });
}

// ------------------------------------------------------------------ セクション切り替え
const SECTIONS = ['general', 'analysis', 'output', 'properties', 'variables', 'templates'];

function showSection(section, templateId) {
  const target = SECTIONS.includes(section) ? section : 'general';

  for (const node of document.querySelectorAll('.settings-section')) {
    node.classList.remove('active');
  }
  for (const item of document.querySelectorAll('#sidebar li')) {
    item.classList.remove('active');
  }

  $(`${target}-section`).classList.add('active');
  const navItem = document.querySelector(`#sidebar li[data-section="${target}"]`);
  if (navItem) navItem.classList.add('active');

  if (target === 'templates') {
    const template = findTemplateById(templateId) || store.templates[0];
    if (template) {
      showTemplateEditor(template);
      setHash(`#templates/${template.id}`);
    }
  } else {
    editingTemplate = null;
    setHash(`#${target}`);
  }

  if (target === 'properties') renderPropertyTypes();

  $('settings').classList.remove('sidebar-open');
  document.getElementById('content').scrollTop = 0;
}

/** 同じ hash を入れ直すと hashchange 経由で再描画が走るので、変化するときだけ書く */
function setHash(hash) {
  if (location.hash !== hash) location.hash = hash;
}

function applyHashRoute() {
  const [section, templateId] = location.hash.replace(/^#/, '').split('/');
  showSection(section || 'general', templateId);
}

// ------------------------------------------------------------------ 一般設定
function initializeGeneralSection() {
  bindSetting('output-mode', 'value', 'outputMode', updateOutputModeVisibility);
  bindSetting('save-behavior', 'value', 'saveBehavior');
  bindSetting('open-after-save', 'checked', 'openAfterSave');
  bindSetting('uri-mode', 'value', 'uriMode');
  bindSetting('download-md', 'checked', 'downloadMd');
  bindSetting('clipboard-copy', 'checked', 'clipboard');

  updateOutputModeVisibility();
  renderVaultList();
  // ディレクトリハンドルの取得は IndexedDB 経由で遅くなりうるので、画面の初期化は待たせない
  refreshVaultDirStatus().catch((err) => console.warn('Vault フォルダの状態を取得できません', err));

  $('pick-vault-btn').addEventListener('click', pickVaultDirectory);

  $('vault-input').addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const name = event.target.value.trim();
    if (!name) return;
    if (!store.settings.vaults.includes(name)) {
      store.settings.vaults.push(name);
      await saveSettings();
      renderVaultList();
      renderTemplateVaultOptions();
    }
    event.target.value = '';
  });

  $('reset-default-template-btn').addEventListener('click', async () => {
    if (!confirm('テンプレートをすべて削除して初期状態に戻します。よろしいですか？')) return;
    store.templates = [createDefaultTemplate()];
    ensurePropertyTypes();
    await saveAll();
    renderTemplateList();
    showSection('templates', store.templates[0].id);
    toast('テンプレートをリセットしました');
  });

  $('export-all-settings-btn').addEventListener('click', () => {
    downloadJson(
      { settings: store.settings, templates: store.templates },
      'speakerdeck-obsidian-settings.json'
    );
  });

  $('import-all-settings-btn').addEventListener('click', () => {
    showImportModal('すべての設定をインポート', async (text) => {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') throw new Error('JSON の形式が不正です');
      if (data.settings) store.settings = { ...store.settings, ...data.settings };
      if (Array.isArray(data.templates) && data.templates.length) store.templates = data.templates;
      ensurePropertyTypes();
      await saveAll();
      renderVaultList();
      renderTemplateList();
      renderPropertyTypes();
      applyHashRoute();
      toast('設定をインポートしました');
    });
  });
}

/** 保存方法によって意味を持たない設定項目を隠す */
function updateOutputModeVisibility() {
  const isVaultMode = store.settings.outputMode === 'vault';
  $('vault-dir-item').classList.toggle('is-hidden', !isVaultMode);
  $('uri-mode-item').classList.toggle('is-hidden', isVaultMode);
  $('download-md-item').classList.toggle('is-hidden', isVaultMode);
  const openAfterItem = $('open-after-save').closest('.setting-item');
  openAfterItem.classList.toggle('is-hidden', !isVaultMode);
}

async function pickVaultDirectory() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'obsidian-vault' });
    if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      throw new Error('フォルダへの書き込みが許可されませんでした');
    }
    await setVaultDirHandle(handle);
    // Vault のルートを選んだ場合、フォルダ名がそのまま Vault 名になる
    if (!store.settings.vaults.includes(handle.name)) {
      store.settings.vaults.unshift(handle.name);
      await saveSettings();
      renderVaultList();
      renderTemplateVaultOptions();
    }
    await refreshVaultDirStatus();
    toast(`Vault フォルダを設定しました: ${handle.name}`);
  } catch (err) {
    if (err.name === 'AbortError') return;
    toast(err.message, 'error');
  }
}

async function refreshVaultDirStatus() {
  const status = $('vault-dir-status');
  const handle = await getVaultDirHandle();
  if (!handle) {
    status.textContent = '未選択です。Vault のルートフォルダを一度だけ選んでください。';
    return;
  }
  const granted = await hasVaultPermission(handle);
  status.textContent = granted
    ? `選択中: ${handle.name}`
    : `選択中: ${handle.name}（ブラウザ再起動後は保存時に再認可が必要です）`;
}

function renderVaultList() {
  const list = $('vault-list');
  list.textContent = '';

  store.settings.vaults.forEach((vault, index) => {
    const item = el('li');
    item.dataset.index = String(index);
    item.draggable = true;

    const handle = el('div', 'drag-handle');
    handle.appendChild(createIcon('grip-vertical'));
    item.appendChild(handle);

    item.appendChild(el('span', 'vault-name', vault));
    if (index === 0) item.appendChild(el('span', 'vault-default-tag', '既定'));

    const remove = iconButton('trash-2', 'setting-item-list-remove', `${vault} を削除`);
    remove.addEventListener('click', async () => {
      store.settings.vaults.splice(index, 1);
      await saveSettings();
      renderVaultList();
      renderTemplateVaultOptions();
    });
    item.appendChild(remove);

    list.appendChild(item);
  });
}

// ------------------------------------------------------------------ 解析・出力
function initializeAnalysisSection() {
  bindSetting('opt-ocr', 'checked', 'ocr');
  bindSetting('opt-threshold', 'number', 'threshold');
  bindSetting('opt-lang', 'value', 'lang');
  bindSetting('opt-width', 'number', 'width');
  bindSetting('opt-max-pages', 'number', 'maxPages');
}

function initializeOutputSection() {
  bindSetting('opt-embed-mode', 'value', 'embedMode', updateImageQualityVisibility);
  bindSetting('opt-image-quality', 'number', 'imageQuality');
  bindSetting('opt-text-block', 'value', 'textBlock');
  bindSetting('opt-save-pdf', 'checked', 'savePdf');
  updateImageQualityVisibility();
}

function updateImageQualityVisibility() {
  const item = $('opt-image-quality').closest('.setting-item');
  item.classList.toggle('is-hidden', store.settings.embedMode !== 'image');
}

// ------------------------------------------------------------------ プロパティ型
function renderPropertyTypes() {
  const list = $('property-types-list');
  list.textContent = '';

  const usage = countPropertyUsage();
  const sorted = [...store.settings.propertyTypes].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );

  let hasUnused = false;

  for (const propertyType of sorted) {
    const usageCount = usage[propertyType.name] || 0;
    if (usageCount === 0 && propertyType.name !== 'tags') hasUnused = true;
    list.appendChild(createPropertyTypeRow(propertyType, usageCount));
  }

  $('delete-unused-item').classList.toggle('is-hidden', !hasUnused);
  refreshPropertyNameSuggestions();
}

function createPropertyTypeRow(propertyType, usageCount) {
  const row = el('div', 'property-editor');
  const isTags = propertyType.name === 'tags';
  if (isTags) row.classList.add('tags-property');

  const { wrapper, select, setIcon } = createTypeSelect(propertyType.type);
  select.disabled = isTags;
  row.appendChild(wrapper);

  row.appendChild(el('span', 'property-name', propertyType.name));

  const defaultValue = el('input', 'property-default-value');
  defaultValue.type = 'text';
  defaultValue.value = propertyType.defaultValue || '';
  defaultValue.placeholder = '既定値';
  row.appendChild(defaultValue);

  const flair = el('span', 'tree-item-flair', usageCount ? `${usageCount} 件で使用中` : '未使用');
  row.appendChild(flair);

  const remove = iconButton('trash-2', 'remove-property-btn', `${propertyType.name} を削除`);
  if (usageCount > 0 || isTags) {
    remove.setAttribute('disabled', '');
  } else {
    remove.addEventListener('click', async () => {
      await removePropertyType(propertyType.name);
      renderPropertyTypes();
    });
  }
  row.appendChild(remove);

  select.addEventListener('change', async () => {
    setIcon(select.value);
    await upsertPropertyType(propertyType.name, select.value, defaultValue.value);
    if (editingTemplate) syncPropertyRowTypes();
  });

  defaultValue.addEventListener('change', async () => {
    await upsertPropertyType(propertyType.name, select.value, defaultValue.value);
  });

  return row;
}

/** アイコン表示つきの型セレクタ（select 本体は透明にしてアイコンに重ねる） */
function createTypeSelect(type) {
  const wrapper = el('div', 'property-select');
  const selected = el('div', 'property-selected');
  selected.dataset.value = type;
  selected.appendChild(createIcon(getPropertyTypeIcon(type)));
  wrapper.appendChild(selected);

  const select = el('select', 'property-type');
  for (const value of PROPERTY_TYPES) {
    const option = el('option', null, PROPERTY_TYPE_LABELS[value]);
    option.value = value;
    select.appendChild(option);
  }
  select.value = type;
  wrapper.appendChild(select);

  const setIcon = (value) => {
    selected.textContent = '';
    selected.dataset.value = value;
    selected.appendChild(createIcon(getPropertyTypeIcon(value)));
  };

  return { wrapper, select, selected, setIcon };
}

function initializePropertiesSection() {
  $('add-property-type-btn').addEventListener('click', () => {
    const list = $('property-types-list');
    const row = el('div', 'property-editor');

    const { wrapper, select } = createTypeSelect('text');
    row.appendChild(wrapper);

    const nameInput = el('input', 'property-name');
    nameInput.type = 'text';
    nameInput.placeholder = 'プロパティ名';
    row.appendChild(nameInput);

    const defaultValue = el('input', 'property-default-value');
    defaultValue.type = 'text';
    defaultValue.placeholder = '既定値';
    row.appendChild(defaultValue);

    const commit = async () => {
      const name = nameInput.value.trim();
      if (!name) {
        row.remove();
        return;
      }
      await upsertPropertyType(name, select.value, defaultValue.value);
      renderPropertyTypes();
      refreshPropertyNameSuggestions();
    };

    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });
    nameInput.addEventListener('blur', () => setTimeout(commit, 120));

    list.appendChild(row);
    nameInput.focus();
  });

  $('delete-unused-properties-btn').addEventListener('click', async () => {
    const usage = countPropertyUsage();
    const unused = store.settings.propertyTypes.filter(
      (pt) => !usage[pt.name] && pt.name !== 'tags'
    );
    if (!unused.length) {
      toast('未使用のプロパティはありません');
      return;
    }
    if (!confirm(`未使用のプロパティ ${unused.length} 件を削除します。よろしいですか？`)) return;
    store.settings.propertyTypes = store.settings.propertyTypes.filter(
      (pt) => usage[pt.name] || pt.name === 'tags'
    );
    await saveSettings();
    renderPropertyTypes();
    toast(`${unused.length} 件のプロパティを削除しました`);
  });

  $('export-types-btn').addEventListener('click', () => {
    const types = {};
    for (const pt of store.settings.propertyTypes) types[pt.name] = pt.type;
    downloadJson({ types }, 'types.json');
  });

  $('import-types-btn').addEventListener('click', () => {
    showImportModal('プロパティをインポート', async (text) => {
      const data = JSON.parse(text);
      if (!data || typeof data.types !== 'object') {
        throw new Error('types.json の形式ではありません（"types" が見つかりません）');
      }
      let imported = 0;
      for (const [name, type] of Object.entries(data.types)) {
        const validType = PROPERTY_TYPES.includes(type) ? type : 'text';
        await upsertPropertyType(name, name === 'tags' ? 'multitext' : validType);
        imported += 1;
      }
      renderPropertyTypes();
      toast(`${imported} 件のプロパティを読み込みました`);
    });
  });
}

function refreshPropertyNameSuggestions() {
  let datalist = $('property-name-suggestions');
  if (!datalist) {
    datalist = el('datalist');
    datalist.id = 'property-name-suggestions';
    document.body.appendChild(datalist);
  }
  datalist.textContent = '';
  for (const pt of store.settings.propertyTypes) {
    const option = el('option');
    option.value = pt.name;
    datalist.appendChild(option);
  }
}

// ------------------------------------------------------------------ テンプレート一覧
function renderTemplateList() {
  const list = $('template-list');
  list.textContent = '';

  for (const template of store.templates) {
    const item = el('li');
    item.dataset.id = template.id;
    if (editingTemplate && template.id === editingTemplate.id) item.classList.add('active');

    const handle = el('div', 'drag-handle');
    handle.appendChild(createIcon('grip-vertical'));
    attachDragHandle(handle, item);
    item.appendChild(handle);

    item.appendChild(el('span', 'template-name', template.name));

    const remove = iconButton('trash-2', 'delete-template-btn', `${template.name} を削除`);
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      await deleteTemplate(template.id);
    });
    item.appendChild(remove);

    item.addEventListener('click', (event) => {
      if (event.target.closest('.delete-template-btn')) return;
      showSection('templates', template.id);
    });

    list.appendChild(item);
  }
}

async function deleteTemplate(id) {
  const template = findTemplateById(id);
  if (!template) return;
  if (store.templates.length === 1) {
    toast('最後のテンプレートは削除できません', 'error');
    return;
  }
  if (!confirm(`テンプレート「${template.name}」を削除します。よろしいですか？`)) return;

  store.templates = store.templates.filter((t) => t.id !== id);
  await saveTemplates();
  renderTemplateList();
  showSection('templates', store.templates[0].id);
  toast('テンプレートを削除しました');
}

// ------------------------------------------------------------------ テンプレート編集
function showTemplateEditor(template) {
  editingTemplate = template;

  $('template-name').value = template.name;
  $('url-patterns').value = (template.triggers || []).join('\n');
  $('template-behavior').value = template.behavior;
  $('note-name-format').value = template.noteNameFormat;
  $('template-path-name').value = template.path;
  $('template-pdf-path').value = template.pdfPath || '';
  $('note-content-format').value = template.noteContentFormat || DEFAULT_NOTE_CONTENT;

  renderTemplateVaultOptions();
  $('template-vault').value = template.vault || '';

  const propertiesContainer = $('template-properties');
  propertiesContainer.textContent = '';
  for (const property of template.properties) {
    propertiesContainer.appendChild(createPropertyRow(property));
  }

  updateBehaviorDescription();
  markDuplicateProperties();
  validateField($('note-name-format'));
  validateField($('template-path-name'));
  validateField($('note-content-format'));
  renderTemplateList();
}

function renderTemplateVaultOptions() {
  const select = $('template-vault');
  const current = select.value;
  select.textContent = '';

  const defaultOption = el('option', null, '既定の Vault');
  defaultOption.value = '';
  select.appendChild(defaultOption);

  for (const vault of store.settings.vaults) {
    const option = el('option', null, vault);
    option.value = vault;
    select.appendChild(option);
  }
  select.value = current;
}

function updateBehaviorDescription() {
  const behavior = $('template-behavior').value;
  const label = $('note-name-format').closest('.setting-item').querySelector('.setting-item-description');
  label.textContent =
    behavior === 'create'
      ? '変数が使えます。ファイル名に使えない文字は自動で置き換えます。'
      : `${BEHAVIOR_LABELS[behavior]}ため、既存のノート名と一致させてください。`;
}

/** テンプレート編集フォームの内容を編集中テンプレートへ書き戻す */
function updateTemplateFromForm() {
  if (!editingTemplate) return;

  editingTemplate.name = $('template-name').value;
  editingTemplate.triggers = $('url-patterns').value.split('\n').map((s) => s.trim()).filter(Boolean);
  editingTemplate.behavior = $('template-behavior').value;
  editingTemplate.noteNameFormat = $('note-name-format').value;
  editingTemplate.path = $('template-path-name').value;
  editingTemplate.pdfPath = $('template-pdf-path').value;
  editingTemplate.vault = $('template-vault').value;
  editingTemplate.noteContentFormat = $('note-content-format').value;

  editingTemplate.properties = [...$('template-properties').querySelectorAll('.property-editor')]
    .map((row) => ({
      id: row.dataset.id,
      name: row.querySelector('.property-name').value.trim(),
      value: row.querySelector('.property-value').value,
    }))
    .filter((property) => property.name !== '');

  markDuplicateProperties();
  saveTemplatesDebounced();
}

/**
 * 同名のプロパティが並んでいる行に警告を出す。
 * フロントマターは YAML なので同じキーを 2 回書けず、書き出されるのは最初の 1 個だけになる。
 */
function markDuplicateProperties() {
  const seen = new Set();

  for (const row of $('template-properties').querySelectorAll('.property-editor')) {
    const name = row.querySelector('.property-name').value.trim();
    const isDuplicate = name !== '' && seen.has(name);
    if (name) seen.add(name);

    let warning = row.querySelector('.duplicate-warning');
    if (!isDuplicate) {
      if (warning) warning.remove();
      continue;
    }

    if (!warning) {
      warning = el('div', 'template-validation duplicate-warning warning is-visible');
      warning.appendChild(createIcon('alert-triangle'));
      warning.appendChild(el('div', 'validation-warning'));
      row.appendChild(warning);
    }
    warning.querySelector('.validation-warning').textContent =
      `プロパティ名「${name}」が重複しています。書き出されるのは上の行だけです。`;
  }
}

function createPropertyRow(property) {
  const row = el('div', 'property-editor');
  row.dataset.id = property.id || generateId();

  const inner = el('div', 'property-row');

  const handle = el('div', 'drag-handle');
  handle.appendChild(createIcon('grip-vertical'));
  attachDragHandle(handle, row);
  inner.appendChild(handle);

  const type = getPropertyTypeEntry(property.name)?.type || 'text';
  const { wrapper, select, setIcon } = createTypeSelect(type);
  inner.appendChild(wrapper);

  const nameInput = el('input', 'property-name');
  nameInput.type = 'text';
  nameInput.value = property.name || '';
  nameInput.placeholder = 'プロパティ名';
  nameInput.setAttribute('list', 'property-name-suggestions');
  nameInput.autocomplete = 'off';
  inner.appendChild(nameInput);

  const valueInput = el('input', 'property-value');
  valueInput.type = 'text';
  valueInput.value = property.value || '';
  valueInput.placeholder = '値（変数が使えます）';
  inner.appendChild(valueInput);

  const remove = iconButton('trash-2', 'remove-property-btn', 'このプロパティを削除');
  remove.addEventListener('click', () => {
    row.remove();
    updateTemplateFromForm();
    renderPropertyTypes();
  });
  inner.appendChild(remove);

  row.appendChild(inner);

  // 型を変えると、そのプロパティ名の型定義そのものが変わる（全テンプレート共通）
  select.addEventListener('change', async () => {
    setIcon(select.value);
    const name = nameInput.value.trim();
    if (name) await upsertPropertyType(name, select.value);
    updateTemplateFromForm();
  });

  // 既知のプロパティ名を入れたら、その型と既定値を引き継ぐ
  nameInput.addEventListener('input', () => {
    const entry = getPropertyTypeEntry(nameInput.value.trim());
    if (!entry) return;
    select.value = entry.type;
    setIcon(entry.type);
    if (entry.defaultValue && !valueInput.value) valueInput.value = entry.defaultValue;
    updateTemplateFromForm();
  });

  nameInput.addEventListener('change', async () => {
    const name = nameInput.value.trim();
    if (name && !getPropertyTypeEntry(name)) await upsertPropertyType(name, select.value);
    updateTemplateFromForm();
  });

  valueInput.addEventListener('input', () => updateTemplateFromForm());
  valueInput.addEventListener('blur', () => validateField(valueInput, row));
  if (property.value) validateField(valueInput, row);

  return row;
}

/** 型定義を変更したとき、開いているプロパティ行のアイコンを追従させる */
function syncPropertyRowTypes() {
  for (const row of $('template-properties').querySelectorAll('.property-editor')) {
    const name = row.querySelector('.property-name').value.trim();
    const type = getPropertyTypeEntry(name)?.type || 'text';
    const select = row.querySelector('select.property-type');
    const selected = row.querySelector('.property-selected');
    select.value = type;
    selected.dataset.value = type;
    selected.textContent = '';
    selected.appendChild(createIcon(getPropertyTypeIcon(type)));
  }
}

/**
 * 変数・フィルタの書き間違いをその場に表示する。
 * @param {HTMLElement} field 対象の入力欄
 * @param {HTMLElement} [appendTo] 表示先（省略時は入力欄の直後）
 */
function validateField(field, appendTo) {
  const validationId = `${field.id || field.className}-validation`;
  // 行には重複警告の枠も付きうるので、値の検証結果は専用クラスで区別する
  let box = appendTo
    ? appendTo.querySelector('.value-validation')
    : document.getElementById(validationId);

  if (!box) {
    box = el('div', 'template-validation value-validation');
    if (!appendTo) box.id = validationId;
    if (appendTo) appendTo.appendChild(box);
    else field.parentNode.insertBefore(box, field.nextSibling);
  }

  box.textContent = '';
  box.className = 'template-validation value-validation';

  const { errors, warnings } = validateTemplateString(field.value, VARIABLE_NAMES);
  if (!errors.length && !warnings.length) return;

  box.classList.add('is-visible', errors.length ? 'invalid' : 'warning');
  box.appendChild(createIcon('alert-triangle'));

  const listNode = el('div', 'validation-errors');
  for (const message of errors) listNode.appendChild(el('div', 'validation-error', message));
  for (const message of warnings) listNode.appendChild(el('div', 'validation-warning', message));
  box.appendChild(listNode);
}

function initializeTemplatesSection() {
  const fields = [
    'template-name',
    'url-patterns',
    'template-behavior',
    'note-name-format',
    'template-path-name',
    'template-pdf-path',
    'template-vault',
    'note-content-format',
  ];

  for (const id of fields) {
    const field = $(id);
    field.addEventListener('input', () => {
      updateTemplateFromForm();
      if (id === 'template-name') renderTemplateList();
    });
    field.addEventListener('change', () => {
      updateTemplateFromForm();
      if (id === 'template-behavior') updateBehaviorDescription();
    });
  }

  for (const id of ['note-name-format', 'template-path-name', 'note-content-format']) {
    $(id).addEventListener('blur', () => validateField($(id)));
  }

  $('add-property-btn').addEventListener('click', () => {
    const container = $('template-properties');
    const row = createPropertyRow({ id: generateId(), name: '', value: '' });
    container.appendChild(row);
    const nameInput = row.querySelector('.property-name');
    nameInput.focus();
    nameInput.addEventListener(
      'blur',
      () => {
        // 名前が入らなかった行は残しても意味がないので消す
        if (!nameInput.value.trim()) row.remove();
        else updateTemplateFromForm();
      },
      { once: true }
    );
  });

  makeSortable($('template-properties'), '.property-editor', () => updateTemplateFromForm());

  makeSortable($('template-list'), 'li', (items) => {
    const order = items.map((item) => item.dataset.id);
    store.templates.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    saveTemplates();
  });

  makeSortable($('vault-list'), 'li', (items) => {
    const order = items.map((item) => Number(item.dataset.index));
    store.settings.vaults = order.map((index) => store.settings.vaults[index]);
    saveSettings().then(renderVaultList).then(renderTemplateVaultOptions);
  });

  $('new-template-btn').addEventListener('click', async () => {
    const template = createDefaultTemplate();
    template.name = uniqueTemplateName('新しいテンプレート');
    template.properties = [];
    store.templates.unshift(template);
    await saveTemplates();
    renderTemplateList();
    showSection('templates', template.id);
    $('template-name').focus();
    $('template-name').select();
  });

  const menu = $('template-actions-menu');
  $('more-actions-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    menu.classList.toggle('show');
  });
  document.addEventListener('click', () => menu.classList.remove('show'));

  $('duplicate-template-btn').addEventListener('click', async () => {
    if (!editingTemplate) return;
    const copy = duplicateTemplate(editingTemplate.id);
    await saveTemplates();
    renderTemplateList();
    showSection('templates', copy.id);
    toast('テンプレートを複製しました');
  });

  $('copy-template-json-btn').addEventListener('click', async () => {
    if (!editingTemplate) return;
    await navigator.clipboard.writeText(JSON.stringify(editingTemplate, null, 2));
    toast('JSON をコピーしました');
  });

  $('delete-template-btn').addEventListener('click', () => {
    if (editingTemplate) deleteTemplate(editingTemplate.id);
  });

  for (const button of document.querySelectorAll('.export-template-btn')) {
    button.addEventListener('click', () => {
      if (!editingTemplate) return;
      downloadJson(editingTemplate, `${editingTemplate.name || 'template'}.json`);
    });
  }

  for (const button of document.querySelectorAll('.import-template-btn')) {
    button.addEventListener('click', () => {
      showImportModal('テンプレートをインポート', async (text) => {
        const data = JSON.parse(text);
        const list = Array.isArray(data) ? data : [data];
        for (const raw of list) {
          if (!raw || typeof raw !== 'object' || !raw.name) {
            throw new Error('テンプレートの JSON ではありません');
          }
          const template = { ...createDefaultTemplate(), ...raw };
          template.id = generateId();
          template.name = uniqueTemplateName(template.name);
          template.properties = (template.properties || []).map((p) => ({ ...p, id: generateId() }));
          store.templates.unshift(template);
        }
        ensurePropertyTypes();
        await saveAll();
        renderTemplateList();
        showSection('templates', store.templates[0].id);
        toast('テンプレートをインポートしました');
      });
    });
  }
}

// ------------------------------------------------------------------ 変数・フィルタ一覧
const FILTER_DESCRIPTIONS = {
  blockquote: '各行の先頭に > を付けて引用にする',
  calc: '四則演算する。例: {{slideCount|calc:"+1"}}',
  callout: 'コールアウトにする。callout:("quote", "見出し", true) で折りたたみ',
  camel: 'camelCase にする',
  capitalize: '先頭の 1 文字を大文字にする',
  date: '日付を整形する。例: date:"YYYY-MM-DD"',
  first: '配列の最初の要素を取り出す',
  image: 'Markdown の画像記法にする',
  join: '配列を連結する。例: join:", "',
  kebab: 'kebab-case にする',
  last: '配列の最後の要素を取り出す',
  length: '文字数・要素数を返す',
  link: 'Markdown のリンク記法にする。例: link:"表示名"',
  list: '配列を箇条書きにする。list:numbered / list:task も使える',
  lower: 'すべて小文字にする',
  nth: '配列から n 番目だけ残す。例: nth:3 / nth:3n / nth:n+3',
  pascal: 'PascalCase にする',
  replace: '置換する。例: replace:"旧":"新"、正規表現は "/re/g" 形式',
  round: '数値を丸める。例: round:2',
  safe_name: 'ファイル名に使えない文字を取り除く',
  slice: '一部を切り出す。例: slice:0,3',
  snake: 'snake_case にする',
  split: '文字列を配列に分ける。例: split:", "',
  title: 'Title Case にする',
  trim: '前後の空白を取り除く',
  uncamel: 'camelCase を空白区切りに戻す',
  unique: '配列の重複を取り除く',
  upper: 'すべて大文字にする',
  wikilink: '[[...]] 記法にする。wikilink:"別名" で別名つき',
};

function renderReference() {
  const variableList = $('variable-reference');
  for (const variable of VARIABLE_DEFINITIONS) {
    const item = el('div', 'reference-item');
    item.appendChild(el('code', null, `{{${variable.name}}}`));
    item.appendChild(el('span', 'reference-description', variable.description));
    item.addEventListener('click', async () => {
      await navigator.clipboard.writeText(`{{${variable.name}}}`);
      toast(`{{${variable.name}}} をコピーしました`);
    });
    variableList.appendChild(item);
  }

  const filterList = $('filter-reference');
  for (const filter of SUPPORTED_FILTERS) {
    const item = el('div', 'reference-item');
    item.appendChild(el('code', null, filter));
    item.appendChild(el('span', 'reference-description', FILTER_DESCRIPTIONS[filter] || ''));
    item.addEventListener('click', async () => {
      await navigator.clipboard.writeText(`|${filter}`);
      toast(`|${filter} をコピーしました`);
    });
    filterList.appendChild(item);
  }
}

// ------------------------------------------------------------------ インポート用モーダル
let importHandler = null;

function showImportModal(title, handler) {
  importHandler = handler;
  const modal = $('import-modal');
  $('import-modal-title').textContent = title;
  modal.querySelector('.import-json-textarea').value = '';
  modal.querySelector('.import-error').hidden = true;
  modal.classList.add('show');
}

function hideImportModal() {
  $('import-modal').classList.remove('show');
  importHandler = null;
}

async function runImport(text) {
  const errorNode = $('import-modal').querySelector('.import-error');
  try {
    await importHandler(text);
    hideImportModal();
  } catch (err) {
    errorNode.textContent = err.message;
    errorNode.hidden = false;
  }
}

function initializeImportModal() {
  const modal = $('import-modal');
  const dropZone = modal.querySelector('.import-drop-zone');
  const textarea = modal.querySelector('.import-json-textarea');

  modal.querySelector('.modal-bg').addEventListener('click', hideImportModal);
  modal.querySelector('.import-cancel-btn').addEventListener('click', hideImportModal);
  modal.querySelector('.import-confirm-btn').addEventListener('click', () => {
    if (!textarea.value.trim()) return;
    runImport(textarea.value);
  });

  dropZone.addEventListener('click', () => {
    const picker = el('input');
    picker.type = 'file';
    picker.accept = '.json,application/json';
    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      if (file) runImport(await file.text());
    });
    picker.click();
  });

  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', async (event) => {
    event.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = event.dataTransfer.files[0];
    if (file) runImport(await file.text());
  });
}

// ------------------------------------------------------------------ 起動
async function initialize() {
  await loadAll();
  initializeIcons(document);

  initializeGeneralSection();
  initializeAnalysisSection();
  initializeOutputSection();
  initializePropertiesSection();
  initializeTemplatesSection();
  initializeImportModal();
  renderReference();
  refreshPropertyNameSuggestions();
  renderTemplateList();

  for (const item of document.querySelectorAll('#sidebar li[data-section]')) {
    item.addEventListener('click', () => showSection(item.dataset.section));
  }
  $('settings-sidebar-title').addEventListener('click', () => showSection('general'));
  $('hamburger-menu').addEventListener('click', () => $('settings').classList.toggle('sidebar-open'));

  window.addEventListener('hashchange', applyHashRoute);
  applyHashRoute();
}

initialize().catch((err) => {
  console.error(err);
  toast(`設定の読み込みに失敗しました: ${err.message}`, 'error');
});
