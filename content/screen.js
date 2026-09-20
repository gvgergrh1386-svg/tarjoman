/**
 * Screen-region translation — the feature that lets this product leave the
 * browser (v3.0.0).
 *
 * WHY IT EXISTS
 * ─────────────
 * Everything else here can only translate what the DOM exposes. That is a hard
 * ceiling, and it excludes exactly the things a Persian reader most often
 * cannot get help with:
 *
 *   · video games (text drawn to a canvas, or a native window entirely)
 *   · desktop applications — an installer, an error dialog, a spreadsheet
 *   · DRM-protected video, where the player refuses to give up its pixels
 *   · a PDF in some other viewer, or a scanned document
 *   · anything at all in a screenshot someone sent you
 *
 * The user picks a screen or window with the browser's own picker, drags a
 * rectangle over the text, and gets Persian back. The OCR runs on the LOCAL
 * bridge (see bridge.py `/ocr`), so the pixels never leave the machine — only
 * the recognised text is sent for translation, and only if a cloud engine is
 * selected.
 *
 * DESIGN NOTES
 *  - `getDisplayMedia` is used rather than `chrome.desktopCapture` because it
 *    needs no extra manifest permission and puts the user in front of an
 *    explicit, familiar picker every single time. Capturing someone's screen
 *    is not something an extension should be able to make quiet.
 *  - ONE frame is grabbed and the track is stopped IMMEDIATELY. There is no
 *    reason to hold a live screen capture open, and a stray one would show in
 *    the browser's sharing indicator forever.
 *  - The frozen frame is what the user drags on, not the live screen: a
 *    selection made against moving content is a selection of the wrong thing.
 */
'use strict';
(() => {
  if (globalThis.GXT?.screenReady) return;
  globalThis.GXT = globalThis.GXT || {};
  globalThis.GXT.screenReady = true;

  const UI = () => globalThis.GXT.ui;

  let overlay = null;
  let settings = null;

  const send = (message) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          void chrome.runtime.lastError;
          resolve(reply || null);
        });
      } catch {
        resolve(null);
      }
    });

  /** Grab exactly one frame of a screen the user chooses, then let it go. */
  async function grabFrame() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 },
        audio: false,
        // Hint the picker toward whole screens/windows, which is what this is
        // for — a browser tab can already be translated properly.
        preferCurrentTab: false,
      });
    } catch (error) {
      // The user cancelling the picker is the normal path, not an error.
      if (String(error?.name) === 'NotAllowedError') return null;
      throw error;
    }
    let timer;
    const cleanup = [];
    try {
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      const frameReady = new Promise((resolve, reject) => {
        const check = () => { if (video.videoWidth && video.videoHeight) resolve(); };
        const failed = () => reject(new Error(globalThis.GXT.i18n.t("content_screen_failed_1")));
        video.addEventListener('loadeddata', check);
        video.addEventListener('error', failed);
        cleanup.push(() => video.removeEventListener('loadeddata', check),
          () => video.removeEventListener('error', failed));
        for (const track of stream.getTracks()) {
          track.addEventListener('ended', failed);
          cleanup.push(() => track.removeEventListener('ended', failed));
          if (track.readyState === 'ended') failed();
        }
        check();
      });
      await Promise.race([
        Promise.all([video.play(), frameReady]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(globalThis.GXT.i18n.t("content_screen_grabFrame_1"))), 12000);
        }),
      ]);
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      return canvas;
    } finally {
      clearTimeout(timer);
      for (const remove of cleanup) remove();
      // Immediately, and in a finally: a screen capture left running shows in
      // the browser's sharing indicator and is exactly the kind of thing that
      // makes people distrust an extension.
      for (const track of stream.getTracks()) track.stop();
    }
  }

  /**
   * The picker's own styles — v3.2.5.
   *
   * This surface used to build its OWN shadow root with its own `all: initial`
   * reset, its own font stack and five hand-picked colours, because
   * `GXT.ui.surface()` only mounted inside an element the page owns and there
   * was no helper for a full-viewport overlay. `GXT.ui.layer()` is that helper
   * now, so the picker gets the shared token block, the shared component sheet
   * and every accessibility rule in it, and only has to describe what is
   * genuinely its own: the frozen frame, the veil and the selection box.
   *
   * The veil and the marching border stay achromatic on purpose. This overlay
   * covers a screenshot of the user's whole screen — the thing being dimmed is
   * arbitrary pixels, and a themed wash over them would tint what the user is
   * trying to read to decide where to drag.
   */
  const PICKER_CSS = `
    .wrap { position: fixed; inset: 0; cursor: crosshair; user-select: none; }
    img { position: absolute; inset: 0; width: 100%; height: 100%;
          object-fit: contain; background: #000; }
    .veil { position: absolute; inset: 0; background: rgba(0,0,0,.45); }
    /* The selection: a bright hairline plus a 9999px shadow that dims
       everything outside it, so the crop is legible against any wallpaper. */
    .box { position: absolute; display: none;
           border: 2px solid #fff; outline: 1px solid var(--gxt-accent);
           box-shadow: 0 0 0 9999px rgba(0,0,0,.45); }
    /* The instruction is the design system's toast, positioned at the top. */
    .hint { position: fixed; top: var(--gxt-sp-5); left: 50%;
            transform: translateX(-50%);
            display: flex; align-items: center; gap: var(--gxt-sp-2);
            background: var(--gxt-card); color: var(--gxt-fg);
            border: 1px solid var(--gxt-line);
            border-radius: var(--gxt-radius-pill);
            padding: var(--gxt-sp-2) var(--gxt-sp-4);
            font-size: var(--gxt-fs-sm); font-weight: 700;
            line-height: var(--gxt-lh-tight);
            box-shadow: var(--gxt-elev-2); direction: rtl; }
    .hint::before { content: ""; width: var(--gxt-dot); height: var(--gxt-dot);
            border-radius: 50%; background: var(--gxt-accent); flex: none; }
    .hint kbd { font: inherit; font-size: var(--gxt-fs-xs);
            border: 1px solid var(--gxt-line-strong);
            border-radius: var(--gxt-radius-sm);
            padding: 0 var(--gxt-sp-1); color: var(--gxt-fg-muted); }
    @media (forced-colors: active) {
      .hint { border-color: CanvasText; background: Canvas; color: CanvasText; }
      .box { border-color: Highlight; outline-color: Highlight; }
    }
  `;

  /** Full-screen picker over the frozen frame. Resolves to a cropped canvas. */
  function pickRegion(frame) {
    return new Promise((resolve) => {
      const mounted = UI()?.layer?.({ id: 'screen', css: PICKER_CSS });
      const root = mounted?.root;
      // No shared layer (a page where content/ui.js did not load): the feature
      // must still work, so fall back to a bare picker rather than refuse.
      if (!root) return void resolve(fallbackPick(frame));
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      globalThis.GXT.i18n.bind(wrap, "innerHTML", () => ('<img alt="">'
        + '<div class="veil"></div>'
        + '<div class="box"></div>'
        + globalThis.GXT.i18n.t("content_screen_pickRegion_1")));
      root.appendChild(wrap);
      const img = root.querySelector('img');
      const veil = root.querySelector('.veil');
      const box = root.querySelector('.box');
      img.src = frame.toDataURL('image/png');

      let start = null;
      const finish = (rect) => {
        UI()?.dropSurface?.('screen');
        document.removeEventListener('keydown', onKey, true);
        resolve(rect);
      };
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          finish(null);
        }
      };
      document.addEventListener('keydown', onKey, true);

      wrap.addEventListener('pointerdown', (event) => {
        start = { x: event.clientX, y: event.clientY };
        veil.style.display = 'none';
        box.style.display = 'block';
        wrap.setPointerCapture(event.pointerId);
      });
      wrap.addEventListener('pointermove', (event) => {
        if (!start) return;
        const x = Math.min(start.x, event.clientX);
        const y = Math.min(start.y, event.clientY);
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        box.style.width = `${Math.abs(event.clientX - start.x)}px`;
        box.style.height = `${Math.abs(event.clientY - start.y)}px`;
      });
      wrap.addEventListener('pointerup', (event) => {
        if (!start) return finish(null);
        const x0 = Math.min(start.x, event.clientX);
        const y0 = Math.min(start.y, event.clientY);
        const w = Math.abs(event.clientX - start.x);
        const h = Math.abs(event.clientY - start.y);
        start = null;
        // A stray click is not a selection. Below this the crop is noise and
        // the OCR would return confident nonsense.
        if (w < 12 || h < 12) return finish(null);
        finish(cropTo(frame, img, { x: x0, y: y0, w, h }));
      });
    });
  }

  /**
   * The picker without the shared UI layer — v3.2.5.
   *
   * `GXT.ui.layer()` is new, and a browser still running the PREVIOUS
   * content-script registration has whatever content/ui.js it was injected with:
   * Chrome re-reads that list only when the extension is RELOADED, not when the
   * page is. v3.2.0 shipped a version of exactly this mistake on the YouTube
   * surface — `if (!surface) return;` — and the entire in-player UI silently
   * vanished for every already-open browser.
   *
   * So a missing helper degrades instead of deleting the feature: same geometry,
   * same keys, same crop maths, only unthemed. Deliberately minimal — this path
   * exists to survive one extension update, not to be maintained as a second
   * design.
   */
  function fallbackPick(frame) {
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.setAttribute('data-gxt-screen', '');
      host.style.cssText =
        'all:initial;position:fixed;inset:0;z-index:2147483646;cursor:crosshair;'
        + 'font-family:"Vazirmatn","Segoe UI",Tahoma,sans-serif;';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = PICKER_CSS
        + '.hint{background:rgba(10,12,16,.94);color:#fff;'
        + 'border:1px solid rgba(255,255,255,.25);border-radius:9999px;'
        + 'padding:9px 16px;font-size:14px;font-weight:700;}'
        + '.hint::before{background:#1d9bf0;width:7px;height:7px;}';
      shadow.appendChild(style);
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      globalThis.GXT.i18n.bind(wrap, "innerHTML", () => ('<img alt="">'
        + '<div class="veil"></div>'
        + '<div class="box"></div>'
        + globalThis.GXT.i18n.t("content_screen_fallbackPick_1")));
      shadow.appendChild(wrap);
      const img = shadow.querySelector('img');
      const veil = shadow.querySelector('.veil');
      const box = shadow.querySelector('.box');
      img.src = frame.toDataURL('image/png');
      document.documentElement.appendChild(host);

      let start = null;
      const done = (rect) => {
        host.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(rect);
      };
      const onKey = (event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        done(null);
      };
      document.addEventListener('keydown', onKey, true);
      wrap.addEventListener('pointerdown', (event) => {
        start = { x: event.clientX, y: event.clientY };
        veil.style.display = 'none';
        box.style.display = 'block';
        wrap.setPointerCapture(event.pointerId);
      });
      wrap.addEventListener('pointermove', (event) => {
        if (!start) return;
        box.style.left = `${Math.min(start.x, event.clientX)}px`;
        box.style.top = `${Math.min(start.y, event.clientY)}px`;
        box.style.width = `${Math.abs(event.clientX - start.x)}px`;
        box.style.height = `${Math.abs(event.clientY - start.y)}px`;
      });
      wrap.addEventListener('pointerup', (event) => {
        if (!start) return done(null);
        const x0 = Math.min(start.x, event.clientX);
        const y0 = Math.min(start.y, event.clientY);
        const w = Math.abs(event.clientX - start.x);
        const h = Math.abs(event.clientY - start.y);
        start = null;
        if (w < 12 || h < 12) return done(null);
        done(cropTo(frame, img, { x: x0, y: y0, w, h }));
      });
    });
  }

  /**
   * Map a rectangle drawn in CSS pixels onto the captured frame.
   *
   * The frame is shown with `object-fit: contain`, so it is letterboxed: the
   * displayed image is not the element's box, and using the element's box
   * would crop the wrong part of the screen — subtly, which is worse than
   * obviously.
   */
  function cropTo(frame, img, rect) {
    const view = img.getBoundingClientRect();
    const scale = Math.min(view.width / frame.width, view.height / frame.height);
    if (!Number.isFinite(scale) || scale <= 0 || rect.w <= 0 || rect.h <= 0) return null;
    const shownW = frame.width * scale;
    const shownH = frame.height * scale;
    const offsetX = view.left + (view.width - shownW) / 2;
    const offsetY = view.top + (view.height - shownH) / 2;

    const sx = Math.max(0, (rect.x - offsetX) / scale);
    const sy = Math.max(0, (rect.y - offsetY) / scale);
    const right = Math.min(frame.width, (rect.x + rect.w - offsetX) / scale);
    const bottom = Math.min(frame.height, (rect.y + rect.h - offsetY) / scale);
    const sw = right - sx;
    const sh = bottom - sy;
    if (sw < 4 || sh < 4) return null;

    const out = document.createElement('canvas');
    // OCR accuracy depends on glyph height far more than on anything else, so
    // a small selection is upscaled before it is sent. 2× is the point where
    // this stops helping and starts just costing bytes.
    const zoom = sh < 220 ? 2 : 1;
    out.width = Math.round(sw * zoom);
    out.height = Math.round(sh * zoom);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return out;
  }

  /** The whole flow, from the toolbar/menu/hotkey to Persian on screen. */
  async function translateScreenRegion() {
    settings = settings || (await globalThis.GXT?.getSettings?.());
    UI().configure(settings);
    let frame;
    try {
      frame = await grabFrame();
    } catch (error) {
      UI().toast(globalThis.GXT.i18n.t("content_screen_translateScreenRegion_5", {v0:(error.message || error)}));
      return;
    }
    if (!frame) return; // user cancelled the picker

    const crop = await pickRegion(frame);
    if (!crop) return; // user cancelled the selection

    const card = UI().card({
      get title() { return globalThis.GXT.i18n.t("content_screen_card_2"); },
      get body() { return globalThis.GXT.i18n.t("content_screen_card_1"); },
      dots: true,
      speak: true,
    });
    const data = crop.toDataURL('image/png');
    const res = await send({ type: 'OCR_TRANSLATE', image: data });
    if (!card.isOpen()) return;

    if (!res?.ok) {
      card.error(
        res?.error || globalThis.GXT.i18n.t("content_screen_translateScreenRegion_4"),
        res?.code === 'NO_OCR'
          ? globalThis.GXT.i18n.t("content_screen_translateScreenRegion_3")
          : res?.detail
      );
      return;
    }
    if (!res.text) {
      card.setText(globalThis.GXT.i18n.t("content_screen_translateScreenRegion_2"));
      return;
    }
    card.setText(res.translated || res.text);
    card.setSubtitle?.(globalThis.GXT.i18n.t("content_screen_translateScreenRegion_1", {v0:(res.lines || 0)}));
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'GXT_SCREEN') void translateScreenRegion();
  });

  globalThis.GXT.screen = { translateScreenRegion, _internal: { cropTo, pickRegion, grabFrame } };
})();
