/**
 * RTX Video / hardware-overlay helper (v2.0.2) — opt-in, reversible.
 *
 * WHY THIS EXISTS
 * NVIDIA's RTX Video Super Resolution (and the driver's HDR upscaling) is not
 * applied by the browser: it is applied by the GPU while the video is being
 * presented on its OWN hardware plane (a DirectComposition overlay / MPO).
 * The browser only promotes a <video> to that plane when the video is a plain
 * rectangle of pixels it can hand straight to the compositor. The moment the
 * page decorates it — rounded corners, a CSS filter, a mask, a blend mode,
 * partial opacity, a blurred element sitting on top — the frame has to be
 * composited in software into the page surface instead, the overlay is gone
 * and VSR silently stops. That is why the same 1080p file gets enhanced on one
 * site and not on another, with identical hardware and settings.
 *
 * WHAT THIS DOES
 * For every significant <video> on the page it removes exactly those
 * presentation blockers — on the video and on the few ancestors that clip or
 * blend it — with `!important` inline styles, remembering the previous inline
 * value so everything can be put back. It also strips backdrop blur from
 * elements inside the player (a site's own control bar is a very common
 * offender). Nothing else about the page is touched.
 *
 * WHAT IT CANNOT DO (reported honestly instead)
 *  - Raise or lower the source resolution: VSR ignores input above 1440p.
 *  - Change a player that draws into a <canvas> (no <video> = no overlay).
 *  - Undo a CSS transform on an ancestor — neutralizing it would wreck the
 *    layout, so it is reported, not "fixed".
 *  - Anything outside the page: driver settings, browser zoom, battery saver,
 *    hardware acceleration being off.
 */
'use strict';
(() => {
  if (globalThis.__gxtVsrLoaded) return;
  globalThis.__gxtVsrLoaded = true;
  if (!globalThis.chrome?.runtime?.id) return;

  const MIN_W = 160; // ignore decorative thumbnails/sprites
  const MIN_H = 100;
  const ANCESTOR_DEPTH = 6;
  const STYLE_ID = 'gxt-vsr-style';

  let settings = null;
  let running = false;
  let scanTimer = 0;

  /** element -> [[property, previousInlineValue], …] so every change is undoable. */
  const patched = new Map();

  /**
   * Presentation properties that keep a <video> off the hardware overlay.
   * Values are what the video needs to be "just pixels" again.
   */
  const VIDEO_FIXES = [
    ['border-radius', '0px'],
    ['filter', 'none'],
    ['-webkit-filter', 'none'],
    ['backdrop-filter', 'none'],
    ['mask-image', 'none'],
    ['-webkit-mask-image', 'none'],
    ['clip-path', 'none'],
    ['mix-blend-mode', 'normal'],
    ['will-change', 'auto'],
    // NOT box-shadow: it is painted outside the video rectangle, so it does
    // not cost the overlay — removing it would be a visible change for nothing.
  ];

  /** On ancestors only the properties that actually clip or blend the video. */
  const ANCESTOR_FIXES = [
    ['border-radius', '0px'],
    ['filter', 'none'],
    ['-webkit-filter', 'none'],
    ['backdrop-filter', 'none'],
    ['mask-image', 'none'],
    ['-webkit-mask-image', 'none'],
    ['clip-path', 'none'],
    ['mix-blend-mode', 'normal'],
  ];

  const NEUTRAL = new Set(['none', 'normal', 'auto', '0px', '0%', 'rgba(0, 0, 0, 0) none', '']);

  const isNeutral = (value) =>
    !value || NEUTRAL.has(value.trim()) || /^0px( 0px)*$/.test(value.trim());

  function ours(el) {
    return !!el.closest?.(
      '#gxt-yt-overlay, #gxt-yt-controls, #gxt-yt-panel, .gxt-box, .gxt-linkrow'
    );
  }

  /** Record + override one property, keeping the old inline value. */
  function patch(el, property, value) {
    let entries = patched.get(el);
    if (!entries) patched.set(el, (entries = []));
    if (entries.some(([p]) => p === property)) return;
    entries.push([property, el.style.getPropertyValue(property), el.style.getPropertyPriority(property)]);
    el.style.setProperty(property, value, 'important');
  }

  function restoreAll() {
    for (const [el, entries] of patched) {
      for (const [property, previous, priority] of entries) {
        if (previous) el.style.setProperty(property, previous, priority || '');
        else el.style.removeProperty(property);
      }
    }
    patched.clear();
    document.getElementById(STYLE_ID)?.remove();
    for (const el of document.querySelectorAll('[data-gxt-vsr]')) {
      delete el.dataset.gxtVsr;
    }
  }

  /**
   * One stylesheet handles the case inline styles cannot: elements the site
   * paints ON TOP of the player with a backdrop blur (its own control bar,
   * a title overlay). A backdrop blur forces the compositor to read the video
   * pixels, which is the single most reliable way to lose the overlay plane.
   */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      [data-gxt-vsr="scope"] *:not(#gxt-yt-panel):not(#gxt-yt-panel *) {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
      [data-gxt-vsr="video"] {
        border-radius: 0 !important;
        filter: none !important;
        mask-image: none !important;
        clip-path: none !important;
        mix-blend-mode: normal !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /** Videos worth optimizing: on screen, big enough, not one of ours. */
  function significantVideos() {
    const out = [];
    for (const video of document.querySelectorAll('video')) {
      if (ours(video)) continue;
      const rect = video.getBoundingClientRect();
      if (rect.width < MIN_W || rect.height < MIN_H) continue;
      out.push(video);
    }
    return out;
  }

  /**
   * Inspect (and optionally fix) one video.
   * @param {boolean} apply false = report only
   * @returns {{fixed: string[], blocked: string[], w: number, h: number}}
   */
  function process(video, apply) {
    const fixed = [];
    const blocked = [];
    const cs = getComputedStyle(video);

    for (const [property, value] of VIDEO_FIXES) {
      const current = cs.getPropertyValue(property);
      if (isNeutral(current)) continue;
      fixed.push(`video:${property}`);
      if (apply) patch(video, property, value);
    }
    // Partial opacity also drops the overlay — but a video the page deliberately
    // hides (opacity 0, background decoration) must stay hidden.
    const opacity = parseFloat(cs.opacity);
    if (Number.isFinite(opacity) && opacity < 1 && opacity >= 0.5) {
      fixed.push('video:opacity');
      if (apply) patch(video, 'opacity', '1');
    }

    // Ancestors: the wrapper is usually what rounds/clips the player.
    let node = video.parentElement;
    for (let depth = 0; node && depth < ANCESTOR_DEPTH; depth += 1) {
      if (node === document.body || node === document.documentElement) break;
      const acs = getComputedStyle(node);
      for (const [property, value] of ANCESTOR_FIXES) {
        const current = acs.getPropertyValue(property);
        if (isNeutral(current)) continue;
        // Rounded corners only matter when the wrapper actually clips.
        if (property === 'border-radius' && acs.overflow === 'visible') continue;
        fixed.push(`${node.tagName.toLowerCase()}:${property}`);
        if (apply) patch(node, property, value);
      }
      const op = parseFloat(acs.opacity);
      if (Number.isFinite(op) && op < 1 && op >= 0.5) {
        fixed.push(`${node.tagName.toLowerCase()}:opacity`);
        if (apply) patch(node, 'opacity', '1');
      }
      // Transforms are reported, never touched: neutralizing one would move
      // the player somewhere else on the page.
      const transform = acs.transform;
      if (transform && transform !== 'none' && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(transform)) {
        blocked.push(`${node.tagName.toLowerCase()}:transform`);
      }
      node = node.parentElement;
    }

    if (apply) {
      ensureStyle();
      video.dataset.gxtVsr = 'video';
      // Scope the "no backdrop blur" rule to the player container.
      const scope = video.closest('div, section, article, main, body') || video.parentElement;
      if (scope && !ours(scope)) scope.dataset.gxtVsr = 'scope';
    }

    return {
      fixed,
      blocked,
      w: video.videoWidth || 0,
      h: video.videoHeight || 0,
      cssW: Math.round(video.getBoundingClientRect().width),
      cssH: Math.round(video.getBoundingClientRect().height),
      paused: !!video.paused,
    };
  }

  function optimizeAll() {
    if (!running) return;
    for (const video of significantVideos()) process(video, true);
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      optimizeAll();
    }, 400);
  }

  const observer = new MutationObserver(scheduleScan);

  function start() {
    if (running) return;
    running = true;
    optimizeAll();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // A player often only creates its <video> when playback starts.
    document.addEventListener('play', scheduleScan, true);
    document.addEventListener('loadedmetadata', scheduleScan, true);
    window.addEventListener('resize', scheduleScan, { passive: true });
  }

  function stop() {
    running = false;
    observer.disconnect();
    document.removeEventListener('play', scheduleScan, true);
    document.removeEventListener('loadedmetadata', scheduleScan, true);
    window.removeEventListener('resize', scheduleScan);
    clearTimeout(scanTimer);
    scanTimer = 0;
    restoreAll();
  }

  /**
   * A plain-language report for the popup: what was found, what was fixed and
   * what is still in the way — including the things no extension can change.
   */
  /** Which properties we are currently overriding for this video's subtree.
   *  Read from the undo log, because the computed style now looks clean —
   *  that IS the fix, and the report has to say so. */
  function appliedFor(video) {
    const out = [];
    const collect = (el, prefix) => {
      for (const [property] of patched.get(el) || []) out.push(`${prefix}:${property}`);
    };
    collect(video, 'video');
    let node = video.parentElement;
    for (let depth = 0; node && depth < ANCESTOR_DEPTH; depth += 1) {
      collect(node, node.tagName.toLowerCase());
      node = node.parentElement;
    }
    return out;
  }

  function buildReport() {
    const videos = significantVideos().map((video) => {
      const info = process(video, false); // report only — never mutate here
      const applied = appliedFor(video);
      const notes = [];
      let verdict = 'ok';
      if (!info.w || !info.h) {
        notes.push(globalThis.GXT.i18n.t("content_vsr_videos_5"));
        verdict = 'unknown';
      } else if (info.h > 1440) {
        notes.push(globalThis.GXT.i18n.t("content_vsr_videos_4"));
        verdict = 'no';
      } else if (info.h >= 1080 && info.cssH && info.cssH <= info.h) {
        notes.push(globalThis.GXT.i18n.t("content_vsr_videos_3"));
      }
      if (info.paused) notes.push(globalThis.GXT.i18n.t("content_vsr_videos_2"));
      if (info.blocked.length) {
        notes.push(globalThis.GXT.i18n.t("content_vsr_videos_1"));
      }
      return {
        w: info.w,
        h: info.h,
        cssW: info.cssW,
        cssH: info.cssH,
        applied, // properties this extension is currently neutralizing
        remaining: info.fixed, // blockers still in effect (helper off / new node)
        blocked: info.blocked, // found, deliberately not touched
        notes,
        verdict,
      };
    });
    const canvases = [...document.querySelectorAll('canvas')].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width >= 320 && r.height >= 200;
    }).length;
    return {
      ok: true,
      running,
      url: location.host,
      videos,
      canvasOnly: videos.length === 0 && canvases > 0,
      forceH264: !!globalThis.__gxtVsrCodec,
      patchedElements: patched.size,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'GXT_VSR_REPORT') return;
    try {
      sendResponse(buildReport());
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return true;
  });

  void (async () => {
    try {
      settings = await globalThis.GXT.getSettings();
    } catch {
      return;
    }
    if (settings.vsrHelper) start();
    globalThis.GXT.onStorageChanged?.(({ settings: next }) => {
      if (!next) return;
      const before = settings;
      settings = next;
      if (!before?.vsrHelper && next.vsrHelper) start();
      else if (before?.vsrHelper && !next.vsrHelper) stop();
    });
  })();
})();
