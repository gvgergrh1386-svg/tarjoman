/**
 * Selection + full-page translation module.
 *
 * Injected on demand (context menu / activeTab) into any http(s) page, and
 * auto-registered for the user's auto-translate sites. Never loaded on X or
 * YouTube in auto mode — those have dedicated pipelines.
 *
 * All UI lives in a closed world: a shadow root with its own styles, so no
 * page CSS can break it and it can't break any page. Everything is fully
 * restorable with one click.
 *
 * v1.8.0 — the page engine gained four opt-in superpowers (each behind its
 * own setting, defaults preserve the 1.6 behavior):
 *  - pageBlockMode (default ON — quality fix): sentences translate as whole
 *    block units; inline formatting (<a>/<b>/<em>…) is carried through the
 *    model as numbered <gN> tags and rebuilt, so a sentence broken across
 *    links/bold spans no longer turns into disconnected fragments.
 *  - pageDynamic: after the first pass a MutationObserver + Intersection-
 *    Observer keep translating content as it appears/scrolls in (SPAs,
 *    infinite scroll, menus opened later). Off-screen content costs nothing.
 *  - pageBilingual: the Persian appears under the original instead of
 *    replacing it (requires block mode).
 *  - pageAttrs: placeholder / title / alt / aria-label get translated too.
 *  - pageFrames: same-page iframes are translated as well (UI stays in the
 *    top frame; subframes work silently).
 * Plus: chunks run several-at-a-time, a floating «ترجمه» chip after selecting
 * text (selectionButton), a Persian summary card (GXT_SUMMARY) and the
 * image-translation result card (GXT_IMAGE_*).
 *
 * v2.1.0 — a full audit of this engine, driven by "it has problems":
 *  - open SHADOW ROOTS are translated. Anything built from web components
 *    used to report "done" over an untouched page, because neither
 *    querySelectorAll nor a TreeWalker crosses that boundary.
 *  - an OVERSIZED unit no longer demotes its whole subtree to the node
 *    engine. One stray text node high in the document used to drag the entire
 *    page down to per-text-node translation — the exact fragmentation block
 *    mode exists to avoid.
 *  - `dir="auto"` is no longer stamped on flex/grid containers, where it
 *    REVERSES child order. That was the "translation broke the layout" bug:
 *    navigation bars, toolbars and card rows flipping.
 *  - BILINGUAL mode no longer deep-clones block placeholders, which used to
 *    duplicate every image/video/button inside a translated block.
 *  - the TAB TITLE translates (and restores) with the page.
 *  - SPA route changes are detected, so a translated page that swaps its
 *    content keeps working instead of freezing on a stale "done".
 *  - URLs, e-mails, asset paths and hashes are never sent (quota + safety).
 *  - the pill gained an in-context «پیوسته» toggle, and all in-page UI moved
 *    to the shared content/ui.js layer (drag + opacity control included).
 */
'use strict';
(() => {
  if (globalThis.__gxtPageLoaded) return;
  globalThis.__gxtPageLoaded = true;
  if (!globalThis.chrome?.runtime?.id) return;

  const IS_TOP = window.self === window.top;

  const SKIP_HOSTS = /(^|\.)((x|twitter)\.com|youtube\.com)$/i;
  const SKIP_SELECTOR =
    'script,style,noscript,textarea,input,select,option,code,pre,kbd,samp,svg,' +
    '[contenteditable=""],[contenteditable="true"],[data-gxt-sig],.gxt-box,.gxt-linkrow,' +
    '.gxt-bi,.gxt-imgbtn,.gxt-compose-chip';
  const ARABIC_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
  const LETTER_RE = /\p{L}/gu;
  const faNum = (n) => globalThis.GXT.i18n ? globalThis.GXT.i18n.number(n) : Number(n || 0).toLocaleString('fa-IR');

  let settings = null;

  const send = async (message) => {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  };

  // The shared in-page UI layer (content/ui.js) owns the shadow root, the
  // design tokens, the card component (drag + «◐/●» opacity control) and the
  // failure rendering — so this module and the X image card are literally the
  // same window.
  const UI = () => globalThis.GXT.ui;
  const friendly = (result) => UI().friendly(result);

  // ------------------------------------------------------- UI (shared layer)
  //
  // Everything drawn on the page comes from content/ui.js: one shadow root,
  // one token-driven stylesheet, one card component. That is what makes the
  // page card, the selection card and the X image card the same window.

  const shadow = () => UI().root();

  function toast(text, ms = 4000) {
    if (!IS_TOP) return;
    UI().toast(text, ms);
  }

  const button = (label, onClick, cls) => UI().button(label, onClick, cls);

  // ------------------------------------------------------------ result card

  /** @type {ReturnType<typeof globalThis.GXT.ui.card>|null} */
  let card = null;

  function closeCard() {
    const open = card;
    card = null;
    open?.close();
  }

  /** Re-clamp after a content change (the card grows when a translation lands). */
  function clampCard() {
    card?.clamp();
  }

  /**
   * Open the result window. `anchorRect` is the selection rectangle when there
   * is one, so the card appears where the user is looking.
   * @returns {HTMLElement} the body element to write into
   */
  function openCard(anchorRect, titleText = globalThis.GXT.i18n.t("content_page_translate_openCard_1"), options = {}) {
    card = UI().card({
      title: titleText,
      anchorRect,
      ...options,
      onClose: () => {
        card = null;
      },
    });
    return card.body;
  }

  const showFailureInCard = (body, failure) => UI().showFailure(body, failure);


  // -------------------------------------------------------------- selection

  async function translateSelection(fallbackText) {
    const selection = window.getSelection();
    let text = selection && String(selection).trim() ? String(selection) : fallbackText || '';
    text = text.trim();
    if (!text) {
      toast(globalThis.GXT.i18n.t("content_page_translate_translateSelection_2"));
      return;
    }
    let rect = null;
    try {
      if (selection?.rangeCount) rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch {
      /* keep centered */
    }
    const body = openCard(rect);
    globalThis.GXT.i18n.bind(body, "textContent", () => (globalThis.GXT.i18n.t("content_page_translate_translateSelection_1")));
    body.classList.add('dots');
    const parts = text
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    const res = await send({ type: 'TRANSLATE_TEXTS', texts: parts, kind: 'selection' });
    // Closed while loading — or superseded by a newer card, whose body is a
    // different element. Either way this response has nowhere to go.
    if (!card || !body.isConnected) return;
    body.classList.remove('dots');
    const failure = res?.ok ? res.failed : res;
    if (!res?.ok || (res.failed && res.list.every((t) => t == null))) {
      showFailureInCard(body, failure);
      return;
    }
    body.textContent = res.list.map((t, i) => t ?? parts[i]).join('\n\n');
    clampCard();
  }

  // --------------------------------------------- selection chip (v1.8, opt-in)

  let selChip = null;
  function hideSelChip() {
    selChip?.remove();
    selChip = null;
  }

  function maybeShowSelChip() {
    if (!IS_TOP || !settings?.selectionButton || !settings?.enabled) return;
    const selection = window.getSelection();
    const text = selection ? String(selection).trim() : '';
    if (!text || text.length < 2 || !selection.rangeCount) {
      hideSelChip();
      return;
    }
    let rect;
    try {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch {
      return;
    }
    if (!rect || (!rect.width && !rect.height)) return;
    const r = shadow();
    if (!selChip || !selChip.isConnected) {
      selChip = document.createElement('div');
      selChip.className = 'selchip';
      /**
       * One action in the selection pill.
       *
       * pointerdown, not click: the page clears the selection on mousedown, so
       * by click time there would be nothing left to translate.
       *
       * v2.9.0 — a real <button>. These were <span>s, which meant the pill was
       * operable with a pointer and with nothing else, and announced as loose
       * text. As a button it is focusable and Enter/Space-activated for free;
       * `keydown` is still handled explicitly because the pointerdown handler
       * above suppresses the synthetic click a button would otherwise fire.
       */
      const part = (labelText, title, run) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'selchip-part';
        button.textContent = labelText;
        button.title = title;
        button.setAttribute('aria-label', title);
        const fire = (event) => {
          event.preventDefault();
          event.stopPropagation();
          hideSelChip();
          run();
        };
        button.addEventListener('pointerdown', fire);
        button.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') fire(event);
        });
        selChip.appendChild(button);
      };
      part(globalThis.GXT.i18n.t("content_page_translate_maybeShowSelChip_3"), globalThis.GXT.i18n.t("content_page_translate_maybeShowSelChip_2"), () => void translateSelection(''));
      // v2.5.1 — the same pill also reads the selection aloud, so speech is one
      // click away on every site instead of only on X.
      if (settings?.ttsButton !== false) {
        part('🔊', globalThis.GXT.i18n.t("content_page_translate_maybeShowSelChip_1"), () => readSelection('', false));
      }
      r.appendChild(selChip);
    }
    const margin = 8;
    selChip.style.left = `${Math.min(Math.max(margin, rect.right - 30), innerWidth - 80)}px`;
    selChip.style.top = `${Math.min(Math.max(margin, rect.bottom + 8), innerHeight - 42)}px`;
  }

  // ---------------------------------------------------------- summary (v1.8)

  function extractMainText() {
    const rootEl =
      document.querySelector('article') || document.querySelector('main') || document.body;
    return (rootEl?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 60000);
  }

  async function summarize(fallbackText) {
    const selection = window.getSelection();
    let text = selection && String(selection).trim() ? String(selection).trim() : '';
    if (!text) text = (fallbackText || '').trim();
    if (!text) text = extractMainText();
    if (!text) {
      toast(globalThis.GXT.i18n.t("content_page_translate_summarize_2"));
      return;
    }
    const body = openCard(null, globalThis.GXT.i18n.t("content_page_translate_body_2"));
    globalThis.GXT.i18n.bind(body, "textContent", () => (globalThis.GXT.i18n.t("content_page_translate_summarize_1")));
    body.classList.add('dots');
    const res = await send({ type: 'TRANSLATE_SUMMARY', text });
    if (!card || !body.isConnected) return;
    body.classList.remove('dots');
    if (!res?.ok) {
      showFailureInCard(body, res);
      return;
    }
    body.textContent = res.t;
    clampCard();
  }

  // ---------------------------------------------------- read aloud (v2.5.1)
  //
  // The speech engine (content/ui.js → background/tts.js) was never specific
  // to X; only its ENTRY POINTS were. On X a 🔊 sits on every translation
  // card, and everywhere else there was no way in at all. These are the ways
  // in — the right-click menu, the selection chip and a shortcut — all landing
  // in one function, on every site.
  //
  // What gets spoken is what the user is looking at. Text already in Persian
  // is read as it stands; anything else is translated first and the Persian is
  // read, which is precisely what the X button does. That rule also means
  // «خواندن این صفحه» on a page already translated by this extension reads the
  // translation, with no second trip to the model.

  /** Speech is expensive and a whole site can be enormous; past this the read
   *  is truncated rather than left to run for an hour. */
  const READ_MAX_CHARS = 20000;
  /** Below this share of Persian letters, the text is treated as foreign. Not
   *  1.0: a Persian paragraph routinely carries Latin names and numbers. */
  const READ_FA_RATIO = 0.35;

  function persianRatio(text) {
    const letters = String(text || '').match(LETTER_RE);
    if (!letters?.length) return 0;
    let fa = 0;
    for (const letter of letters) if (ARABIC_RE.test(letter)) fa += 1;
    return fa / letters.length;
  }

  /**
   * Read text aloud, translating it to Persian first when it is not already.
   *
   * @param {string} sourceText what to read
   * @param {{toggle?: boolean, anchorRect?: DOMRect|null, label?: string}} options
   *        `toggle` makes a second invocation a STOP instead of a restart —
   *        the shortcut needs that, a menu click does not.
   */
  async function readAloud(sourceText, { toggle = false, anchorRect = null, label = globalThis.GXT.i18n.t("content_page_translate_readAloud_3") } = {}) {
    // Already reading: this is a stop. The shortcut is therefore a play/stop
    // switch on one key, and speech can never be left running invisibly.
    if (UI().isSpeaking()) {
      UI().stopSpeech();
      if (toggle) return;
    }
    const text = (sourceText || '').trim().slice(0, READ_MAX_CHARS);
    if (!text) {
      toast(globalThis.GXT.i18n.t("content_page_translate_readAloud_2"));
      return;
    }

    // `speak: true` — this card's whole purpose is the 🔊, so it carries one
    // even for a user who turned the button off on translation cards.
    const body = openCard(anchorRect, label, { speak: true });
    const opened = card;

    let speech = text;
    if (persianRatio(text) < READ_FA_RATIO && settings?.ttsTranslateFirst !== false) {
      globalThis.GXT.i18n.bind(body, "textContent", () => (globalThis.GXT.i18n.t("content_page_translate_readAloud_1")));
      body.classList.add('dots');
      const parts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).slice(0, 200);
      const res = await send({ type: 'TRANSLATE_TEXTS', texts: parts, kind: 'selection' });
      // Card closed, or replaced by a newer one, while the model worked.
      if (card !== opened || !body.isConnected) return;
      body.classList.remove('dots');
      if (!res?.ok || res.list.every((t) => t == null)) {
        showFailureInCard(body, res?.ok ? res.failed : res);
        return;
      }
      speech = res.list.map((t, i) => t ?? parts[i]).join('\n\n');
    }
    // The card reads its own body, so the text has to be in place first.
    body.textContent = speech;
    clampCard();
    opened.startSpeaking();
  }

  /** The selection, or what the menu captured before the click cleared it. */
  function readSelection(fallbackText, toggle) {
    const selection = window.getSelection();
    const selected = selection && String(selection).trim() ? String(selection).trim() : '';
    let rect = null;
    try {
      if (selected && selection?.rangeCount) rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch {
      /* keep centered */
    }
    const text = selected || (fallbackText || '').trim();
    // Nothing selected and nothing captured: the shortcut still has an obvious
    // meaning — read what is on screen.
    if (!text) return void readAloud(extractMainText(), { toggle, get label() { return globalThis.GXT.i18n.t("content_page_translate_message_1"); } });
    return void readAloud(text, { toggle, anchorRect: rect });
  }

  // ------------------------------------------------- image result card (v1.8)

  let imageBody = null;
  function onImageBegin() {
    imageBody = openCard(null, globalThis.GXT.i18n.t("content_composer_ensureImageButton_2"));
    globalThis.GXT.i18n.bind(imageBody, "textContent", () => (globalThis.GXT.i18n.t("content_composer_ensureImageButton_1")));
    imageBody.classList.add('dots');
  }

  function onImageResult(res) {
    if (!card || !imageBody || !imageBody.isConnected) return;
    imageBody.classList.remove('dots');
    if (res?.ok) {
      imageBody.textContent = res.t;
      clampCard();
    } else {
      showFailureInCard(imageBody, res);
    }
  }

  // ------------------------------------------- manga hand-off card (v2.5.1)
  //
  // The vision path above returns TEXT, and a card is the whole answer. The
  // local pipeline returns a rebuilt PAGE — the original art with the Persian
  // lettering typeset back into the bubbles — and the right place for that is
  // the page being read, not a file path in a toast. So the translated image
  // replaces the one on screen, and the original is one click away.

  /** @type {Map<HTMLImageElement, {src: string, srcset: string, sources: Array<{el: HTMLSourceElement, srcset: string}>}>} */
  const mangaOriginals = new Map();
  let mangaBody = null;
  let mangaTarget = null;

  /** The <img> the context menu was invoked on.
   *  `currentSrc` first: with a srcset the element's `src` is not what is
   *  actually displayed, and it is the displayed URL Chrome reports. */
  function findImageBySrc(src) {
    if (!src) return null;
    const images = Array.from(document.images || []);
    return (
      images.find((img) => img.currentSrc === src) ||
      images.find((img) => img.src === src) ||
      null
    );
  }

  function rectOfElement(el) {
    try {
      const rect = el?.getBoundingClientRect();
      return rect && (rect.width || rect.height) ? rect : null;
    } catch {
      return null;
    }
  }

  /** Show `dataUrl` in place of the page's own image, remembering everything
   *  needed to put it back. A responsive image ignores `src` while `srcset`
   *  still points at the original, so every source is neutralised too. */
  function swapImage(img, dataUrl) {
    if (!img) return false;
    if (!mangaOriginals.has(img)) {
      const picture = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : null;
      mangaOriginals.set(img, {
        src: img.getAttribute('src') || '',
        srcset: img.getAttribute('srcset') || '',
        sources: picture
          ? Array.from(picture.querySelectorAll('source')).map((el) => ({
              el,
              srcset: el.getAttribute('srcset') || '',
            }))
          : [],
      });
    }
    const saved = mangaOriginals.get(img);
    for (const source of saved.sources) source.el.removeAttribute('srcset');
    img.removeAttribute('srcset');
    img.src = dataUrl;
    img.dataset.gxtManga = '1';
    return true;
  }

  function restoreImage(img) {
    const saved = mangaOriginals.get(img);
    if (!saved) return;
    for (const source of saved.sources) source.el.setAttribute('srcset', source.srcset);
    if (saved.srcset) img.setAttribute('srcset', saved.srcset);
    if (saved.src) img.setAttribute('src', saved.src);
    delete img.dataset.gxtManga;
    mangaOriginals.delete(img);
  }

  function onMangaBegin(src) {
    mangaTarget = findImageBySrc(src);
    mangaBody = openCard(rectOfElement(mangaTarget), globalThis.GXT.i18n.t("content_page_translate_onMangaBegin_2"));
    globalThis.GXT.i18n.bind(mangaBody, "textContent", () => (globalThis.GXT.i18n.t("content_page_translate_onMangaBegin_1")));
    mangaBody.classList.add('dots');
  }

  function onMangaResult(src, res) {
    if (!card || !mangaBody || !mangaBody.isConnected) return;
    mangaBody.classList.remove('dots');
    if (!res?.ok) {
      showFailureInCard(mangaBody, res);
      return;
    }
    mangaBody.textContent = '';
    // The element may have been re-created while the pipeline ran (lazy
    // loaders swap images constantly), so look again rather than trust the
    // one found at the start.
    const img = mangaTarget?.isConnected ? mangaTarget : findImageBySrc(src);
    const swapped = res.dataUrl ? swapImage(img, res.dataUrl) : false;

    const line = document.createElement('div');
    globalThis.GXT.i18n.bind(line, "textContent", () => (swapped
      ? globalThis.GXT.i18n.t("content_page_translate_onMangaResult_6")
      : res.dataUrl
        ? globalThis.GXT.i18n.t("content_page_translate_onMangaResult_5")
        : globalThis.GXT.i18n.t("content_page_translate_onMangaResult_4", {v0:(res.file || res.dir || '')})));
    mangaBody.appendChild(line);
    // A page that defeated the pipeline is still written out — as the
    // original. Saying so beats handing back an untranslated page as success.
    if (res.failedPages) {
      // v3.2.5 — `.note`, not `opacity: 0.75`. Fading text is the one thing this
      // design system refuses to call a hierarchy: `--gxt-fg-muted` is derived to
      // clear 10:1 on the card's own composited surface, and this particular line
      // is the only place the user is told their page came back untranslated.
      mangaBody.appendChild(
        UI().note(
          globalThis.GXT.i18n.t("content_page_translate_onMangaResult_3", {v0:(res.note ? ` — ${res.note}` : '')})
        )
      );
    }

    if (res.dataUrl && !swapped) {
      // `.thumb`: the design system's radius and hairline instead of a literal
      // 8px corner with no edge at all.
      mangaBody.appendChild(UI().thumb(res.dataUrl, globalThis.GXT.i18n.t("content_page_translate_onMangaResult_2")));
    }

    const row = document.createElement('div');
    row.className = 'gxt-linkrow';
    if (swapped) {
      const toggle = button(globalThis.GXT.i18n.t("content_manga_actions_2"), () => {
        if (mangaOriginals.has(img)) {
          restoreImage(img);
          globalThis.GXT.i18n.bind(toggle, "textContent", () => (globalThis.GXT.i18n.t("content_page_translate_toggle_1")));
        } else {
          swapImage(img, res.dataUrl);
          globalThis.GXT.i18n.bind(toggle, "textContent", () => (globalThis.GXT.i18n.t("content_manga_actions_2")));
        }
      });
      row.appendChild(toggle);
    }
    if (res.dataUrl) {
      row.appendChild(button(globalThis.GXT.i18n.t("content_page_translate_onMangaResult_1"), () => {
        const link = document.createElement('a');
        link.href = res.dataUrl;
        link.download = (res.file || 'manga').split(/[\\/]/).pop() || 'manga.png';
        link.click();
      }));
    }
    if (row.childNodes.length) mangaBody.appendChild(row);
    clampCard();
  }

  // ------------------------------------------------------------- full page
  //
  // Two extraction engines share one restore/translate pipeline:
  //  - BLOCK engine (v1.8, default): whole block elements as units, inline
  //    formatting carried as <gN> tags, embedded elements as ⟦n⟧ tokens.
  //  - NODE engine (pre-1.8 fallback): individual text nodes.

  /** @type {Map<Text, string>} translated node -> original nodeValue */
  const restoreMap = new Map();
  /** @type {Map<Element, Node[]>} block unit -> its original child nodes */
  const unitRestore = new Map();
  /** @type {Element[]} bilingual blocks we inserted */
  const biNodes = [];
  /** @type {Array<{el: Element, attr: string, original: string}>} */
  const attrRestore = [];
  /** @type {Element[]} parents/units that received dir="auto" */
  const dirTouched = [];
  // [element, the lang it had before] for everything this run re-declared as
  // Persian (v2.9.5). The PREVIOUS value is kept, not just the fact that we
  // touched it, so restoring a page that legitimately said lang="en" puts
  // that back instead of stripping it.
  const langTouched = [];
  /** Session translation memory: source text -> Persian. */
  const doneTexts = new Map();
  const DONE_MAX = 5000;
  /** Units already handled (either engine), so dynamic mode never re-queues.
   *  Recreated on restore — a fresh run must be able to see everything again. */
  let seenUnits = new WeakSet();

  let pageState = 'idle'; // 'idle' | 'running' | 'done'
  let cancelRequested = false;
  let pageGeneration = 0;
  let dynamicOn = false;
  let dynamicCount = 0;
  let pill = null;
  let pillLabel = null;
  let pillActions = null;
  /** Options snapshot taken when a page run starts. */
  let run = null;

  /** Has this run actually changed anything on the page? Drives whether the
   *  menu item / shortcut means "translate" or "restore". */
  function translatedSomething() {
    return !!(
      restoreMap.size ||
      unitRestore.size ||
      biNodes.length ||
      attrRestore.length ||
      titleOriginal !== null
    );
  }

  function rememberText(key, value) {
    if (doneTexts.size >= DONE_MAX) doneTexts.delete(doneTexts.keys().next().value);
    doneTexts.set(key, value);
  }

  function pillShow(text, actions = []) {
    if (!IS_TOP) return;
    const r = shadow();
    if (!pill || !pill.isConnected) {
      pill = document.createElement('div');
      pill.className = 'pill';
      pillLabel = document.createElement('span');
      pillLabel.className = 'pill-label';
      /**
       * The pill is the ONLY progress channel full-page translation has —
       * «در حال ترجمهٔ صفحه… ۴/۱۲», «صفحه ترجمه شد ✓», «ترجمه متوقف شد» — and
       * until v2.9.5 it was an inert <span>. A screen-reader user who asked for
       * a page translation was told nothing: not that it had started, not how
       * far it had got, not that it had finished or failed (WCAG 4.1.3, Status
       * Messages, Level AA). The toast and the card body were already live
       * regions, so this was an inconsistency as much as a gap.
       *
       * The live region is the LABEL, not the pill: the pill also holds
       * buttons, and marking the container live would re-announce «لغو» and
       * «بازگرداندن» on every repaint. `atomic` because "۴/۱۲" only means
       * anything read whole, and updates arrive one per completed chunk — a
       * network round-trip apart — which is the cadence polite regions are for.
       */
      pillLabel.setAttribute('role', 'status');
      pillLabel.setAttribute('aria-live', 'polite');
      pillLabel.setAttribute('aria-atomic', 'true');
      // `.actions` (v3.2.5) — the same flex row the card header uses, so the
      // pill's button gap steps with density instead of being a literal 6px.
      pillActions = document.createElement('span');
      pillActions.className = 'actions';
      // The opacity control is part of the bar itself, not of the action set:
      // it must stay reachable in EVERY state, including mid-translation when
      // the only other action is «لغو» (v2.1.0).
      pill.append(pillLabel, pillActions, UI().opaqueToggle());
      r.appendChild(pill);
    }
    pillLabel.textContent = text;
    pillActions.replaceChildren(...actions);
  }

  function pillHide() {
    pill?.remove();
    pill = null;
  }

  /** Re-run the whole page translation (restore first for a clean slate).
   *  Already-translated lines are L2-cache hits, so this rarely costs API. */
  function reRunPage() {
    restorePage();
    void runPage();
  }

  /** Flip bilingual (original + Persian) display and re-run so it applies to
   *  the page that is already translated, not just future pages. The choice is
   *  persisted; bilingual needs block mode, so that is enabled alongside it. */
  function toggleBilingual() {
    const on = !settings?.pageBilingual;
    if (settings) {
      settings.pageBilingual = on;
      if (on) settings.pageBlockMode = true;
    }
    void globalThis.GXT?.setSettings?.(
      on ? { pageBilingual: true, pageBlockMode: true } : { pageBilingual: false }
    );
    reRunPage();
  }

  /** Turn continuous translation on (or off) for the page in front of the
   *  user, not just the next one. Switching it ON immediately starts the
   *  observers, so content that arrives later — infinite scroll, a menu, an
   *  SPA route — keeps translating without another click (v2.1.0). */
  function toggleDynamic() {
    const on = !dynamicOn;
    if (settings) settings.pageDynamic = on;
    void globalThis.GXT?.setSettings?.({ pageDynamic: on });
    if (on) {
      if (run) run.dynamic = true;
      startDynamic();
    } else {
      stopDynamic();
    }
  }

  /** Controls shown once a page finishes translating: in-context toggles for
   *  bilingual display and continuous translation (settings the feature
   *  otherwise only exposed in the popup, and only for the NEXT page), a
   *  re-translate, restore/close, and an error-details button when a chunk
   *  failed. */
  function pageDoneActions(failure) {
    const biOn = !!settings?.pageBilingual;
    const acts = [
      button(biOn ? globalThis.GXT.i18n.t("content_page_translate_acts_3") : globalThis.GXT.i18n.t("content_page_translate_acts_2"), toggleBilingual, biOn ? 'on' : ''),
      button(globalThis.GXT.i18n.t("content_page_translate_acts_1"), toggleDynamic),
      button(globalThis.GXT.i18n.t("content_page_translate_runPageInner_3"), reRunPage, 'accent'),
    ];
    if (failure) {
      acts.push(
        button(globalThis.GXT.i18n.t("content_page_translate_pageDoneActions_1"), () => {
          const body = openCard(null, globalThis.GXT.i18n.t("content_page_translate_body_1"));
          showFailureInCard(body, failure);
        })
      );
    }
    acts.push(button(globalThis.GXT.i18n.t("content_page_translate_dynamicPill_1"), restorePage), button('✕', pillHide));
    return acts;
  }

  function skipped(el) {
    return !el || el.closest(SKIP_SELECTOR) || UI().contains(el);
  }

  /** Strings that are never prose: a bare URL, an e-mail, a file/asset path,
   *  a hex/hash blob. Sending these wastes a quota slot AND risks the model
   *  "translating" an identifier the page depends on (v2.1.0). */
  const NON_PROSE_RE =
    /^(?:https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+|[\w./-]+\.(?:js|css|png|jpe?g|svg|gif|webp|woff2?|json|xml|pdf)|[0-9a-f]{16,}|[A-Za-z0-9+/=_-]{40,})$/i;

  function translatableRatioOk(raw) {
    const text = raw.trim();
    if (!text || NON_PROSE_RE.test(text)) return false;
    const letters = text.match(LETTER_RE) || [];
    if (letters.length < 2) return false;
    // Script is not language: Arabic, Urdu and Persian must all reach
    // automatic source detection. Providers can retain already-target text.
    return true;
  }

  function visible(el) {
    try {
      return !el.checkVisibility || el.checkVisibility();
    } catch {
      return true;
    }
  }

  /**
   * May we stamp `dir="auto"` on this element?
   *
   * `dir` is not only a text-direction hint: on a flex or grid container it
   * REVERSES the layout order of the children. Marking every translated unit
   * `dir="auto"` therefore flipped navigation bars, toolbars and card rows on
   * a lot of real sites — one of the most visible "page translation breaks the
   * page" bugs (v2.1.0). Text blocks still get the attribute, which is where
   * it actually matters for Persian punctuation.
   */
  function canSetDir(el) {
    try {
      return !/flex|grid/.test(getComputedStyle(el).display);
    } catch {
      return true; // detached/unstyled: harmless
    }
  }

  function markDir(el, allowed) {
    if (!el) return;
    /**
     * `lang` first, and unconditionally — v2.9.5.
     *
     * A screen reader chooses its voice and its pronunciation rules from
     * `lang`. Persian left sitting inside an `<html lang="en">` document is
     * handed to an English speech engine, which either applies English
     * phonetics to Arabic script or skips the run entirely — so the blind
     * user of a TRANSLATION extension received nothing at all from it. That
     * is WCAG 3.1.2 (Language of Parts, Level AA), and it is the one
     * accessibility rule this particular product exists to satisfy.
     *
     * It is set even where `dir` is refused: `dir` is withheld on flex and
     * grid containers because it REVERSES their children, whereas `lang`
     * changes no layout whatsoever. Withholding both would have left the
     * navigation bars and toolbars — exactly the places the dir guard
     * protects — silently unreadable.
     *
     * It OVERWRITES an existing declaration rather than deferring to it. An
     * `<article lang="en">` is ordinary markup, and once its text has been
     * replaced with Persian that attribute is not merely unhelpful, it is a
     * confident lie — the screen reader would pick an English voice BECAUSE
     * the page asked it to. The previous value is kept so restore is exact.
     */
    if (el.lang !== (settings.targetLang || 'fa')) {
      langTouched.push([el, el.getAttribute('lang')]);
      el.lang = settings.targetLang || 'fa';
    }
    if (el.getAttribute('dir')) return;
    // `allowed` is measured once at COLLECTION time, before anything on the
    // page has been mutated. Calling getComputedStyle from the apply path
    // instead would force a synchronous layout between every two writes —
    // hundreds of reflows on a large page.
    if (allowed === undefined ? !canSetDir(el) : !allowed) return;
    el.setAttribute('dir', 'auto');
    dirTouched.push(el);
  }

  /** Work entry for the block engine: the serialized unit plus the one style
   *  question we must answer before the page starts changing under us. */
  function makeUnitMeta(unit) {
    const meta = serializeUnit(unit);
    meta.dirOk = canSetDir(unit);
    return meta;
  }

  /** Work entry for the node engine, same reasoning. */
  function makeNodeWork(node) {
    return { node, original: node.nodeValue, dirOk: canSetDir(node.parentElement) };
  }


  // ------------------------------------------------------------ NODE engine

  /**
   * Every translatable text node under `rootEl`, INCLUDING the ones inside
   * open shadow roots (v2.1.0).
   *
   * Web components render their real content in a shadow root, which neither
   * querySelectorAll nor a TreeWalker enters — so on a site built from custom
   * elements the translator used to find a handful of light-DOM strings and
   * report "done" over an untouched page. The walk visits elements as well as
   * text so shadow hosts are discovered in the SAME pass (and a skipped
   * subtree is pruned whole instead of being re-tested per text node).
   * Closed roots remain invisible — nothing can reach those.
   */
  function collectNodes(rootEl) {
    const base = rootEl || document.body;
    if (!base) return [];
    const nodes = [];
    const pending = [base];
    if (base.shadowRoot) pending.push(base.shadowRoot);
    const SHOW = NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT;
    while (pending.length) {
      const walker = document.createTreeWalker(pending.pop(), SHOW, {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (skipped(node)) return NodeFilter.FILTER_REJECT; // prune subtree
            if (node.shadowRoot) pending.push(node.shadowRoot);
            return NodeFilter.FILTER_SKIP; // descend, but never collect
          }
          const value = node.nodeValue;
          if (!value || value.trim().length < 2) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || skipped(parent)) return NodeFilter.FILTER_REJECT;
          if (restoreMap.has(node)) return NodeFilter.FILTER_REJECT;
          if (!translatableRatioOk(value)) return NodeFilter.FILTER_REJECT;
          // Static pass skips hidden nodes; dynamic mode keeps them and lets
          // the IntersectionObserver fire when they actually become visible.
          if (!run?.dynamic && !visible(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      while (walker.nextNode()) nodes.push(walker.currentNode);
    }
    return nodes;
  }

  function applyNodeTranslation(node, original, translated, dirOk) {
    if (!node.isConnected || node.nodeValue !== original) return;
    if (!restoreMap.has(node)) restoreMap.set(node, original);
    const lead = /^\s*/.exec(original)[0];
    const trail = /\s*$/.exec(original)[0];
    node.nodeValue = lead + translated + trail;
    markDir(node.parentElement, dirOk);
  }

  // ----------------------------------------------------------- BLOCK engine

  const INLINE_OK = new Set([
    'A', 'B', 'STRONG', 'EM', 'I', 'U', 'S', 'MARK', 'SMALL', 'SUP', 'SUB',
    'SPAN', 'ABBR', 'TIME', 'BDI', 'BDO', 'FONT', 'INS', 'DEL', 'Q', 'CITE',
    'DFN', 'VAR', 'LABEL',
  ]);
  const BLOCKISH_SEL =
    'div,p,li,ul,ol,dl,table,section,article,aside,header,footer,nav,form,' +
    'h1,h2,h3,h4,h5,h6,img,svg,video,audio,canvas,iframe,button,input,select,textarea,br';
  const UNIT_MAX_CHARS = 3500;

  function hasDirectText(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE && n.nodeValue.trim().length >= 2) return true;
    }
    return false;
  }

  /** An inline child is taggable when it holds text and no block content. */
  function taggableInline(el) {
    return (
      INLINE_OK.has(el.tagName) &&
      (el.textContent || '').trim().length > 0 &&
      !el.querySelector(BLOCKISH_SEL)
    );
  }

  function inlineOnly(el) {
    if (!el.children.length) return false;
    for (const child of el.children) {
      if (!INLINE_OK.has(child.tagName) && child.tagName !== 'BR') return false;
    }
    return true;
  }

  /**
   * Recursively collect translation units under `rootEl`:
   *  - an element with its own text content (direct text nodes, or only
   *    inline children) becomes a unit;
   *  - its non-inline children (nested blocks that will ride along as ⟦n⟧
   *    placeholders) are ALSO recursed into, so their text translates too.
   * @param {{fallbackNodes: Text[]}} bag oversized units degrade to per-node
   */
  function collectUnits(rootEl, out, bag) {
    if (!rootEl || rootEl.nodeType !== Node.ELEMENT_NODE) return;
    if (skipped(rootEl)) return;
    // A wrapper holding exactly one inline element (<nav><a>text</a></nav>)
    // translates better as the inner element itself: its plain text dedupes
    // with identical strings elsewhere and no tag tokens are spent.
    if (!hasDirectText(rootEl) && rootEl.children.length === 1 && !rootEl.shadowRoot) {
      const only = rootEl.children[0];
      if (INLINE_OK.has(only.tagName)) return collectUnits(only, out, bag);
    }
    const isUnit =
      !seenUnits.has(rootEl) &&
      (hasDirectText(rootEl) || (inlineOnly(rootEl) && (rootEl.textContent || '').trim()));
    if (isUnit) {
      const raw = rootEl.textContent || '';
      if (!run?.dynamic && !visible(rootEl)) {
        // static pass: hidden — leave for a later run (or dynamic mode)
      } else if (raw.length > UNIT_MAX_CHARS) {
        // Oversized: this element's own text is handled node-by-node, but its
        // CHILDREN are still collected as proper units below.
        //
        // Until v2.1.0 an oversized unit dumped its whole subtree into the node
        // engine and returned. On a page whose <body> (or a top-level wrapper)
        // happens to hold a stray text node, that single decision demoted the
        // ENTIRE document to per-text-node translation — every sentence split
        // at each <a>/<b>, exactly the breakage block mode exists to prevent.
        seenUnits.add(rootEl);
        for (const n of rootEl.childNodes) {
          if (
            n.nodeType === Node.TEXT_NODE &&
            n.nodeValue.trim().length >= 2 &&
            !restoreMap.has(n) &&
            translatableRatioOk(n.nodeValue)
          ) {
            bag.fallbackNodes.push(n);
          }
        }
      } else if (translatableRatioOk(raw)) {
        out.push(rootEl);
      } else {
        seenUnits.add(rootEl); // nothing translatable; don't revisit
      }
      // Recurse into nested non-inline children so their own text (carried
      // as a placeholder in this unit) still gets translated.
      for (const child of rootEl.children) {
        if (!INLINE_OK.has(child.tagName) && child.tagName !== 'BR') {
          collectUnits(child, out, bag);
        }
      }
      if (rootEl.shadowRoot) collectShadow(rootEl.shadowRoot, out, bag);
      return;
    }
    for (const child of rootEl.children) collectUnits(child, out, bag);
    if (rootEl.shadowRoot) collectShadow(rootEl.shadowRoot, out, bag);
  }

  /** Descend into an open shadow root (its children are elements like any
   *  other; only the traversal boundary is special). */
  function collectShadow(shadowRoot, out, bag) {
    for (const child of shadowRoot.children || []) collectUnits(child, out, bag);
  }

  /** Serialize a unit: text runs + <gN>inline text</gN> + ⟦n⟧ elements. */
  function serializeUnit(el) {
    const tags = [];
    const placeholders = [];
    const parts = [];
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        parts.push(n.nodeValue);
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      if (taggableInline(n)) {
        const i = tags.length;
        tags.push(n);
        parts.push(`<g${i}>${n.textContent}</g${i}>`);
      } else {
        const i = placeholders.length;
        placeholders.push(n);
        parts.push(`⟦${i}⟧`);
      }
    }
    // The serialized form IS the snapshot: a response landing after an in-place
    // SPA content swap must not be painted over the new text. Deliberately not
    // el.textContent — that also covers nested blocks, which are ⟦n⟧
    // placeholders here and are units in their own right. When such a child was
    // translated first, textContent no longer matched and the PARENT's own text
    // was silently left in English (v1.9.6 fix).
    return { text: parts.join(''), tags, placeholders };
  }

  const STRAY_TAG_RE = /<\/?g\d+>/g;
  const UNIT_PIECE_RE = /<g(\d+)>([\s\S]*?)<\/g\1>|⟦(\d+)⟧/g;

  /**
   * Rebuild a unit's content from the translated string.
   *
   * @param {'move'|'copy'} mode how to handle ⟦n⟧ block placeholders:
   *   - 'move' (replace mode): the original nodes are moved into the rebuilt
   *     unit, so nothing is duplicated and restore puts them back.
   *   - 'copy' (bilingual mode): they are DROPPED. The original block is still
   *     right above the Persian line with those children intact, and each of
   *     them is a translation unit in its own right — cloning them here
   *     duplicated every image, video, button and nested block on the page
   *     (v2.1.0 fix). Inline <gN> tags are still cloned: they are part of the
   *     sentence, not separate content.
   */
  function buildUnitFragment(translated, meta, mode) {
    const keepPlaceholders = mode !== 'copy';
    const frag = document.createDocumentFragment();
    const appendText = (str) => {
      if (str) frag.append(str.replace(STRAY_TAG_RE, ''));
    };
    const usedTags = new Set();
    const usedPh = new Set();
    let last = 0;
    let match;
    UNIT_PIECE_RE.lastIndex = 0;
    while ((match = UNIT_PIECE_RE.exec(translated)) !== null) {
      appendText(translated.slice(last, match.index));
      if (match[1] !== undefined) {
        const i = parseInt(match[1], 10);
        const orig = meta.tags[i];
        if (orig && !usedTags.has(i)) {
          usedTags.add(i);
          const clone = orig.cloneNode(false); // keeps href/class, drops kids
          clone.textContent = match[2].replace(STRAY_TAG_RE, '');
          frag.appendChild(clone);
        } else {
          appendText(match[2]);
        }
      } else {
        const i = parseInt(match[3], 10);
        const node = meta.placeholders[i];
        if (node && !usedPh.has(i)) {
          usedPh.add(i);
          if (keepPlaceholders) frag.appendChild(node);
        }
      }
      last = match.index + match[0].length;
    }
    appendText(translated.slice(last));
    // Never lose content: anything the model dropped is appended at the end.
    meta.tags.forEach((orig, i) => {
      if (orig && !usedTags.has(i)) {
        frag.append(' ');
        frag.appendChild(orig.cloneNode(true));
      }
    });
    if (keepPlaceholders) {
      meta.placeholders.forEach((node, i) => {
        if (node && !usedPh.has(i)) {
          frag.append(' ');
          frag.appendChild(node);
        }
      });
    }
    return frag;
  }

  function applyUnitTranslation(unit, translated, meta) {
    if (!unit.isConnected) return;
    // Re-serialize and compare: identical ⇒ this unit's own content is still
    // exactly what we sent (a nested unit having been translated meanwhile
    // changes nothing here — it is an opaque ⟦n⟧ placeholder either way).
    if (serializeUnit(unit).text !== meta.text) return;
    if (run?.bilingual) {
      const bi = document.createElement('div');
      bi.className = 'gxt-bi';
      bi.dir = 'auto';
      // v3.2.5 — styled in content/content.css. It was an inline string with a
      // literal grey rule and `opacity: .96`, so the bilingual bar was the one
      // thing this module drew that could not follow the user's accent. On a page
      // that is not x.com there is no content.css, so the essentials are kept
      // here as a floor and the sheet refines them where it is present.
      bi.style.cssText =
        'display:block;margin:.3em 0 .55em;padding-inline-start:.6em;' +
        'border-inline-start:2px solid var(--gxt-accent-line, rgba(128,128,128,.55));' +
        'text-align:start;';
      const frag = buildUnitFragment(translated, meta, 'copy');
      // A unit that was pure block placeholders has no sentence of its own —
      // an empty bilingual bar would just add a stray rule to the page.
      if (!(frag.textContent || '').trim()) {
        seenUnits.add(unit);
        return;
      }
      bi.appendChild(frag);
      unit.insertAdjacentElement('afterend', bi);
      biNodes.push(bi);
    } else {
      if (!unitRestore.has(unit)) unitRestore.set(unit, [...unit.childNodes]);
      unit.replaceChildren(buildUnitFragment(translated, meta, 'move'));
      markDir(unit, meta.dirOk);
    }
    seenUnits.add(unit);
    dynClaims.delete(unit);
  }

  // ------------------------------------------------------- attributes (v1.8)

  const ATTR_NAMES = ['placeholder', 'title', 'alt', 'aria-label'];
  const ATTR_SEL =
    'input[placeholder], textarea[placeholder], [title], img[alt], [aria-label]';

  function collectAttrs() {
    const out = []; // {el, attr, original}
    if (!run?.attrs || !document.body) return out;
    // Elements already recorded. attrRestore can hold several entries for the
    // same element (title + aria-label), which is why this is built as a Set.
    const recorded = new Set();
    for (const entry of attrRestore) recorded.add(entry.el);
    for (const el of document.body.querySelectorAll(ATTR_SEL)) {
      if (out.length >= 300) break;
      if (skipped(el) || recorded.has(el)) continue;
      for (const attr of ATTR_NAMES) {
        const value = el.getAttribute(attr);
        if (!value || value.length < 2 || value.length > 300) continue;
        if (!translatableRatioOk(value)) continue;
        out.push({ el, attr, original: value });
      }
    }
    return out;
  }

  // ------------------------------------------------------- page title (v2.1)

  /** The tab title is the one piece of page text the user reads *outside* the
   *  page — and it was never translated. Restored with everything else. */
  let titleOriginal = null;

  function applyTitle(translated) {
    if (typeof translated !== 'string' || !translated.trim()) return;
    if (titleOriginal === null) titleOriginal = document.title;
    document.title = translated;
  }

  function restoreTitle() {
    if (titleOriginal !== null) {
      document.title = titleOriginal;
      titleOriginal = null;
    }
  }

  function titleCandidate() {
    if (!IS_TOP) return '';
    const raw = (titleOriginal === null ? document.title : titleOriginal).trim();
    if (!raw || raw.length > 300 || !translatableRatioOk(raw)) return '';
    return raw;
  }

  // --------------------------------------------------- translate orchestrator

  /** Chunks in flight. Three is the sweet spot: the Gemini client's own
   *  limiter allows 2 concurrent HTTP calls and the keyless MT engines allow
   *  more, so a third chunk is always queued and ready the instant a slot
   *  frees — without making a failure storm any louder. */
  const PAGE_WORKERS = 3;

  /**
   * Translate unique strings through TRANSLATE_TEXTS.
   * @returns {Promise<{map: Map<string,string>, failure: object|null}>}
   */
  async function translateUnique(uniques, onProgress, generation = pageGeneration) {
    const map = new Map();
    let failure = null;
    let aborted = false;
    let next = 0;
    const CHUNK = 40;
    const chunks = [];
    for (let i = 0; i < uniques.length; i += CHUNK) chunks.push(uniques.slice(i, i + CHUNK));
    const worker = async () => {
      for (;;) {
        if (generation !== pageGeneration || cancelRequested || aborted || next >= chunks.length) return;
        const chunkTexts = chunks[next];
        next += 1;
        const res = await send({ type: 'TRANSLATE_TEXTS', texts: chunkTexts, kind: 'page' });
        if (generation !== pageGeneration) return;
        if (!res?.ok) {
          failure = res || { code: 'ERR' };
          aborted = true;
          return;
        }
        chunkTexts.forEach((t, i) => {
          const out = res.list?.[i];
          if (typeof out === 'string' && out) {
            map.set(t, out);
            rememberText(t, out);
          }
        });
        if (res.failed) {
          failure = res.failed;
          if (['RATE_LIMIT', 'BAD_KEY', 'NO_KEY'].includes(res.failed.code)) {
            aborted = true;
            return;
          }
        }
        onProgress?.(chunkTexts.length);
      }
    };
    await Promise.all(Array.from({ length: PAGE_WORKERS }, worker));
    return { map, failure };
  }

  // ------------------------------------------------------------- static run

  async function runPage() {
    if (pageState === 'running') return;
    const generation = ++pageGeneration;
    try {
      await runPageInner(generation);
    } catch (error) {
      if (generation !== pageGeneration) return;
      // Any unexpected DOM/serialization failure used to leave pageState stuck
      // at 'running' forever, after which the menu item and Alt+Shift+P did
      // nothing at all. Always land in a usable state (v1.9.6).
      console.warn(globalThis.GXT.i18n.t("content_page_translate_runPage_2"), error);
      pageState =
        translatedSomething() ? 'done' : 'idle';
      pillShow(globalThis.GXT.i18n.t("content_page_translate_runPage_1"), [
        button(globalThis.GXT.i18n.t("content_page_translate_runPageInner_3"), reRunPage, 'accent'),
        button(globalThis.GXT.i18n.t("content_page_translate_dynamicPill_1"), restorePage),
        button('✕', pillHide),
      ]);
    }
  }

  async function runPageInner(generation) {
    pageState = 'running';
    cancelRequested = false;
    run = {
      block: settings?.pageBlockMode !== false,
      bilingual: !!(settings?.pageBilingual && settings?.pageBlockMode !== false),
      dynamic: !!settings?.pageDynamic,
      attrs: !!settings?.pageAttrs,
    };

    // ---- collect work
    const bag = { fallbackNodes: [] };
    /** @type {Map<string, Array<{unit?: Element, meta?: object, node?: Text, original?: string, attr?: object}>>} */
    const byText = new Map();
    const addWork = (key, entry) => {
      let bucket = byText.get(key);
      if (!bucket) byText.set(key, (bucket = []));
      bucket.push(entry);
    };

    if (run.block) {
      const units = [];
      collectUnits(document.body, units, bag);
      for (const unit of units) {
        const meta = makeUnitMeta(unit);
        if (!meta.text.trim()) {
          seenUnits.add(unit);
          continue;
        }
        addWork(meta.text.trim(), { unit, meta });
      }
      for (const node of bag.fallbackNodes) {
        addWork(node.nodeValue.trim(), makeNodeWork(node));
      }
    } else {
      for (const node of collectNodes(null)) {
        addWork(node.nodeValue.trim(), makeNodeWork(node));
      }
    }
    for (const attrEntry of collectAttrs()) {
      addWork(attrEntry.original.trim(), { attr: attrEntry });
    }
    // The tab title rides along in the same batch — no extra request.
    const pageTitle = titleCandidate();
    if (pageTitle) addWork(pageTitle, { title: true });

    // ---- session-memory hits apply instantly and cost nothing
    const applyText = (key, translated) => {
      for (const entry of byText.get(key) || []) {
        if (entry.unit) applyUnitTranslation(entry.unit, translated, entry.meta);
        else if (entry.node) {
          applyNodeTranslation(entry.node, entry.original, translated, entry.dirOk);
        } else if (entry.title) applyTitle(translated);
        else if (entry.attr) {
          const { el, attr, original } = entry.attr;
          // Guard against applying the same entry twice (a re-run can hand the
          // same element back): only record a restore point the first time.
          if (el.getAttribute(attr) === original) {
            attrRestore.push(entry.attr);
            el.setAttribute(attr, translated);
          }
        }
      }
    };

    const uniques = [];
    for (const key of byText.keys()) {
      const known = doneTexts.get(key);
      if (known) applyText(key, known);
      else uniques.push(key);
    }

    if (!byText.size) {
      toast(globalThis.GXT.i18n.t("content_page_translate_runPageInner_7"));
      pageState = translatedSomething() ? 'done' : 'idle';
      if (run.dynamic) startDynamic();
      return;
    }
    if (!uniques.length) {
      // Everything came from session memory (a re-run, or a bilingual toggle):
      // no request needed, but the page IS translated.
      pageState = 'done';
      if (run.dynamic) startDynamic();
      else pillShow(globalThis.GXT.i18n.t("content_page_translate_runPageInner_1"), pageDoneActions(null));
      return;
    }

    // Viewport-first: what the user is looking at translates first.
    const vh = innerHeight;
    const score = (key) => {
      const entry = (byText.get(key) || [])[0];
      const el = entry?.unit || entry?.node?.parentElement || entry?.attr?.el;
      try {
        const rect = el.getBoundingClientRect();
        return rect.top >= -vh && rect.top <= vh * 2 ? 0 : 1;
      } catch {
        return 1;
      }
    };
    uniques.sort((a, b) => score(a) - score(b));

    let doneCount = 0;
    const cancelBtn = () => [button(globalThis.GXT.i18n.t("content_page_translate_cancelBtn_1"), () => (cancelRequested = true))];
    pillShow(globalThis.GXT.i18n.t("content_page_translate_runPageInner_6", {v0:(faNum(0)), v1:(faNum(uniques.length))}), cancelBtn());

    const { map, failure } = await translateUnique(uniques, (n) => {
      doneCount += n;
      pillShow(
        globalThis.GXT.i18n.t("content_page_translate_runPageInner_6", {v0:(faNum(Math.min(doneCount, uniques.length))), v1:(faNum(uniques.length))}),
        cancelBtn()
      );
    }, generation);
    if (generation !== pageGeneration) return;
    for (const [key, translated] of map) applyText(key, translated);

    pageState = translatedSomething() ? 'done' : 'idle';
    if (failure?.code === 'NO_KEY') {
      pillHide();
      toast(globalThis.GXT.i18n.t("content_page_translate_runPageInner_5"));
      return;
    }

    if (run.dynamic && !cancelRequested) {
      startDynamic();
      return;
    }

    if (cancelRequested) {
      pillShow(globalThis.GXT.i18n.t("content_page_translate_runPageInner_4"), [
        button(globalThis.GXT.i18n.t("content_page_translate_runPageInner_3"), reRunPage, 'accent'),
        button(globalThis.GXT.i18n.t("content_page_translate_dynamicPill_1"), restorePage),
        button('✕', pillHide),
      ]);
    } else {
      pillShow(
        failure ? globalThis.GXT.i18n.t("content_page_translate_runPageInner_2") : globalThis.GXT.i18n.t("content_page_translate_runPageInner_1"),
        pageDoneActions(failure)
      );
    }
  }

  // ---------------------------------------------------- dynamic engine (v1.8)

  let dynObserver = null; // MutationObserver
  let dynIO = null; // IntersectionObserver
  /** Node-engine bookkeeping: parent element -> its pending text nodes. */
  const dynNodesOf = new Map();
  let dynQueue = new Set(); // elements (units or node-parents) ready to translate
  let dynFlushTimer = 0;
  let dynScanTimer = 0;
  let dynInFlight = false;
  const dynClaims = new Set(); // queued/observed units, excluding completed translations

  function dynamicPill() {
    pillShow(globalThis.GXT.i18n.t("content_page_translate_dynamicPill_2", {v0:(faNum(dynamicCount))}), [
      button(globalThis.GXT.i18n.t("content_manga_translateChapter_4"), stopDynamic),
      button(globalThis.GXT.i18n.t("content_page_translate_dynamicPill_1"), restorePage),
      button('✕', pillHide),
    ]);
  }

  function startDynamic() {
    if (dynamicOn) return;
    dynamicOn = true;
    pageState = 'done';
    dynIO = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          dynIO.unobserve(entry.target);
          dynQueue.add(entry.target);
        }
        if (dynQueue.size) scheduleDynFlush();
      },
      { rootMargin: '700px 0px 700px 0px' }
    );
    dynObserver = new MutationObserver((records) => {
      let touched = false;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.classList?.contains('gxt-bi') || node.hasAttribute?.('data-gxt-ui')) continue;
          touched = true;
          break;
        }
        if (touched) break;
      }
      if (touched) scheduleDynScan();
    });
    dynObserver.observe(document.body, { childList: true, subtree: true });
    observeAllDynamic(document.body);
    dynamicPill();
  }

  /** Shared teardown for the observers/timers (stop + restore paths). */
  function teardownDynamic() {
    pageGeneration += 1;
    dynamicOn = false;
    dynInFlight = false;
    for (const unit of dynClaims) seenUnits.delete(unit);
    dynClaims.clear();
    dynObserver?.disconnect();
    dynObserver = null;
    dynIO?.disconnect();
    dynIO = null;
    dynQueue.clear();
    dynNodesOf.clear();
    clearTimeout(dynFlushTimer);
    dynFlushTimer = 0; // a stale non-zero id would no-op every later schedule
    clearTimeout(dynScanTimer);
    dynScanTimer = 0;
  }

  function stopDynamic() {
    teardownDynamic();
    pageState = translatedSomething() ? 'done' : 'idle';
    // Land back on the full control set, not a dead-end two-button pill: the
    // user just turned a mode off, they have not finished with the page.
    pillShow(globalThis.GXT.i18n.t("content_page_translate_stopDynamic_1"), pageDoneActions(null));
  }

  function scheduleDynScan() {
    if (dynScanTimer) return;
    dynScanTimer = setTimeout(() => {
      dynScanTimer = 0;
      observeAllDynamic(document.body);
    }, 700);
  }

  const DYN_MARGIN = 700;

  /** Already within the look-ahead band (and actually laid out)? Queue it
   *  directly — an IO callback needs a render tick that a throttled/background
   *  tab may not get for a while. IO stays on for far/hidden elements. */
  function inLookahead(el) {
    try {
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) return false; // hidden: wait for IO
      return rect.bottom >= -DYN_MARGIN && rect.top <= innerHeight + DYN_MARGIN;
    } catch {
      return false;
    }
  }

  /** Register every untranslated unit / text-node parent (queue or IO). */
  function observeAllDynamic(rootEl) {
    if (!dynamicOn || !rootEl) return;
    if (run?.block) {
      const bag = { fallbackNodes: [] };
      const units = [];
      collectUnits(rootEl, units, bag);
      for (const unit of units) {
        if (!seenUnits.has(unit)) {
          seenUnits.add(unit); // claimed: exactly one queue/IO registration
          dynClaims.add(unit);
          unit.__gxtUnit = true;
          if (inLookahead(unit)) dynQueue.add(unit);
          else dynIO.observe(unit);
        }
      }
      for (const node of bag.fallbackNodes) registerDynNode(node);
    } else {
      for (const node of collectNodes(rootEl)) registerDynNode(node);
    }
    if (dynQueue.size) scheduleDynFlush();
  }

  function registerDynNode(node) {
    const parent = node.parentElement;
    if (!parent) return;
    let bucket = dynNodesOf.get(parent);
    if (!bucket) {
      dynNodesOf.set(parent, (bucket = []));
      if (inLookahead(parent)) dynQueue.add(parent);
      else dynIO.observe(parent);
    }
    if (!bucket.includes(node)) bucket.push(node);
  }

  function scheduleDynFlush() {
    if (dynFlushTimer) return;
    dynFlushTimer = setTimeout(() => {
      dynFlushTimer = 0;
      void flushDynamic();
    }, 350);
  }

  async function flushDynamic() {
    if (!dynamicOn || dynInFlight || !dynQueue.size) return;
    const generation = pageGeneration;
    dynInFlight = true;
    const batch = [...dynQueue];
    dynQueue = new Set();
    /** @type {Map<string, Array<object>>} */
    const byText = new Map();
    const addWork = (key, entry) => {
      let bucket = byText.get(key);
      if (!bucket) byText.set(key, (bucket = []));
      bucket.push(entry);
    };
    for (const el of batch) {
      if (!el.isConnected) continue;
      if (el.__gxtUnit) {
        const meta = makeUnitMeta(el);
        if (meta.text.trim()) addWork(meta.text.trim(), { unit: el, meta });
      } else {
        for (const node of dynNodesOf.get(el) || []) {
          if (node.isConnected && !restoreMap.has(node)) {
            addWork(node.nodeValue.trim(), makeNodeWork(node));
          }
        }
        dynNodesOf.delete(el);
      }
    }
    const applyText = (key, translated) => {
      for (const entry of byText.get(key) || []) {
        if (entry.unit) applyUnitTranslation(entry.unit, translated, entry.meta);
        else if (entry.node) {
          applyNodeTranslation(entry.node, entry.original, translated, entry.dirOk);
        }
        dynamicCount += 1;
      }
    };
    const uniques = [];
    for (const key of byText.keys()) {
      const known = doneTexts.get(key);
      if (known) applyText(key, known);
      else uniques.push(key);
    }
    // try/finally, because `dynInFlight` is a lock: a throw anywhere below
    // (a detached node, a serialization edge case) used to leave it latched
    // true, and continuous mode then went quiet for the rest of the page with
    // its pill still cheerfully saying «ترجمهٔ پیوسته فعال ✓».
    try {
      if (uniques.length) {
        const { map, failure } = await translateUnique(uniques, null, generation);
        if (generation !== pageGeneration) return;
        for (const [key, translated] of map) applyText(key, translated);
        if (failure && ['RATE_LIMIT', 'BAD_KEY', 'NO_KEY'].includes(failure.code)) {
          // Back off instead of hammering a dead provider.
          toast(friendly(failure));
          setTimeout(() => {
            if (dynamicOn) scheduleDynFlush();
          }, 20000);
        }
      }
      if (dynamicOn) dynamicPill();
    } finally {
      if (generation === pageGeneration) {
        dynInFlight = false;
        if (dynamicOn && dynQueue.size) scheduleDynFlush();
      }
    }
  }

  // ---------------------------------------------------------------- restore

  function restorePage() {
    pageGeneration += 1;
    cancelRequested = true;
    if (dynamicOn) teardownDynamic();
    for (const [node, original] of restoreMap) {
      if (node.isConnected) node.nodeValue = original;
    }
    restoreMap.clear();
    for (const [unit, kids] of unitRestore) {
      if (unit.isConnected) unit.replaceChildren(...kids);
    }
    unitRestore.clear();
    for (const bi of biNodes) bi.remove();
    biNodes.length = 0;
    for (const { el, attr, original } of attrRestore) {
      if (el.isConnected) el.setAttribute(attr, original);
    }
    attrRestore.length = 0;
    restoreTitle();
    for (const parent of dirTouched) parent.removeAttribute('dir');
    dirTouched.length = 0;
    for (const [el, before] of langTouched) {
      if (before === null) el.removeAttribute('lang');
      else el.setAttribute('lang', before);
    }
    langTouched.length = 0;
    dynamicCount = 0;
    seenUnits = new WeakSet();
    pageState = 'idle';
    pillHide();
  }

  // ------------------------------------------------- SPA navigation (v2.1.0)
  //
  // A single-page app swaps the whole article without ever reloading the
  // document. The old behaviour was to keep claiming "صفحه ترجمه شد ✓" over
  // brand-new English text, and the menu item then acted as RESTORE, so the
  // obvious next click did nothing visible. React to the route change instead.

  let lastUrl = location.href;

  function onNavigated() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (pageState === 'idle' && !dynamicOn) {
      // Not our page: only auto-sites act on their own.
      if (settings?.enabled && (settings.autoSites || []).includes(location.origin)) {
        setTimeout(() => {
          if (pageState === 'idle' && !dynamicOn) void runPage();
        }, 700);
      }
      return;
    }
    // Nodes from the previous route are detached; their restore entries are
    // dead weight and would resurrect nothing. Drop them, keep the session
    // translation memory (it makes the re-run nearly free), and translate the
    // new content. Continuous mode is already watching, so leave it alone.
    if (dynamicOn) {
      scheduleDynScan();
      return;
    }
    pageGeneration += 1;
    for (const [node] of restoreMap) if (!node.isConnected) restoreMap.delete(node);
    for (const [unit] of unitRestore) if (!unit.isConnected) unitRestore.delete(unit);
    titleOriginal = null; // the new route has its own title
    pageState = translatedSomething() ? 'done' : 'idle';
    seenUnits = new WeakSet();
    setTimeout(() => {
      if (pageState !== 'running') void runPage();
    }, 700);
  }

  /**
   * Notice a route change in a single-page app.
   *
   * WHY NOT MONKEY-PATCH history.pushState (which this used to do): a content
   * script runs in an ISOLATED WORLD. Assigning `history.pushState` there
   * writes to the isolated world's own wrapper; the page keeps calling its own,
   * and the patch never fires once. So the SPA support this module advertised
   * only ever worked for hash changes and Back/Forward — a React or Next.js
   * site swapping the article by pushState was invisible, and the pill went on
   * claiming «صفحه ترجمه شد ✓» over untouched English. (The codebase already
   * knows the rule: content/yt-main.js exists precisely because YouTube's
   * player object is unreachable from here.)
   *
   * Two mechanisms that DO work from an isolated world, in order of quality:
   *  1. the Navigation API — `navigate` fires for same-document navigations
   *     however they were initiated, including pushState. Chrome 102+, and the
   *     manifest already requires 116.
   *  2. a slow poll of location.href, as the floor. It costs a string compare
   *     a second and covers anything exotic (or a future API change).
   */
  let navPollTimer = 0;

  function watchNavigation() {
    if (!IS_TOP) return;
    window.addEventListener('popstate', onNavigated);
    window.addEventListener('hashchange', onNavigated);
    const nav = globalThis.navigation;
    const hasNavigationApi = !!nav && typeof nav.addEventListener === 'function';
    if (hasNavigationApi) {
      // `navigatesuccess` rather than `navigate`: on `navigate` the URL has not
      // been committed yet, so location.href still reads as the OLD route and
      // onNavigated would decide nothing had changed.
      nav.addEventListener('navigatesuccess', () => setTimeout(onNavigated, 0));
    }
    /**
     * The poll is a FALLBACK, so it only runs when there is something to fall
     * back from — v2.9.5.
     *
     * It used to run unconditionally, alongside the Navigation API, on every
     * page this engine touches. The manifest requires Chrome 116 and
     * `navigatesuccess` shipped in 102, so on every supported browser the timer
     * woke up once a second, for the life of the tab, to observe a change the
     * event had already delivered — measured in dev/e2e: 6-7 ms for the event
     * against ~1009 ms for the poll. That is a wakeup a second per translated
     * tab and per auto-site tab, for nothing, and wakeups are what keep a CPU
     * out of its idle states on a laptop.
     *
     * Keeping the poll for browsers without the API costs one branch and loses
     * no coverage there.
     */
    const startPoll = () => {
      if (hasNavigationApi || navPollTimer) return;
      navPollTimer = setInterval(onNavigated, 1000);
    };
    clearInterval(navPollTimer);
    navPollTimer = 0;
    startPoll();
    // A poll that outlives the document is a leak in a bfcache'd page.
    window.addEventListener('pagehide', () => {
      clearInterval(navPollTimer);
      navPollTimer = 0;
    });
    window.addEventListener('pageshow', startPoll);
  }

  function togglePage() {
    if (!IS_TOP && !settings?.pageFrames) return; // frames only when opted in
    if (pageState === 'running') {
      cancelRequested = true;
      return;
    }
    if (dynamicOn) {
      restorePage();
      return;
    }
    if (pageState === 'done') {
      restorePage();
      return;
    }
    void runPage();
  }

  // --------------------------------------------------------------- wiring

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'GXT_SELECTION') {
      if (IS_TOP) void translateSelection(message.fallbackText);
    } else if (message?.type === 'GXT_PAGE') togglePage();
    else if (message?.type === 'GXT_SUMMARY') {
      if (IS_TOP) void summarize(message.fallbackText);
    } else if (message?.type === 'GXT_IMAGE_BEGIN') {
      if (IS_TOP) onImageBegin();
    } else if (message?.type === 'GXT_IMAGE_RESULT') {
      if (IS_TOP) onImageResult(message.res);
    } else if (message?.type === 'GXT_READ') {
      if (IS_TOP) readSelection(message.fallbackText, !!message.toggle);
    } else if (message?.type === 'GXT_READ_PAGE') {
      if (IS_TOP) void readAloud(extractMainText(), { get label() { return globalThis.GXT.i18n.t("content_page_translate_message_1"); } });
    } else if (message?.type === 'GXT_MANGA_BEGIN') {
      if (IS_TOP) onMangaBegin(message.src);
    } else if (message?.type === 'GXT_MANGA_RESULT') {
      if (IS_TOP) onMangaResult(message.src, message.res);
    } else if (message?.type === 'GXT_TOAST') {
      if (IS_TOP) toast(message.text);
    }
  });

  // Pure/near-pure pieces of the engine, exposed for the self-test (the same
  // `_internal` convention the background modules use). Nothing else reads
  // these; `setRun`/`resetSeen` exist so a test can drive a fixture through
  // the real collector instead of a copy of it.
  globalThis.GXT.page = {
    _internal: {
      NON_PROSE_RE,
      translatableRatioOk,
      canSetDir,
      collectUnits,
      collectNodes,
      serializeUnit,
      buildUnitFragment,
      UNIT_MAX_CHARS,
      // v2.5.1 — read-aloud everywhere. persianRatio decides whether a
      // selection is spoken as it stands or translated first, so it is worth
      // holding to its behaviour.
      persianRatio,
      READ_FA_RATIO,
      swapImage,
      restoreImage,
      setRun: (value) => {
        run = value;
      },
      // v2.9.5 — is the 1 Hz href poll running? It is a fallback for browsers
      // without the Navigation API, and it used to run alongside the API on
      // every page this engine touched, waking the tab once a second forever to
      // observe what the event had already delivered.
      navPollActive: () => !!navPollTimer,
      hasNavigationApi: () =>
        !!globalThis.navigation && typeof globalThis.navigation.addEventListener === 'function',
      resetSeen: () => {
        seenUnits = new WeakSet();
      },
    },
  };

  document.addEventListener('mouseup', (event) => {
    if (!settings?.selectionButton) return;
    if (UI().inPath(event)) return;
    setTimeout(maybeShowSelChip, 60);
  });
  document.addEventListener('mousedown', (event) => {
    if (selChip && !(event.composedPath?.() || []).includes(selChip)) hideSelChip();
  });
  window.addEventListener('scroll', () => hideSelChip(), { passive: true });

  // Auto-translate sites: registered content script checks the list itself.
  void (async () => {
    try {
      /**
       * v3.0.0 — this page's own profile, layered over the global settings.
       *
       * Applied at the ONE place settings enter this module, so every consumer
       * downstream — the engine, the pill, the selection chip, the cards — sees
       * the site's answer without knowing profiles exist. Only an allow-list of
       * keys can be overridden (see SITE_KEYS), and anything the user has not
       * overridden keeps inheriting the global value.
       */
      const forThisSite = (all) =>
        globalThis.GXT.forScope(globalThis.GXT?.settingsForOrigin?.(all, location.origin) || all,'page');

      settings = forThisSite(await globalThis.GXT?.getSettings?.());
      UI().configure(settings); // the shared layer needs the theme + opacity choice
      globalThis.GXT?.onStorageChanged?.(({ settings: next }) => {
        if (!next) return;
        const wasEnabled = settings?.enabled;
        const previous = settings;
        settings = forThisSite(next);
        if (previous?.targetLang !== settings.targetLang) {
          restorePage();
          doneTexts.clear();
        }
        if (['targetLang','imageTargetLang','summaryTargetLang'].some(key=>previous?.[key] !== settings[key])) closeCard();
        UI().configure(settings); // live theme/accent/opacity change re-skins open UI
        // Master switch OFF: stop spending quota at once. Text already on the
        // page is left as-is (translating it was an explicit user action) —
        // «بازگرداندن» is one click away in the pill.
        if (wasEnabled && !settings.enabled) {
          if (dynamicOn) stopDynamic();
          if (pageState === 'running') cancelRequested = true;
          hideSelChip();
        }
      });
      // Theme "auto" follows the OS; keep an open card in step with it.
      globalThis.GXT?.theme?.onSchemeChange?.(() => {
        if ((settings?.uiTheme || 'auto') === 'auto') UI().configure();
      });
      if (SKIP_HOSTS.test(location.hostname)) return;
      if (!IS_TOP && !settings?.pageFrames) return;
      watchNavigation();
      if (settings?.enabled && (settings.autoSites || []).includes(location.origin)) {
        setTimeout(() => {
          if (pageState === 'idle' && !dynamicOn) void runPage();
        }, 900);
      }
    } catch {
      /* settings unavailable: manual use still works */
    }
  })();
})();
