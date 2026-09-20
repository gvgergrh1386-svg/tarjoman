/**
 * DOM layer: selectors, tweet-text extraction, and language gating.
 *
 * Extraction walks the tweet-text element and produces:
 *  - text:         plain text where links become ⟦n⟧ placeholder tokens and
 *                  mentions/hashtags/cashtags/emojis stay inline (the model
 *                  needs them for context and is instructed to preserve them)
 *  - placeholders: [{token, node}] original anchor nodes for the ⟦n⟧ tokens
 *  - inline:       [{text, node}] mention/hashtag/cashtag anchors, re-linkified
 *                  after translation by string match
 *  - emoji:        Map<altText, imgNode> so Twitter-style emoji images can be
 *                  restored in the translated output
 */
'use strict';
(() => {
  globalThis.GXT = globalThis.GXT || {};

  const SEL = {
    tweetText: 'div[data-testid="tweetText"]',
    bio: 'div[data-testid="UserDescription"]',
    candidates: 'div[data-testid="tweetText"], div[data-testid="UserDescription"]',
    // v1.8 (experimental, settings.xExtraZones): Community Notes and Articles.
    extraZones:
      'div[data-testid="birdwatch-pivot"], div[data-testid="longformRichTextComponent"]',
    userName: 'div[data-testid="User-Name"]',
    cell: 'div[data-testid="cellInnerDiv"]',
    // X's "Show more" link that expands a truncated long post's TEXT (distinct
    // from "Show this thread" / "Show more replies", which have other testids).
    showMore: '[data-testid="tweet-text-show-more-link"]',
  };

  /** Candidate selector honoring the experimental extra-zones toggle. */
  function candidatesFor(settings) {
    return settings?.xExtraZones ? `${SEL.candidates}, ${SEL.extraZones}` : SEL.candidates;
  }

  /**
   * The "Show more" control that expands THIS tweet-text element, or null.
   * The link sits right after the text, so we look inside the element and walk
   * up at most two ancestors — stopping before the cell so a quoted tweet's own
   * "Show more" is never returned for the outer post. Best-effort: if X renames
   * the testid the caller simply finds nothing and the post translates as-is.
   */
  function findShowMore(el) {
    if (!el) return null;
    if (el.matches?.(SEL.showMore)) return el;
    const inside = el.querySelector?.(SEL.showMore);
    if (inside) return inside;
    let node = el.parentElement;
    for (let i = 0; i < 3 && node; i += 1) {
      for (const found of node.querySelectorAll?.(SEL.showMore) || []) {
        // A quote can have its own control inside the same article/cell.
        // Its nearest text-bearing scope identifies which post it expands.
        let owner = found.parentElement;
        while (owner && !owner.querySelector(SEL.tweetText)) owner = owner.parentElement;
        if (owner?.querySelector(SEL.tweetText) === el) return found;
      }
      // Search up to and INCLUDING the post's cell (the link commonly sits a
      // few levels above the text), but never cross above it into other posts.
      if (node.matches?.(`${SEL.cell}, article`)) break;
      node = node.parentElement;
    }
    return null;
  }

  const PLACEHOLDER_RE = /⟦\d+⟧/g;
  const ARABIC_SCRIPT_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
  /** Letters/marks that identify Persian (vs Arabic/other Arabic-script). */
  const PERSIAN_MARKER_RE = /[پچژگی]|‌/;
  /** Arabic-script languages that SHOULD still be translated when declared. */
  const ARABIC_SCRIPT_LANGS = new Set(['ar', 'ur', 'ps', 'sd', 'ckb', 'pnb', 'ug']);

  function extract(el) {
    const parts = [];
    const placeholders = [];
    const inline = [];
    const emoji = new Map();
    let phIndex = 0;
    const literalTokens = new Set((el.textContent || '').match(PLACEHOLDER_RE) || []);

    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          parts.push(child.nodeValue);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.matches(SEL.showMore)) continue;
        const tag = child.tagName;
        if (tag === 'IMG') {
          const alt = child.getAttribute('alt') || '';
          if (alt) {
            parts.push(alt);
            if (!emoji.has(alt)) emoji.set(alt, child);
          }
        } else if (tag === 'A') {
          const trimmed = (child.textContent || '').trim();
          if (/^[@#$]/.test(trimmed)) {
            parts.push(child.textContent);
            inline.push({ text: trimmed, node: child });
          } else {
            while (literalTokens.has(`⟦${phIndex}⟧`)) phIndex += 1;
            const token = `⟦${phIndex}⟧`;
            phIndex += 1;
            parts.push(token);
            placeholders.push({ token, node: child });
          }
        } else if (tag === 'BR') {
          parts.push('\n');
        } else {
          walk(child);
        }
      }
    };
    walk(el);

    return { text: parts.join(''), placeholders, inline, emoji };
  }

  /** Cheap change signature, used to detect in-place text swaps
   *  ("Show more" expansion, Grok translation toggling, …). */
  function signature(el) {
    const data = extract(el);
    // React reuses nodes for equal-length posts and can change only a link or
    // emoji. The first 32 characters are not an identity for those updates.
    return JSON.stringify([
      getLang(el), data.text,
      data.placeholders.map(({ node }) => [node.getAttribute('href'), node.textContent]),
      data.inline.map(({ text, node }) => [text, node.getAttribute('href')]),
      [...data.emoji].map(([alt, node]) => [alt, node.getAttribute('src')]),
    ]);
  }

  /**
   * The element's own lang attribute only. Deliberately NOT the closest
   * [lang] ancestor: that would pick up X's UI language (html[lang]) and
   * mislabel tweets that lack their own attribute.
   */
  function getLang(el) {
    return (el.getAttribute('lang') || '').trim().toLowerCase().split(/[-_]/)[0];
  }

  function shouldTranslate(text, lang, targetLang = 'fa') {
    if(targetLang !== 'fa') {
      const letters = String(text || '').match(/\p{L}/gu) || [];
      return letters.length >= 2 && (String(lang).split('-')[0] !== String(targetLang).split('-')[0]);
    }
    lang = String(lang || '').trim().toLowerCase().split(/[-_]/)[0];
    if (!text || !text.trim()) return false;
    if (lang === 'fa') return false;
    const cleaned = text
      .replace(PLACEHOLDER_RE, ' ')
      .replace(/[@#$][\p{L}\p{N}_]+/gu, ' ')
      .replace(/https?:\/\/\S+/g, ' ');
    const letters = cleaned.match(/\p{L}/gu) || [];
    if (letters.length < 2) return false;

    const arabic = letters.filter((ch) => ARABIC_SCRIPT_RE.test(ch)).length;
    if (arabic / letters.length > 0.5) {
      // Explicitly-declared Arabic-script languages (Arabic, Urdu, …) do get
      // translated into Persian.
      if (ARABIC_SCRIPT_LANGS.has(lang)) return true;
      // Persian-specific letters/ZWNJ mean the visible text is already
      // Persian — e.g. Grok's auto-translation is being shown while the
      // lang attribute still says "en". Never re-translate Persian.
      if (PERSIAN_MARKER_RE.test(cleaned)) return false;
      // Unknown Arabic-script text may be Arabic or Urdu. Let the provider
      // detect it instead of treating the script itself as a language.
    }
    return true;
  }

  function getArticle(el) {
    return el.closest('article');
  }

  // A status permalink belongs to the post, while location.pathname and the
  // preceding conversation cell belong only to the current view. Quote cards
  // must be resolved before the enclosing article's own permalink.
  function contentIdentity(el) {
    const article = getArticle(el);
    if (article) {
      for (let scope = el.parentElement; scope; scope = scope.parentElement) {
          const links = [...scope.querySelectorAll('a[href*="/status/"]')].filter(a=>{
            if(a.closest(SEL.tweetText))return false;
            // A quote's timestamp can be nearer to the outer text than the
            // outer header. Resolve the link's own card before using its ID.
            for(let owner=a;owner;owner=owner.parentElement){
              const texts=[...owner.querySelectorAll(SEL.tweetText)];
              if(texts.length)return texts.includes(el);
              if(owner===article)break;
            }
            return false;
          });
          const own = links.find(a => a.querySelector('time')) || links.find(a => !a.closest(SEL.tweetText));
          const id = own?.getAttribute('href')?.match(/\/status\/(\d+)(?:[/?#]|$)/)?.[1];
          if (id) return `x:${id}`;
        if (scope === article) break;
      }
    }
    // No reliable permalink (bios, extra zones, incomplete virtualized cards):
    // a content identity, never an index, parent context or current page URL.
    const author=getAuthor(el);const handle=author.match(/@[\w.]+/)?.[0]||author;
    const quoted=article?.querySelectorAll(SEL.tweetText);
    return JSON.stringify(['text',handle,quoted?.[0]===el&&quoted.length>1?(quoted[1].textContent||'').trim():'']);
  }

  function cacheSource(el, extraction = extract(el)) {
    return JSON.stringify([contentIdentity(el), extraction.text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim(),
      extraction.placeholders.map(({node}) => node.getAttribute('href') || node.textContent)]);
  }

  /**
   * Best-effort author identity for translation context: the display name
   * plus @handle when both are available ("Elon Musk (@elonmusk)"), which
   * signals register/tone (a news org vs. an individual) far better than the
   * handle alone. Falls back to whichever piece is present.
   */
  function getAuthor(el) {
    try {
      const article = getArticle(el);
      let scope = el.parentElement;
      while (scope && scope !== article && !scope.querySelector(SEL.userName)) {
        scope = scope.parentElement;
      }
      const nameEl = scope?.querySelector(SEL.userName);
      const raw = nameEl?.textContent || '';
      const handle = /@[\w.]+/.exec(raw)?.[0] || '';
      // The display name is the text before the handle, minus the trailing
      // "· 5h" timestamp X appends inside the same element.
      let name = (handle ? raw.slice(0, raw.indexOf(handle)) : raw)
        .replace(/[·•].*$/s, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
      if (name && handle) return `${name} (${handle})`;
      return handle || name || '';
    } catch {
      return '';
    }
  }

  /**
   * Smallest ancestor of `textEl` that carries an author (User-Name) but does
   * NOT contain `exclude` — i.e. the quoted tweet's own card, so its author is
   * read instead of the enclosing post's. Null if none qualifies.
   */
  function nearestAuthorScope(textEl, exclude) {
    let node = textEl.parentElement;
    while (node) {
      if (!node.contains(exclude) && node.querySelector(SEL.userName)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /** Compact "@handle: text" label for a context (quoted/parent) tweet. */
  function contextTweetLabel(scopeEl, textEl) {
    const handle = /@[\w.]+/.exec(scopeEl?.querySelector(SEL.userName)?.textContent || '')?.[0] || '';
    const text = (textEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    if (!text) return '';
    return handle ? `${handle}: ${text}` : text;
  }

  /**
   * Surrounding tweet(s) that `el` refers to, so the model can resolve
   * ambiguous references — best-effort, disambiguation-only:
   *  - Quoted tweet: a second tweetText inside the SAME article.
   *  - Reply parent: on a conversation (/status/) page, the previous tweet in
   *    the thread column. Gated to /status/ so unrelated adjacent posts on the
   *    home timeline are never mistaken for a parent.
   * Returns a single string; empty when nothing reliable is found.
   */
  function getContext(el) {
    const parts = [];
    try {
      const article = getArticle(el);
      if (!article) return '';
      const texts = article.querySelectorAll(SEL.tweetText);
      if (texts.length > 1 && texts[0] === el) {
        // Quoted tweet lives in a nested block; label it with ITS OWN author,
        // not the outer post's — so scope to the smallest ancestor that holds
        // the quoted text and its author card but not the commentary.
        const quoted = texts[1];
        const scope = nearestAuthorScope(quoted, el) || article;
        const label = contextTweetLabel(scope, quoted);
        if (label) parts.push(`quoting ${label}`);
      }
      if (/\/status\//.test(location.pathname)) {
        const parent = precedingThreadTweet(article, el);
        if (parent) parts.push(`in reply to ${parent}`);
      }
    } catch {
      /* context is best-effort */
    }
    return parts.join(' | ').slice(0, 600);
  }

  /** The tweet immediately above `article` in a conversation thread column. */
  function precedingThreadTweet(article, el) {
    const cell = article.closest(SEL.cell);
    let node = cell ? cell.previousElementSibling : null;
    let hops = 0;
    while (node && hops < 4) {
      const textEl = node.querySelector?.(SEL.tweetText);
      if (textEl && textEl !== el) {
        const scope = node.querySelector('article') || node;
        return contextTweetLabel(scope, textEl);
      }
      node = node.previousElementSibling;
      hops += 1;
    }
    return '';
  }

  globalThis.GXT.dom = {
    SEL,
    candidatesFor,
    findShowMore,
    PLACEHOLDER_RE,
    extract,
    signature,
    getLang,
    shouldTranslate,
    getAuthor,
    getContext,
    contentIdentity,
    cacheSource,
  };
})();
