/**
 * Translation memory — consistency across a session, a site and a lifetime.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Consistency is the clearest line between amateur and professional
 * translation. Nothing in this extension enforced it: every batch was
 * translated in isolation, so «Michael» could come back مایکل on one post and
 * مایکائیل three posts later, and a technical term could drift three ways
 * inside one subtitle file. The reader notices, even when each individual
 * choice was defensible.
 *
 * WHAT IT DOES
 *   1. LEARNS. After a translation lands, aligned proper nouns and repeated
 *      terms are extracted and remembered as source → Persian.
 *   2. HINTS. Before a translation is sent, any remembered term that appears
 *      in the text is attached, so the model reuses the established Persian
 *      instead of inventing a new one.
 *   3. CORRECTS. A term the user fixes once is pinned (`n` set high) and wins
 *      over anything the model would otherwise pick.
 *
 * It also gets CHEAPER with use: a hint is a handful of tokens, and it removes
 * the reasoning the model would otherwise spend on a name it has seen before.
 *
 * ARCHITECTURE. Persistence lives in shared/settings.js (`getMemory` /
 * `updateMemory`), so that file stays "everything that is stored". This file
 * is the semantics, and is deliberately PURE apart from those two calls — the
 * extraction and hint-building functions take data and return data, so the
 * self-test can drive them directly.
 */
'use strict';
(() => {
  if (globalThis.GXT && globalThis.GXT.memoryReady) return;
  const G = () => globalThis.GXT;

  /**
   * Terms worth remembering are NAMES and TERMS, not words.
   *
   * The filter matters more than the extractor: a memory full of "the", "with"
   * and "video" is worse than no memory, because every one of those becomes a
   * hint token on every request and a chance for the model to be told
   * something it already knows. So the bar is deliberately high — see
   * `isCandidate`.
   */
  const MIN_LEN = 3;
  const MAX_LEN = 48;
  /** Hints attached to one request. Beyond this the token cost stops paying
   *  for itself, and the most-confirmed terms are the ones that matter. */
  const MAX_HINTS = 24;
  /**
   * Times a term must be seen before it is used as a hint.
   *
   * This is what lets extraction be imperfect without the memory
   * degrading. Learning a term is a guess; USING it is not, so a guess has
   * to be confirmed by a second sighting before it costs tokens on every
   * request and starts steering the model. A one-off mistake stays inert
   * and eventually gets pruned. A user PIN skips the gate entirely: they
   * are not guessing.
   */
  const MIN_CONFIRMATIONS = 2;

  /** Words that look like names because they start a sentence, and are not. */
  const STOPWORDS = new Set(
    ('the a an and or but if then than that this these those there here when while for '
      + 'with without from into onto about after before during under over again once you '
      + 'your yours our ours their theirs его his her hers its it we they he she who whom '
      + 'what which why how all any both each few more most other some such only own same '
      + 'so too very can will just should now also been being have has had was were are is '
      + 'am be do does did doing would could may might must shall i me my mine no not nor '
      + 'yes ok okay one two three new old good bad big small last next first').split(' ')
  );

  const PERSIAN_RE = /[؀-ۿ]/;
  const LATIN_RE = /[A-Za-z]/;

  /** Normalized lookup key: case- and spacing-insensitive. */
  const keyOf = (text) => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');

  /** Words that legitimately sit INSIDE a title without being capitalised. */
  const CONNECTIVES = new Set(['of', 'the', 'and', 'on', 'in', 'de', 'van', 'von', 'du', 'la', 'le']);

  /**
   * Is this string worth remembering as a term?
   *
   * `opts.midSentence` means the word was found capitalised somewhere OTHER
   * than the start of a sentence. In English that is a strong signal of a
   * proper noun, and it is the only cheap one available: without it, a lone
   * «Video» opening a sentence is indistinguishable from a name — and a memory
   * that learns «Video» then spends a hint token on every future request to
   * teach the model a word it already knows.
   *
   * Accepts: ALLCAPS acronyms anywhere; multi-word Capitalised phrases;
   * single Capitalised words only mid-sentence.
   */
  function isCandidate(text, opts = {}) {
    const s = String(text || '').trim();
    if (s.length < MIN_LEN || s.length > MAX_LEN) return false;
    if (!LATIN_RE.test(s)) return false;
    if (/https?:|www\.|@|#|⟦|⟧/.test(s)) return false;
    if (/^\d+$/.test(s)) return false;
    const words = s.split(/\s+/);
    if (words.length > 5) return false;
    if (words.length === 1) {
      if (/^[A-Z]{2,}$/.test(s)) return true; // acronym: NASA, GPU, ED
      if (!/^[A-Z][a-z’'-]+$/.test(s)) return false;
      if (STOPWORDS.has(s.toLowerCase())) return false;
      return !!opts.midSentence;
    }
    // Multi-word: every word is either Capitalised or a known connective.
    return words.every((w) => /^[A-Z]/.test(w) || CONNECTIVES.has(w.toLowerCase()));
  }

  /**
   * Latin phrases inside a string — used on the PERSIAN side.
   *
   * This is the move that removes the guesswork. Extracting proper nouns from
   * ENGLISH is inference: an initial capital may be a name or may just be the
   * start of a sentence, and there is no part-of-speech tagger here to tell
   * them apart. But a Latin run that SURVIVED into Persian output is not an
   * inference at all — it is a decision the model already made, that this
   * string is a name and stays Latin. Mining the OUTPUT yields terms with no
   * heuristic whatsoever.
   */
  function latinRunsIn(text) {
    const out = [];
    const re = /[A-Za-z][A-Za-z0-9’'.-]*(?:\s+[A-Za-z0-9’'.-]+)*/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
      const words = m[0].trim().replace(/[.,;:!?]+$/, '').split(/\s+/);
      // Trim connectives the surrounding sentence left on the end.
      while (words.length > 1 && CONNECTIVES.has(words[words.length - 1].toLowerCase())) words.pop();
      const phrase = words.join(' ');
      if (phrase.length >= MIN_LEN && phrase.length <= MAX_LEN) out.push(phrase);
    }
    return [...new Set(out)];
  }

  /** Proper-noun-ish candidates in one English string, sentence-start aware. */
  function candidatesIn(text) {
    const out = [];
    const s = String(text || '');
    // Positions where a new sentence begins — an initial capital there carries
    // no information about whether the word is a name.
    const starts = new Set([0]);
    const boundary = /[.!?\n]\s+/g;
    let b;
    while ((b = boundary.exec(s))) starts.add(b.index + b[0].length);

    // A regex LITERAL, not a constructed string: the first attempt at this
    // built the pattern by interpolation and the `\b` word-boundary became a
    // raw 0x08 backspace byte in the source \u2014 the exact control-character
    // hazard this repo has hit three times before.
    const re = /\b[A-Z][A-Za-z\u2019'-]*(?:\s+(?:of|the|and|on|in|de|van|von)\s+[A-Z][A-Za-z\u2019'-]*|\s+[A-Z][A-Za-z\u2019'-]*)*\b/g;
    let m;
    while ((m = re.exec(s))) {
      const phrase = m[0].trim();
      if (isCandidate(phrase, { midSentence: !starts.has(m.index) })) out.push(phrase);
    }
    return [...new Set(out)];
  }


  /**
   * Learn from one aligned pair.
   *
   * The honest limit: we do NOT have word alignment, only a source string and
   * its Persian. So a term is learned only when the pair is SHORT enough that
   * the mapping is unambiguous — a two-word title translated to two or three
   * Persian words is safe; a paragraph is not, and guessing which fragment of
   * it corresponds to «Ghibli» would poison the memory with nonsense.
   *
   * That is why this returns few entries per call and gets its value from
   * volume over time rather than from cleverness per item.
   */
  function learnFromPair(source, target) {
    const src = String(source || '').trim();
    const tgt = String(target || '').trim();
    if (!src || !tgt) return [];
    if (!PERSIAN_RE.test(tgt)) return [];
    const out = [];
    /**
     * Case 1 — the whole string IS a term: a title, a name, a label, a table
     * cell. Here the mapping is unambiguous because there is nothing else in
     * the pair it could refer to. `standalone` tells `isCandidate` that a
     * leading capital carries no sentence-start ambiguity, since there is no
     * sentence.
     */
    if (isCandidate(src, { midSentence: true }) && tgt.length <= MAX_LEN) {
      out.push({ s: src, t: tgt });
      return out;
    }
    /**
     * Case 2 — a Latin run survived UNTRANSLATED into the Persian.
     *
     * Read off the OUTPUT, not guessed from the input. A Latin phrase sitting
     * in Persian text is a decision the model already made ("this is a name,
     * it stays Latin"), so there is no inference to get wrong — which is
     * exactly what made the first version of this learn «Watching Attack»
     * from a sentence that merely began with a capital.
     */
    for (const phrase of latinRunsIn(tgt)) {
      if (src.includes(phrase) && isCandidate(phrase, { midSentence: true })) {
        out.push({ s: phrase, t: phrase });
      }
    }
    return out;
  }

  /** Fold learned pairs into a memory object (pure — takes and returns data). */
  function absorb(memory, pairs, { pinned = false, max = 4000 } = {}) {
    const terms = { ...(memory.terms || {}) };
    const now = Date.now();
    for (const { s, t } of pairs || []) {
      const key = keyOf(s);
      if (!key) continue;
      const existing = terms[key];
      if (existing && !pinned && existing.pinned) continue; // a user fix is final
      const n = pinned ? 9999 : Math.min((existing?.n || 0) + 1, 9998);
      terms[key] = { s, t, n, at: now, ...(pinned ? { pinned: true } : {}) };
    }
    // Prune by least-confirmed, then oldest — a term seen once a year ago is
    // the safest thing to forget.
    const keys = Object.keys(terms);
    if (keys.length > max) {
      keys
        .sort((a, b) => (terms[a].n - terms[b].n) || (terms[a].at - terms[b].at))
        .slice(0, keys.length - max)
        .forEach((k) => delete terms[k]);
    }
    return { ...memory, terms };
  }

  /**
   * The remembered terms that actually occur in these texts.
   *
   * Scanning the memory against the text (rather than sending the whole
   * memory) is what keeps this affordable: a 4000-term memory costs nothing
   * until one of its terms is on screen.
   */
  function hintsFor(memory, texts, { max = MAX_HINTS, minSeen = MIN_CONFIRMATIONS } = {}) {
    const terms = memory?.terms || {};
    const keys = Object.keys(terms);
    if (!keys.length) return {};
    const haystack = (Array.isArray(texts) ? texts.join('\n') : String(texts || '')).toLowerCase();
    if (!haystack) return {};
    const hits = [];
    for (const key of keys) {
      // The confirmation gate — and the reason extraction is allowed to be
      // imperfect. Learning is a guess; being USED as a hint is not, so a term
      // has to be seen more than once (or pinned by the user) before it starts
      // costing tokens and steering the model. A one-off mistake stays inert.
      if ((terms[key].n || 0) < minSeen && !terms[key].pinned) continue;
      if (haystack.includes(key)) hits.push(key);
    }
    // Most-confirmed first: if the budget binds, keep the terms whose
    // consistency the reader is most likely to notice.
    hits.sort((a, b) => (terms[b].n || 0) - (terms[a].n || 0));
    const out = {};
    for (const key of hits.slice(0, max)) out[terms[key].s] = terms[key].t;
    return out;
  }

  /** Human-readable «term = ترجمه» lines, for the memory screen and export. */
  function toLines(memory) {
    return Object.values(memory?.terms || {})
      .sort((a, b) => (b.n || 0) - (a.n || 0) || String(a.s).localeCompare(String(b.s)))
      .map((e) => `${e.s} = ${e.t}${e.pinned ? '  ★' : ''}`);
  }

  // ─────────────────────────────────────────────────── storage-backed API

  /** Learn from a whole batch of aligned pairs, in one serialized write. */
  async function remember(pairs, { pinned = false, generation = G()?.memoryGeneration?.() } = {}) {
    const S = G();
    if (!S?.updateMemory) return 0;
    const settings = await S.getSettings();
    if (!settings.memoryEnabled && !pinned) return 0;
    const flat = [];
    for (const { source, target } of pairs || []) {
      flat.push(...learnFromPair(source, target));
    }
    if (!flat.length) return 0;
    const next = await S.updateMemory((current) =>
      absorb(current, flat, { pinned, max: settings.memoryMax || 4000 }), { generation }
    );
    return next.count;
  }

  /** Pin a correction: the user's word is final and never overwritten. */
  function pin(source, target) {
    const s = String(source || '').trim();
    const t = String(target || '').trim();
    const S = G();
    if (!s || !t || !S?.updateMemory) return Promise.resolve(0);
    // A deliberate correction need not pass the heuristic used to learn names
    // automatically (which rejects lowercase terms and longer phrases).
    return S.getSettings().then((settings) => S.updateMemory((current) =>
      absorb(current, [{ s, t }], { pinned: true, max: settings.memoryMax || 4000 })
    )).then((next) => next.count);
  }

  async function forget(source) {
    const S = G();
    if (!S?.updateMemory) return;
    const key = keyOf(source);
    await S.updateMemory((current) => {
      const terms = { ...current.terms };
      delete terms[key];
      return { ...current, terms };
    });
  }

  /** Hints for an outgoing request, or `null` when there is nothing to say. */
  async function hintsForRequest(texts) {
    const S = G();
    if (!S?.getMemory) return null;
    const settings = await S.getSettings();
    if (!settings.memoryEnabled) return null;
    const memory = await S.getMemory();
    const hints = hintsFor(memory, texts);
    return Object.keys(hints).length ? hints : null;
  }

  globalThis.GXT = Object.assign(globalThis.GXT || {}, {
    memoryReady: true,
    memory: {
      MAX_HINTS,
      MIN_CONFIRMATIONS,
      latinRunsIn,
      keyOf,
      isCandidate,
      candidatesIn,
      learnFromPair,
      absorb,
      hintsFor,
      toLines,
      remember,
      pin,
      forget,
      hintsForRequest,
    },
  });
})();
