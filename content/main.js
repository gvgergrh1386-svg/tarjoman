/**
 * Orchestrator: watches X's virtualized timeline, lazily translates what
 * scrolls into view, batches requests, and recovers from every failure mode
 * without ever breaking the page.
 *
 * Flow: MutationObserver -> idle-scheduled scan -> IntersectionObserver
 * (only elements near the viewport get processed) -> per-session page cache
 * -> debounced batch -> service worker -> render.
 *
 * The scan also re-considers a tweet-text element whose CONTENT changed in
 * place (same node, new children/text). That covers "Show more" expansion
 * and X's Grok auto-translation being toggled back to the original text.
 */
'use strict';
(() => {
  if (globalThis.__gxtMainLoaded) return;
  globalThis.__gxtMainLoaded = true;
  if (!globalThis.chrome?.runtime?.id) return;

  const { getSettings, onStorageChanged, DEFAULTS, cacheNamespace } = globalThis.GXT;
  const D = globalThis.GXT.dom;
  const R = globalThis.GXT.render;

  let settings = { ...DEFAULTS };
  let hasKey = true; // optimistic; corrected on the first NO_KEY response
  let noKeyToastShown = false;
  let pausedUntil = 0;
  let consecutiveFailures = 0;
  let reqSeq = 0;
  let pauseTimer = null;

  /** Session cache: exact provider, source and disambiguation context -> {t, sl}. Makes re-mounted
   *  (virtualized) tweets re-render instantly with no messaging. */
  const pageCache = new Map();
  const PAGE_CACHE_MAX = 2000;

  /** @type {Map<string, object>} request id -> job */
  const pending = new Map();
  const activeJobs = new WeakMap();
  let queue = [];
  let flushTimer = null;

  const metadataFor = (el, isBio = el.matches(D.SEL.bio)) => ({
    author: isBio ? '' : D.getAuthor(el), ctx: isBio ? '' : D.getContext(el),
  });
  const signatureFor = el => {
    const metadata = metadataFor(el);
    return JSON.stringify([D.signature(el), D.contentIdentity(el)]);
  };
  const pageKey = (job) => {
    return JSON.stringify([cacheNamespace(settings), D.cacheSource(job.el, job.extraction)]);
  };

  function allowed(el) {
    return settings.enabled && el.isConnected &&
      (!el.matches(D.SEL.bio) || settings.translateBios) &&
      (!el.matches(D.SEL.extraZones) || settings.xExtraZones);
  }

  function cancelElement(el) {
    const job = activeJobs.get(el);
    if (job) {
      pending.delete(job.id);
      activeJobs.delete(el);
      queue = queue.filter((item) => item.id !== job.id);
    }
    io.unobserve(el);
    dwellIO.unobserve(el);
    const timer = dwellTimers.get(el);
    if (timer !== undefined) clearTimeout(timer);
    dwellTimers.delete(el);
  }

  function takeJob(id) {
    const job = pending.get(id);
    pending.delete(id);
    if (!job || activeJobs.get(job.el) !== job) return null;
    activeJobs.delete(job.el);
    return allowed(job.el) && signatureFor(job.el) === job.sig &&
      cacheNamespace(settings) === job.namespace ? job : null;
  }

  function pageCacheSet(key, value) {
    pageCache.delete(key);
    if (pageCache.size >= PAGE_CACHE_MAX) {
      pageCache.delete(pageCache.keys().next().value);
    }
    pageCache.set(key, value);
  }

  const engineName = () => {
    switch (settings.provider) {
      case 'openai':
        return settings.openaiModel || 'AI';
      case 'google':
        return 'Google Translate';
      case 'bing':
        return 'Bing';
      default:
        return 'Gemini';
    }
  };

  const viewOpts = (job) => ({
    replaceOriginal: settings.replaceOriginal && !job.isBio,
    engine: engineName(),
    targetLang: settings.targetLang || 'fa',
    tts: settings.ttsButton !== false,
    refreshOptions: () => viewOpts(job),
  });

  // ------------------------------------------------------------------- font

  /**
   * Push the user's appearance choices onto the page as CSS variables
   * (v2.0.0). content.css builds the card's structure from `currentColor` so
   * it always matches X's own theme; these two variables carry the parts that
   * are the USER's choice — their font and their accent colour.
   */
  function applyAppearance() {
    const name =
      settings.font === 'x-default'
        ? ''
        : settings.font === '_custom'
          ? (settings.customFont || '').trim()
          : settings.font;
    const root = document.documentElement;
    if (name) root.style.setProperty('--gxt-font', `"${name.replace(/"/g, '')}"`);
    else root.style.removeProperty('--gxt-font');
    // The box on X derives its own surface from `currentColor` so it tracks X's
    // light/dim/dark themes without detecting them — but the two colours that
    // are the EXTENSION's own identity (the accent rail and the error red) come
    // from the user's theme. Both are published on :root for content.css.
    //
    // The accent published here is the DERIVED one, not the authored hex: it is
    // guaranteed to clear 3:1 against the theme's surfaces, which the raw hex is
    // not on the light presets.
    const theme = globalThis.GXT.theme;
    const resolved = theme?.resolve(settings);
    if (resolved) {
      const palette = theme.palette(resolved.theme, resolved.accent);
      root.style.setProperty('--gxt-accent', palette.accentEdge);
      root.style.setProperty('--gxt-err', palette.err);
      /**
       * v3.2.0 — shape, motion and the type scale as well.
       *
       * The box's COLOURS stay derived from `currentColor` on purpose: that is
       * what lets it track X's light / dim / lights-out themes without
       * detecting them, and it is a better design than reading the extension's
       * own background would be. But its radii, its transitions and its font
       * sizes had no such reason to be hand-written — they were simply the one
       * surface the design system never reached. Publishing the SHAPE tokens
       * (and not the colour or font-family ones, which would override the
       * currentColor design and the user's «فونت ایکس» choice) lets
       * content.css use the same scale as every other surface.
       */
      const tokens = Object.fromEntries([...theme.tokens(settings, {inPage:true}).matchAll(/--gxt-([\w-]+):\s*([^;]+);/g)].map(m=>[m[1],m[2]]));
      for (const key of ['radius-sm', 'radius-md', 'radius-lg', 'radius-pill', 'fs-2xs', 'fs-xs', 'fs-sm', 'fs-md', 'fs-lg', 'sp-2', 'sp-3', 'lh', 'lh-tight', 'dur-1', 'dur-2', 'ease', 'motion']) {
        if (tokens[key]) root.style.setProperty(`--gxt-${key}`,tokens[key]);
      }
      root.style.setProperty('--gxt-focus-ring', `0 0 0 2px currentColor, 0 0 0 4px ${palette.accentEdge}`);
    }
  }

  // ---------------------------------------------------------------- observers

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        processElement(entry.target);
      }
    },
    { rootMargin: '900px 0px 900px 0px' }
  );

  /**
   * Opt-in dwell gate (settings.dwellMode): a tweet is translated only after
   * staying ≥50% visible for a full second, measured against the smaller of
   * the post and viewport. An expanded post can be several screens tall and
   * can never reach a native intersectionRatio of 0.5. IO still starts/stops
   * sampling, so only the handful of on-screen posts have a timer.
   */
  const DWELL_MS = 1000;
  const dwellTimers = new WeakMap();

  function startDwell(el) {
    let visibleSince = 0;
    let lastSample = Date.now();
    const sample = () => {
      if (!allowed(el) || !settings.dwellMode || settings.mode !== 'auto') {
        dwellTimers.delete(el);
        return;
      }
      const now = Date.now();
      // Time spent in a suspended/background tab is not reading time.
      if (now - lastSample > 500) visibleSince = 0;
      lastSample = now;
      const rect = el.getBoundingClientRect();
      const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const readable = document.visibilityState !== 'hidden' && rect.height > 0 && rect.width > 0 &&
        height >= Math.min(rect.height, innerHeight) * 0.5 &&
        width >= Math.min(rect.width, innerWidth) * 0.5;
      if (readable) {
        if (!visibleSince) visibleSince = now;
        if (now - visibleSince >= DWELL_MS) {
          dwellTimers.delete(el);
          dwellIO.unobserve(el);
          processElement(el);
          return;
        }
      } else visibleSince = 0;
      dwellTimers.set(el, setTimeout(sample, 100));
    };
    sample();
  }

  const dwellIO = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target;
        if (entry.isIntersecting) {
          if (!dwellTimers.has(el)) startDwell(el);
        } else {
          const timer = dwellTimers.get(el);
          if (timer !== undefined) {
            clearTimeout(timer);
            dwellTimers.delete(el);
          }
        }
      }
    },
    { threshold: [0] }
  );

  const pendingRoots = new Set();
  let scanScheduled = false;

  const mutationObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') {
        const parent = record.target.parentElement;
        if (parent) pendingRoots.add(parent);
        continue;
      }
      // React frequently replaces a bare text node or removes a suffix. Those
      // changes have no added ELEMENT_NODE and still invalidate a translation.
      if (record.target.nodeType === Node.ELEMENT_NODE) pendingRoots.add(record.target);
      for (const node of record.removedNodes || []) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const removed = [node, ...node.querySelectorAll(`${D.SEL.candidates}, ${D.SEL.extraZones}`)];
        for (const el of removed) {
          if (!el.matches(`${D.SEL.candidates}, ${D.SEL.extraZones}`)) continue;
          cancelElement(el);
          R.removeUI(el);
          delete el.dataset.gxtSig;
        }
      }
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) pendingRoots.add(node);
      }
    }
    if (pendingRoots.size) scheduleScan();
  });

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    const run = () => {
      scanScheduled = false;
      const roots = [...pendingRoots];
      pendingRoots.clear();
      for (const root of roots) scan(root);
    };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 200 });
    else setTimeout(run, 40);
  }

  function scan(root) {
    if (!root.isConnected) return;
    if (root.closest?.('.gxt-box') || root.closest?.('.gxt-linkrow')) return;
    const candidates = D.candidatesFor(settings);
    // A mutation INSIDE an existing text element (Grok translation toggled,
    // "Show more" expanded in place): re-consider the host element itself.
    const host = root.closest?.(candidates);
    if (host) {
      consider(host);
      return;
    }
    if (root.querySelectorAll) {
      for (const el of root.querySelectorAll(candidates)) consider(el);
    }
  }

  function consider(el) {
    if (!allowed(el)) return;
    const previousSig = el.dataset.gxtSig;
    const currentSig = signatureFor(el);
    if (previousSig !== undefined) {
      if (previousSig === currentSig && !R.needsRepair(el)) return;
      // In-place content change: drop stale UI and start over. Also clear the
      // "Show more" guard — a successful expand IS such a change (so the full
      // text now translates), and a virtualized node reused for another post
      // must be free to expand again.
      R.removeUI(el);
      delete el.dataset.gxtExpandTried;
    }
    cancelElement(el);
    el.dataset.gxtSig = currentSig;
    // cancelElement above removed both observers and any old dwell timer.
    // Dwell mode only gates AUTO translation; manual links appear normally.
    if (settings.dwellMode && settings.mode === 'auto') dwellIO.observe(el);
    else io.observe(el);
  }

  // ------------------------------------------------------------- translation

  function processElement(el) {
    if (!allowed(el)) {
      delete el.dataset.gxtSig;
      return;
    }
    const isBio = el.matches(D.SEL.bio);
    if (isBio && !settings.translateBios) {
      delete el.dataset.gxtSig;
      return;
    }
    // Auto-expand long posts (opt-in): click this post's own "Show more" so the
    // FULL text is revealed, then let the in-place expansion re-trigger
    // translation via the MutationObserver (the same path a manual click uses).
    // While a "Show more" is present we never translate the truncated preview;
    // a fallback translates whatever is visible if the click didn't expand.
    if (settings.expandLongPosts && !isBio && !el.dataset.gxtExpandTried) {
      const more = D.findShowMore(el);
      if (more) {
        el.dataset.gxtExpandTried = '1';
        more.click();
        setTimeout(() => {
          if (el.isConnected && !R.hasUI(el)) processElement(el);
        }, 600);
        return;
      }
    }
    const extraction = D.extract(el);
    const lang = isBio ? 'auto' : D.getLang(el) || 'auto';
    if (!D.shouldTranslate(extraction.text, lang === 'auto' ? '' : lang, settings.targetLang)) return;

    const job = { el, extraction, lang, isBio };
    const cached = pageCache.get(pageKey(job));
    if (cached) {
      R.showTranslation(el, cached.t, extraction, cached.sl || lang, viewOpts(job));
      return;
    }
    const linkLabel = isBio ? globalThis.GXT.i18n.t("content_main_linkLabel_2") : globalThis.GXT.i18n.t("content_main_linkLabel_1");
    if (settings.mode === 'manual' || !hasKey || Date.now() < pausedUntil) {
      if (hasKey || settings.mode === 'manual') {
        R.showTranslateLink(el, () => startTranslate(job, true), linkLabel);
      }
      return;
    }
    startTranslate(job, false);
  }

  function startTranslate(job, immediate) {
    if (!allowed(job.el)) return;
    // Links/retry callbacks can outlive the draft of a virtualized post. Read
    // the current source at activation, and give each element one live request.
    const sig = signatureFor(job.el);
    if (activeJobs.get(job.el)?.sig === sig) return;
    cancelElement(job.el);
    job = { ...job, ...metadataFor(job.el, job.isBio), extraction: D.extract(job.el),
      lang: job.isBio ? 'auto' : D.getLang(job.el) || 'auto', sig,
      namespace: cacheNamespace(settings) };
    if (!D.shouldTranslate(job.extraction.text, job.lang, settings.targetLang)) {
      R.removeUI(job.el);
      return;
    }
    job.cacheKey = pageKey(job);
    R.showLoading(job.el);
    // Snapshot the element's content so a response that arrives after the
    // text changed in place ("Show more", Grok toggle) is not rendered onto
    // the new, different text.
    job.sig = signatureFor(job.el);
    reqSeq += 1;
    const id = `r${reqSeq}`;
    job.id = id;
    pending.set(id, job);
    activeJobs.set(job.el, job);
    queue.push({
      id,
      text: job.extraction.text,
      lang: job.lang,
      author: job.author,
      ctx: job.ctx,
      contentId: D.cacheSource(job.el, job.extraction),
    });
    if (immediate || queue.length >= settings.batchSize) {
      void flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => void flush(), settings.batchDelayMs);
    }
  }

  async function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!queue.length) return;
    const items = queue.filter((item) => pending.has(item.id));
    queue = [];
    if (!items.length) return;
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({ type: 'TRANSLATE_BATCH', items });
    } catch {
      response = null; // extension reloaded or worker unreachable
    }
    handleResponse(items, response);
  }

  function friendlyError(result) {
    switch (result?.code) {
      case 'RATE_LIMIT':
        // The worker's message is specific (e.g. "همهٔ کلیدها پر شده") — keep it.
        return result?.error || globalThis.GXT.i18n.t("content_main_friendlyError_6");
      case 'BAD_KEY':
        return globalThis.GXT.i18n.t("content_main_friendlyError_5");
      case 'BAD_BASE_URL':
        return globalThis.GXT.i18n.t("content_main_friendlyError_4");
      case 'NETWORK':
        return globalThis.GXT.i18n.t("content_main_friendlyError_3");
      case 'BLOCKED':
        return globalThis.GXT.i18n.t("content_main_friendlyError_2");
      default:
        return result?.error || globalThis.GXT.i18n.t("content_main_friendlyError_1");
    }
  }

  function handleResponse(items, response) {
    // The master switch may have been turned off while this batch was in
    // flight — never paint a translation onto a disabled page.
    if (!settings.enabled) {
      for (const item of items) pending.delete(item.id);
      return;
    }
    if (!response || !response.ok) {
      if (response?.code === 'NO_KEY') {
        onNoKey(items);
        return;
      }
      failAll(items, response);
      return;
    }
    let anyFailure = false;
    for (const item of items) {
      const job = takeJob(item.id);
      if (!job) continue;
      const result = response.results?.[item.id];
      // If the element's content changed while this batch was in flight, a
      // fresh job already covers the new text — don't paint the stale result.
      const stale = signatureFor(job.el) !== job.sig;
      if (result?.ok && typeof result.t === 'string' && result.t.trim()) {
        consecutiveFailures = 0;
        pageCacheSet(job.cacheKey, { t: result.t, sl: result.sl || '' });
        if (!stale && job.el.isConnected) {
          R.showTranslation(
            job.el,
            result.t,
            job.extraction,
            result.sl || job.lang,
            viewOpts(job)
          );
        }
      } else {
        anyFailure = true;
        if (!stale && job.el.isConnected) {
          R.showError(job.el, friendlyError(result), () => startTranslate(job, true), result?.detail);
        }
      }
    }
    if (anyFailure) noteFailure();
  }

  function failAll(items, response) {
    const message = friendlyError(response || { code: 'ERR' });
    let failed = false;
    for (const item of items) {
      const job = takeJob(item.id);
      if (job) {
        failed = true;
        R.showError(job.el, message, () => startTranslate(job, true), response?.detail);
      }
    }
    if (failed) noteFailure();
  }

  function noteFailure() {
    consecutiveFailures += 1;
    if (consecutiveFailures >= 3 && settings.mode === 'auto') {
      pausedUntil = Date.now() + 60000;
      consecutiveFailures = 0;
      R.toast(globalThis.GXT.i18n.t("content_main_noteFailure_1"));
      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        pausedUntil = 0;
        resetUnfinished();
        rescanAll();
      }, 60000);
    }
  }

  function onNoKey(items) {
    const jobs = items.map((item) => takeJob(item.id)).filter(Boolean);
    if (!jobs.length) return;
    hasKey = false;
    for (const job of jobs) R.removeUI(job.el);
    if (!noKeyToastShown) {
      noKeyToastShown = true;
      R.toast(globalThis.GXT.i18n.t("content_main_onNoKey_1"));
    }
  }

  // ------------------------------------------------------- settings liveness

  function rescanAll() {
    for (const el of document.querySelectorAll(D.candidatesFor(settings))) {
      if (!R.hasUI(el)) {
        delete el.dataset.gxtSig;
        consider(el);
      }
    }
  }

  function resetUnfinished() {
    for (const el of document.querySelectorAll(`${D.SEL.candidates}, ${D.SEL.extraZones}`)) {
      if (R.isTranslated(el)) continue;
      cancelElement(el);
      R.removeUI(el);
      delete el.dataset.gxtSig;
    }
  }

  /**
   * Re-render already-translated posts in place. `replaceOriginal` is a pure
   * display setting (it only decides whether the source is hidden), so a live
   * toggle from the popup must apply to what's already on screen — not just to
   * posts scrolled in afterwards. removeUI first restores the original, so the
   * re-extraction and re-render read a visible node; the translation itself is
   * a page-cache hit, so this costs no API calls.
   */
  function reapplyReplaceOriginal() {
    if (!settings.enabled) return;
    for (const el of [...document.querySelectorAll(D.candidatesFor(settings))]) {
      if (!R.isTranslated(el)) continue;
      const isBio = el.matches(D.SEL.bio);
      R.removeUI(el);
      const extraction = D.extract(el);
      const lang = isBio ? 'auto' : D.getLang(el) || 'auto';
      const job = { el, extraction, lang, isBio };
      const cached = pageCache.get(pageKey(job));
      if (cached) {
        R.showTranslation(el, cached.t, extraction, cached.sl || lang, viewOpts(job));
      } else {
        // No cached translation (rare): let the normal pipeline re-handle it.
        delete el.dataset.gxtSig;
        consider(el);
      }
    }
  }

  /** Drop translation UI from posts matching `sel` (used when a feature toggle
   *  is turned OFF, so already-translated bios / extra zones revert instead of
   *  lingering until reload). */
  function removeTranslationsMatching(sel) {
    if (!sel) return;
    for (const el of document.querySelectorAll(sel)) {
      cancelElement(el);
      R.removeUI(el);
      delete el.dataset.gxtSig;
    }
  }

  /**
   * Turning the master switch OFF must clear the page NOW, not on the next
   * reload: every box, manual link and hidden original goes away, and the
   * elements are un-marked so switching back ON re-considers them. Queued and
   * in-flight work is dropped too, so nothing repaints afterwards.
   */
  function removeAllTranslations() {
    queue = [];
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pending.clear();
    // Every zone the extension can touch, not just the ones enabled right now.
    const all = `${D.SEL.candidates}, ${D.SEL.extraZones}`;
    for (const el of document.querySelectorAll(all)) {
      cancelElement(el);
      R.removeUI(el);
      delete el.dataset.gxtSig;
      delete el.dataset.gxtExpandTried;
      io.unobserve(el);
      dwellIO.unobserve(el);
      const timer = dwellTimers.get(el);
      if (timer !== undefined) {
        clearTimeout(timer);
        dwellTimers.delete(el);
      }
    }
  }

  /** When auto-expand is switched ON, expand posts already on the page so the
   *  change applies now, not only to posts scrolled in later. Each in-place
   *  expansion re-triggers translation through the MutationObserver. */
  function expandVisibleLongPosts() {
    if (!settings.enabled || !settings.expandLongPosts) return;
    for (const el of document.querySelectorAll(D.SEL.tweetText)) {
      if (el.dataset.gxtExpandTried) continue;
      const more = D.findShowMore(el);
      if (more) {
        el.dataset.gxtExpandTried = '1';
        more.click();
      }
    }
  }

  onStorageChanged(({ settings: next, apiKeyChanged }) => {
    if (next) {
      next=globalThis.GXT.forScope(next,'x');
      const previous = settings;
      settings = next;
      applyAppearance();
      // Master switch OFF: retract everything immediately (v1.9.6 — it used to
      // linger until a page reload, the classic "the switch did nothing" bug).
      if (previous.enabled && !next.enabled) {
        removeAllTranslations();
        return;
      }
      const namespaceChanged = cacheNamespace(previous) !== cacheNamespace(next);
      if (namespaceChanged) {
        hasKey = true;
        noKeyToastShown = false;
        pausedUntil = 0;
        clearTimeout(pauseTimer);
        removeAllTranslations();
      } else if (previous.mode !== next.mode || previous.dwellMode !== next.dwellMode) {
        resetUnfinished();
      }
      const needsRescan =
        (!previous.enabled && next.enabled) ||
        previous.mode !== next.mode ||
        previous.dwellMode !== next.dwellMode ||
        (!previous.translateBios && next.translateBios) ||
        (!previous.xExtraZones && next.xExtraZones) ||
        namespaceChanged;
      if (needsRescan) rescanAll();
      // Turning a scope OFF must retract what it already translated.
      if (previous.translateBios && !next.translateBios) {
        removeTranslationsMatching(D.SEL.bio);
      }
      if (previous.xExtraZones && !next.xExtraZones) {
        removeTranslationsMatching(D.SEL.extraZones);
      }
      // replaceOriginal is display-only: re-render on-screen posts in place.
      if (previous.replaceOriginal !== next.replaceOriginal || previous.ttsButton !== next.ttsButton) {
        reapplyReplaceOriginal();
      }
      // Turning auto-expand ON should expand posts already on screen too.
      if (!previous.expandLongPosts && next.expandLongPosts) expandVisibleLongPosts();
    }
    if (apiKeyChanged) {
      hasKey = true;
      noKeyToastShown = false;
      pausedUntil = 0;
      clearTimeout(pauseTimer);
      resetUnfinished();
      rescanAll();
    }
  });

  // -------------------------------------------------------------------- init

  async function init() {
    try {
      settings = globalThis.GXT.forScope(await getSettings(),'x');
    } catch {
      /* storage unavailable: keep defaults */
    }
    applyAppearance();
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['lang', 'href', 'alt', 'src'],
    });
    for (const el of document.querySelectorAll(D.candidatesFor(settings))) consider(el);
  }

  void init();
})();
