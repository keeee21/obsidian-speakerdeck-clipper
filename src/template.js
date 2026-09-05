/**
 * src/template.js
 *
 * `{{variable|filter:"param"}}` 記法の展開と、フロントマターの生成。
 *
 * 変数は左から右へフィルタに通す。フィルタは文字列だけでなく配列も扱えるため、
 * `split` で配列にしてから `wikilink` → `join` のように連結できる。
 */

// ------------------------------------------------------------------ 変数の定義
/** ポップアップで使える変数と、設定画面のヘルプに出す説明 */
export const VARIABLE_DEFINITIONS = [
  { name: 'title', description: 'スライドのタイトル' },
  { name: 'author', description: '発表者名' },
  { name: 'url', description: 'スライドの URL' },
  { name: 'domain', description: 'ドメイン（speakerdeck.com）' },
  { name: 'description', description: '概要欄のテキスト' },
  { name: 'published', description: '公開日（date フィルタで整形可）' },
  { name: 'date', description: '今日の日付' },
  { name: 'time', description: '現在の日時（ISO 8601）' },
  { name: 'pdfUrl', description: 'PDF の URL' },
  { name: 'deckId', description: 'Speaker Deck の内部 ID' },
  { name: 'thumbnail', description: 'サムネイル画像の URL' },
  { name: 'noteName', description: '生成されるノート名' },
  { name: 'slideCount', description: 'ページ数（解析後に確定）' },
  { name: 'ocrCount', description: 'OCR を通したページ数' },
  { name: 'textCount', description: 'テキスト抽出できたページ数' },
  { name: 'slides', description: '全スライドの Markdown（埋め込み + 抽出テキスト）' },
  { name: 'content', description: '{{slides}} と同じ' },
  { name: 'allText', description: '全ページの抽出テキストを連結したもの' },
  { name: 'firstText', description: '1 ページ目の抽出テキスト' },
  { name: 'pdfLink', description: 'PDF への Obsidian 埋め込みリンク' },
];

export const VARIABLE_NAMES = VARIABLE_DEFINITIONS.map((v) => v.name);

/** 使えるフィルタ名。テンプレート検証で未知のフィルタを弾くのにも使う。 */
export const SUPPORTED_FILTERS = [
  'blockquote', 'calc', 'callout', 'camel', 'capitalize', 'date', 'first', 'image', 'join',
  'kebab', 'last', 'length', 'link', 'list', 'lower', 'nth', 'pascal', 'replace', 'round',
  'safe_name', 'slice', 'snake', 'split', 'title', 'trim', 'uncamel', 'unique', 'upper',
  'wikilink',
];

/**
 * HTML 処理やオブジェクト操作を伴うフィルタ。
 * この拡張が扱うのは PDF から取り出した平文だけなので実装していない。
 * 名前を知っていれば「未知のフィルタ」ではなく理由つきの警告を出せる。
 */
const UNSUPPORTED_FILTERS = [
  'date_modify', 'duration', 'decode_uri', 'footnote', 'fragment_link', 'html_to_json', 'map',
  'markdown', 'merge', 'object', 'remove_attr', 'remove_html', 'remove_tags', 'replace_tags',
  'strip_attr', 'strip_md', 'strip_tags', 'table', 'template',
];

// ------------------------------------------------------------------ 小物
/**
 * ファイル名の長さ上限（UTF-8 バイト）。
 * 主要なファイルシステムはファイル名 1 要素あたり 255 バイトまでなので、
 * 拡張子（.md / .pdf）と同名回避の連番ぶんを引いた値にしている。
 * 日本語は 1 文字 3 バイトなので、この上限は約 80 文字に相当する。
 */
const MAX_FILE_NAME_BYTES = 240;

const encoder = new TextEncoder();

/** UTF-8 バイト数で切り詰める。単語の途中で切れないよう、直前の空白まで戻す。 */
function truncateByBytes(text, maxBytes) {
  if (encoder.encode(text).length <= maxBytes) return text;

  let truncated = '';
  let bytes = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > maxBytes) break;
    truncated += char;
    bytes += size;
  }

  // 単語の途中で切れている場合だけ空白まで戻す。
  // 大きく削れてしまうときは戻さない（日本語のように空白が無い文でも短くなりすぎない）。
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > truncated.length * 0.6) truncated = truncated.slice(0, lastSpace);

  return truncated.replace(/[\s.\-_]+$/, '');
}

export function sanitizeFileName(name) {
  const cleaned = String(name || '')
    // Obsidian で使えない文字と、OS 共通で避けたい文字を落とす
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return truncateByBytes(cleaned, MAX_FILE_NAME_BYTES) || 'untitled';
}

/** 相対パスとして安全な形に整える（先頭 / と .. を落とす） */
export function sanitizeFolder(folder) {
  return String(folder || '')
    .split('/')
    .map((seg) => seg.replace(/[\\:*?"<>|]/g, ' ').replace(/^\.+$/, '').trim())
    .filter(Boolean)
    .join('/');
}

export function joinPath(folder, file) {
  const dir = sanitizeFolder(folder);
  return dir ? `${dir}/${file}` : file;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n) => String(n).padStart(2, '0');

export function formatDate(value, format = 'YYYY-MM-DD') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? '');

  const tokens = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MMMM: MONTHS[date.getMonth()],
    MMM: MONTHS[date.getMonth()].slice(0, 3),
    MM: pad(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    DD: pad(date.getDate()),
    D: String(date.getDate()),
    dddd: DAYS[date.getDay()],
    ddd: DAYS[date.getDay()].slice(0, 3),
    HH: pad(date.getHours()),
    H: String(date.getHours()),
    mm: pad(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: pad(date.getSeconds()),
    s: String(date.getSeconds()),
  };

  return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|mm|m|ss|s/g, (match, literal) =>
    literal !== undefined ? literal : tokens[match]
  );
}

// ------------------------------------------------------------------ フィルタ
const toArray = (value) => (Array.isArray(value) ? value : [value]);
const toText = (value) => (Array.isArray(value) ? value.join(', ') : String(value ?? ''));

/** `("a", "b")` / `"a"` / `1,3` のいずれの形でもパラメータを配列に開く */
function parseParams(param) {
  if (param === undefined || param === '') return [];
  let body = param.trim();
  if (body.startsWith('(') && body.endsWith(')')) body = body.slice(1, -1);
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\' && i + 1 < body.length) {
        current += unescapeChar(body[i + 1]);
        i += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',' || ch === ':') {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

function unescapeChar(ch) {
  if (ch === 'n') return '\n';
  if (ch === 't') return '\t';
  return ch;
}

/** `"/re/gi"` 形式なら RegExp を返す */
function toRegExp(pattern) {
  const match = /^\/(.*)\/([gimsuy]*)$/.exec(pattern);
  if (!match) return null;
  try {
    return new RegExp(match[1], match[2]);
  } catch (_) {
    return null;
  }
}

const FILTERS = {
  upper: (v) => toText(v).toUpperCase(),
  lower: (v) => toText(v).toLowerCase(),
  trim: (v) => toText(v).trim(),
  capitalize: (v) => {
    const s = toText(v);
    return s.charAt(0).toUpperCase() + s.slice(1);
  },
  title: (v) =>
    toText(v).replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()),
  uncamel: (v) => toText(v).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase(),
  camel: (v) => {
    const words = toText(v).split(/[\s\-_]+/).filter(Boolean);
    return words
      .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
      .join('');
  },
  pascal: (v) =>
    toText(v)
      .split(/[\s\-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(''),
  kebab: (v) => toText(v).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase(),
  snake: (v) => toText(v).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase(),
  safe_name: (v) => sanitizeFileName(toText(v)),

  replace: (v, param) => {
    const params = parseParams(param);
    let text = toText(v);
    for (let i = 0; i + 1 < params.length; i += 2) {
      const re = toRegExp(params[i]);
      if (re) text = text.replace(re, params[i + 1]);
      else text = text.split(params[i]).join(params[i + 1]);
    }
    return text;
  },

  split: (v, param) => {
    const text = toText(v);
    if (param === undefined || param === '') return text.split('');
    const [separator] = parseParams(param);
    const re = toRegExp(separator);
    return re ? text.split(re) : text.split(separator);
  },
  join: (v, param) => {
    const [separator] = parseParams(param);
    return toArray(v).join(separator === undefined ? ',' : separator);
  },
  first: (v) => (Array.isArray(v) ? String(v[0] ?? '') : v),
  last: (v) => (Array.isArray(v) ? String(v[v.length - 1] ?? '') : v),
  unique: (v) => (Array.isArray(v) ? [...new Set(v)] : v),
  length: (v) => String(Array.isArray(v) ? v.length : toText(v).length),
  slice: (v, param) => {
    const params = parseParams(param).filter((p) => p !== '');
    const start = params.length ? Number(params[0]) : 0;
    const end = params.length > 1 ? Number(params[1]) : undefined;
    return Array.isArray(v) ? v.slice(start, end) : toText(v).slice(start, end);
  },
  nth: (v, param) => {
    if (!Array.isArray(v)) return v;
    const spec = (parseParams(param)[0] || '').trim();
    const everyN = /^(\d+)n$/.exec(spec);
    if (everyN) {
      const step = Number(everyN[1]);
      return v.filter((_, i) => (i + 1) % step === 0);
    }
    const fromN = /^n\+(\d+)$/.exec(spec);
    if (fromN) return v.slice(Number(fromN[1]) - 1);
    const index = Number(spec);
    return Number.isFinite(index) ? [v[index - 1]].filter((x) => x !== undefined) : v;
  },

  round: (v, param) => {
    const num = parseFloat(toText(v));
    if (Number.isNaN(num)) return toText(v);
    const digits = Number(parseParams(param)[0] || 0);
    return String(Number(num.toFixed(digits)));
  },
  calc: (v, param) => {
    const num = parseFloat(toText(v));
    if (Number.isNaN(num)) return toText(v);
    const expr = (parseParams(param)[0] || '').replace(/\s+/g, '').replace('^', '**');
    const match = /^(\*\*|[+\-*/])(-?\d+(?:\.\d+)?)$/.exec(expr);
    if (!match) return String(num);
    const operand = Number(match[2]);
    switch (match[1]) {
      case '+': return String(num + operand);
      case '-': return String(num - operand);
      case '*': return String(num * operand);
      case '/': return operand === 0 ? String(num) : String(num / operand);
      case '**': return String(num ** operand);
      default: return String(num);
    }
  },

  date: (v, param) => {
    const [outputFormat] = parseParams(param);
    return formatDate(toText(v), outputFormat || 'YYYY-MM-DD');
  },

  list: (v, param) => {
    const style = (parseParams(param)[0] || '').trim();
    const items = toArray(v).map((item) => String(item ?? '')).filter((item) => item !== '');
    return items
      .map((item, i) => {
        switch (style) {
          case 'numbered': return `${i + 1}. ${item}`;
          case 'task': return `- [ ] ${item}`;
          case 'numbered-task': return `${i + 1}. [ ] ${item}`;
          default: return `- ${item}`;
        }
      })
      .join('\n');
  },
  blockquote: (v) =>
    toText(v)
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
  callout: (v, param) => {
    const [type = 'info', calloutTitle = '', foldState = ''] = parseParams(param);
    const fold = foldState === 'true' ? '-' : foldState === 'false' ? '+' : '';
    const head = `> [!${type || 'info'}]${fold}${calloutTitle ? ` ${calloutTitle}` : ''}`;
    const body = toText(v)
      .split('\n')
      .map((line) => (line.trim() ? `> ${line}` : '>'))
      .join('\n');
    return `${head}\n${body}`;
  },
  wikilink: (v, param) => {
    const [alias] = parseParams(param);
    const wrap = (item) => (alias ? `[[${item}|${alias}]]` : `[[${item}]]`);
    return Array.isArray(v) ? v.map((item) => wrap(String(item))) : wrap(toText(v));
  },
  link: (v, param) => {
    const [text] = parseParams(param);
    const wrap = (item) => `[${text || item}](${item})`;
    return Array.isArray(v) ? v.map((item) => wrap(String(item))) : wrap(toText(v));
  },
  image: (v, param) => {
    const [alt] = parseParams(param);
    const wrap = (item) => `![${alt || ''}](${item})`;
    return Array.isArray(v) ? v.map((item) => wrap(String(item))) : wrap(toText(v));
  },
};

/** `name:param` の形をしたフィルタ 1 個を適用する */
function applyFilter(value, expression) {
  const separatorIndex = expression.indexOf(':');
  const name = (separatorIndex === -1 ? expression : expression.slice(0, separatorIndex)).trim();
  const param = separatorIndex === -1 ? undefined : expression.slice(separatorIndex + 1).trim();
  const filter = FILTERS[name];
  if (!filter) return value;
  try {
    return filter(value, param);
  } catch (err) {
    console.warn(`フィルタ ${name} の適用に失敗しました`, err);
    return value;
  }
}

/** `|` で区切る。ただし引用符・括弧の中の `|` は区切りにしない。 */
function splitPipes(expression) {
  const parts = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < expression.length) {
        current += expression[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '(') {
      depth += 1;
      current += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === '|' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim());
}

// ------------------------------------------------------------------ 展開
/**
 * `{{ ... }}` を変数の値で置き換える。
 * @param {string} text テンプレート文字列
 * @param {Record<string, any>} variables 変数名 → 値
 */
export function renderTemplate(text, variables) {
  if (!text) return '';
  return String(text).replace(/\{\{([\s\S]*?)\}\}/g, (match, expression) => {
    const parts = splitPipes(expression);
    const head = parts.shift();
    let value = resolveVariable(head, variables);
    for (const filterExpression of parts) {
      if (filterExpression) value = applyFilter(value, filterExpression);
    }
    return toText(value);
  });
}

function resolveVariable(token, variables) {
  const trimmed = token.trim();
  // "..." はそのまま値として扱う（フィルタだけを試したいときに使える）
  if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) return trimmed.slice(1, -1);
  if (Object.prototype.hasOwnProperty.call(variables, trimmed)) {
    const value = variables[trimmed];
    return value === undefined || value === null ? '' : value;
  }
  return '';
}

// ------------------------------------------------------------------ 検証
/**
 * テンプレート文字列の変数名 / フィルタ名を検証する。
 * 構文の破綻は errors、名前の間違いは warnings に分ける。
 * warnings は空文字に展開されるだけで動作はするため、保存を妨げない。
 */
export function validateTemplateString(text, knownVariables = VARIABLE_NAMES) {
  const errors = [];
  const warnings = [];
  if (!text) return { errors, warnings };

  const opens = (text.match(/\{\{/g) || []).length;
  const closes = (text.match(/\}\}/g) || []).length;
  if (opens !== closes) {
    errors.push(`{{ と }} の数が合っていません（{{ が ${opens} 個、}} が ${closes} 個）`);
  }

  const pattern = /\{\{([\s\S]*?)\}\}/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const parts = splitPipes(match[1]);
    const head = (parts.shift() || '').trim();
    const isLiteral = /^".*"$/.test(head) || /^'.*'$/.test(head);
    if (!head) {
      errors.push('空の変数（{{}}）があります');
    } else if (!isLiteral && !knownVariables.includes(head)) {
      warnings.push(`未知の変数: {{${head}}}`);
    }
    for (const filterExpression of parts) {
      const name = filterExpression.split(':')[0].trim();
      if (!name) continue;
      if (UNSUPPORTED_FILTERS.includes(name)) {
        warnings.push(`フィルタ ${name} はこの拡張では未対応です（HTML / オブジェクト向けのため）`);
      } else if (!SUPPORTED_FILTERS.includes(name)) {
        warnings.push(`未知のフィルタ: ${name}`);
      }
    }
  }

  return { errors, warnings };
}

// ------------------------------------------------------------------ フロントマター
const escapeDoubleQuotes = (str) => String(str).replace(/"/g, '\\"');

/**
 * プロパティ配列 + 型マップから YAML フロントマターを作る。
 * 型ごとに書き方が変わる: multitext は `- "値"` のリスト、number は裸の数値、
 * checkbox は true/false、date/datetime は引用符なし、それ以外は引用符つき文字列。
 */
export function generateFrontmatter(properties, propertyTypes = {}) {
  let frontmatter = '---\n';
  // YAML は同じキーを 2 回書けない（書くとパースに失敗する）ので、
  // 同名のプロパティは最初の 1 個だけを出力する。
  const written = new Set();

  for (const property of properties) {
    const trimmedName = String(property.name || '').trim();
    if (!trimmedName || written.has(trimmedName)) continue;
    written.add(trimmedName);

    const needsQuotes =
      /[:\s{}[\],&*#?|<>=!%@\\-]/.test(trimmedName) ||
      /^\d/.test(trimmedName) ||
      /^(true|false|null|yes|no|on|off)$/i.test(trimmedName);
    const key = needsQuotes
      ? trimmedName.includes('"')
        ? `'${trimmedName.replace(/'/g, "''")}'`
        : `"${trimmedName}"`
      : trimmedName;

    frontmatter += `${key}:`;

    const type = propertyTypes[trimmedName] || 'text';
    const rawValue = property.value;

    switch (type) {
      case 'multitext': {
        let items;
        const text = String(rawValue ?? '').trim();
        if (text.startsWith('["') && text.endsWith('"]')) {
          try {
            items = JSON.parse(text);
          } catch (_) {
            items = text.split(',').map((item) => item.trim());
          }
        } else {
          // [[...]] リンク内のカンマで項目が割れないようにする
          items = text.split(/,(?![^[]*\]\])/).map((item) => item.trim());
        }
        items = items.filter((item) => item !== '');
        frontmatter += '\n';
        for (const item of items) frontmatter += `  - "${escapeDoubleQuotes(item)}"\n`;
        break;
      }
      case 'number': {
        const numeric = String(rawValue ?? '').replace(/[^\d.-]/g, '');
        frontmatter += numeric ? ` ${parseFloat(numeric)}\n` : '\n';
        break;
      }
      case 'checkbox': {
        const checked = typeof rawValue === 'boolean' ? rawValue : String(rawValue) === 'true';
        frontmatter += ` ${checked}\n`;
        break;
      }
      case 'date':
      case 'datetime':
        frontmatter += String(rawValue ?? '').trim() !== '' ? ` ${String(rawValue).trim()}\n` : '\n';
        break;
      default:
        frontmatter += String(rawValue ?? '').trim() !== ''
          ? ` "${escapeDoubleQuotes(String(rawValue).trim())}"\n`
          : '\n';
    }
  }

  frontmatter += '---\n';
  return frontmatter;
}
