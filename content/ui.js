/**
 * Shared in-page UI layer (v3.2.5).
 *
 * Every surface the extension draws ON a web page — the translation card, the
 * page-translation pill, toasts, the selection chip — is built here, once, in a
 * single closed shadow root. Before v2.1 the page module owned all of this
 * privately and the X image-translation card was a second, hand-rolled, dark
 * box with no theme, no transparency and no way to move it. One implementation
 * now serves both, so a look/behaviour fix lands everywhere at once.
 *
 * Three rules this module exists to enforce:
 *
 *  1. TOKENS ONLY. Colours, radii, spacing and motion come from
 *     shared/theme.js via custom properties written onto the shadow HOST, so
 *     the user's theme/accent/density/surface choice reaches in-page UI and a
 *     live change re-skins open cards with no rebuild.
 *  2. VIDEO-SAFE. `tokens(..., {inPage:true})` resolves `--gxt-backdrop` to
 *     `none` unless the user opted out, because a backdrop blur forces the
 *     compositor to read the pixels behind the element and knocks a <video>
 *     off its hardware overlay plane (RTX VSR and driver HDR go with it).
 *  3. REACHABLE CONTROLS. The translucent surface is the default and it is
 *     lovely over most pages — but over a bright or busy one it is not. Every
 *     card and the pill therefore carry the «◐ / ●» opacity toggle, so making
 *     the background fully solid is one click away exactly where the problem
 *     is visible, not buried in the popup.
 *
 * Chrome APIs are used defensively (getURL, setSettings) so the module also
 * loads in the dev harness, where there is no extension context.
 */
'use strict';
(() => {
  globalThis.GXT = globalThis.GXT || {};
  if (globalThis.GXT.uiReady) return;

  /** Live snapshot of the user's settings; owners call configure() on change. */
  let settings = null;

  let host = null;
  let root = null;

  const theme = () => globalThis.GXT.theme;

  // ---------------------------------------------------------------- styling

  /**
   * The bundled Persian webfont as @font-face rules for the shadow root. On X
   * and YouTube the manifest injects fonts.css, but on an arbitrary page
   * nothing does — the UI would ask for "Vazirmatn" and silently fall back to
   * Segoe UI/Tahoma. The files are web-accessible for every origin.
   */
  function fontFaceCss() {
    try {
      const url = (file) => chrome.runtime.getURL(`fonts/${file}`);
      return [400, 700]
        .map(
          (weight) =>
            `@font-face{font-family:"Vazirmatn";src:url("${url(
              `Vazirmatn-${weight === 700 ? 'Bold' : 'Regular'}.woff2`
            )}") format("woff2");font-weight:${weight};font-display:swap;}`
        )
        .join('\n');
    } catch {
      return ''; // getURL unavailable (dev harness): system fonts still apply
    }
  }

  /**
   * The in-page stylesheet — rebuilt on the scale in v3.2.5.
   *
   * v2.9.0 gave the product a seven-step type scale, a six-step spacing scale,
   * radii, motion and (v3.2.5) a control scale. This sheet adopted the COLOUR
   * half of that and almost none of the rest: it carried about thirty-five
   * literal pixel values — `padding: 9px 12px`, `min-height: 26px`,
   * `gap: 4px`, `line-height: 1.6`, `animation: gxt-pop .24s` — so a reader who
   * chose «بزرگ» got larger text inside a card whose header, buttons and gaps
   * never moved, and the chip in a card header was a different size from the
   * visually identical chip over the YouTube player.
   *
   * Now every metric is a token. Two consequences worth stating:
   *  · density reaches in-page UI for the first time;
   *  · this sheet and content/player.css.js can no longer drift, because they
   *    ask the same scale for the same answer instead of each holding a copy.
   */
  const STYLE = `
    /* ═══════════════════════════════════════════════ fallback tokens ══
       The host normally supplies these. This block is what the UI looks like
       when shared/theme.js is absent — which is a real configuration, not a
       hypothetical: a browser still running the PREVIOUS content-script list
       has no theme module until the EXTENSION is reloaded (dev/mock-yt-nodeps
       covers it). It is therefore kept COMPLETE — every token any rule in this
       file or in content/player.css.js reads.

       NOTE this whole sheet is a template literal: a backtick anywhere inside
       it, INCLUDING in a comment like this one, ends the string and turns the
       module into a silent SyntaxError — after which nothing renders and there
       is no console message. Use 'single quotes' in prose here. (It has now
       happened three times in this codebase; dev/selftest.html guards it.)

       v3.2.5 filled the holes: ok, warn, accent-hover, elev-2, bg-elev, the
       sp-1/4/5/6 steps, the control scale and the caption pair were all
       missing, so the player's status lines rendered in the inherited colour,
       its buttons lost their shadow, and the sp-4 paddings collapsed to
       nothing. */
    :host {
      --gxt-bg: #0e1014; --gxt-bg-elev: #171a21; --gxt-bg-sunken: #0a0c10;
      --gxt-ui-dir: rtl; --gxt-content-dir: rtl; --gxt-caption-dir: rtl; --gxt-switch-sign: -1;
      --gxt-card: #171a21; --gxt-card-alpha: 84%;
      --gxt-fg: #e2e5e8; --gxt-fg-muted: #b7bdc6; --gxt-fg-faint: #98a0ad;
      --gxt-line: #232936; --gxt-line-strong: #3a4356;
      --gxt-accent: #1d9bf0; --gxt-accent-brand: #1d9bf0;
      --gxt-accent-solid: #177bbf; --gxt-accent-fg: #fff;
      --gxt-accent-hover: #1469a5;
      --gxt-accent-soft: rgba(29,155,240,.18); --gxt-accent-line: rgba(29,155,240,.45);
      --gxt-accent-ink: #32a5f1; --gxt-accent-on-soft: #5cb8f5;
      --gxt-ok: #3ddc9a; --gxt-warn: #e8c34a; --gxt-err: #f77289;
      --gxt-ok-edge: #12b981; --gxt-warn-edge: #d3a91f; --gxt-err-edge: #f43f5e;
      --gxt-ok-soft: rgba(18,185,129,.18); --gxt-warn-soft: rgba(211,169,31,.18);
      --gxt-err-soft: rgba(244,63,94,.18);
      --gxt-ok-on-soft: #3ddc9a; --gxt-warn-on-soft: #e8c34a; --gxt-err-on-soft: #f77289;
      --gxt-elev-1: 0 2px 8px rgba(0,0,0,.25); --gxt-elev-2: 0 8px 24px rgba(0,0,0,.375);
      --gxt-elev-3: 0 18px 44px rgba(0,0,0,.5);
      --gxt-shadow: var(--gxt-elev-3); --gxt-shadow-sm: var(--gxt-elev-1);
      --gxt-radius-sm: 9px; --gxt-radius-md: 13px; --gxt-radius-lg: 18px;
      --gxt-radius-xl: 24px; --gxt-radius-pill: 9999px;
      --gxt-dur-1: 120ms; --gxt-dur-2: 180ms; --gxt-dur-3: 260ms;
      --gxt-ease: cubic-bezier(.2,0,0,1); --gxt-ease-emphasized: cubic-bezier(.2,.8,.25,1);
      --gxt-motion: var(--gxt-dur-2) var(--gxt-ease);
      --gxt-focus-ring: 0 0 0 2px var(--gxt-card), 0 0 0 4px var(--gxt-accent);
      --gxt-focus-ring-inset: inset 0 0 0 2px var(--gxt-accent);
      --gxt-blur: 16px; --gxt-backdrop: none;
      --gxt-fs-2xs: 11.5px; --gxt-fs-xs: 12px; --gxt-fs-sm: 12.5px; --gxt-fs-md: 13.5px;
      --gxt-fs-lg: 15px; --gxt-fs-xl: 17px; --gxt-fs-2xl: 23px;
      --gxt-lh: 1.75; --gxt-lh-tight: 1.4; --gxt-lh-loose: 2;
      --gxt-fs-body: var(--gxt-fs-md); --gxt-fs-title: var(--gxt-fs-sm);
      --gxt-fs-small: var(--gxt-fs-xs);
      --gxt-sp-1: 4px; --gxt-sp-2: 8px; --gxt-sp-3: 12px; --gxt-sp-4: 16px;
      --gxt-sp-5: 22px; --gxt-sp-6: 30px; --gxt-row-y: 10px; --gxt-tap: 36px;
      --gxt-ctl-h: 36px; --gxt-ctl-h-sm: 28px; --gxt-ctl-px: 15px; --gxt-ctl-px-sm: 11px;
      --gxt-panel-line: var(--gxt-line); --gxt-input-bg: var(--gxt-bg-sunken); --gxt-input-line: var(--gxt-line);
      --gxt-weight: 400; --gxt-weight-strong: 700; --gxt-switch-radius: 9999px; --gxt-switch-knob-radius: 50%;
      --gxt-sw-w: 46px; --gxt-sw-h: 27px; --gxt-sw-knob: 21px; --gxt-sw-travel: 19px;
      --gxt-cap-bg: rgba(8,8,8,.86); --gxt-cap-fg: #fff; --gxt-cap-fg-muted: #c9ced5;
      --gxt-cap-line: rgba(29,155,240,.38);
      --gxt-cap-plain-bg: rgba(8,8,8,.78); --gxt-cap-plain-fg: #fff;
      --gxt-cap-plain-fg-muted: #e6e8ea;
      --gxt-font: "Vazirmatn", "Segoe UI", Tahoma, sans-serif;
      /* The dot that marks a surface as ours — one size, six places. */
      --gxt-dot: 7px;
    }
    * { box-sizing: border-box; margin: 0; }

    /* ══════════════════════════════════════════════════════════ card ══ */
    .card { position: fixed; z-index: 2147483647; max-width: min(460px, calc(100vw - 32px));
      background: var(--gxt-card); color: var(--gxt-fg);
      border: 1px solid var(--gxt-panel-line, var(--gxt-line)); border-radius: var(--gxt-radius-lg);
      box-shadow: var(--gxt-shadow);
      backdrop-filter: var(--gxt-backdrop, none); -webkit-backdrop-filter: var(--gxt-backdrop, none);
      font: var(--gxt-fs-md)/var(--gxt-lh) var(--gxt-font); font-weight: var(--gxt-weight, 400); overflow: hidden; }
    .card:focus { outline: none; }
    /* The head is the popup's card head and the player panel's head: same
       padding step, same accent wash, same 800 weight, same dot. */
    .card-head { display: flex; align-items: center; gap: var(--gxt-sp-1);
      padding: var(--gxt-sp-2) var(--gxt-sp-3);
      border-bottom: 1px solid var(--gxt-line); direction: var(--gxt-ui-dir, rtl);
      font-size: var(--gxt-fs-sm); font-weight: 800;
      background: linear-gradient(180deg, var(--gxt-accent-soft), transparent);
      cursor: move; touch-action: none; user-select: none; }
    /* Feedback that the header IS the drag handle — the image card had no
       affordance at all before, so nobody discovered it could be moved. */
    .card-head:active { cursor: grabbing; }
    .card-title { flex: 1; font-weight: 800; display: flex; align-items: center;
      gap: var(--gxt-sp-2);
      letter-spacing: -.01em; min-width: 0; line-height: var(--gxt-lh-tight); }
    .card-title > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-title::before { content: ""; width: var(--gxt-dot); height: var(--gxt-dot);
      border-radius: 50%; flex: none; background: var(--gxt-accent); }
    /* RTL base direction is enforced (no unicode-bidi:plaintext — that let a
       paragraph starting with a Latin word render left-to-right). Latin runs
       still embed correctly inside the RTL text. */
    .card-body { padding: var(--gxt-sp-3) var(--gxt-sp-4); direction: var(--gxt-content-dir, rtl); text-align: start;
      white-space: pre-wrap; overflow-wrap: break-word; max-height: 46vh;
      overflow-y: auto; overscroll-behavior: contain; user-select: text; }
    /* A themed scrollbar, so a card over a dark page does not get a bright
       native strip down its edge. Matches the player panel's. */
    .card-body::-webkit-scrollbar, .detail::-webkit-scrollbar { width: 10px; }
    .card-body::-webkit-scrollbar-thumb, .detail::-webkit-scrollbar-thumb {
      background: var(--gxt-line-strong); border-radius: var(--gxt-radius-pill);
      border: 3px solid transparent; background-clip: content-box; }

    /* ════════════════════════════════════════════════════════ button ══
       One control, three sizes, all from the control scale. Every variant
       clears the 24×24 target-size floor WCAG 2.2 added (2.5.8) at every
       density, which a literal 'min-height: 26px' only did by luck. */
    .btn { cursor: pointer; border: 1px solid transparent; background: transparent;
      color: var(--gxt-fg-muted); font: inherit; font-size: var(--gxt-fs-xs);
      font-weight: 600; padding: 0 var(--gxt-ctl-px-sm); min-height: var(--gxt-ctl-h-sm);
      display: inline-flex; align-items: center; justify-content: center;
      gap: var(--gxt-sp-1); line-height: var(--gxt-lh-tight);
      border-radius: var(--gxt-radius-pill); white-space: nowrap; flex: none;
      transition: background var(--gxt-motion), color var(--gxt-motion),
        border-color var(--gxt-motion), transform var(--gxt-dur-1) var(--gxt-ease); }
    .btn:hover:not(:disabled) { color: var(--gxt-fg); background: var(--gxt-accent-soft);
      border-color: var(--gxt-accent-line); }
    .btn:active:not(:disabled) { transform: scale(.96); }
    .btn:focus-visible { outline: none; box-shadow: var(--gxt-focus-ring); }
    .btn:disabled { opacity: .5; cursor: default; }
    .btn.icon { padding: 0; min-width: var(--gxt-ctl-h-sm); font-size: var(--gxt-fs-sm); }
    .btn.accent { color: var(--gxt-accent-on-soft); border-color: var(--gxt-accent-line);
      background: var(--gxt-accent-soft); }
    .btn.on { color: var(--gxt-accent-fg); background: var(--gxt-accent-solid);
      border-color: var(--gxt-accent-solid); }
    .btn.on:hover:not(:disabled) { background: var(--gxt-accent-hover);
      border-color: var(--gxt-accent-hover); color: var(--gxt-accent-fg); }
    /* Full-width secondary action inside a card body — the same control the
       player panel calls '.yt-btn.wide'. */
    .btn.wide { width: 100%; min-height: var(--gxt-ctl-h);
      border-color: var(--gxt-line-strong); font-size: var(--gxt-fs-sm); }
    /* The state dot: an on/off mark that is not a «✓» glued into the label, so
       the label never has to be rewritten to show state. */
    .btn .dot { width: var(--gxt-dot); height: var(--gxt-dot); border-radius: 50%;
      flex: none; background: currentColor; opacity: .45; }
    .btn.on .dot, .btn[aria-pressed="true"] .dot { opacity: 1; }

    /* ══════════════════════════════════════════════════ text blocks ══
       Explanatory copy is de-emphasised by SIZE and COLOUR, never by opacity:
       fading text below the legibility floor is not a hierarchy, and
       '--gxt-fg-muted' is derived to clear 10:1 on this exact surface. Three
       call sites used to write 'opacity: .75' by hand. */
    .note { font-size: var(--gxt-fs-xs); color: var(--gxt-fg-muted);
      line-height: var(--gxt-lh); }
    .note.tip { padding-inline-start: var(--gxt-sp-2);
      border-inline-start: 2px solid var(--gxt-accent-line); }
    .note:empty { display: none; }
    .err { color: var(--gxt-err); }
    .detail { direction: ltr; text-align: left;
      font: var(--gxt-fs-2xs)/var(--gxt-lh-tight) Consolas, "Courier New", monospace;
      background: var(--gxt-bg-sunken); color: var(--gxt-fg-muted);
      border: 1px solid var(--gxt-line); border-radius: var(--gxt-radius-sm);
      padding: var(--gxt-sp-2) var(--gxt-sp-3); margin-top: var(--gxt-sp-2);
      white-space: pre-wrap; overflow-wrap: anywhere;
      max-height: 180px; overflow-y: auto; user-select: text; }
    .dots::after { content: "…"; }

    /* ═══════════════════════════════════════════════════════ callout ══
       A tinted advisory block with room for its own actions. The YouTube
       full-video warning was this, hand-written in a style string with four
       literal hex values and 'font-size: 11.5px'; the manga and page cards had
       no such component at all and used a bare line of faded text. */
    .callout { display: flex; flex-direction: column; gap: var(--gxt-sp-2);
      padding: var(--gxt-sp-2) var(--gxt-sp-3); margin-top: var(--gxt-sp-2);
      border-radius: var(--gxt-radius-md);
      font-size: var(--gxt-fs-xs); line-height: var(--gxt-lh);
      border: 1px solid var(--gxt-line-strong);
      background: color-mix(in srgb, var(--gxt-fg) 6%, transparent);
      color: var(--gxt-fg); }
    .callout.warn { border-color: var(--gxt-warn-edge); background: var(--gxt-warn-soft);
      color: var(--gxt-warn-on-soft); }
    .callout.err { border-color: var(--gxt-err-edge); background: var(--gxt-err-soft);
      color: var(--gxt-err-on-soft); }
    .callout.ok { border-color: var(--gxt-ok-edge); background: var(--gxt-ok-soft);
      color: var(--gxt-ok-on-soft); }
    /* Actions inside a callout inherit its ink, so a warning's buttons read as
       part of the warning rather than as neutral chrome. */
    .callout .btn { color: inherit; border-color: color-mix(in srgb, currentColor 45%, transparent); }
    .callout .btn:hover:not(:disabled) { color: inherit;
      background: color-mix(in srgb, currentColor 14%, transparent);
      border-color: currentColor; }

    /* ══════════════════════════════════════════════════════ actions ══ */
    .actions { display: flex; align-items: center; gap: var(--gxt-sp-2); flex-wrap: wrap; }
    .actions.fill > .btn { flex: 1; }
    /**
     * A text button in a card BODY carries a visible edge — v3.2.5.
     *
     * '.btn' is quiet by default, which is right in a card header: those are
     * icons (close, mute, opacity) and a border round each would be noise. In a
     * body it is wrong, and rendering the manga panel showed why — «تصویر اصلی»,
     * «دانلود CBZ» and «بستن» sat in a row with a transparent border and no
     * background, so three primary actions read as a line of plain text. The
     * pill already solved this for itself ('.pill .btn'); this is the same rule
     * for the surface where it matters most.
     */
    .card-body .btn, .gxt-linkrow .btn {
      border-color: var(--gxt-line-strong); color: var(--gxt-fg);
      min-height: var(--gxt-ctl-h-sm); }
    .card-body .btn:hover:not(:disabled), .gxt-linkrow .btn:hover:not(:disabled) {
      border-color: var(--gxt-accent); }

    /* ════════════════════════════════════════════════════════ meter ══
       The popup's quota bar, available in-page: same height, same sunken
       track, same framed edge, same emphasized easing. The manga progress bar
       was 'height:6px;border-radius:99px;background:#0003' in a style string,
       with no frame — so on a light theme it was an invisible groove. */
    .meter { height: 8px; margin: var(--gxt-sp-2) 0 var(--gxt-sp-1);
      border-radius: var(--gxt-radius-pill); background: var(--gxt-bg-sunken);
      border: 1px solid var(--gxt-line); overflow: hidden; }
    .meter > i { display: block; height: 100%; width: 0;
      border-radius: var(--gxt-radius-pill); background: var(--gxt-accent);
      transition: width var(--gxt-dur-3) var(--gxt-ease-emphasized); }
    .meter > i.warn { background: var(--gxt-warn-edge); }
    .meter > i.done { background: var(--gxt-ok-edge); }

    /* ════════════════════════════════════════════════════════ thumb ══ */
    .thumb { display: block; max-width: 100%; height: auto;
      margin-top: var(--gxt-sp-2); border-radius: var(--gxt-radius-md);
      border: 1px solid var(--gxt-line); }

    /* ═══════════════════════════════════════════════════════ switch ══
       The popup's switch, from the control scale so it steps with density —
       which neither the popup's copy nor the player panel's copy did. */
    .switch { position: relative; display: inline-block;
      width: var(--gxt-sw-w); height: var(--gxt-sw-h); flex: none; }
    .switch input { position: absolute; inset: 0; width: 100%; height: 100%;
      margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
    .switch .track { position: absolute; inset: 0; border-radius: var(--gxt-switch-radius, 9999px);
      background: var(--gxt-line-strong); transition: background var(--gxt-motion);
      pointer-events: none; }
    .switch .track::before { content: ""; position: absolute; top: 3px;
      inset-inline-start: 3px; width: var(--gxt-sw-knob); height: var(--gxt-sw-knob);
      border-radius: var(--gxt-switch-knob-radius, 50%); background: #fff; box-shadow: var(--gxt-elev-1);
      transition: transform var(--gxt-dur-2) var(--gxt-ease-emphasized); }
    /* RTL: the knob travels toward the LEADING edge, which is the left one. */
    .switch input:checked + .track { background: var(--gxt-accent-solid); }
    .switch input:checked + .track::before {
      transform: translateX(calc(var(--gxt-sw-travel) * var(--gxt-switch-sign, -1))); }
    .switch input:focus-visible + .track { box-shadow: var(--gxt-focus-ring); }
    .switch input:disabled + .track { opacity: .5; }

    /* ═════════════════════════════════════════════════════════ pill ══
       The floating control bar: one rounded surface, chip-shaped actions. */
    .pill { position: fixed; z-index: 2147483647;
      bottom: var(--gxt-sp-5); left: var(--gxt-sp-5);
      display: flex; align-items: center; gap: var(--gxt-sp-2); flex-wrap: wrap;
      max-width: min(620px, calc(100vw - 40px));
      background: var(--gxt-card); color: var(--gxt-fg);
      border: 1px solid var(--gxt-panel-line, var(--gxt-line)); border-radius: var(--gxt-radius-lg);
      padding: var(--gxt-sp-2) var(--gxt-sp-2) var(--gxt-sp-2) var(--gxt-sp-4);
      backdrop-filter: var(--gxt-backdrop, none); -webkit-backdrop-filter: var(--gxt-backdrop, none);
      font: var(--gxt-fs-body)/var(--gxt-lh-tight) var(--gxt-font);
      box-shadow: var(--gxt-shadow); direction: var(--gxt-ui-dir, rtl);
      animation: gxt-pop var(--gxt-dur-3) var(--gxt-ease-emphasized); }
    @keyframes gxt-pop { from { opacity: 0; transform: translateY(10px); } }
    .pill-label { font-weight: 800; white-space: nowrap; padding-inline-end: 2px;
      display: flex; align-items: center; gap: var(--gxt-sp-2);
      font-size: var(--gxt-fs-sm); }
    .pill-label::before { content: ""; width: var(--gxt-dot); height: var(--gxt-dot);
      border-radius: 50%; background: var(--gxt-accent); flex: none; }
    .pill .btn { border-color: var(--gxt-line-strong); }

    /* ════════════════════════════════════════════════════════ toast ══ */
    .toast { position: fixed; z-index: 2147483647; bottom: var(--gxt-sp-6); left: 50%;
      transform: translateX(-50%); max-width: min(420px, calc(100vw - 40px));
      background: var(--gxt-card); color: var(--gxt-fg);
      backdrop-filter: var(--gxt-backdrop, none); -webkit-backdrop-filter: var(--gxt-backdrop, none);
      border: 1px solid var(--gxt-line); border-radius: var(--gxt-radius-md);
      padding: var(--gxt-sp-3) var(--gxt-sp-5);
      font: var(--gxt-fs-md)/var(--gxt-lh) var(--gxt-font); font-weight: var(--gxt-weight, 400); direction: var(--gxt-ui-dir, rtl);
      text-align: center;
      box-shadow: var(--gxt-shadow); animation: gxt-pop var(--gxt-dur-3) var(--gxt-ease-emphasized); }

    /* ═════════════════════════════════════════════════════ selchip ══ */
    .selchip { position: fixed; z-index: 2147483647;
      display: inline-flex; align-items: center; gap: 2px;
      background: var(--gxt-accent-solid); color: var(--gxt-accent-fg);
      border-radius: var(--gxt-radius-pill); padding: 2px var(--gxt-sp-2);
      font: var(--gxt-fs-xs)/var(--gxt-lh-tight) var(--gxt-font);
      font-weight: var(--gxt-weight-strong, 700); direction: var(--gxt-ui-dir, rtl);
      box-shadow: 0 8px 24px var(--gxt-accent-soft), var(--gxt-shadow-sm); user-select: none;
      animation: gxt-pop var(--gxt-dur-2) var(--gxt-ease);
      transition: transform var(--gxt-motion); }
    .selchip:hover { transform: translateY(-1px); }
    /* Two actions in one pill (v2.5.1: translate + 🔊 read aloud), divided by a
       hairline rather than split into two chips, so the pair still reads as one
       control sitting under the selection.
       v2.9.0: these are real <button>s. They were <span>s with a pointerdown
       handler — operable with a mouse and with nothing else, and announced as
       plain text. Each one now clears the 24px target-size floor too. */
    .selchip-part { appearance: none; border: 0; background: none; color: inherit;
      font: inherit; cursor: pointer; padding: 0 var(--gxt-sp-2); min-height: 24px;
      display: inline-flex; align-items: center;
      border-radius: var(--gxt-radius-pill); }
    .selchip-part + .selchip-part {
      border-inline-start: 1px solid color-mix(in srgb, currentColor 35%, transparent); }
    .selchip-part:hover { background: color-mix(in srgb, #000 18%, transparent); }
    .selchip-part:focus-visible { outline: none; box-shadow: var(--gxt-focus-ring); }

    /* ══════════════════════════════════════════════ user preferences ══ */
    @media (prefers-reduced-motion: reduce) {
      .pill, .toast, .selchip, .card { animation: none; }
      .btn, .selchip, .selchip-part, .meter > i, .switch .track,
      .switch .track::before { transition: none; }
      .btn:active:not(:disabled) { transform: none; }
    }
    /* Asked for by the OS, so it must not need a setting in here to get it. */
    @media (prefers-reduced-transparency: reduce) {
      .card, .pill, .toast {
        backdrop-filter: none; -webkit-backdrop-filter: none;
        background: var(--gxt-bg-elev); }
    }
    @media (prefers-contrast: more) {
      .card, .pill, .toast, .detail, .meter { border-color: var(--gxt-line-strong); }
      .btn { border-color: var(--gxt-line-strong); }
    }
    /* Forced colours (Windows High Contrast) — v2.9.5.
       Everything this layer draws was distinguished by FILL, and forced colours
       replace author fills with the system palette: the «دوزبانه ✓» button
       looked identical to the one beside it, the selection chip became black on
       black, and — because forced colours never paint box-shadow — the focus
       ring disappeared from every control on the page. State moves to the
       system's own Highlight pair, which this mode honours, and focus becomes a
       real outline, which survives. */
    @media (forced-colors: active) {
      .btn { border-color: ButtonBorder; color: ButtonText; }
      .btn.accent { border-color: Highlight; }
      .btn.on, .btn[aria-pressed="true"] {
        background: Highlight; color: HighlightText; border-color: Highlight; }
      .btn:focus-visible, .selchip-part:focus-visible, .card:focus-visible,
      .switch input:focus-visible + .track {
        outline: 3px solid CanvasText; outline-offset: 2px; box-shadow: none; }
      .selchip { border: 1px solid ButtonBorder; background: ButtonFace; color: ButtonText; }
      /* The title/pill dots are the only mark that a surface is ours. */
      .card-title::before, .pill-label::before { background: CanvasText; }
      .card, .pill, .toast, .callout { border-color: CanvasText; }
      .callout, .note, .detail { color: CanvasText; }
      /* A progress bar that cannot show progress is worse than none, so the
         fill keeps its colour and the track keeps a visible frame. */
      .meter { border: 1px solid CanvasText; }
      .meter > i { forced-color-adjust: none; }
      .switch .track { background: Canvas; border: 1px solid ButtonBorder; }
      .switch .track::before { background: CanvasText; }
      .switch input:checked + .track { background: Highlight; border-color: Highlight; }
      .switch input:checked + .track::before { background: HighlightText; }
    }
  `;

  /**
   * Every shadow host this layer owns (v3.2.0).
   *
   * There used to be exactly one, on `document.body`. The YouTube in-player UI
   * needs its own, mounted INSIDE `#movie_player` so it enters fullscreen with
   * the video — but it must be themed by the same tokens and re-themed by the
   * same `configure()` call, or the two surfaces drift apart. Which is exactly
   * what had happened: the player UI was built from hand-written inline style
   * strings and shared nothing with the design system but the palette.
   *
   * @type {Set<{host: HTMLElement, extra?: string}>}
   */
  const surfaces = new Set();

  /**
   * The inline reset every host in this layer carries — v3.2.5.
   *
   * `all: initial` is what locks the page's styles out of our shadow tree, and
   * it is applied INLINE, which means it also sets `font-family: Times New
   * Roman`, `font-size: 16px`, `line-height: normal` and `color: black` — and
   * every descendant of the shadow root inherits from the host. A `:host` rule
   * cannot override an inline declaration without `!important`, so the tokens
   * sitting on that very element go unused.
   *
   * That shipped once, in v3.2.2, on the YouTube surface: the whole in-player UI
   * rendered in a serif at the wrong size while `--gxt-font` sat right there,
   * correct and ignored. content/youtube.js learned the lesson in its own
   * HOST_STYLE; this layer had not, and only avoided the same fate because every
   * top-level component (`.card`, `.pill`, `.toast`, `.selchip`) happens to
   * declare `font:` for itself. Anything mounted directly into the root — the
   * screen-capture picker's hint, any future component — would have inherited
   * the serif.
   *
   * So the typography is re-declared here, AFTER the reset, in the same string:
   * later-wins settles it with no specificity argument. `var()` resolves at
   * computed-value time, so these pick up the token block `themeHost` appends
   * after them.
   */
  const HOST_BASE =
    'all: initial;'
    + 'font-family: var(--gxt-font, "Vazirmatn", "Segoe UI", Tahoma, sans-serif);'
    + 'font-size: var(--gxt-fs-md, 13.5px);'
    + 'line-height: var(--gxt-lh, 1.75);'
    + 'color: var(--gxt-fg, #e2e5e8);'
    + 'direction: var(--gxt-ui-dir, rtl);'
    + 'text-align: start;'
    + '-webkit-font-smoothing: antialiased;';

  /** Write the appearance tokens onto a shadow host. `all:initial` does not
   *  touch custom properties, so they inherit into the shadow tree while the
   *  page's own styles stay locked out. */
  function themeHost(el, keep = HOST_BASE) {
    if (!el || !theme()) return;
    el.style.cssText = `${keep} ${theme().tokens(settings || {}, { inPage: true })}`;
  }

  function applyTheme() {
    themeHost(host);
    for (const entry of surfaces) {
      if (entry.host.isConnected) themeHost(entry.host, entry.keep);
      else surfaces.delete(entry);
    }
  }

  /** The shared shadow root, created on first use and rebuilt if a page (SPA
   *  route change, document.write) tore the host out of the DOM. */
  function ensure() {
    if (root && host?.isConnected) {
      applyTheme();
      return root;
    }
    host = document.createElement('div');
    host.setAttribute('data-gxt-ui', '');
    // Everything this layer draws is Persian, so the language is declared
    // once on the host and inherits into every card, pill, toast and chip
    // (v2.9.5, WCAG 3.1.2). `all:initial` does not reset attributes.
    host.setAttribute('lang', 'fa');
    host.style.cssText = HOST_BASE;
    root = host.attachShadow({ mode: 'open' });
    applyTheme();
    const style = document.createElement('style');
    style.textContent = `${fontFaceCss()}\n${STYLE}`;
    root.appendChild(style);
    (document.body || document.documentElement).appendChild(host);
    return root;
  }

  /**
   * A second shadow surface, mounted inside an element the page owns (v3.2.0).
   *
   * WHY A SHADOW ROOT AND NOT A CLASS ON YOUTUBE'S DOM: the in-player UI used
   * inline style strings for one good reason — YouTube's own stylesheets are
   * aggressive, and an inline style outranks them. But inline styles also mean
   * no type scale, no spacing scale, no focus ring, no reduced-motion rule and
   * no forced-colors support, because none of those can be expressed as a
   * per-element string. A shadow root gets the isolation WITHOUT giving up the
   * stylesheet, so the player UI can finally be written against the same
   * tokens as the popup.
   *
   * `keep` is the inline style the host itself needs, applied before the tokens
   * so a re-theme cannot drop it. It defaults to HOST_BASE — the reset PLUS the
   * typography, which a caller supplying its own `keep` must remember to include
   * (content/youtube.js's HOST_STYLE does; see the note on HOST_BASE for what
   * happens when it does not). `layer()` below is the convenience for the common
   * case of a full-viewport overlay.
   *
   * @param {HTMLElement} parent
   * @param {{id: string, keep?: string, css?: string}} opts
   * @returns {{host: HTMLElement, root: ShadowRoot}}
   */
  function surface(parent, { id, keep = HOST_BASE, css = '' } = {}) {
    for (const entry of surfaces) {
      if (entry.id === id) {
        if (entry.host.isConnected && entry.host.parentElement === parent) {
          themeHost(entry.host, entry.keep);
          return { host: entry.host, root: entry.root };
        }
        entry.host.remove();
        surfaces.delete(entry);
      }
    }
    const el = document.createElement('div');
    el.setAttribute('data-gxt-ui', id);
    el.setAttribute('lang', 'fa');
    el.style.cssText = keep;
    const shadow = el.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${fontFaceCss()}\n${STYLE}\n${css}`;
    shadow.appendChild(style);
    const entry = { id, host: el, root: shadow, keep };
    surfaces.add(entry);
    themeHost(el, keep);
    parent.appendChild(el);
    return { host: el, root: shadow };
  }

  /**
   * A full-viewport themed overlay — v3.2.5.
   *
   * The one shape `surface()` gets asked for that is not "inside an element the
   * page owns": a modal layer over the whole document. content/screen.js was
   * hand-rolling its own shadow root for this, with its own reset, its own
   * hard-coded colours and its own font stack, because there was no helper for
   * it — which is exactly how a second design system starts.
   *
   * @param {{id: string, css?: string}} opts
   */
  function layer({ id, css = '' }) {
    return surface(document.documentElement, {
      id,
      keep: `${HOST_BASE} position: fixed; inset: 0; z-index: 2147483646;`,
      css,
    });
  }

  /** Drop a surface created by `surface()`. */
  function dropSurface(id) {
    for (const entry of surfaces) {
      if (entry.id !== id) continue;
      entry.host.remove();
      surfaces.delete(entry);
    }
  }

  /** Is this node part of our UI? (Used to ignore our own clicks/selection.) */
  const contains = (node) => {
    if (!node) return false;
    if (host && host.contains(node)) return true;
    for (const entry of surfaces) if (entry.host.contains(node)) return true;
    return false;
  };

  /** Does an event path pass through our UI? Works across the shadow boundary. */
  const inPath = (event) => {
    const path = event?.composedPath?.() || [];
    if (host && path.includes(host)) return true;
    for (const entry of surfaces) if (path.includes(entry.host)) return true;
    return false;
  };

  // ---------------------------------------------------------------- widgets

  function button(label, onClick, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls ? `btn ${cls}` : 'btn';
    globalThis.GXT.i18n.bindLabel(b,'textContent',label);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  /** `document.createElement` with a class and text, which is most of the job. */
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // ── the component set (v3.2.5) ─────────────────────────────────────────
  //
  // These exist because the callers were building them by hand, differently,
  // in style strings: `content/manga.js` had a progress bar with a literal
  // 6px height and a '#0003' track, `content/page-translate.js` had a preview
  // image with a literal 8px radius and a warning line drawn with
  // `opacity: .75`, and `content/youtube.js` had a whole advisory box with four
  // literal hex values inside the settings sheet. Same three ideas, five
  // implementations, none of them on the scale. Now there is one of each.

  /** Muted explanatory copy. `tip` adds the accent rail the popup's hints use. */
  const note = (text, cls) => el('div', cls ? `note ${cls}` : 'note', text);

  /** A flex row of actions that wraps. `fill` makes them share the width. */
  function actions(nodes = [], cls) {
    const row = el('div', cls ? `actions ${cls}` : 'actions');
    for (const node of nodes) if (node) row.appendChild(node);
    return row;
  }

  /**
   * A tinted advisory block.
   *
   * @param {string} text the message
   * @param {{tone?: 'warn'|'err'|'ok', buttons?: HTMLElement[]}} [opts]
   */
  function callout(text, { tone = 'warn', buttons = [] } = {}) {
    const box = el('div', `callout ${tone}`);
    // A warning nobody hears is not a warning: an advisory that appears in
    // response to an action the user just took has to be announced, and it is
    // never the thing that should steal focus.
    box.setAttribute('role', tone === 'err' ? 'alert' : 'status');
    box.appendChild(el('div', '', text));
    if (buttons.length) box.appendChild(actions(buttons, 'fill'));
    return box;
  }

  /**
   * A progress meter. Returns the track with a `set(fraction, tone)` method, so
   * a caller never has to touch the fill element or know it is an <i>.
   */
  function meter(label = globalThis.GXT.i18n.t("content_ui_meter_1")) {
    const track = el('div', 'meter');
    const fill = document.createElement('i');
    track.appendChild(fill);
    // A bar that carries the only indication of progress must expose it: an
    // unlabelled <div> tells a screen reader nothing at all.
    track.setAttribute('role', 'progressbar');
    globalThis.GXT.i18n.bindLabel(track,'ariaLabel',label);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.set = (fraction, tone) => {
      const pct = Math.max(0, Math.min(100, Math.round((Number(fraction) || 0) * 100)));
      fill.style.width = `${pct}%`;
      fill.className = tone || '';
      track.setAttribute('aria-valuenow', String(pct));
    };
    track.set(0);
    return track;
  }

  /** An image preview inside a card body. */
  function thumb(src, alt = '') {
    const img = el('img', 'thumb');
    img.src = src;
    img.alt = alt;
    return img;
  }

  /**
   * The design system's switch, as a labelled control.
   *
   * @returns {HTMLLabelElement} with `.input` exposed for callers that need it.
   */
  function toggle(label, checked, onChange) {
    const wrap = el('label', 'switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.setAttribute('role', 'switch');
    globalThis.GXT.i18n.bindLabel(input,'ariaLabel',label);
    if (onChange) input.addEventListener('change', () => onChange(input.checked));
    wrap.append(input, el('span', 'track'));
    wrap.input = input;
    return wrap;
  }

  /**
   * The opacity control (v2.1.0). Translucent is the default and the design's
   * intent; this makes the surface fully solid on the theme's deepest colour
   * for the pages where translucency stops being readable. The choice is
   * persisted, so it carries to the next card and the next site, and every
   * live toggle in the document repaints together.
   */
  const opaquePainters = new Set();

  function opaqueToggle() {
    const b = button('', null, 'icon');
    const paint = () => {
      const on = !!settings?.cardOpaque;
      b.textContent = on ? '●' : '◐';
      b.classList.toggle('on', on);
      globalThis.GXT.i18n.bind(b, "title", () => (on
        ? globalThis.GXT.i18n.t("content_ui_paint_3")
        : globalThis.GXT.i18n.t("content_ui_paint_2")));
      b.setAttribute('aria-label', b.title);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    b.addEventListener('click', () => {
      const next = !settings?.cardOpaque;
      if (settings) settings.cardOpaque = next;
      else settings = { cardOpaque: next };
      applyTheme();
      for (const repaint of opaquePainters) repaint();
      // Persisted so the preference survives this card, this page and this
      // session; storage.onChanged then syncs every other frame/tab.
      try {
        void globalThis.GXT?.setSettings?.({ cardOpaque: next });
      } catch {
        /* dev harness / no extension context */
      }
    });
    paint();
    paint.node = b;
    opaquePainters.add(paint);
    // Painters are keyed on live nodes; sweep the dead ones occasionally so a
    // long session (hundreds of cards) cannot leak them.
    if (opaquePainters.size > 24) {
      for (const p of [...opaquePainters]) {
        if (p !== paint && !p.node?.isConnected) opaquePainters.delete(p);
      }
    }
    return b;
  }

  let toastEl = null;
  let toastTimer = 0;

  function toast(text, ms = 4000) {
    const r = ensure();
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      // Toasts carry outcomes the user cannot get any other way ("permission
      // refused", "nothing to translate"). role=status announces them without
      // stealing focus, which is exactly the contract a toast wants.
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      r.appendChild(toastEl);
    }
    globalThis.GXT.i18n.bindLabel(toastEl,'textContent',text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl?.remove();
      toastEl = null;
    }, ms);
  }

  // ------------------------------------------------------------------ card

  /** Every open card, so a new one can retire the previous (one result window
   *  at a time was always the behaviour; it is now enforced in one place). */
  const openCards = new Set();

  function closeAll() {
    for (const instance of [...openCards]) instance.close();
  }

  /**
   * A floating result window: themed, draggable by its header, clamped inside
   * the viewport, with copy / opacity / close and room for extra actions.
   *
   * Anchoring: `anchorRect` (a selection/element rect) puts the card just
   * under it, left edges aligned; `anchorPoint` ({x, y} — a click) centres it
   * under the point; neither centres it in the viewport.
   *
   * @param {{title?: string, anchorRect?: DOMRect|null, anchorPoint?: {x:number,y:number}|null,
   *          copy?: boolean, exclusive?: boolean, onClose?: Function}} opts
   */
  function card(opts = {}) {
    const {
      title = globalThis.GXT.i18n.t("content_page_translate_openCard_1"),
      anchorRect = null,
      anchorPoint = null,
      copy = true,
      exclusive = true,
      // `undefined` follows the user's «🔊 on translation cards» setting.
      // `true` forces the control on — the read-aloud card IS the speech
      // feature, so a preference about decorating translations must not be
      // able to remove the only control it has.
      speak = undefined,
    } = opts;
    if (exclusive) closeAll();
    const r = ensure();
    /** Where focus was before this card took it, so close() can return it. */
    let openerFocus = null;

    const el = document.createElement('div');
    el.className = 'card';
    el.dir = globalThis.GXT.i18n.direction();
    // A floating result window is a dialog — but a NON-modal one: the page
    // behind it stays usable on purpose, so `aria-modal` would be a lie.
    // `tabindex="-1"` exists so the card can take focus when it opens, which is
    // what makes the title and then the result reach a screen reader at all.
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', title);
    el.tabIndex = -1;

    const head = document.createElement('div');
    head.className = 'card-head';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'card-title';
    const titleText = document.createElement('span');
    globalThis.GXT.i18n.bindLabel(titleText,'textContent',title);
    titleWrap.appendChild(titleText);

    const body = document.createElement('div');
    body.className = 'card-body';
    body.dir = globalThis.GXT.targetDirection(settings?.targetLang || 'fa');
    body.lang = settings?.targetLang || 'fa';
    // The translation arrives asynchronously, replacing a row of skeleton bars.
    // Without a live region that change is silent.
    body.setAttribute('aria-live', 'polite');
    // Starts FALSE, not true: not every card opens in a loading state (the
    // chapter progress card fills itself immediately), and a window stuck at
    // aria-busy="true" is announced as perpetually loading. `busyWatch` below
    // raises it the moment a caller actually shows the loading ellipsis.
    body.setAttribute('aria-busy', 'false');

    // The header's slot for caller-supplied actions. This was the last inline
    // style string in this module (v3.2.5); it is `.actions` now, which means
    // its gap steps with density like every other gap in the card.
    // (Built the long way: `el` is the card's own <div> in this scope, and the
    // module-level `el()` helper is shadowed by it here.)
    const extras = document.createElement('span');
    extras.className = 'actions';

    const instance = {
      el,
      head,
      body,
      setTitle(text) {
        globalThis.GXT.i18n.bindLabel(titleText,'textContent',text);
        el.setAttribute('aria-label', text);
      },
      /** Explicitly mark the result as landed. Rarely needed — `busyWatch`
       *  below infers it — but available for a caller that never showed the
       *  loading state in the first place. */
      settle() {
        body.setAttribute('aria-busy', 'false');
      },
      addAction(node) {
        extras.appendChild(node);
        return node;
      },
      clamp() {
        clampInto(el);
      },
      isOpen: () => el.isConnected,
      close() {
        // Closing the window the audio belongs to must silence it — otherwise
        // a dismissed card keeps reading to an empty screen.
        if (speechOwner === instance) stopSpeech();
        busyWatch.disconnect();
        /**
         * Give focus back where it came from — v2.9.5.
         *
         * The card takes focus when it opens (see below: that is what makes
         * Escape work and the result get announced). It never gave it back, so
         * dismissing a translation dropped focus onto <body> and a keyboard
         * user was returned to the TOP OF THE PAGE — having to travel back to
         * the paragraph they were reading, every time. The appearance sheet in
         * the popup has always restored focus; this is the same courtesy on the
         * surface people actually use (WCAG 2.4.3).
         *
         * Guarded on `isConnected` because the opener is frequently gone by
         * now: page translation replaces the very nodes a selection came from.
         */
        const returnTo = openerFocus;
        openerFocus = null;
        el.remove();
        openCards.delete(instance);
        if (returnTo?.isConnected && typeof returnTo.focus === 'function') {
          try {
            returnTo.focus({ preventScroll: true });
          } catch {
            /* the opener may have become unfocusable; <body> is the fallback */
          }
        }
        opts.onClose?.();
      },
    };

    /**
     * Keep `aria-busy` truthful without asking every caller to remember.
     *
     * Every producer of a card already signals "the result landed" the same
     * way — by dropping the `.dots` class that draws the loading ellipsis — so
     * that one existing signal is observed here instead of adding a second one
     * that a future caller could forget to send.
     */
    const busyWatch = new MutationObserver(() => {
      body.setAttribute('aria-busy', body.classList.contains('dots') ? 'true' : 'false');
    });
    busyWatch.observe(body, { attributes: true, attributeFilter: ['class'] });

    head.append(titleWrap, extras, opaqueToggle());
    let speaker = null;
    if (speak === true || (speak === undefined && settings?.ttsButton !== false)) {
      speaker = speakButton(() => {
        speechOwner = instance;
        return body.textContent || '';
      });
      head.appendChild(speaker);
    }
    /** Begin reading this card aloud, as if its 🔊 had been pressed. Used by
     *  «خواندن» on any site, so that feature reuses the control the user
     *  already knows instead of introducing a second one beside it. */
    instance.startSpeaking = () => {
      if (speaker && !speaker.gxtActive()) speaker.click();
    };
    if (copy) {
      const copyBtn = button(globalThis.GXT.i18n.t("content_ui_copyBtn_1"), async () => {
        try {
          await navigator.clipboard.writeText(body.textContent || '');
          globalThis.GXT.i18n.bind(copyBtn, "textContent", () => (globalThis.GXT.i18n.t("content_ui_copyBtn_2")));
          setTimeout(() => (globalThis.GXT.i18n.bind(copyBtn, "textContent", () => (globalThis.GXT.i18n.t("content_ui_copyBtn_1")))), 1200);
        } catch {
          /* clipboard unavailable (permissions/policy): silent, not fatal */
        }
      });
      head.appendChild(copyBtn);
    }
    head.appendChild(button('✕', () => instance.close(), 'icon'));
    el.append(head, body);
    r.appendChild(el);

    makeDraggable(el, head);

    // Position relative to the anchor, then clamp fully on-screen. Measured,
    // not guessed: the card's real width is known only once it is in the DOM.
    const margin = 12;
    const rect = el.getBoundingClientRect();
    let top = innerHeight / 2 - rect.height / 2;
    let left = innerWidth / 2 - rect.width / 2;
    if (anchorRect) {
      top = anchorRect.bottom + 8;
      left = anchorRect.left;
    } else if (anchorPoint) {
      top = anchorPoint.y + 12;
      left = anchorPoint.x - rect.width / 2;
    }
    el.style.top = `${Math.max(margin, top)}px`;
    el.style.left = `${Math.max(margin, left)}px`;
    clampInto(el);

    // Escape closes, from anywhere inside the card. The listener is on the card
    // itself, so a page that stops keydown propagation on document cannot
    // swallow it, and it dies with the node.
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      instance.close();
    });
    // Every card here is the answer to something the user just asked for, so
    // moving focus to it is expected rather than disruptive — and it is what
    // makes Escape work and the result get announced. preventScroll matters:
    // the card is position:fixed, and scrolling the page under it would be a
    // visible jump for no reason.
    // Remembered BEFORE the card takes focus, so `close()` can hand it back.
    // A node inside our own shadow tree is never the answer (that would be a
    // previous card's button), so those are ignored.
    const active = document.activeElement;
    openerFocus = active && active !== document.body && !host?.contains(active) ? active : null;
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* focus can be refused while the page is mid-navigation */
    }

    openCards.add(instance);
    return instance;
  }

  /** Keep an absolutely-positioned element fully inside the viewport. Called
   *  again after every content change, since a card grows when its
   *  translation arrives. */
  function clampInto(el) {
    if (!el?.isConnected) return;
    const margin = 12;
    const rect = el.getBoundingClientRect();
    const left = Math.min(
      Math.max(margin, rect.left),
      Math.max(margin, innerWidth - rect.width - margin)
    );
    const top = Math.min(
      Math.max(margin, rect.top),
      Math.max(margin, innerHeight - rect.height - margin)
    );
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  /**
   * Drag `el` by `handle`. Move/end listeners live on window (capture) so the
   * gesture survives the pointer leaving the handle — and, critically, so a
   * page that stops propagation on its own document listeners cannot swallow
   * the drag. Pointer capture is a best-effort enhancement on top.
   */
  function makeDraggable(el, handle) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();
      const start = el.getBoundingClientRect();
      const dx = event.clientX - start.left;
      const dy = event.clientY - start.top;
      const width = start.width;
      const height = start.height;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* pointer not active or capture unsupported: window listeners cover it */
      }
      const margin = 12;
      const onMove = (ev) => {
        if (!el.isConnected) return onEnd();
        el.style.left = `${Math.min(
          Math.max(margin, ev.clientX - dx),
          Math.max(margin, innerWidth - width - margin)
        )}px`;
        el.style.top = `${Math.min(
          Math.max(margin, ev.clientY - dy),
          Math.max(margin, innerHeight - height - margin)
        )}px`;
      };
      const onEnd = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onEnd, true);
        window.removeEventListener('pointercancel', onEnd, true);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onEnd, true);
      window.addEventListener('pointercancel', onEnd, true);
    });
  }

  // -------------------------------------------------------------- failures

  function friendly(result) {
    switch (result?.code) {
      case 'NO_KEY':
        return globalThis.GXT.i18n.t("content_page_translate_runPageInner_5");
      case 'RATE_LIMIT':
        return result?.error || globalThis.GXT.i18n.t("content_ui_friendly_3");
      case 'BAD_KEY':
        return globalThis.GXT.i18n.t("content_ui_friendly_2");
      case 'NEED_AI':
        return result?.error || globalThis.GXT.i18n.t("content_ui_friendly_1");
      default:
        return result?.error || globalThis.GXT.i18n.t("content_main_friendlyError_1");
    }
  }

  /**
   * Diagnostics — provider, model, per-key attempts, HTTP status, quota ids
   * and raw messages. Deliberately hides nothing so a failure can be
   * researched without a debugger, EXCEPT the credential itself.
   *
   * This card lives in a shadow root on the page, and an open shadow root is
   * readable by the page's own scripts. The worker already masks (errorDetail);
   * masking again here costs nothing and closes the path for good. The popup —
   * the extension's own origin — still shows full keys.
   */
  const mask = (key) => globalThis.GXT?.maskKey?.(key) ?? '***';
  const clean = (text) => globalThis.GXT?.scrubSecrets?.(text) ?? String(text ?? '');

  function formatDetail(d) {
    if (!d) return '';
    const lines = [];
    lines.push(
      `provider=${d.provider}  model=${d.model}  code=${d.code}` +
        (d.http ? `  http=${d.http}` : '') +
        (d.apiStatus ? `  status=${d.apiStatus}` : '')
    );
    if (d.quotaId) lines.push(`quota=${d.quotaId}`);
    if (d.retryAfterMs) lines.push(`retryAfter=${Math.round(d.retryAfterMs / 1000)}s`);
    if (d.raw) lines.push(`message=${clean(d.raw)}`);
    for (const a of d.attempts || []) {
      if (a.code === 'COOLING' || a.code === 'INVALID') {
        const left = Math.max(0, Math.round(((a.coolUntil || 0) - Date.now()) / 1000));
        lines.push(`key ${mask(a.key)} -> skipped (${a.code}${a.coolUntil ? ` ${left}s left` : ''})`);
      } else {
        lines.push(
          `key ${mask(a.key)} -> ${a.code}` +
            (a.http ? ` HTTP ${a.http}` : '') +
            (a.apiStatus ? ` ${a.apiStatus}` : '') +
            (a.retryAfterMs ? ` retry=${Math.round(a.retryAfterMs / 1000)}s` : '') +
            (a.quotaId ? `\n  quota=${a.quotaId}` : '') +
            (a.raw ? `\n  msg=${clean(a.raw)}` : '')
        );
      }
    }
    return lines.join('\n');
  }

  /** Render a failure into a card body (message + collapsible raw detail). */
  function showFailure(body, failure) {
    if (!body) return;
    body.replaceChildren();
    body.classList.remove('dots');
    body.setAttribute('aria-busy', 'false');
    const err = document.createElement('div');
    err.className = 'err';
    err.textContent = friendly(failure);
    body.appendChild(err);
    const detailText = formatDetail(failure?.detail);
    if (detailText) {
      const pre = document.createElement('pre');
      pre.className = 'detail';
      pre.textContent = detailText;
      body.appendChild(pre);
    }
    clampInto(body.closest('.card'));
  }

  // ----------------------------------------------------------- speech (v2.2.0)
  //
  // Playback uses the Web Audio API, not `new Audio(src)`. Three reasons, and
  // each one is a real failure we would otherwise ship:
  //
  //  1. CSP. A page may restrict `media-src`, which would block a blob: or
  //     data: URL on an <audio> element. `decodeAudioData` fetches nothing, so
  //     no CSP directive applies to it.
  //  2. Cross-origin plumbing. The audio is synthesized in the service worker;
  //     an extension blob: URL is not readable from the page's context anyway.
  //     Base64 over the message channel sidesteps the whole problem (a chunk
  //     is tens of KB — nothing for sendMessage).
  //  3. Scheduling. AudioBufferSourceNode starts on the audio clock, which is
  //     what the YouTube dubbing work in a later phase needs. Building the
  //     player on it now means that phase inherits a proven layer instead of
  //     replacing this one.

  let audioCtx = null;
  /** The single active playback. Starting a new one always stops this. */
  let speechSession = null;
  /** Which card (if any) the current playback belongs to, so closing that
   *  card silences it. Declared here because `card()` sets it. */
  let speechOwner = null;

  function ctx() {
    if (!audioCtx) audioCtx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    // Autoplay policy suspends a context created outside a user gesture; every
    // entry point here IS a click, so resuming is safe and usually a no-op.
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  }

  function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  const send = (message) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError;
          resolve(response);
        });
      } catch {
        resolve(null); // extension context invalidated (reload/update)
      }
    });

  function stopSpeech() {
    if (!speechSession) return;
    const session = speechSession;
    speechSession = null;
    session.cancelled = true;
    try { session.source?.stop(); } catch { /* already ended */ }
    session.source = null;
    session.onState?.('idle');
  }

  /**
   * Read `text` aloud. Returns immediately; progress arrives via `onState`
   * ('loading' | 'playing' | 'idle' | 'error').
   *
   * Pieces are fetched one ahead of playback, so the first (deliberately
   * short) piece starts the moment it lands while the rest render behind it.
   * A failure on piece N stops there and reports — it never plays the
   * remaining text out of order.
   *
   * @returns {{stop: Function}}
   */
  function speak(text, { onState } = {}) {
    stopSpeech();
    const session = { cancelled: false, source: null, onState };
    speechSession = session;
    onState?.('loading');

    (async () => {
      const split = await send({ type: 'TTS_SPLIT', text });
      if (session.cancelled) return;
      if (!split?.ok) {
        onState?.('error', split);
        if (speechSession === session) speechSession = null;
        return;
      }
      const parts = split.parts;
      const pending = new Map();
      const fetchPart = (i) => {
        if (i >= parts.length || pending.has(i)) return;
        pending.set(i, send({ type: 'TTS_SPEAK', text: parts[i] }));
      };
      fetchPart(0);

      for (let i = 0; i < parts.length; i += 1) {
        fetchPart(i + 1); // one ahead: its latency hides under the current piece
        const clip = await pending.get(i);
        pending.delete(i);
        if (session.cancelled) return;
        if (!clip?.ok) {
          onState?.('error', clip);
          if (speechSession === session) speechSession = null;
          return;
        }
        let buffer;
        try {
          buffer = await ctx().decodeAudioData(base64ToBuffer(clip.data));
        } catch {
          onState?.('error', { get error() { return globalThis.GXT.i18n.t("content_ui_speak_2"); } });
          if (speechSession === session) speechSession = null;
          return;
        }
        if (session.cancelled) return;
        onState?.('playing', { index: i, total: parts.length });
        await new Promise((resolve) => {
          const source = ctx().createBufferSource();
          source.buffer = buffer;
          source.connect(ctx().destination);
          source.onended = resolve;
          session.source = source;
          source.start();
        });
        if (session.cancelled) return;
      }
      if (speechSession === session) speechSession = null;
      onState?.('idle');
    })().catch(() => {
      if (speechSession === session) speechSession = null;
      onState?.('error', { get error() { return globalThis.GXT.i18n.t("content_ui_speak_1"); } });
    });

    return { stop: stopSpeech };
  }

  /**
   * A 🔊 button that reads whatever `getText()` returns at click time.
   * Clicking again while it is speaking stops it, so one control covers both
   * directions and nothing can be left playing invisibly.
   */
  function speakButton(getText, cls) {
    const b = button('🔊', null, cls || 'icon');
    let active = false;
    /** Is this particular button the one currently speaking? Read by the card
     *  so «start reading» can never mean «stop what is already playing». */
    b.gxtActive = () => active;
    const paint = (state) => {
      active = state === 'loading' || state === 'playing';
      b.textContent = state === 'loading' ? '…' : active ? '■' : '🔊';
      b.classList.toggle('on', active);
      globalThis.GXT.i18n.bind(b, "title", () => (active ? globalThis.GXT.i18n.t("content_render_paint_2") : globalThis.GXT.i18n.t("content_ui_paint_1")));
      b.setAttribute('aria-label', b.title);
    };
    b.addEventListener('click', () => {
      if (active) { stopSpeech(); paint('idle'); return; }
      const text = (getText?.() || '').trim();
      if (!text) return;
      speak(text, {
        onState: (state, info) => {
          paint(state);
          if (state === 'error') toast(friendly(info) || globalThis.GXT.i18n.t("content_ui_speakButton_1"));
        },
      });
    });
    paint('idle');
    return b;
  }

  // ----------------------------------------------------------------- wiring

  /** Adopt a new settings snapshot: re-theme the host and repaint the
   *  opacity toggles (a change may have come from the popup or another tab). */
  function configure(next) {
    if (next) settings = next;
    applyTheme();
    for (const repaint of opaquePainters) repaint();
  }

  globalThis.GXT.ui = {
    uiReady: true,
    configure,
    root: ensure,
    // v3.2.0 — a themed shadow surface anywhere on the page, so the in-player
    // UI shares this design system instead of reimplementing a corner of it.
    surface,
    // v3.2.5 — a full-viewport themed overlay (the screen-capture picker).
    layer,
    dropSurface,
    contains,
    inPath,
    button,
    opaqueToggle,
    // v3.2.5 — the component set every in-page surface now builds from, so
    // «a progress bar», «a hint», «a warning» mean one thing in this product.
    el,
    note,
    actions,
    callout,
    meter,
    thumb,
    toggle,
    toast,
    card,
    closeAll,
    clamp: clampInto,
    makeDraggable,
    friendly,
    formatDetail,
    showFailure,
    // v2.2.0 — speech
    speak,
    stopSpeech,
    speakButton,
    /** Is anything being read right now, from any card? */
    isSpeaking: () => !!speechSession,
    get settings() {
      return settings;
    },
  };
  globalThis.GXT.uiReady = true;
})();
