/**
 * The in-player design system — v3.3.8.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * v2.9.0 rebuilt the extension's visual language: a seven-step type scale, a
 * six-step spacing scale, radii, motion, derived AAA ink, real focus rings,
 * forced-colors support. The popup, the page cards and the subtitle workshop
 * all adopted it. The YouTube in-player UI did not — it was still assembled
 * from hand-concatenated inline style strings, which is why it looked like a
 * different product:
 *
 *   · ~15 magic font sizes and paddings, none from the scale. `font-size:10.5px`
 *     appeared SEVEN times — below the 11px floor dev/uicheck.html enforces for
 *     every other surface.
 *   · the settings panel used a raw `<input type=checkbox>` with `accent-color`,
 *     while the same switch in the popup is a designed track-and-knob control.
 *   · no focus ring on anything (an inline style cannot express
 *     `:focus-visible`), so the whole panel was invisible to keyboard use.
 *   · no `prefers-reduced-motion` and no `forced-colors` rule, for the same
 *     reason — a media query has nowhere to live in a style attribute.
 *
 * Inline styles were not laziness: YouTube's stylesheets are aggressive and an
 * inline declaration outranks them. The fix is to keep the isolation but stop
 * paying that price — the UI is mounted in a shadow root inside `#movie_player`
 * (so it enters fullscreen with the video) and styled by a real stylesheet.
 *
 * Everything below references TOKENS ONLY. Sizes step with the user's density
 * choice, colours are the same derived AAA values the popup uses, and the
 * player UI now inherits every accessibility rule the rest of the product has.
 */
'use strict';
(() => {
  globalThis.GXT = globalThis.GXT || {};
  if (globalThis.GXT.playerCss) return;

  // WARNING: this is a template literal. A backtick anywhere inside it ends
  // the string and turns the rest of the file into a syntax error, which fails
  // SILENTLY as far as the product is concerned: the shadow root simply gets no
  // stylesheet and the whole in-player UI renders invisible. So use 'single
  // quotes' in prose here, never backticks.
  //
  // This has now caught the codebase out FOUR times — twice in this file and
  // twice in content/ui.js, every time inside a CSS *comment*, because writing
  // prose about CSS is exactly when a hand reaches for a backtick. There are
  // three nets: dev/run_harness.py refuses to start the browser if either sheet
  // literal ends early (the cheap one, and it names the line), dev/selftest.html
  // asserts both modules produced a real stylesheet, and the runner now reports
  // uncaught exceptions instead of silently losing the checks that depended on
  // them.
  globalThis.GXT.playerCss = `
    /* ═══════════════════════════════════════════════ the host surface ══
       Fills the player so percentage positioning and drag geometry are
       unchanged, and passes pointer events through: only real controls
       accept them, or the host would swallow every click on the video. */
    /* The host's POSITION and Z-INDEX are set inline by youtube.js (see
       HOST_STYLE there): the host carries 'all: initial' inline to lock the
       page out, and an inline declaration beats any rule here that is not
       '!important' — which is exactly how v3.2.0 ended up with 'z-index: auto'
       and the whole UI painted under YouTube's controls. These stay as a floor
       for any caller that does not supply its own, and they are marked
       important so the floor cannot be lost the same way twice. */
    :host {
      position: absolute !important;
      inset: 0 !important;
      pointer-events: none !important;
      z-index: 2147483000 !important;
      font: var(--gxt-fs-md)/var(--gxt-lh) var(--gxt-font); font-weight: var(--gxt-weight, 400);
      color: var(--gxt-fg);
      direction: var(--gxt-ui-dir, rtl);
    }

    /* ═══════════════════════════════════════════ the control cluster ══ */
    .yt-controls {
      position: absolute;
      /* PHYSICAL 'right', not 'inset-inline-end' — v3.2.0 fix.
         The host is 'direction: rtl' (the UI is Persian), which makes
         'inset-inline-end' resolve to LEFT and moved the whole cluster to the
         wrong corner of the player. Where these sit is a fact about the
         PLAYER's layout — YouTube's own controls are bottom-right — not about
         the direction of the text inside them. */
      right: var(--gxt-sp-3);
      bottom: 7px;
      display: flex;
      gap: 2px;
      align-items: center;
      direction: var(--gxt-ui-dir, rtl);
      pointer-events: auto;
      padding: 3px;
      border: 1px solid var(--gxt-line);
      border-radius: var(--gxt-radius-pill);
      background: var(--gxt-card);
      box-shadow: var(--gxt-elev-2);
      /* Above the caption (59) — see .yt-cap-wrap. */
      z-index: 60;
      transition: opacity var(--gxt-dur-3) var(--gxt-ease);
    }

    /* A chip, matching the popup's pill buttons and content/ui.js's '.btn': same
       radius token, same weight, same motion, and — v3.2.5 — the same CONTROL
       SCALE, so «فشرده» / «راحت» / «بزرگ» move this button and the one in a
       translation card's header by the same amount. Until v3.2.5 the two were
       36px and 26px respectively, both written as literals in different files.

       This is the FLOATING variant of that shared control: it sits on video with
       nothing behind it, so unlike '.btn' it carries its own surface and
       elevation. Everything else is identical by construction. */
    .yt-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--gxt-sp-1);
      min-height: var(--gxt-ctl-h);
      padding: 0 var(--gxt-ctl-px);
      border: 1px solid var(--gxt-line);
      border-radius: var(--gxt-radius-pill);
      background: var(--gxt-card);
      color: var(--gxt-fg);
      font: inherit;
      font-size: var(--gxt-fs-sm);
      font-weight: var(--gxt-weight-strong, 700);
      line-height: var(--gxt-lh-tight);
      white-space: nowrap;
      cursor: pointer;
      box-shadow: var(--gxt-elev-2);
      backdrop-filter: var(--gxt-backdrop, none);
      -webkit-backdrop-filter: var(--gxt-backdrop, none);
      transition: background var(--gxt-motion), border-color var(--gxt-motion),
        color var(--gxt-motion), transform var(--gxt-dur-1) var(--gxt-ease);
    }
    .yt-btn:hover:not(:disabled) { border-color: var(--gxt-accent); }
    .yt-btn:active:not(:disabled) { transform: scale(.97); }
    .yt-btn:focus-visible { outline: none; box-shadow: var(--gxt-focus-ring); }
    .yt-btn[aria-pressed="true"] {
      background: var(--gxt-accent-solid);
      border-color: var(--gxt-accent-solid);
      color: var(--gxt-accent-fg);
    }
    .yt-btn[aria-pressed="true"]:hover { background: var(--gxt-accent-hover); }
    .yt-btn:disabled { opacity: .5; cursor: default; }
    /* The icon variant is square and keeps the 24×24 target floor (2.5.8). */
    .yt-btn.icon {
      padding: 0;
      width: var(--gxt-ctl-h);
      font-size: var(--gxt-fs-lg);
    }
    /* A status dot, so «زیرنویس ✓» does not need a tick glued into its label.
       Same token as the card title's and the pill label's dot. */
    .yt-btn .dot {
      width: var(--gxt-dot); height: var(--gxt-dot); border-radius: 50%; flex: none;
      background: currentColor; opacity: .45;
    }
    .yt-btn[aria-pressed="true"] .dot { opacity: 1; }
    /* The dock is icon-first: all three controls remain present, while their
       full Persian names stay available to hover tooltips and screen readers. */
    .yt-controls .yt-btn {
      position: relative;
      width: var(--gxt-ctl-h);
      min-width: var(--gxt-ctl-h);
      padding: 0;
      border-color: transparent;
      background: transparent;
      box-shadow: none;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
    .yt-controls .yt-btn:hover:not(:disabled) {
      border-color: var(--gxt-accent-line);
      background: var(--gxt-accent-soft);
    }
    .yt-controls .yt-btn::after {
      content: attr(data-glyph);
      font-size: var(--gxt-fs-md);
      font-weight: 900;
      line-height: 1;
    }
    .yt-controls .yt-btn .txt {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .yt-controls .yt-btn .dot {
      position: absolute;
      top: 3px;
      right: 3px;
    }

    /* ═════════════════════════════════════════════ the settings sheet ══
       Structurally the popup's card: one elevated surface, a titled head,
       named groups, rows of label + control. */
    .yt-panel {
      position: absolute;
      /* Same reason as .yt-controls: physical, so the sheet opens above the
         gear that summoned it rather than across the player from it. */
      right: var(--gxt-sp-3);
      bottom: 112px;
      width: min(390px, calc(100% - var(--gxt-sp-5) * 2));
      /* Bounded by what is actually left above the controls, so the sheet can
         never be clipped by the top of the player on a short one (a Shorts
         player, or a small embedded window). */
      /* Measured: at 'calc(100% - 128px)' the sheet's top edge sat 16px from the
         top of a 506px player, which reads as overflowing rather than floating.
         160px leaves the controls their room AND a visible margin above. */
      max-height: min(520px, calc(100% - 160px));
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      /* Above the controls that summoned it, and above the caption. */
      z-index: 61;
      background: var(--gxt-card);
      color: var(--gxt-fg);
      border: 1px solid var(--gxt-panel-line, var(--gxt-line));
      border-radius: var(--gxt-radius-lg);
      box-shadow: var(--gxt-elev-3);
      backdrop-filter: var(--gxt-backdrop, none);
      -webkit-backdrop-filter: var(--gxt-backdrop, none);
      overflow: hidden;
      animation: yt-rise var(--gxt-dur-3) var(--gxt-ease-emphasized);
    }
    @keyframes yt-rise {
      from { opacity: 0; transform: translateY(8px) scale(.98); }
      to { opacity: 1; transform: none; }
    }
    .yt-panel-head {
      display: flex;
      align-items: center;
      gap: var(--gxt-sp-2);
      padding: 11px var(--gxt-sp-4);
      border-bottom: 1px solid var(--gxt-line);
      background: linear-gradient(180deg, var(--gxt-accent-soft), transparent);
      flex: none;
    }
    .yt-panel-head h2 {
      margin: 0;
      flex: 1;
      font-size: var(--gxt-fs-md);
      font-weight: 800;
      letter-spacing: -.01em;
      display: flex; align-items: center; gap: var(--gxt-sp-2);
    }
    .yt-panel-head h2::before {
      content: ""; width: var(--gxt-dot); height: var(--gxt-dot);
      border-radius: 50%; flex: none;
      background: var(--gxt-accent);
    }
    .yt-panel-body {
      padding: var(--gxt-sp-3) var(--gxt-sp-4) var(--gxt-sp-4);
      display: flex;
      flex-direction: column;
      gap: var(--gxt-sp-3);
      overflow-y: auto;
      overscroll-behavior: contain;
      /* Measured: this body is ~1180px of content in ~325px of space, and it
         used to end at a hard edge with nothing to suggest more existed. The
         mask fades the first and last few pixels ONLY while there is something
         scrolled out of view in that direction — 'scroll-driven' via the
         standard two-gradient trick, so no script is involved. */
      mask-image: linear-gradient(
        to bottom,
        transparent 0,
        #000 var(--gxt-sp-3),
        #000 calc(100% - var(--gxt-sp-3)),
        transparent 100%
      );
      -webkit-mask-image: linear-gradient(
        to bottom,
        transparent 0,
        #000 var(--gxt-sp-3),
        #000 calc(100% - var(--gxt-sp-3)),
        transparent 100%
      );
    }
    /* A slim, themed scrollbar — the default one is a bright native strip
       across a dark panel over video. */
    .yt-panel-body::-webkit-scrollbar { width: 10px; }
    .yt-panel-body::-webkit-scrollbar-thumb {
      background: var(--gxt-line-strong); border-radius: var(--gxt-radius-pill);
      border: 3px solid transparent; background-clip: content-box;
    }

    .yt-tabs {
      position: sticky;
      top: calc(var(--gxt-sp-3) * -1);
      z-index: 3;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--gxt-sp-1);
      padding: var(--gxt-sp-1);
      margin-bottom: var(--gxt-sp-3);
      border: 1px solid var(--gxt-line);
      border-radius: var(--gxt-radius-md);
      background: var(--gxt-card);
      box-shadow: var(--gxt-elev-1);
    }
    .yt-tab {
      min-height: 34px;
      border: 0;
      border-radius: calc(var(--gxt-radius-md) - 3px);
      background: transparent;
      color: var(--gxt-fg-muted);
      font: inherit;
      font-size: var(--gxt-fs-sm);
      font-weight: 800;
      cursor: pointer;
      transition: background var(--gxt-motion), color var(--gxt-motion);
    }
    .yt-tab:hover { color: var(--gxt-fg); background: var(--gxt-accent-soft); }
    .yt-tab:focus-visible { outline: none; box-shadow: var(--gxt-focus-ring); }
    .yt-tab.active {
      color: var(--gxt-accent-fg);
      background: var(--gxt-accent-solid);
    }
    .yt-pane {
      display: flex;
      flex-direction: column;
      gap: var(--gxt-sp-3);
      min-width: 0;
    }
    .yt-pane[hidden] { display: none; }

    .yt-dashboard {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--gxt-sp-2);
    }
    .yt-state-card {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
      padding: var(--gxt-sp-3);
      border: 1px solid var(--gxt-line);
      border-radius: var(--gxt-radius-md);
      background: var(--gxt-accent-soft);
    }
    .yt-state-card strong { font-size: var(--gxt-fs-sm); color: var(--gxt-fg); }
    .yt-state-card span {
      color: var(--gxt-fg-muted);
      font-size: var(--gxt-fs-xs);
      line-height: var(--gxt-lh-tight);
    }

    /* Group label — the popup's '.group-lbl', same role and same weight. */
    .yt-group {
      font-size: var(--gxt-fs-2xs);
      font-weight: 800;
      color: var(--gxt-fg-faint);
      letter-spacing: .04em;
      padding-bottom: var(--gxt-sp-1);
      border-bottom: 1px solid var(--gxt-line);
      margin-top: var(--gxt-sp-2);
    }
    .yt-group:first-child { margin-top: 0; }

    .yt-row {
      display: flex;
      align-items: center;
      gap: var(--gxt-sp-3);
      justify-content: space-between;
      min-height: 28px;
    }
    .yt-lbl {
      flex: 1;
      min-width: 0;
      font-size: var(--gxt-fs-sm);
      color: var(--gxt-fg);
      line-height: var(--gxt-lh-tight);
    }
    /* Explanations use the SIZE-and-weight hierarchy the design system is
       built on, not a lower opacity — v2.9.0's whole point was that fading
       text below the legibility floor is not a hierarchy. */
    .yt-hint {
      font-size: var(--gxt-fs-xs);
      color: var(--gxt-fg-muted);
      line-height: var(--gxt-lh);
      border-inline-start: 2px solid var(--gxt-accent-line);
      padding-inline-start: var(--gxt-sp-2);
    }
    .yt-note {
      font-size: var(--gxt-fs-xs);
      color: var(--gxt-fg-muted);
      line-height: var(--gxt-lh);
    }
    .yt-status { font-size: var(--gxt-fs-xs); color: var(--gxt-fg-muted); line-height: var(--gxt-lh); }
    .yt-status.warn { color: var(--gxt-warn); }
    .yt-status.err { color: var(--gxt-err); }
    .yt-status.ok { color: var(--gxt-ok); }

    /* ══════════════════════════════════════════════════════ controls ══ */
    .yt-panel select {
      flex: none;
      max-width: 62%;
      font: inherit;
      font-size: var(--gxt-fs-xs);
      color: var(--gxt-fg);
      background: var(--gxt-input-bg, var(--gxt-bg-sunken));
      border: 1px solid var(--gxt-input-line, var(--gxt-line-strong));
      border-radius: var(--gxt-radius-sm);
      padding: 6px 8px;
      cursor: pointer;
      direction: var(--gxt-ui-dir, rtl);
      transition: border-color var(--gxt-motion);
    }
    .yt-panel select:hover { border-color: var(--gxt-accent); }
    .yt-panel select:focus-visible { outline: none; box-shadow: var(--gxt-focus-ring); }

    /* The SAME switch as the popup — v3.2.5 makes that literally true.
       v3.2.0 rebuilt it from tokens for COLOUR but kept its own geometry
       (40×24, an 18px knob, a -16px travel), which is the popup's '.sm' size
       rather than its full one, so the panel's switches were quietly smaller
       than every other switch in the product and did not grow with «بزرگ».
       The 'sw-*' tokens are now the one answer, and the travel is derived from
       the width and the knob rather than restated. */
    .yt-switch {
      position: relative; display: inline-block;
      width: var(--gxt-sw-w); height: var(--gxt-sw-h); flex: none;
    }
    .yt-switch input {
      position: absolute; inset: 0; width: 100%; height: 100%;
      margin: 0; opacity: 0; cursor: pointer; z-index: 1;
    }
    .yt-switch .track {
      position: absolute; inset: 0; border-radius: var(--gxt-switch-radius, 9999px);
      background: var(--gxt-line-strong);
      transition: background var(--gxt-motion);
      pointer-events: none;
    }
    .yt-switch .track::before {
      content: ""; position: absolute; top: 3px; inset-inline-start: 3px;
      width: var(--gxt-sw-knob); height: var(--gxt-sw-knob);
      border-radius: var(--gxt-switch-knob-radius, 50%); background: #fff;
      box-shadow: var(--gxt-elev-1);
      transition: transform var(--gxt-dur-2) var(--gxt-ease-emphasized);
    }
    .yt-switch input:checked + .track { background: var(--gxt-accent-solid); }
    .yt-switch input:checked + .track::before {
      transform: translateX(calc(var(--gxt-sw-travel) * var(--gxt-switch-sign, -1)));
    }
    .yt-switch input:focus-visible + .track { box-shadow: var(--gxt-focus-ring); }
    .yt-switch input:disabled + .track { opacity: .5; }

    /* Progress: the full-video button doubles as a bar, so the percentage is
       shown where the action is instead of in a separate widget. */
    .yt-bulk {
      position: relative;
      width: 100%;
      justify-content: center;
      overflow: hidden;
      isolation: isolate;
    }
    .yt-bulk .fill {
      position: absolute; inset-block: 0; inset-inline-start: 0;
      width: 0; background: var(--gxt-accent-soft); z-index: -1;
      transition: width var(--gxt-dur-3) var(--gxt-ease);
    }

    /* Full-width secondary action (download SRT, reset position). */
    .yt-btn.wide {
      width: 100%;
      justify-content: center;
      background: transparent;
      border-color: var(--gxt-line-strong);
      color: var(--gxt-fg-muted);
      box-shadow: none;
      font-weight: 600;
      min-height: 32px;
      font-size: var(--gxt-fs-xs);
    }
    .yt-btn.wide:hover { color: var(--gxt-fg); background: var(--gxt-accent-soft); }
    /* The gear's close button: quiet until reached. */
    .yt-btn.quiet {
      background: transparent; box-shadow: none; border-color: transparent;
      color: var(--gxt-fg-muted); min-height: 28px; width: 28px;
    }
    .yt-btn.quiet:hover { color: var(--gxt-fg); background: var(--gxt-accent-soft); }
    /* The voice button on a video the caption engine cannot serve: discouraged,
       not forbidden — one click switches the engine to the one that works. */
    .yt-btn.warned { border-style: dashed; color: var(--gxt-fg-muted); }

    /* The range input — the popup's, not the browser's (v3.2.5).
       'accent-color' recolours the native widget and nothing else, so the size
       slider was the one control in this panel that still looked like a Chrome
       form control: a thick platform track and a platform thumb, beside a
       hand-built switch and a token-built select. Same 4px rail, same 18px
       accent thumb ringed in the surface colour, same hover growth as the
       popup's sliders. */
    .yt-range {
      -webkit-appearance: none;
      appearance: none;
      flex: 1;
      min-width: 0;
      height: 4px;
      margin: var(--gxt-sp-2) 0;
      border-radius: var(--gxt-radius-pill);
      background: var(--gxt-line-strong);
      cursor: pointer;
    }
    .yt-range::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 18px;
      height: 18px;
      border: 2px solid var(--gxt-bg-elev);
      border-radius: 50%;
      background: var(--gxt-accent);
      transition: transform var(--gxt-motion);
    }
    .yt-range:hover::-webkit-slider-thumb { transform: scale(1.12); }
    .yt-range:focus-visible {
      outline: 2px solid var(--gxt-accent); outline-offset: 4px; box-shadow: none;
    }

    .yt-actions { display: flex; gap: var(--gxt-sp-2); flex-wrap: wrap; }
    .yt-actions .yt-btn {
      box-shadow: none; min-height: var(--gxt-ctl-h-sm); font-size: var(--gxt-fs-xs);
    }

    /* ══════════════════════════════════════════════════════ callout ══
       The full-video warning. It used to be a style string inside youtube.js
       with four hand-picked amber and grey literals, a sub-floor type size, and
       two buttons that were not '.yt-btn' at all — a box that belonged to no
       theme, sitting inside a panel that belongs to every one of them. It is the
       same component as content/ui.js's '.callout' now, on the status ramp, so
       it is amber on «کاغذی» and on «نیمه‌شب» in the right way for each. */
    .yt-callout {
      display: flex; flex-direction: column; gap: var(--gxt-sp-2);
      padding: var(--gxt-sp-2) var(--gxt-sp-3);
      border-radius: var(--gxt-radius-md);
      font-size: var(--gxt-fs-xs);
      line-height: var(--gxt-lh);
      border: 1px solid var(--gxt-warn-edge);
      background: var(--gxt-warn-soft);
      color: var(--gxt-warn-on-soft);
    }
    .yt-callout.err {
      border-color: var(--gxt-err-edge); background: var(--gxt-err-soft);
      color: var(--gxt-err-on-soft);
    }
    /* A warning's buttons read as part of the warning, not as neutral chrome. */
    .yt-callout .yt-btn {
      flex: 1; box-shadow: none; background: transparent; color: inherit;
      min-height: var(--gxt-ctl-h-sm); font-size: var(--gxt-fs-xs);
      border-color: color-mix(in srgb, currentColor 45%, transparent);
    }
    .yt-callout .yt-btn:hover:not(:disabled) {
      border-color: currentColor;
      background: color-mix(in srgb, currentColor 14%, transparent);
    }
    .yt-callout .yt-btn.primary {
      background: color-mix(in srgb, currentColor 20%, transparent);
      border-color: currentColor; font-weight: var(--gxt-weight-strong, 700);
    }

    /* ════════════════════════════════════════════ the subtitle caption ══
       THE LAST SURFACE OUTSIDE THE DESIGN SYSTEM — v3.2.5.

       Until now this was 'rgba(8,8,8,.78)' with '#fff' on it, and the reason
       given was sound: a caption sits on arbitrary footage for the whole video,
       so legibility there beats matching the panel above it. The reasoning was
       right and the conclusion was wrong. A themed scrim is legible too — it
       just has to be DERIVED against the surface it really has, which is the
       scrim composited over a frame the extension does not control.

       shared/theme.js does exactly that: 'cap-fg' is ramped against the harder
       of (scrim over a white title card) and (scrim over a black letterbox),
       which bounds every frame in between. Measured across all four concrete
       themes at both extremes, the themed caption at 86% is 11.40:1 at worst —
       BETTER than the 10.70:1 the untheming achieved. So this change makes the
       caption match the product and makes it easier to read. dev/uicheck.html
       re-measures the whole matrix every run.

       Two things do NOT change. There is still no backdrop filter, ever: this
       box sits on the video for the video's whole duration, and a blurred
       backdrop would keep it out of its hardware overlay plane and hold
       driver-side enhancement (RTX VSR) off the entire session. And '.plain'
       keeps the old high-contrast bar one switch away for anyone who wants
       maximum legibility over a matching surface.

       Sizes here are in 'em', not on the type scale, and that is deliberate: the
       caption's font-size is computed from the PLAYER's width (see
       applyAppearance), because a subtitle is measured against the picture it
       sits on, not against the reader's UI density. Everything derived from it —
       padding, radius, the second line — follows in em so the whole box scales
       as one. */
    .yt-cap-wrap {
      position: absolute;
      transform: translateX(-50%);
      max-width: 90%;
      pointer-events: none;
      /* Our own stacking order, stated once. 59 is also what this needs in the
         FALLBACK path, where the overlay is appended straight into the player
         and has to clear YouTube's chrome (.ytp-* at 59-62). The controls and
         the settings sheet sit above it, so a caption dragged down to the
         bottom of the picture can never cover the buttons — which it could
         before, because they had no z-index at all. */
      z-index: 59;
      text-align: center;
    }
    .yt-cap {
      display: none;
      background: var(--gxt-cap-bg);
      color: var(--gxt-cap-fg);
      /* A hairline in the accent, at the same 38% the rest of the product uses
         for a soft edge. It is what makes the caption legibly OURS at a glance
         without shouting, and it also gives the box an edge on a frame that
         happens to be the same luminance as the scrim. */
      border: 1px solid var(--gxt-cap-line);
      box-shadow: var(--gxt-elev-1);
      padding: .2em .7em;
      border-radius: .5em;
      text-align: center;
      direction: var(--gxt-ui-dir, rtl);
      unicode-bidi: plaintext;
      direction: var(--gxt-caption-dir, rtl);
      line-height: 1.75;
      pointer-events: auto;
      cursor: grab;
      user-select: none;
      transition: opacity var(--gxt-dur-2) var(--gxt-ease);
    }
    /* The classic bar: maximum contrast, no theme. Selected by 'ytCapTheme'. */
    .yt-cap.plain {
      background: var(--gxt-cap-plain-bg);
      color: var(--gxt-cap-plain-fg);
      border-color: transparent;
      box-shadow: none;
    }
    /* Getting out of the way of a YouTube menu — v3.3.2.
       The caption keeps painting (it is the product's output; hiding subtitles
       because someone opened the volume menu would be absurd) and stops taking
       pointer events, which was the whole of the harm: it is draggable, so
       wherever it overlapped a menu it swallowed that menu's clicks. The cursor
       has to stop promising a drag that no longer works, and a slight recede
       says «not me right now» without taking the words away. */
    .yt-cap.yielding { cursor: default; filter: saturate(.85) brightness(.92); }

    /* Showing the ORIGINAL line because its translation has not arrived yet.
       Signalled by the border, never by opacity — see the note in youtube.js:
       fading the box thins the scrim as well as the ink and measured 3.82:1 on
       the default theme, under the AA floor, in the one state where the viewer
       is reading a foreign language. */
    .yt-cap.pending { border-style: dashed; border-color: var(--gxt-accent); }
    .yt-cap.plain.pending {
      border-color: var(--gxt-cap-plain-fg);
      border-style: dashed;
    }
    .yt-cap:active { cursor: grabbing; }
    .yt-cap .orig {
      display: none;
      font-size: .72em;
      /* Was 'opacity: .85'. The original line is secondary, but fading text is
         not how this design system says so — 'cap-fg-muted' is a real colour
         derived to clear 10:1 on the caption's own composited surface, and the
         .72em size is what carries the hierarchy. */
      color: var(--gxt-cap-fg-muted);
      line-height: 1.5;
      margin-top: .12em;
      unicode-bidi: plaintext;
      direction: var(--gxt-caption-dir, rtl);
    }
    .yt-cap.plain .orig { color: var(--gxt-cap-plain-fg-muted); }

    /* ══════════════════════════════════════════════ user preferences ══ */
    @media (prefers-reduced-motion: reduce) {
      .yt-panel { animation: none; }
      .yt-btn, .yt-switch .track, .yt-switch .track::before,
      .yt-panel select, .yt-bulk .fill, .yt-cap,
      .yt-range::-webkit-slider-thumb { transition: none; }
      .yt-btn:active { transform: none; }
      .yt-range:hover::-webkit-slider-thumb { transform: none; }
    }
    @media (prefers-reduced-transparency: reduce) {
      .yt-btn, .yt-panel {
        backdrop-filter: none; -webkit-backdrop-filter: none;
        background: var(--gxt-bg-elev);
      }
      /* The caption is translucent by design (it must let the picture through),
         so «less transparency» means as opaque as it can be while still being a
         caption — the theme's own elevated surface, no compositing at all. */
      .yt-cap { background: var(--gxt-bg-elev); }
    }
    @media (prefers-contrast: more) {
      .yt-btn, .yt-panel, .yt-panel select, .yt-callout { border-color: var(--gxt-line-strong); }
      /* Someone who asked the OS for more contrast is asking for the plain bar. */
      .yt-cap {
        background: var(--gxt-cap-plain-bg); color: var(--gxt-cap-plain-fg);
        border-color: transparent;
      }
      .yt-cap .orig { color: inherit; }
    }
    /* Windows High Contrast. Same rules as the popup: a border proves the
       control exists, state moves to the system Highlight pair, and focus
       becomes a real outline because forced colours never paint box-shadow. */
    @media (forced-colors: active) {
      .yt-btn, .yt-panel, .yt-panel select { border: 1px solid ButtonBorder; }
      .yt-btn[aria-pressed="true"] {
        background: Highlight; color: HighlightText; border-color: Highlight;
      }
      .yt-switch .track { background: Canvas; border: 1px solid ButtonBorder; }
      .yt-switch .track::before { background: CanvasText; }
      .yt-switch input:checked + .track { background: Highlight; border-color: Highlight; }
      .yt-switch input:checked + .track::before { background: HighlightText; }
      .yt-btn:focus-visible, .yt-panel select:focus-visible,
      .yt-switch input:focus-visible + .track, .yt-range:focus-visible {
        outline: 3px solid CanvasText; outline-offset: 2px; box-shadow: none;
      }
      .yt-status, .yt-hint, .yt-note { color: CanvasText; }
      .yt-bulk .fill { forced-color-adjust: none; }
      /* The callout is distinguished only by its tint, which this mode
         replaces — so the border has to carry it. */
      .yt-callout { border: 1px solid CanvasText; color: CanvasText; }
      .yt-callout .yt-btn { border-color: ButtonBorder; color: ButtonText; }
      /* v3.2.5 — the caption had no forced-colours rule at all, so its scrim
         became Canvas and its ink CanvasText with NO border: a caption with no
         edge, floating on a video that keeps its own colours. It needs to look
         like a box. */
      .yt-cap {
        background: Canvas; color: CanvasText;
        border: 1px solid CanvasText; box-shadow: none;
      }
      .yt-cap.pending { border-style: dashed; border-color: Highlight; }
      .yt-cap .orig { color: CanvasText; }
      /* The slider's rail and thumb are both author fills. */
      .yt-range { background: ButtonBorder; forced-color-adjust: none; }
      .yt-range::-webkit-slider-thumb {
        background: Highlight; border-color: Canvas; forced-color-adjust: none;
      }
    }
  `;
})();
