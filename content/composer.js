/**
 * X extras (v1.8.0) — both opt-in via the popup, default OFF:
 *
 *  - composerTranslate: a small «EN ترجمه به انگلیسی» chip under the X
 *    compose/reply box that appears as soon as the draft contains Persian.
 *    One click translates the Persian draft into a natural English post and
 *    replaces the draft in place (via execCommand so X's editor state and
 *    Ctrl+Z undo keep working; clipboard fallback if the editor refuses).
 *
 *  - xImageButton: a small «ترجمهٔ تصویر» button on tweet images. One click
 *    sends the image (upgraded to its large variant) to the AI provider and
 *    shows the Persian rendering in a floating card. Results are cached by
 *    image URL in the shared L2 cache, so re-opening a tweet costs nothing.
 *    v2.1.0: that card is now the shared content/ui.js window — same theme,
 *    same translucency, draggable, with full error diagnostics.
 */
'use strict';
(() => {
  if (globalThis.__gxtComposerLoaded) return;
  globalThis.__gxtComposerLoaded = true;
  if (!globalThis.chrome?.runtime?.id) return;

  const { getSettings, onStorageChanged, DEFAULTS } = globalThis.GXT;

  let settings = { ...DEFAULTS };
  // A monotonic epoch also rejects A -> B -> A settings changes.
  let requestGeneration = 0;

  const PERSIAN_RE = /[؀-ۿ]/;
  const EDITOR_SEL = 'div[data-testid^="tweetTextarea"][contenteditable="true"]';
  const IMAGE_SEL = 'article img[src*="pbs.twimg.com/media"]';

  const send = async (message) => {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  };

  /**
   * Make a `role="button"` span behave like a button (v3.2.5).
   *
   * Both controls this module draws were `<span role="button">`. The composer
   * chip at least had `tabIndex = 0`, so it could be FOCUSED — and then nothing
   * happened, because `role` and `tabindex` only promise a button and the
   * browser gives such an element no keyboard activation of its own. The image
   * button had no `tabIndex` at all, so «ترجمهٔ تصویر» was unreachable without a
   * mouse in every sense.
   *
   * content/render.js already had this exact helper for the same reason on the
   * same site; this is the second copy rather than a new idea, and both now
   * behave identically. (A real <button> would be simpler, but X styles form
   * controls inside a post aggressively — which is why these are spans.)
   */
  function activatable(el, onActivate) {
    el.tabIndex = 0;
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      onActivate(event);
    });
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      // Space scrolls the page and Enter submits X's composer; neither is what
      // pressing a button here means.
      event.preventDefault();
      event.stopPropagation();
      onActivate(event);
    });
  }

  // ------------------------------------------------------- floating card
  //
  // v2.1.0 — this used to be a hand-rolled #1c1d20 box: it ignored the user's
  // theme, was opaque while every other window of the extension was
  // translucent, and could not be moved, so it covered the very image it was
  // translating. It is now the SHARED card from content/ui.js — identical
  // tokens, identical drag, identical «◐/●» opacity control, and real error
  // diagnostics instead of a one-line message.

  const UI = () => globalThis.GXT.ui;

  /** @type {ReturnType<typeof globalThis.GXT.ui.card>|null} */
  let card = null;

  function closeCard() {
    const open = card;
    card = null;
    open?.close();
  }

  /** Result card anchored under the click, clamped on-screen, draggable. */
  function openCard(x, y) {
    closeCard();
    card = UI().card({
      get title() { return globalThis.GXT.i18n.t("content_composer_ensureImageButton_2"); },
      anchorPoint: { x, y },
      onClose: () => {
        card = null;
      },
    });
    return card.body;
  }

  // ------------------------------------------------------------ composer

  const chipOf = new WeakMap(); // editor -> chip element
  /** Visibility updaters of every live chip. A chip only re-evaluated itself
   *  on `input`, so switching the feature (or the extension) on/off did
   *  nothing until the user typed another character (v1.9.6 fix). */
  const chipSyncs = new Map(); // chip element -> its visibility updater
  const chipEditors = new Map(); // chip element -> editor, for listener cleanup

  function forgetChip(chip) {
    const editor = chipEditors.get(chip);
    const sync = chipSyncs.get(chip);
    if (editor && sync) editor.removeEventListener('input', sync);
    if (editor && chipOf.get(editor) === chip) chipOf.delete(editor);
    chipSyncs.delete(chip);
    chipEditors.delete(chip);
    chip.remove();
  }

  function syncComposerChips() {
    for (const [chip, sync] of chipSyncs) {
      // X tears composers down constantly; drop dead entries as we go.
      if (!chip.isConnected) {
        forgetChip(chip);
        continue;
      }
      try {
        sync();
      } catch {
        /* never let one chip break the rest */
      }
    }
  }

  function ensureComposerChip(editor) {
    const existing = chipOf.get(editor);
    if (existing?.isConnected && editor.nextElementSibling === existing) return;
    if (existing) forgetChip(existing);
    // v3.2.5 — the styling moved to content/content.css (`.gxt-compose-chip`),
    // which is where every other surface this extension draws on X is styled.
    // It was an inline string with a literal accent hex, a literal 12.5px and no
    // hover, focus or reduced-motion rule, so it was the one control on X that
    // ignored the user's accent and type scale. Only the SHOWN/HIDDEN state is
    // still set from here, because that is behaviour, not appearance.
    const chip = document.createElement('div');
    chip.className = 'gxt-compose-chip';
    chip.dir = 'rtl';
    chip.hidden = true;
    const btn = document.createElement('span');
    btn.className = 'gxt-chip-btn';
    btn.setAttribute('role', 'button');
    globalThis.GXT.i18n.bind(btn, "textContent", () => (globalThis.GXT.i18n.t("content_composer_ensureComposerChip_1")));
    chip.appendChild(btn);
    chipOf.set(editor, chip);

    const sync = () => {
      const on =
        settings.enabled &&
        settings.composerTranslate &&
        PERSIAN_RE.test(editor.innerText || '');
      chip.hidden = !on;
    };
    editor.addEventListener('input', sync);
    chipSyncs.set(chip, sync);
    chipEditors.set(chip, editor);
    sync();

    let busy = false;
    activatable(btn, async () => {
      if (busy || !settings.enabled || !settings.composerTranslate || !editor.isConnected) return;
      const snapshot = editor.innerText || '';
      const draft = snapshot.trim();
      if (!draft || !PERSIAN_RE.test(draft)) return;
      busy = true;
      const generation = requestGeneration;
      btn.setAttribute('aria-disabled', 'true');
      globalThis.GXT.i18n.bind(btn, "textContent", () => (globalThis.GXT.i18n.t("content_composer_ensureComposerChip_8")));
      const res = await send({ type: 'TRANSLATE_COMPOSE', text: draft });
      busy = false;
      btn.setAttribute('aria-disabled', 'false');
      if (generation !== requestGeneration && chip.isConnected) {
        globalThis.GXT.i18n.bind(btn, "textContent", () => (globalThis.GXT.i18n.t("content_composer_ensureComposerChip_7")));
      }
      if (generation !== requestGeneration || !settings.enabled || !settings.composerTranslate || !editor.isConnected ||
          !chip.isConnected || chipOf.get(editor) !== chip) return;
      if ((editor.innerText || '') !== snapshot) {
        globalThis.GXT.i18n.bind(btn, "textContent", () => (globalThis.GXT.i18n.t("content_composer_ensureComposerChip_6")));
        return;
      }
      if (!res?.ok || typeof res.t !== 'string' || !res.t.trim()) {
        globalThis.GXT.i18n.bind(btn, "textContent", () => (`⚠ ${res?.error || globalThis.GXT.i18n.t("content_composer_ensureComposerChip_5")}`));
        setTimeout(() => (globalThis.GXT.i18n.bind(btn, "textContent", () => (globalThis.GXT.i18n.t("content_composer_ensureComposerChip_1")))), 4000);
        return;
      }
      // Replace in place through the editor's own event pipeline so X's
      // draft state stays consistent and Ctrl+Z still restores the Persian.
      let ok = false;
      try {
        editor.focus();
        if (document.activeElement !== editor && !editor.contains(document.activeElement)) {
          throw new Error('Editor focus was refused');
        }
        // Scope the selection explicitly. A failed focus followed by a global
        // selectAll can select the page or another editor and destroy its text.
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
        ok = document.execCommand('insertText', false, res.t);
      } catch {
        ok = false;
      }
      if (ok) {
        globalThis.GXT.i18n.bind(btn, "textContent", () => (globalThis.GXT.i18n.t("content_composer_ensureComposerChip_4")));
      } else {
        try {
          await navigator.clipboard.writeText(res.t);
          globalThis.GXT.i18n.bind(btn, "textContent", () => (globalThis.GXT.i18n.t("content_composer_ensureComposerChip_3")));
        } catch {
          globalThis.GXT.i18n.bind(btn, "textContent", () => (globalThis.GXT.i18n.t("content_composer_ensureComposerChip_2")));
        }
      }
      sync();
      setTimeout(() => (globalThis.GXT.i18n.bind(btn, "textContent", () => (globalThis.GXT.i18n.t("content_composer_ensureComposerChip_1")))), 4000);
    });

    // Place the chip right below the editor; X tolerates siblings here.
    editor.insertAdjacentElement('afterend', chip);
  }

  // -------------------------------------------------------- image buttons

  /** Ask for the large variant so small-thumbnail text stays readable. */
  function bigImageUrl(src) {
    try {
      const u = new URL(src);
      if (u.searchParams.has('name')) u.searchParams.set('name', 'large');
      return u.toString();
    } catch {
      return src;
    }
  }

  function ensureImageButton(img) {
    const existing = imageButtons.get(img);
    if (existing?.isConnected && existing.parentElement === img.parentElement) return;
    if (existing) {
      imageOwners.delete(existing);
      existing.remove();
    }
    const parent = img.parentElement;
    // Mark only once the button can actually be placed — marking first meant an
    // image seen mid-insertion (no parent yet) was never retried.
    if (!parent) return;
    try {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    } catch {
      return;
    }
    img.dataset.gxtImgBtn = '1';
    const btn = document.createElement('span');
    imageButtons.set(img, btn);
    imageOwners.set(btn, img);
    btn.className = 'gxt-imgbtn';
    btn.setAttribute('role', 'button');
    globalThis.GXT.i18n.bind(btn, "textContent", () => (globalThis.GXT.i18n.t("content_composer_ensureImageButton_2")));
    btn.dir = 'rtl';
    // v3.2.5 — styled in content/content.css. It was a style string with a
    // literal near-black fill, a literal 11.5px, and a hover state implemented
    // as two JS listeners writing `style.opacity` — which is also why it had no
    // focus appearance at all: an inline style cannot express `:focus-visible`.
    // The hover is a CSS rule now, and the two listeners are gone.
    activatable(btn, async (event) => {
      if (!settings.enabled || !settings.xImageButton || !img.isConnected || !btn.isConnected) return;
      // A keyboard activation has no cursor position; anchor on the image.
      const rect = img.getBoundingClientRect();
      const x = event.clientX || rect.left + rect.width / 2;
      const y = event.clientY || rect.top + rect.height / 2;
      const body = openCard(x, y);
      const requestCard = card;
      const generation = requestGeneration;
      const source = img.src;
      const selectedSource = img.currentSrc;
      globalThis.GXT.i18n.bind(body, "textContent", () => (globalThis.GXT.i18n.t("content_composer_ensureImageButton_1")));
      body.classList.add('dots');
      const res = await send({ type: 'TRANSLATE_IMAGE', url: bigImageUrl(source) });
      if (card !== requestCard || !body.isConnected) return;
      if (generation !== requestGeneration || !img.isConnected || !btn.isConnected ||
          img.src !== source || (selectedSource && img.currentSrc !== selectedSource)) {
        closeCard();
        return;
      }
      if (!settings.enabled ||
          !settings.xImageButton) return; // closed/replaced/disabled while loading
      body.classList.remove('dots');
      if (res?.ok) {
        body.textContent = res.t;
        requestCard.clamp(); // the card grew: keep it fully on screen
      } else {
        // Same unmasked provider/key/HTTP diagnostics the page card shows.
        UI().showFailure(body, res);
      }
    });
    parent.appendChild(btn);
  }

  const imageButtons = new WeakMap();
  const imageOwners = new Map();

  function removeImageButtons() {
    for (const btn of document.querySelectorAll('.gxt-imgbtn')) btn.remove();
    // dataset key gxtImgBtn maps to the data-gxt-img-btn attribute.
    for (const img of document.querySelectorAll('img[data-gxt-img-btn]')) {
      delete img.dataset.gxtImgBtn;
    }
    imageOwners.clear();
  }

  /** Remove composer chips when the feature is switched off. The chip sits
   *  immediately after its editor, so recover the editor to clear the WeakMap
   *  guard — otherwise re-enabling would find the (stale) entry and never
   *  rebuild the chip. */
  function removeComposerChips() {
    for (const chip of [...chipSyncs.keys()]) forgetChip(chip);
  }

  // ---------------------------------------------------------------- scan

  let scanScheduled = false;

  function scan() {
    scanScheduled = false;
    if (!settings.enabled) return;
    if (settings.composerTranslate) {
      for (const editor of document.querySelectorAll(EDITOR_SEL)) ensureComposerChip(editor);
      // Chips that already exist must reflect the current settings too.
      syncComposerChips();
    }
    if (settings.xImageButton) {
      for (const [btn, img] of imageOwners) {
        if (!img.isConnected || !btn.isConnected || img.parentElement !== btn.parentElement) {
          btn.remove();
          imageOwners.delete(btn);
        }
      }
      for (const img of document.querySelectorAll(IMAGE_SEL)) ensureImageButton(img);
    }
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(scan, 400);
  }

  const observer = new MutationObserver(scheduleScan);
  let observing = false;

  /** X mutates its DOM constantly, so only watch it while a feature that
   *  needs the scan is actually on (both default OFF). */
  function syncObserver() {
    const want = !!(settings.enabled && (settings.composerTranslate || settings.xImageButton));
    if (want === observing) return;
    observing = want;
    if (want) observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['src', 'contenteditable', 'data-testid'],
    });
    else observer.disconnect();
  }

  // ---------------------------------------------------------------- init

  void (async () => {
    try {
      settings = await getSettings();
    } catch {
      /* keep defaults */
    }
    UI().configure(settings);
    onStorageChanged(({ settings: next }) => {
      if (!next) return;
      const before = settings;
      settings = next;
      if (globalThis.GXT.cacheNamespace(before) !== globalThis.GXT.cacheNamespace(next) ||
          before.composeTargetLang !== next.composeTargetLang || before.imageTargetLang !== next.imageTargetLang ||
          before.enabled !== next.enabled || before.composerTranslate !== next.composerTranslate ||
          before.xImageButton !== next.xImageButton) {
        requestGeneration += 1;
      }
      // Theme / accent / opacity changes re-skin an open card immediately.
      UI().configure(next);
      // Every OFF path retracts immediately — including the master switch,
      // which used to leave the chip and the image buttons behind.
      const off = before.enabled && !next.enabled;
      if (off || (before.xImageButton && !next.xImageButton)) removeImageButtons();
      if (off || (before.composerTranslate && !next.composerTranslate)) removeComposerChips();
      if (off || (before.xImageButton && !next.xImageButton)) closeCard();
      syncObserver();
      scheduleScan();
    });
    syncObserver();
    scheduleScan();
  })();
})();
