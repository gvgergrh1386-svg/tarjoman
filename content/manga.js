/**
 * Manga chapter mode (v2.5.8).
 *
 * v2.5.1 could translate ONE right-clicked image. That is the right primitive
 * and the wrong product: a chapter is twenty pages, so it meant twenty
 * right-clicks and — far more expensive — twenty cold starts of a pipeline
 * whose models take about twelve seconds to load and five to use.
 *
 * This module treats a chapter as the unit. It finds the pages on the site,
 * hands the whole run to the local pipeline in one go, and fills them in as
 * they come back.
 *
 * ── Three things decide the design ─────────────────────────────────────────
 *
 * 1. THE PAGES ARE ALREADY ON THE PAGE. A manga reader is a list of large
 *    images in reading order. Nothing needs to be scraped or guessed about the
 *    site: the DOM already holds the chapter, in order, and `collectPages`
 *    only has to tell a page apart from a logo, an avatar and an advert.
 *
 * 2. RESULTS MUST STREAM. Waiting two minutes for a chapter to appear all at
 *    once is a worse experience than reading it as it arrives. The bridge
 *    reports each finished group, and each page is dropped into the reader the
 *    moment it exists — you start reading page one while page nine renders.
 *
 * 3. THE ORIGINAL IS NEVER LOST. Every swap remembers `src`, `srcset` and any
 *    `<picture><source>`, so «تصویر اصلی» is always one click away, and a
 *    reload is never needed to see what the artist actually drew.
 *
 * ── What this module deliberately does NOT do ──────────────────────────────
 *
 * It does not re-implement any part of MangaTranslator. OCR, inpainting,
 * typesetting and reading order all happen in that application, through the
 * batch entry point it already exposes. This module finds pictures, shows
 * progress, and puts the results back.
 */
'use strict';
(() => {
  globalThis.GXT = globalThis.GXT || {};
  if (globalThis.__gxtMangaLoaded) return;
  globalThis.__gxtMangaLoaded = true;

  const UI = () => globalThis.GXT.ui;
  const IS_TOP = window === window.top;
  let settings = { ...(globalThis.GXT.DEFAULTS || {}) };

  const send = async (message) => {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  };

  const faNum = (n) => globalThis.GXT.i18n ? globalThis.GXT.i18n.number(n) : Number(n || 0).toLocaleString('fa-IR');

  // ---------------------------------------------------------- page detection

  /** Below this a picture is furniture: an avatar, an icon, a site banner. */
  const MIN_WIDTH = 300;
  const MIN_HEIGHT = 380;
  const MIN_AREA = 160000;
  /** Wider than this and it is a banner, not a page — even a double-page
   *  spread stays close to 2:3 per page, so 4:1 is far outside a comic. */
  const MAX_ASPECT = 4;
  /** Chapter-length guard. Beyond this the user is on an index page, not a
   *  chapter, and the local pipeline should not be handed a whole archive. */
  const MAX_PAGES = 200;

  const SKIP_ANCESTORS = 'header,nav,footer,aside,[role="banner"],[role="navigation"],.gxt-box';

  /** The dimensions to judge an image by, whether or not it has loaded yet.
   *  A lazy reader has dozens of images with `naturalWidth === 0`, and judging
   *  those as "too small" would find nothing on exactly the sites that matter. */
  function sizeOf(img) {
    const rect = img.getBoundingClientRect();
    const width = img.naturalWidth || rect.width || Number(img.getAttribute('width')) || 0;
    const height = img.naturalHeight || rect.height || Number(img.getAttribute('height')) || 0;
    return { width, height };
  }

  /** Is this image a page of the comic? */
  function looksLikePage(img) {
    if (!img || img.dataset?.gxtManga === 'busy') return false;
    const src = img.currentSrc || img.src || '';
    if (!/^(https?:|data:image\/)/i.test(src)) return false;
    // An SVG is a logo or an icon, never a scan.
    if (/\.svg(\?|$)/i.test(src)) return false;
    if (img.closest?.(SKIP_ANCESTORS)) return false;
    const { width, height } = sizeOf(img);
    if (!width || !height) return false;
    if (width < MIN_WIDTH || height < MIN_HEIGHT) return false;
    if (width * height < MIN_AREA) return false;
    if (width / height > MAX_ASPECT) return false;
    return true;
  }

  /**
   * Every page of the chapter, in reading order.
   *
   * Document order IS reading order — a reader lays its pages out top to
   * bottom, and that is true of paginated readers, long-strip webtoons and
   * plain image lists alike. Ordering by geometry instead would break the
   * moment a page was absolutely positioned.
   */
  function collectPages(root) {
    pruneDetached();
    const scope = root || document;
    const images = Array.from(scope.querySelectorAll('img'));
    const seen = new Set();
    const pages = [];
    for (const img of images) {
      if (!looksLikePage(img)) continue;
      const src = originals.get(img)?.selectedSrc || img.currentSrc || img.src;
      // The same URL twice is a thumbnail strip beside the reader, or a
      // preloaded duplicate; translating it twice would cost real money and
      // real GPU time for one picture.
      if (seen.has(src)) continue;
      seen.add(src);
      pages.push({ el: img, src, state: imageState(img) });
      if (pages.length >= MAX_PAGES) break;
    }
    return pages;
  }

  // ------------------------------------------------------------ swap / restore

  /** @type {Map<HTMLImageElement, {src, srcset, sizes, sources: Array<{el, srcset}>}>} */
  const originals = new Map();
  /** Translated data URL per image, so the toggle can go back and forth
   *  without asking the bridge for the same page twice. */
  const translated = new Map();
  const ownedStates = new Map();

  // React can keep an <img> connected while assigning it a different page.
  // Compare author-controlled source attributes, not currentSrc, which can
  // lag behind src while the browser decodes the replacement image.
  function imageState(img) {
    const picture = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : null;
    return JSON.stringify([
      img.getAttribute('src'), img.getAttribute('srcset'), img.getAttribute('sizes'),
      picture ? Array.from(picture.querySelectorAll('source')).map((source) =>
        [source.getAttribute('srcset'), source.getAttribute('media'), source.getAttribute('type')]) : [],
    ]);
  }

  function ownsImage(img) {
    if (img.isConnected && ownedStates.get(img) === imageState(img)) return true;
    originals.delete(img);
    translated.delete(img);
    ownedStates.delete(img);
    delete img.dataset.gxtManga;
    return false;
  }
  /**
   * Every page URL this session has already handed to the pipeline — whether
   * it came back translated, failed, or was refused by the site.
   *
   * This is what stops the automatic follow-up run (watchForNewPages) from
   * being a perpetual motion machine. A page that FAILS is recorded nowhere
   * else: it is not in `translated`, it is not in `originals`, so the next
   * scan sees it as "new" and sends it again — and because a run repaints the
   * panel, the run itself is a DOM mutation that schedules the next scan. One
   * failing page therefore meant an unbounded loop of full local-pipeline
   * jobs, each loading models and pinning the GPU, for as long as the tab
   * stayed open. Attempt-once is the invariant; «ترجمهٔ همهٔ صفحه‌ها» from the
   * menu clears it, because that IS the user asking to try again.
   */
  const attempted = new Set();

  /** Elements the page has thrown away (a virtualised reader recycles them
   *  constantly). Holding them in a Map keeps their data URLs — several
   *  megabytes each — alive for the life of the tab. */
  function pruneDetached() {
    for (const img of [...originals.keys()]) ownsImage(img);
  }

  function rememberOriginal(img) {
    if (originals.has(img)) return;
    const picture = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : null;
    originals.set(img, {
      selectedSrc: img.currentSrc || img.src,
      loading: img.getAttribute('loading'),
      src: img.getAttribute('src') || '',
      srcset: img.getAttribute('srcset') || '',
      sizes: img.getAttribute('sizes') || '',
      sources: picture
        ? Array.from(picture.querySelectorAll('source')).map((el) => ({
            el,
            srcset: el.getAttribute('srcset') || '',
          }))
        : [],
    });
  }

  /** Show a translated page in place of the site's own image.
   *
   *  `srcset` is removed, not just overridden: in a responsive image it OUTRANKS
   *  `src`, so setting src alone leaves the original on screen — which looks
   *  exactly like the translation having silently failed. */
  function showTranslated(img, dataUrl) {
    if (!img?.isConnected) return false;
    if (originals.has(img) && !ownsImage(img)) return false;
    rememberOriginal(img);
    for (const source of originals.get(img).sources) source.el.removeAttribute('srcset');
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    // Lazy loaders re-assert their own src when an image scrolls into view;
    // marking it stops ours being replaced by the original a second later.
    img.setAttribute('loading', 'eager');
    img.src = dataUrl;
    img.dataset.gxtManga = 'fa';
    translated.set(img, dataUrl);
    ownedStates.set(img, imageState(img));
    return true;
  }

  function showOriginal(img) {
    if (!ownsImage(img)) return;
    const saved = originals.get(img);
    if (!saved) return;
    for (const source of saved.sources) {
      if (source.srcset) source.el.setAttribute('srcset', source.srcset);
    }
    if (saved.srcset) img.setAttribute('srcset', saved.srcset);
    if (saved.sizes) img.setAttribute('sizes', saved.sizes);
    if (saved.src) img.setAttribute('src', saved.src);
    if (saved.loading == null) img.removeAttribute('loading');
    else img.setAttribute('loading', saved.loading);
    img.dataset.gxtManga = 'orig';
    ownedStates.set(img, imageState(img));
  }

  /** Flip every page this module has translated. */
  function setAllTranslated(on) {
    for (const [img, dataUrl] of translated) {
      if (!img.isConnected) continue;
      if (on) showTranslated(img, dataUrl);
      else showOriginal(img);
    }
  }

  // -------------------------------------------------------------------- run

  /** One chapter run. Null when nothing is in flight. */
  let run = null;
  let card = null;
  let panel = null;

  const POLL_MS = 1200;

  function closeCard() {
    const open = card;
    card = null;
    panel = null;
    open?.close();
  }

  /** The reader panel: progress, the two controls that matter while it runs,
   *  and the two that matter once it has. */
  function openPanel(total) {
    closeCard();
    card = UI().card({ get title() { return globalThis.GXT.i18n.t("content_manga_openPanel_2"); }, copy: false, onClose: () => { card = null; panel = null; } });
    const body = card.body;
    body.replaceChildren();

    const line = document.createElement('div');
    globalThis.GXT.i18n.bind(line, "textContent", () => (globalThis.GXT.i18n.t("content_manga_openPanel_1", {v0:(faNum(total))})));

    // v3.2.5 — the design system's components, not three style strings.
    //
    // The bar was `height:6px;border-radius:99px;background:var(--gxt-bg-sunken,#0003)`
    // with no frame, so on a light theme it was an invisible groove; the note
    // was `font-size:11px;opacity:.75`, which is both below the 11.5px floor
    // `--gxt-fs-2xs` holds at every density AND the fade-to-illegible that this
    // design system exists to avoid. `.meter` is the popup's quota bar and
    // `.note` is the popup's hint, so the manga panel now reads like both.
    const bar = UI().meter(globalThis.GXT.i18n.t("content_manga_bar_1"));
    const note = UI().note('');

    const row = document.createElement('div');
    row.className = 'gxt-linkrow actions';

    body.append(line, bar, note, row);
    panel = { line, bar, note, row, total };
    return panel;
  }

  function setActions(buttons) {
    if (!panel) return;
    panel.row.replaceChildren();
    for (const button of buttons) if (button) panel.row.appendChild(button);
  }

  const button = (label, onClick) => UI().button(label, onClick);

  function paintProgress(done, total, failed) {
    if (!panel) return;
    // The meter owns its own fill and its aria-valuenow, so progress is
    // announced as progress rather than being a silently widening <i>.
    panel.bar.set(total ? done / total : 0, failed ? 'warn' : done >= total ? 'done' : '');
    globalThis.GXT.i18n.bind(panel.line, "textContent", () => (globalThis.GXT.i18n.t("content_manga_paintProgress_2", {v0:(faNum(done)), v1:(faNum(total))})));
    if (failed) globalThis.GXT.i18n.bind(panel.note, "textContent", () => (globalThis.GXT.i18n.t("content_manga_paintProgress_1", {v0:(faNum(failed))})));
  }

  /**
   * Translate a list of pages, streaming each one back into the reader.
   *
   * @param {Array<{el: HTMLImageElement, src: string}>} pages
   * @param {{quiet?: boolean}} options `quiet` is the automatic follow-up run
   *        for pages that appeared later: it must not steal the window.
   */
  async function translateChapter(pages, { quiet = false } = {}) {
    if (settings.enabled === false) return;
    if (run) {
      if (!quiet) UI().toast(globalThis.GXT.i18n.t("content_manga_startHere_2"));
      return;
    }
    if (!pages.length) {
      if (!quiet) UI().toast(globalThis.GXT.i18n.t("content_manga_startHere_1"));
      return;
    }
    // Claimed BEFORE the first await: a page is attempted once per session,
    // succeed or fail, so the automatic follow-up can never re-send it.
    for (const page of pages) attempted.add(page.src);
    const active = { cancelled: false, job: null, done: 0, failed: 0, pages, seen: new Set() };
    run = active;
    if (!quiet) {
      openPanel(pages.length);
      paintProgress(0, pages.length, 0);
      setActions([button(globalThis.GXT.i18n.t("content_manga_translateChapter_4"), () => void cancel())]);
      if (panel) globalThis.GXT.i18n.bind(panel.note, "textContent", () => (globalThis.GXT.i18n.t("content_manga_translateChapter_3")));
    }

    // `finally` rather than a `run = null` on each exit: an unexpected throw
    // anywhere below used to leave `run` set for ever, and every later attempt
    // answered «یک ترجمه در حال اجراست» until the tab was reloaded.
    try {
      const started = await send({
        type: 'MANGA_START',
        urls: pages.map((page) => page.src),
      });
      if (active.cancelled) {
        if (started?.ok && started.job) await send({ type: 'MANGA_CANCEL', job: started.job });
        return void finish(active, started);
      }
      if (!started?.ok) return void failRun(active, started);
      active.job = started.job;
      // The bridge may have refused individual pages (a CDN that would not
      // serve them); it reports which, and the rest of the chapter carries on.
      // `truncated` means the worker hit its memory ceiling — say so, because
      // the alternative reading of "eleven of twenty pages appeared" is that
      // the feature is broken.
      if (panel) {
        const notes = [];
        if (started.skipped?.length) notes.push(globalThis.GXT.i18n.t("content_manga_translateChapter_2", {v0:(faNum(started.skipped.length))}));
        if (started.truncated) {
          notes.push(globalThis.GXT.i18n.t("content_manga_translateChapter_1"));
        }
        if (notes.length) panel.note.textContent = `${notes.join(' — ')}.`;
      }
      const indexMap = started.indexMap || pages.map((_, i) => i);

      for (;;) {
        const status = await send({ type: 'MANGA_STATUS', job: active.job });
        if (active.cancelled) return;
        if (!status?.ok) return void failRun(active, status);
        // Defended, not assumed: a bridge that answered `ok` without a `ready`
        // array would otherwise throw here, and the throw is what wedged the
        // whole module.
        for (const index of Array.isArray(status.ready) ? status.ready : []) {
          if (active.seen.has(index)) continue;
          active.seen.add(index);
          // `indexMap[i]` is where the bridge's page `i` sat in OUR list. The
          // lookup has to go that way round: a page the site refused to serve
          // is dropped before upload, so bridge index and reader index part
          // company at the first failure, and reversing this would paint every
          // page after it with the wrong picture.
          const page = pages[indexMap[index]];
          if (!page) continue;
          const result = await send({ type: 'MANGA_PAGE', job: active.job, index });
          if (active.cancelled) return;
          if (result?.ok && result.dataUrl && page.el.isConnected &&
              imageState(page.el) === page.state && showTranslated(page.el, result.dataUrl)) {
            active.done += 1;
            paintProgress(active.done, pages.length, active.failed);
          }
        }
        active.failed = Object.keys(status.failed || {}).length + (status.failedPages || 0);
        if (status.done) return void finish(active, status);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    } catch (error) {
      if (!active.cancelled) failRun(active, { error: String(error?.message || error) });
    } finally {
      if (run === active) run = null;
      pruneDetached();
    }
  }

  function failRun(active, result) {
    if (active.reported) return;
    active.reported = true;
    const message = UI().friendly(result) || result?.error || globalThis.GXT.i18n.t("content_manga_message_1");
    if (panel) {
      panel.note.textContent = message;
      setActions([button(globalThis.GXT.i18n.t("content_manga_finish_1"), () => closeCard())]);
    } else {
      UI().toast(message);
    }
  }

  /** Paint the final state. Idempotent: `cancel()` and the poll loop can both
   *  reach here for the same run, and the second one used to overwrite
   *  «متوقف شد» with «تمام شد — ۰ از ۰ صفحه» because `run` was already null. */
  function finish(active, status) {
    if (!active || active.reported) return;
    active.reported = true;
    const total = active.pages.length;
    const done = active.done;
    const job = active.job;
    const cancelled = active.cancelled;
    if (!panel) return;
    paintProgress(done, total, status?.failedPages || 0);
    globalThis.GXT.i18n.bind(panel.line, "textContent", () => (cancelled
      ? globalThis.GXT.i18n.t("content_manga_finish_5", {v0:(faNum(done))})
      : globalThis.GXT.i18n.t("content_manga_finish_4", {v0:(faNum(done)), v1:(faNum(total))})));
    if (!cancelled && status?.elapsed) {
      globalThis.GXT.i18n.bind(panel.note, "textContent", () => (globalThis.GXT.i18n.t("content_manga_finish_3", {v0:(faNum(Math.round(status.elapsed)))})));
    }
    const actions = [
      button(globalThis.GXT.i18n.t("content_manga_actions_2"), function toggle() {
        const showingOriginal = this.dataset.state === 'orig';
        setAllTranslated(showingOriginal);
        this.dataset.state = showingOriginal ? 'fa' : 'orig';
        globalThis.GXT.i18n.bind(this, "textContent", () => (showingOriginal ? globalThis.GXT.i18n.t("content_manga_actions_2") : globalThis.GXT.i18n.t("content_manga_actions_1")));
      }),
    ];
    if (done > 0 && job) actions.push(button(globalThis.GXT.i18n.t("content_manga_finish_2"), () => void downloadArchive(job)));
    actions.push(button(globalThis.GXT.i18n.t("content_manga_finish_1"), () => closeCard()));
    setActions(actions);
  }

  async function cancel() {
    const active = run;
    if (!active) return;
    active.cancelled = true;
    // The network may never answer. Release ownership immediately; callbacks
    // retain `active` and cannot finish a later run's panel.
    if (run === active) run = null;
    // A user who stops a chapter does not want the watcher restarting one the
    // moment the reader loads another image.
    stopWatching();
    const job = active.job;
    if (panel) globalThis.GXT.i18n.bind(panel.note, "textContent", () => (globalThis.GXT.i18n.t("content_manga_cancel_1")));
    finish(active, null);
    if (job) await send({ type: 'MANGA_CANCEL', job });
  }

  /** A file name a filesystem will actually accept: the reserved characters
   *  go, control characters go, and so do leading/trailing dots and spaces
   *  (Windows silently mangles a name ending in either), with a fallback for a
   *  title made of nothing else. */
  function safeFileName(raw, fallback) {
    const name = String(raw || '')
      .slice(0, 60)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .trim();
    return name || fallback;
  }

  /** The finished chapter as a CBZ — the format every reader on the machine
   *  already opens, and the only way this work outlives the browser tab. */
  async function downloadArchive(job) {
    if (panel) globalThis.GXT.i18n.bind(panel.note, "textContent", () => (globalThis.GXT.i18n.t("content_manga_downloadArchive_3")));
    const result = await send({ type: 'MANGA_ARCHIVE', job });
    if (!result?.ok || !result.dataUrl) {
      if (panel) globalThis.GXT.i18n.bind(panel.note, "textContent", () => (result?.error || globalThis.GXT.i18n.t("content_manga_downloadArchive_2")));
      return;
    }
    // A chapter archive is tens of megabytes. As a data: URL that is a base64
    // STRING of it held in an attribute — a third larger than the file and
    // copied on every read. A blob: URL hands the browser the bytes once.
    let href = result.dataUrl;
    let blobUrl = '';
    try {
      const comma = result.dataUrl.indexOf(',');
      const binary = atob(result.dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.comicbook+zip' }));
      href = blobUrl;
    } catch {
      /* decode failed: the data URL still works, just less efficiently */
    }
    const link = document.createElement('a');
    link.href = href;
    link.download = `${safeFileName(document.title, 'chapter')}_fa.cbz`;
    link.click();
    // Revoked on the next turn: the click has already started the download by
    // then, and holding the blob would keep the whole chapter in memory.
    if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    if (panel) globalThis.GXT.i18n.bind(panel.note, "textContent", () => (globalThis.GXT.i18n.t("content_manga_downloadArchive_1")));
  }

  // ------------------------------------------------------- pages that arrive late

  /**
   * A reader that loads pages as you scroll is the normal case, not the
   * exception — so a chapter translated on arrival would be half untranslated
   * by the time it is read. This watches for pages that appear afterwards and
   * runs them as a quiet follow-up.
   *
   * Debounced hard: a lazy loader inserts images in bursts, and starting a run
   * per image would be one cold pipeline per page — the exact cost this whole
   * feature exists to avoid.
   */
  let observer = null;
  let followUpTimer = null;

  function watchForNewPages() {
    if (observer || !IS_TOP) return;
    observer = new MutationObserver(() => {
      clearTimeout(followUpTimer);
      followUpTimer = setTimeout(() => {
        if (run) return;                       // a run is already in flight
        // `attempted` is the load-bearing filter, not `translated`/`originals`:
        // those record only SUCCESS, so a failed or site-refused page looked
        // new on every scan and was re-sent for ever (see `attempted`).
        const fresh = collectPages().filter((page) => !attempted.has(page.src));
        if (fresh.length) void translateChapter(fresh, { quiet: true });
      }, 2500);
    });
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['src', 'srcset', 'sizes', 'media', 'type'],
    });
  }

  function stopWatching() {
    observer?.disconnect();
    observer = null;
    clearTimeout(followUpTimer);
  }

  // ------------------------------------------------------------------ entry

  async function startHere({ auto = false } = {}) {
    if (settings.enabled === false) return;
    if (run) { UI().toast(globalThis.GXT.i18n.t("content_manga_startHere_2")); return; }
    const pages = collectPages();
    if (!pages.length) {
      UI().toast(globalThis.GXT.i18n.t("content_manga_startHere_1"));
      return;
    }
    // An explicit «ترجمهٔ همهٔ صفحه‌های این فصل» IS the retry: clear the
    // attempt-once ledger so pages that failed last time are tried again.
    // (The automatic follow-up never does this — that is the whole point.)
    attempted.clear();
    if (auto) watchForNewPages();
    await translateChapter(pages);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!IS_TOP) return;
    if (message?.type === 'GXT_MANGA_CHAPTER') void startHere({ auto: !!message.auto });
    else if (message?.type === 'GXT_MANGA_STOP') void cancel();
  });

  globalThis.GXT.onStorageChanged?.(({ settings: next }) => {
    if (!next) return;
    const before = settings;
    settings = next;
    if (next.enabled === false || (before && globalThis.GXT.cacheNamespace?.(before) !==
        globalThis.GXT.cacheNamespace?.(next))) {
      stopWatching();
      void cancel();
    }
  });
  void globalThis.GXT.getSettings?.().then((next) => { if (next) settings = next; }).catch(() => {});

  globalThis.GXT.manga = {
    startHere,
    cancel,
    setAllTranslated,
    stopWatching,
    _internal: {
      looksLikePage,
      collectPages,
      showTranslated,
      showOriginal,
      sizeOf,
      MIN_WIDTH,
      MIN_HEIGHT,
      MAX_ASPECT,
      MAX_PAGES,
      originals,
      translated,
      attempted,
      pruneDetached,
      isRunning: () => !!run,
    },
  };
})();
