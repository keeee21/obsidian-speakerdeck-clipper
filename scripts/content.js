/**
 * scripts/content.js
 *
 * Speaker Deck のスライドページから、タイトル / 著者 / 投稿日 / 概要 / PDF URL を取り出す。
 *
 * chrome.scripting.executeScript({ files: ['scripts/content.js'] }) で注入され、
 * 最後の式の評価値が InjectionResult.result として popup 側へ返る。
 *
 * セレクタは実際の Speaker Deck の DOM（2026 年時点）に合わせているが、
 * マークアップ変更に備えて各項目は複数の取得手段をフォールバックで試す。
 */
(() => {
  'use strict';

  const text = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const attr = (sel, name) => {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute(name) || '').trim() : '';
  };
  const metaProp = (property) => attr(`meta[property="${property}"]`, 'content');
  const metaName = (name) => attr(`meta[name="${name}"]`, 'content');

  const firstNonEmpty = (...values) => {
    for (const v of values) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  /** ページ全体の HTML。正規表現によるフォールバック探索用。 */
  const rawHtml = () => {
    try {
      return document.documentElement.outerHTML || '';
    } catch (_) {
      return '';
    }
  };

  // ---------------------------------------------------------------- JSON-LD
  const jsonLd = (() => {
    const out = [];
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(node.textContent);
        out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch (_) {
        /* 壊れた JSON-LD は無視 */
      }
    }
    return out;
  })();

  const fromJsonLd = (key) => {
    for (const obj of jsonLd) {
      const v = obj && obj[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object') {
        if (typeof v.name === 'string' && v.name.trim()) return v.name.trim();
        if (typeof v.url === 'string' && v.url.trim()) return v.url.trim();
      }
    }
    return '';
  };

  // ---------------------------------------------------------------- title
  const cleanTitle = (t) =>
    t
      .replace(/\s*[|｜]\s*Speaker Deck\s*$/i, '')
      .replace(/\s+-\s+Speaker Deck\s*$/i, '')
      .trim();

  const title = cleanTitle(
    firstNonEmpty(
      metaProp('og:title'),
      metaName('twitter:title'),
      attr('.speakerdeck-embed', 'data-name'),
      fromJsonLd('name'),
      fromJsonLd('headline'),
      text(document.querySelector('h1')),
      document.title
    )
  );

  // ---------------------------------------------------------------- author
  // twitter:creator は常に @speakerdeck なので使わない。
  const authorFromUrlPath = () => {
    const m = location.pathname.match(/^\/([^/]+)\/[^/]+/);
    return m ? m[1] : '';
  };

  const author = firstNonEmpty(
    metaProp('og:author'),
    metaName('twitter:data1'), // "Deck by" のラベルに対応する値
    text(document.querySelector('.deck-meta a[href^="/"] span:last-child')),
    text(document.querySelector('[itemprop="author"] [itemprop="name"]')),
    fromJsonLd('author'),
    authorFromUrlPath()
  );

  // ---------------------------------------------------------------- date
  const timeEl = document.querySelector('time[datetime], time');
  const publishedAt = firstNonEmpty(
    metaProp('article:published_time'),
    fromJsonLd('datePublished'),
    timeEl ? timeEl.getAttribute('datetime') || text(timeEl) : '',
    text(document.querySelector('.deck-date')) // 例: "August 06, 2026"
  );

  // ---------------------------------------------------------------- description
  /** .deck-description は <p> の集合。段落の区切りを保ったまま取り出す。 */
  const descriptionFromDom = () => {
    const root = document.querySelector('.deck-description') || document.querySelector('[itemprop="description"]');
    if (!root) return '';
    const paragraphs = [...root.querySelectorAll('p')]
      .map((p) => (p.textContent || '').trim())
      .filter(Boolean);
    if (paragraphs.length) return paragraphs.join('\n\n');
    return (root.textContent || '').trim();
  };

  const description = firstNonEmpty(
    descriptionFromDom(),
    metaProp('og:description'),
    metaName('description'),
    // twitter:description は末尾が省略される（&hellip;）ため最後の手段
    metaName('twitter:description'),
    fromJsonLd('description')
  );

  // ---------------------------------------------------------------- deck id
  const deckId = firstNonEmpty(
    attr('.speakerdeck-embed', 'data-id'),
    (rawHtml().match(/speakerdeck\.com\/player\/([0-9a-f]{16,})/i) || [])[1] || ''
  );

  // ---------------------------------------------------------------- PDF URL
  const normalize = (href) => {
    if (!href) return '';
    try {
      return new URL(href, location.href).href;
    } catch (_) {
      return '';
    }
  };

  const isPdf = (href) => /\.pdf(\?|#|$)/i.test(href);

  const findPdfUrl = () => {
    // 1. download 属性つきアンカー
    for (const a of document.querySelectorAll('a[download]')) {
      const href = normalize(a.getAttribute('href'));
      if (isPdf(href)) return href;
    }
    // 2. title="Download PDF" のアンカー（現行 Speaker Deck のダウンロードボタン）
    for (const a of document.querySelectorAll('a[title]')) {
      if (!/download/i.test(a.getAttribute('title') || '')) continue;
      const href = normalize(a.getAttribute('href'));
      if (isPdf(href) || /files\.speakerdeck\.com/i.test(href)) return href;
    }
    // 3. deckId が一致する .pdf アンカーを優先しつつ、拡張子 .pdf のアンカーを走査
    let fallback = '';
    for (const a of document.querySelectorAll('a[href]')) {
      const href = normalize(a.getAttribute('href'));
      if (!isPdf(href)) continue;
      if (deckId && href.includes(deckId)) return href;
      if (!fallback) fallback = href;
    }
    if (fallback) return fallback;

    // 4. HTML 全体から files.speakerdeck.com の PDF を正規表現で探す
    const html = rawHtml();
    const matches = html.match(/https?:\/\/files\.speakerdeck\.com\/[^\s"'<>\\)]+?\.pdf/gi) || [];
    const unescape = (s) => s.replace(/&amp;/g, '&').replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    if (deckId) {
      const hit = matches.find((m) => m.includes(deckId));
      if (hit) return unescape(hit);
    }
    return matches.length ? unescape(matches[0]) : '';
  };

  const pdfUrl = findPdfUrl();

  // ---------------------------------------------------------------- slide count
  // ページ下部の .deck-preview は「関連スライド」なので枚数の根拠にならない。
  // 自分の deckId を持つカードがある場合のみ data-slide-count を採用する。
  const slideCountGuess = (() => {
    if (deckId) {
      const own = document.querySelector(`[data-id="${deckId}"][data-slide-count]`);
      if (own) return Number(own.getAttribute('data-slide-count')) || 0;
    }
    const m = rawHtml().match(/"slide_?count"\s*:\s*(\d+)/i);
    return m ? Number(m[1]) : 0;
  })();

  return {
    ok: Boolean(title),
    url: location.href.split('#')[0],
    title,
    author,
    publishedAt,
    description,
    deckId,
    pdfUrl,
    slideCountGuess,
    thumbnail: metaProp('og:image'),
  };
})();
