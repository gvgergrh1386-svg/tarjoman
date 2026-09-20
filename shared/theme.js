/**
 * Design-token module — v3.2.5 «نما».
 *
 * The single source of truth for every pixel the extension draws: the popup,
 * the translation box on X, the page/selection cards, the YouTube panel and
 * the subtitle workshop.
 *
 * ARCHITECTURE — the three-tier model, with one change that matters:
 *
 *   1. PRIMITIVES   raw values in the THEMES / ACCENTS / DENSITIES tables
 *                   below. A theme is now a BACKGROUND plus an ink tint; a
 *                   theme author no longer hand-picks text colours at all.
 *   2. SEMANTIC     purpose-named custom properties — `--gxt-bg`,
 *                   `--gxt-fg-muted`, `--gxt-accent-ink`, `--gxt-fs-lg`…
 *                   Switching theme re-points these; no component CSS changes.
 *   3. COMPONENT    every stylesheet references semantic tokens ONLY.
 *
 * WHAT CHANGED IN v2.9 AND WHY
 * ────────────────────────────
 * Until v2.8 the ink and status colours were hand-written hex values per
 * theme, and the accent's foreground was the literal `#ffffff`. Measured
 * against WCAG 2.2, that shipped four real defects:
 *
 *   · `--gxt-fg-faint` on graphite was 4.03:1 — below the 4.5:1 AA floor for
 *     the small labels it was used on (stat tiles, the engine status line).
 *   · white on the `sky` accent — the primary button and the active tab — was
 *     3.00:1. On `amber` 3.19:1, on `emerald` 3.39:1. Three of six accents
 *     failed AA for the most important control in the UI.
 *   · `--gxt-warn` as text on the light themes was 3.15:1.
 *   · nothing tested any of it, so the next theme would have failed too.
 *
 * The fix is not a better set of hex values — it is to stop writing them.
 * `ramp()` binary-searches a blend toward the theme's high-contrast direction
 * until a REQUESTED contrast ratio is met, so every ink, every status colour
 * and every accent-as-text is derived from the background it will actually sit
 * on. Adding a theme now means choosing a background; the palette that meets
 * AAA on it is computed. dev/uicheck.html asserts the whole matrix
 * (5 themes × 6 accents) on every run, so the guarantee cannot rot.
 *
 * The look is dark-first: the dark themes are the designed baseline and the
 * light ones are adapted from them, not a naive inversion. Depth comes from
 * hairline borders and layered surfaces rather than heavy drop shadows.
 *
 * Chrome-free by design (no chrome.* calls), so it loads in the popup, in
 * content scripts, in the service worker and in a plain test page alike.
 */
'use strict';
(() => {
  if (globalThis.GXT && globalThis.GXT.themeReady) return;

  // ══════════════════════════════════════════════════ colour mathematics
  //
  // Everything below is plain sRGB / WCAG 2.x relative luminance. It exists so
  // that no palette decision in this file is a guess.

  /** '#rrggbb' → [r, g, b] 0-255. Tolerates '#rgb'. */
  function parseHex(hex) {
    let value = String(hex || '').trim().replace('#', '');
    if (value.length === 3) value = value.split('').map((c) => c + c).join('');
    const n = parseInt(value, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  const toHex = (rgb) =>
    `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;

  /** One sRGB channel (0-255) → linear light. */
  function toLinear(channel) {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }

  /** WCAG relative luminance of a hex colour. */
  function luminance(hex) {
    const [r, g, b] = parseHex(hex);
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  }

  /**
   * WCAG contrast ratio between two hex colours (1 … 21).
   * Exported: the UI conformance suite asserts against this exact function, so
   * "the design system says 7:1" and "the test says 7:1" cannot drift apart.
   */
  function contrast(a, b) {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  /** Linear blend of two hex colours; `t` 0 → `from`, 1 → `to`. */
  function mix(from, to, t) {
    const a = parseHex(from);
    const b = parseHex(to);
    return toHex([0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t));
  }

  /**
   * Blend `from` toward `to` until it reaches `ratio` against `against`.
   *
   * Contrast is monotone along this blend whenever `to` is the far end of the
   * lightness axis from `against` (white on a dark background, black on a light
   * one) — which is exactly how every caller uses it — so a binary search
   * converges. 24 iterations lands well inside one 8-bit step.
   *
   * If even `to` cannot reach the ratio the closest achievable colour is
   * returned rather than a failure: a slightly-short status colour beats an
   * exception in a token builder that runs inside a content script.
   */
  function ramp(from, to, against, ratio) {
    if (contrast(from, against) >= ratio) return from;
    if (contrast(to, against) <= ratio) return to;
    let low = 0;
    let high = 1;
    for (let i = 0; i < 24; i += 1) {
      const mid = (low + high) / 2;
      if (contrast(mix(from, to, mid), against) >= ratio) high = mid;
      else low = mid;
    }
    return mix(from, to, high);
  }

  /**
   * Contrast targets, named so the intent is readable at the call site.
   *
   * AAA (1.4.6) asks 7:1 for body text and 4.5:1 for large text. Every ink
   * level here clears 7:1 — including `faint`. Hierarchy between the three is
   * carried by SIZE and WEIGHT, not by making the least important text
   * illegible, which is the mistake the previous ramp made.
   */
  const TARGET = Object.freeze({
    ink: 15,        // primary text — far above AAA, the reading surface
    inkMuted: 10,   // secondary text, help paragraphs
    inkFaint: 7.2,  // meta labels, captions — still AAA
    accentInk: 7,   // the accent used AS TEXT (links, section titles)
    statusInk: 7,   // ok / warn / error as text
    onAccent: 4.5,  // text on a filled accent surface — AA for UI text
    nonText: 3,     // borders, focus rings, bar fills — AA non-text (1.4.11)
  });

  // ══════════════════════════════════════════════════════════════ presets

  /**
   * A theme is a background family plus the direction its ink travels.
   * `tint` is the hue the greys carry before contrast is enforced, `toward`
   * is the far end of the lightness axis. Everything else is derived.
   */
  const THEMES = Object.freeze([
    {
      id: 'auto',
      get label() { return globalThis.GXT.i18n.t("shared_theme_THEMES_10"); },
      get note() { return globalThis.GXT.i18n.t("shared_theme_THEMES_9"); },
      scheme: 'light dark',
      swatch: ['#0e1014', '#ffffff'],
    },
    {
      id: 'graphite',
      get label() { return globalThis.GXT.i18n.t("shared_theme_THEMES_8"); },
      get note() { return globalThis.GXT.i18n.t("shared_theme_THEMES_7"); },
      scheme: 'dark',
      swatch: ['#0e1014', '#171a21'],
      vars: {
        bg: '#0e1014',
        'bg-elev': '#171a21',
        'bg-sunken': '#0a0c10',
        line: '#232936',
        'line-strong': '#3a4356',
      },
      tint: '#7d8798',
      toward: '#ffffff',
      shadowRgb: '0,0,0',
      shadowAlpha: 0.5,
    },
    {
      id: 'midnight',
      get label() { return globalThis.GXT.i18n.t("shared_theme_THEMES_6"); },
      get note() { return globalThis.GXT.i18n.t("shared_theme_THEMES_5"); },
      scheme: 'dark',
      swatch: ['#000000', '#0c0e12'],
      vars: {
        bg: '#000000',
        'bg-elev': '#0b0d11',
        'bg-sunken': '#000000',
        line: '#1b1f26',
        'line-strong': '#333a45',
      },
      tint: '#767f8d',
      toward: '#ffffff',
      shadowRgb: '0,0,0',
      shadowAlpha: 0.65,
    },
    {
      id: 'daylight',
      get label() { return globalThis.GXT.i18n.t("shared_theme_THEMES_4"); },
      get note() { return globalThis.GXT.i18n.t("shared_theme_THEMES_3"); },
      scheme: 'light',
      swatch: ['#ffffff', '#f2f5f8'],
      vars: {
        bg: '#ffffff',
        'bg-elev': '#f4f7fa',
        'bg-sunken': '#eef2f7',
        line: '#dbe2ea',
        'line-strong': '#b9c4d0',
      },
      tint: '#5b6b7a',
      toward: '#000000',
      shadowRgb: '15,20,25',
      shadowAlpha: 0.14,
    },
    {
      id: 'paper',
      get label() { return globalThis.GXT.i18n.t("shared_theme_THEMES_2"); },
      get note() { return globalThis.GXT.i18n.t("shared_theme_THEMES_1"); },
      scheme: 'light',
      swatch: ['#fbf6ec', '#f3ead9'],
      vars: {
        bg: '#fbf6ec',
        'bg-elev': '#f4ecdf',
        'bg-sunken': '#efe5d3',
        line: '#e2d6c0',
        'line-strong': '#c4b294',
      },
      tint: '#6d6354',
      toward: '#000000',
      shadowRgb: '90,70,40',
      shadowAlpha: 0.18,
    },
  ]);

  /** Accent identities. Every tint, hover, ring and readable variant is
   *  derived from this one hex, so an accent stays one number to maintain. */
  const ACCENTS = Object.freeze([
    { id: 'sky', get label() { return globalThis.GXT.i18n.t("shared_theme_ACCENTS_6"); }, color: '#1d9bf0' },
    { id: 'violet', get label() { return globalThis.GXT.i18n.t("shared_theme_ACCENTS_5"); }, color: '#7c5cf5' },
    { id: 'emerald', get label() { return globalThis.GXT.i18n.t("shared_theme_ACCENTS_4"); }, color: '#0e9f6e' },
    { id: 'rose', get label() { return globalThis.GXT.i18n.t("shared_theme_ACCENTS_3"); }, color: '#e11d63' },
    { id: 'amber', get label() { return globalThis.GXT.i18n.t("shared_theme_ACCENTS_2"); }, color: '#d97706' },
    { id: 'cyan', get label() { return globalThis.GXT.i18n.t("shared_theme_ACCENTS_1"); }, color: '#0891b2' },
  ]);

  /**
   * Spacing and type scale per density.
   *
   * v2.9 adds «بزرگ». Chrome's popup cannot be resized and the browser zoom
   * control does not reach it on every platform, so a reader who needs larger
   * text had no way to get it — an accessibility gap, not a taste setting.
   * Type sizes are a full 7-step scale now; before, three tokens existed and
   * the stylesheets hard-coded about twenty-five sizes around them.
   */
  /**
   * v3.2.5 adds the CONTROL scale — `ctl-*` and `sw-*`.
   *
   * The type and spacing scales reached every surface; control GEOMETRY did
   * not. A chip in a card header was `min-height: 26px; padding: 5px 11px`
   * written into content/ui.js, and the visually identical chip over the
   * YouTube player was `min-height: var(--gxt-tap); padding: 0 14px` written
   * into content/player.css.js — two files, two answers, and neither moved when
   * the reader chose «بزرگ». Same for the switch: 46×27 in the popup, 40×24 in
   * the player panel, both literal.
   *
   * Sharing a SELECTOR across those files would couple them; sharing the SCALE
   * does not. So the geometry becomes tokens and every stylesheet asks for the
   * same ones.
   *
   * `ctl-h-sm` clears the 24px target-size floor WCAG 2.2 added (2.5.8) at every
   * density, and `sw-travel` is `sw-w - sw-knob - 6` (the knob is inset 3px), so
   * the knob lands flush at both ends by construction rather than by a magic
   * translate that has to be re-guessed per size.
   */
  const DENSITIES = Object.freeze([
    {
      id: 'compact',
      get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_8"); },
      vars: {
        'sp-1': '3px', 'sp-2': '6px', 'sp-3': '9px', 'sp-4': '12px',
        'sp-5': '16px', 'sp-6': '22px',
        'row-y': '7px', 'card-p': '11px 12px', 'tap': '32px',
        'fs-2xs': '11px', 'fs-xs': '11.5px', 'fs-sm': '12px', 'fs-md': '12.5px',
        'fs-lg': '14px', 'fs-xl': '16px', 'fs-2xl': '20px',
        'lh-tight': '1.35', 'lh': '1.65', 'lh-loose': '1.85',
        'ctl-h': '32px', 'ctl-h-sm': '26px', 'ctl-px': '13px', 'ctl-px-sm': '10px',
        'sw-w': '40px', 'sw-h': '24px', 'sw-knob': '18px', 'sw-travel': '16px',
      },
    },
    {
      id: 'comfortable',
      get label() { return globalThis.GXT.i18n.t("shared_theme_DENSITIES_2"); },
      vars: {
        'sp-1': '4px', 'sp-2': '8px', 'sp-3': '12px', 'sp-4': '16px',
        'sp-5': '22px', 'sp-6': '30px',
        'row-y': '10px', 'card-p': '13px 14px', 'tap': '36px',
        'fs-2xs': '11.5px', 'fs-xs': '12px', 'fs-sm': '12.5px', 'fs-md': '13.5px',
        'fs-lg': '15px', 'fs-xl': '17px', 'fs-2xl': '23px',
        'lh-tight': '1.4', 'lh': '1.75', 'lh-loose': '2',
        'ctl-h': '36px', 'ctl-h-sm': '28px', 'ctl-px': '15px', 'ctl-px-sm': '11px',
        'sw-w': '46px', 'sw-h': '27px', 'sw-knob': '21px', 'sw-travel': '19px',
      },
    },
    {
      id: 'large',
      get label() { return globalThis.GXT.i18n.t("shared_theme_DENSITIES_1"); },
      vars: {
        'sp-1': '5px', 'sp-2': '9px', 'sp-3': '14px', 'sp-4': '18px',
        'sp-5': '26px', 'sp-6': '34px',
        'row-y': '13px', 'card-p': '15px 16px', 'tap': '42px',
        'fs-2xs': '12.5px', 'fs-xs': '13px', 'fs-sm': '14px', 'fs-md': '15.5px',
        'fs-lg': '17px', 'fs-xl': '19.5px', 'fs-2xl': '26px',
        'lh-tight': '1.45', 'lh': '1.8', 'lh-loose': '2.05',
        'ctl-h': '42px', 'ctl-h-sm': '32px', 'ctl-px': '18px', 'ctl-px-sm': '13px',
        'sw-w': '54px', 'sw-h': '32px', 'sw-knob': '26px', 'sw-travel': '22px',
      },
    },
  ]);

  /** Surface treatment: frosted glass vs. flat. */
  const SURFACES = Object.freeze([
    { id: 'glass', get label() { return globalThis.GXT.i18n.t("shared_theme_SURFACES_2"); }, vars: { blur: '16px', 'card-alpha': '84%' } },
    { id: 'solid', get label() { return globalThis.GXT.i18n.t("shared_theme_SURFACES_1"); }, vars: { blur: '0px', 'card-alpha': '100%' } },
  ]);

  // A preset is a composition of the stable 3.7.0 palette and new geometry.
  // Legacy theme IDs remain meaningful; selecting a preset writes concrete
  // settings, so individual controls are editable without a hidden override.
  const APPEARANCE_DEFAULTS = Object.freeze({
    uiTheme: 'auto', uiAccent: 'sky', uiDensity: 'comfortable', uiSurface: 'glass',
    uiPreset: 'custom', uiRadius: null, uiShadow: null, uiOpacity: null, uiBlur: null,
    uiScale: 1, uiTextScale: 1, uiTitleScale: 1, uiSpacingScale: 1, uiControlScale: 1,
    uiWeight: 400, uiMotion: 'auto', uiMotionSpeed: 1, uiButtonShape: 'pill',
    uiSwitchShape: 'pill', uiInputStyle: 'filled', uiPanelStyle: 'bordered', uiScrollbar: 'thin',
    uiCustomAccent: '', uiSecondaryColor: '', uiSuccessColor: '', uiWarningColor: '',
    uiErrorColor: '', uiBackground: '', uiCardColor: '', showHints: false, cardOpaque: false,
  });
  const PRESETS = Object.freeze([
    { id: 'system', get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_27"); }, get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_26"); }, settings: {} },
    { id: 'studio', get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_25"); }, get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_24"); }, settings: {uiTheme:'graphite',uiSurface:'solid',uiAccent:'violet',uiRadius:10,uiShadow:0.65,uiPanelStyle:'bordered',uiButtonShape:'rounded'} },
    { id: 'oled', label: 'OLED', get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_23"); }, settings: {uiTheme:'midnight',uiSurface:'solid',uiAccent:'emerald',uiRadius:8,uiShadow:0,uiMotion:'reduce',uiInputStyle:'outline'} },
    { id: 'glass', get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_22"); }, get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_21"); }, settings: {uiTheme:'graphite',uiAccent:'cyan',uiSurface:'glass',uiRadius:18,uiOpacity:78,uiBlur:24,uiShadow:1.3,uiSpacingScale:1.1} },
    { id: 'frost', get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_20"); }, get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_19"); }, settings: {uiTheme:'daylight',uiAccent:'sky',uiOpacity:72,uiBlur:28,uiRadius:16,uiSpacingScale:1.15,uiShadow:0.8} },
    { id: 'matte', get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_18"); }, get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_17"); }, settings: {uiTheme:'graphite',uiSurface:'solid',uiAccent:'amber',uiRadius:4,uiShadow:0,uiButtonShape:'square',uiSwitchShape:'square',uiInputStyle:'outline'} },
    { id: 'minimal', get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_16"); }, get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_15"); }, settings: {uiTheme:'daylight',uiSurface:'solid',uiCustomAccent:'#555555',uiRadius:3,uiShadow:0,uiButtonShape:'square',uiPanelStyle:'quiet',uiMotionSpeed:1.4} },
    { id: 'soft', get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_14"); }, get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_13"); }, settings: {uiTheme:'paper',uiAccent:'rose',uiRadius:22,uiShadow:0.5,uiSurface:'solid',uiSpacingScale:1.2,uiMotionSpeed:0.8} },
    { id: 'future', get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_12"); }, get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_11"); }, settings: {uiTheme:'midnight',uiAccent:'cyan',uiRadius:2,uiShadow:1.4,uiButtonShape:'square',uiSwitchShape:'square',uiInputStyle:'outline',uiPanelStyle:'contrast',uiTitleScale:1.1,uiMotionSpeed:1.5} },
    { id: 'contrast', get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_10"); }, get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_9"); }, settings: {uiTheme:'midnight',uiSurface:'solid',uiAccent:'amber',uiRadius:6,uiShadow:0,uiPanelStyle:'contrast',uiWeight:500,uiDensity:'large',uiMotion:'reduce'} },
    { id: 'dense', get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_8"); }, get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_7"); }, settings: {uiTheme:'graphite',uiDensity:'compact',uiSurface:'solid',uiRadius:6,uiShadow:0.3,uiSpacingScale:0.85,uiButtonShape:'rounded',uiMotionSpeed:1.5} },
    { id: 'airy', get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_6"); }, get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_5"); }, settings: {uiTheme:'daylight',uiDensity:'large',uiSurface:'solid',uiRadius:20,uiShadow:0.6,uiSpacingScale:1.2,uiControlScale:1.1} },
    { id: 'editorial', get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_4"); }, get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_3"); }, settings: {uiTheme:'paper',uiSurface:'solid',uiCustomAccent:'#68513d',uiRadius:0,uiShadow:0,uiButtonShape:'square',uiTextScale:1.08,uiTitleScale:1.15,uiInputStyle:'outline'} },
    { id: 'color', get label() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_2"); }, get note() { return globalThis.GXT.i18n.t("shared_theme_PRESETS_1"); }, settings: {uiTheme:'graphite',uiAccent:'violet',uiSecondaryColor:'#e11d63',uiRadius:16,uiShadow:1.1,uiTitleScale:1.2,uiPanelStyle:'accent',uiSpacingScale:1.08} },
  ].map(p => Object.freeze({...p, settings:Object.freeze(p.settings)})));
  const APPEARANCE_KEYS = Object.freeze([...Object.keys(APPEARANCE_DEFAULTS), 'videoSafeUi']);
  const resetSettings = () => ({...APPEARANCE_DEFAULTS});
  const presetSettings = id => ({...APPEARANCE_DEFAULTS, ...(PRESETS.find(p => p.id===id)?.settings || {}), uiPreset:PRESETS.some(p=>p.id===id)?id:'custom'});
  const settingsKey = settings => JSON.stringify(APPEARANCE_KEYS.map(k => settings?.[k] ?? APPEARANCE_DEFAULTS[k] ?? (k==='videoSafeUi' ? true : null)));
  const color = value => typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value.toLowerCase() : '';
  const number = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min,Math.min(max,value)) : fallback;
  const px = value => `${Math.round(value * 100) / 100}px`;

  /**
   * Opacity of the subtitle scrim — v3.2.5, and the number is a measurement.
   *
   * The YouTube caption was the last surface in the product outside the design
   * system: a hard-coded `rgba(8,8,8,.78)` with `#fff` on it, chosen because a
   * caption sits on arbitrary footage for the whole video and legibility there
   * beats matching the panel. That reasoning is right; the conclusion was not.
   * A THEMED scrim is legible too — it just has to be derived against the
   * surface it really has, exactly like the page cards were in v2.9.5.
   *
   * A caption's true background is the scrim composited over a frame the
   * extension does not control, and the two extremes bound every possibility (a
   * white title card and a black letterbox — see `surfacesFor`). Measured
   * across all four concrete themes at both extremes:
   *
   *     alpha .78  worst  8.58:1      alpha .86  worst 11.40:1
   *     alpha .82  worst  9.89:1      alpha .90  worst 13.04:1
   *
   * The old hard-coded bar measured 10.70:1. So at 86% the themed caption is
   * MORE legible than the untheming was, on every theme, over any frame — while
   * finally looking like the same product as the panel above it. Anything higher
   * buys contrast nobody needs by hiding more of the video.
   *
   * dev/uicheck.html re-measures this whole matrix on every run, so the claim
   * cannot rot into a comment.
   */
  const CAP_ALPHA = 0.86;

  /** Status hues, before contrast is enforced against the live background. */
  const STATUS = Object.freeze({
    ok: '#12b981',
    warn: '#eab308',
    err: '#f43f5e',
  });

  const byId = (list, id, fallbackIndex) =>
    list.find((entry) => entry.id === id) || list[fallbackIndex];

  /** Does the OS ask for a dark UI right now? (safe outside a document) */
  function prefersDark() {
    try {
      return !!globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
    } catch {
      return true; // dark-first default
    }
  }

  /**
   * Resolve the user's appearance settings into a concrete theme description.
   * @returns {{theme, accent, density, surface, dark: boolean}}
   */
  function resolve(settings) {
    const requested = byId(THEMES, settings?.uiTheme, 0);
    const dark = requested.id === 'auto' ? prefersDark() : requested.scheme === 'dark';
    let theme =
      requested.id === 'auto' ? byId(THEMES, dark ? 'graphite' : 'daylight', 1) : requested;
    const background = color(settings?.uiBackground), card = color(settings?.uiCardColor);
    if (background || card) {
      // Mid-tone user colors can make AAA mathematically impossible. Preserve
      // their hue while moving toward the chosen scheme's readable surface.
      const safe = c => ramp(c, dark ? '#000000' : '#ffffff', dark ? '#ffffff' : '#000000', 15);
      theme = {...theme, vars:{...theme.vars}};
      if (background) { theme.vars.bg = safe(background); theme.vars['bg-sunken'] = theme.vars.bg; }
      if (card) theme.vars['bg-elev'] = safe(card);
    }
    const chosenAccent = byId(ACCENTS, settings?.uiAccent, 0);
    const customAccent = color(settings?.uiCustomAccent);
    return {
      theme,
      accent: customAccent ? { ...chosenAccent, color:customAccent } : chosenAccent,
      density: byId(DENSITIES, settings?.uiDensity, 1),
      surface: byId(SURFACES, settings?.uiSurface, 0),
      dark,
    };
  }

  // ══════════════════════════════════════════════════ derived palette

  /**
   * Everything colour-critical for one (theme, accent) pair, computed to hit
   * the contrast targets above.
   *
   * Memoised: `tokens()` runs on every settings change in every frame and once
   * per in-page card, and there are only 5 × 6 possible answers.
   */
  const paletteCache = new Map();

  /**
   * The colour a translucent surface ACTUALLY becomes.
   *
   * `mix(page, surface, alpha)` is source-over compositing for opaque
   * backdrops, which is what a page is: at `alpha` the surface contributes
   * `alpha` and the pixels behind it contribute the rest.
   */
  const compositeOver = (surface, page, alpha) => mix(page, surface, alpha);

  /**
   * Every surface this palette's ink has to stay legible on.
   *
   * v2.9.5. For the popup that is just the three authored backgrounds. For a
   * surface drawn ON a web page it is not: `.card`, `.pill` and `.toast` paint
   * at `--gxt-card-alpha` (84% by default) and — because a backdrop blur would
   * knock a video out of its hardware overlay plane (see `tokens`) — they do it
   * with NO blur behind them. So the real background of that text is the card
   * composited over whatever the page happens to be showing, which the
   * extension does not control and cannot predict.
   *
   * The two extremes bound every possibility: a white page and a black one.
   * Ink that clears its target against both clears it against everything in
   * between, because contrast against the composite is monotone in the page's
   * luminance.
   *
   * @param {object} theme
   * @param {number} [alpha] opacity of the surface, 0-1. Omit (or 1) for an
   *   opaque surface, where only the authored backgrounds apply.
   */
  function surfacesFor(theme, alpha) {
    const list = [theme.vars.bg, theme.vars['bg-elev'], theme.vars['bg-sunken']];
    if (typeof alpha === 'number' && alpha < 1) {
      const card = theme.vars['bg-elev'];
      list.push(compositeOver(card, '#ffffff', alpha), compositeOver(card, '#000000', alpha));
    }
    return list;
  }

  /**
   * @param {object} theme
   * @param {object} accent
   * @param {number} [alpha] see `surfacesFor`. The opaque palette (no alpha)
   *   is byte-identical to v2.9.0's, so nothing that was measured there moves.
   */
  function palette(theme, accent, alpha, statuses = STATUS) {
    const translucent = typeof alpha === 'number' && alpha < 1;
    const key = `${theme.id}|${Object.values(theme.vars).join(',')}|${accent.color}|${Object.values(statuses).join(',')}|${translucent ? alpha.toFixed(3) : 'opaque'}`;
    const hit = paletteCache.get(key);
    if (hit) return hit;

    const bg = theme.vars.bg;
    const tint = theme.tint;
    const toward = theme.toward;
    const isDark = toward === '#ffffff';

    /**
     * The HARDEST surface this ink can land on.
     *
     * A theme has three plain surfaces — the window, an elevated card, a sunken
     * well — and ink derived against only one of them is not guaranteed on the
     * others. Measured: deriving against `bg` alone left the accent chip label
     * at 4.97:1 on graphite, because a chip sits on the elevated card, which is
     * the lighter surface. The worst case is simply the surface with the LEAST
     * contrast against the direction the ink travels: the lightest one on a
     * dark theme, the darkest one on a light theme. Both fall out of the same
     * expression.
     *
     * v2.9.5 widens the candidate set with the COMPOSITED surfaces whenever the
     * caller says this palette is for a translucent surface — see
     * `surfacesFor`. Measured before that change, on the default theme over an
     * ordinary white page: `fg-faint` 4.40:1 and `err` 4.25:1, both under the
     * 4.5:1 AA floor everything else here clears by a wide margin. The tokens
     * were honest about the surface they were derived against; that surface
     * just was not the one the card actually had.
     */
    const worstOf = (list) =>
      list.reduce((a, b) => (contrast(toward, a) < contrast(toward, b) ? a : b));
    const plain = worstOf(surfacesFor(theme, alpha));

    const fg = ramp(tint, toward, plain, TARGET.ink);
    const fgMuted = ramp(tint, toward, plain, TARGET.inkMuted);
    const fgFaint = ramp(tint, toward, plain, TARGET.inkFaint);

    // The accent as TEXT on a plain surface. Walking the accent toward the ink
    // direction keeps its hue while making it readable, which is why a link on
    // the «کاغذی» theme is a deep amber rather than a washed one.
    const accentInk = ramp(accent.color, toward, plain, TARGET.accentInk);

    /**
     * A filled accent surface (primary button, active tab) and its text.
     *
     * White-on-accent is the pairing the product already had and the one every
     * reader expects, and it is achievable for every accent here — measured:
     * white on the authored `sky` is only 3.00:1, but the blue only has to be
     * darkened to L≈0.183 to clear 4.5:1, and that shade is still 4.2:1 against
     * the darkest theme background. So the rule is: DARKEN THE FILL, keep the
     * white. This is exactly what Material's tonal palettes do — `primary` on a
     * light scheme is a dark tone of the seed hue so that `on-primary` can be
     * white — and it preserves the brand colour as the identity token
     * (`--gxt-accent-brand`) while making the control legible.
     *
     * The fallback exists for a hypothetical very light accent, where the
     * darkening needed for white text would sink the control into the surface.
     * There the ink flips to the theme's near-black instead.
     */
    const darkInk = isDark ? theme.vars.bg : mix(tint, '#000000', 0.72);
    let onAccent = '#ffffff';
    let accentSolid = ramp(accent.color, '#000000', onAccent, TARGET.onAccent);
    if (contrast(accentSolid, bg) < TARGET.nonText) {
      onAccent = darkInk;
      accentSolid = ramp(accent.color, '#ffffff', onAccent, TARGET.onAccent);
      if (contrast(accentSolid, bg) < TARGET.nonText) {
        accentSolid = ramp(accentSolid, toward, bg, TARGET.nonText);
      }
    }

    // Non-text accent uses (rails, dots, focus rings, bar fills) need 3:1
    // against the background, and the authored accent can be too dim for that
    // on the light themes.
    const accentEdge = ramp(accent.color, toward, plain, TARGET.nonText);

    const statusInk = (hue) => ramp(hue, toward, plain, TARGET.statusInk);
    const statusEdge = (hue) => ramp(hue, toward, plain, TARGET.nonText);

    /**
     * The soft-tint pair: a translucent chip of a hue, and the ink that stays
     * AAA on it.
     *
     * One ink token cannot serve both a plain card and a tinted chip — that is
     * the defect the rendered audit found, and patching the chip's colour by
     * hand would only move it. So the pair is derived together, the way
     * Material's `*-container` / `on-*-container` roles are: `softPct` here
     * MUST match the percentage the `*-soft` tokens are emitted with below, or
     * the ink is derived against a surface that does not exist.
     */
    const softPct = isDark ? 0.18 : 0.12;
    // A tinted chip sits on the elevated card — or, in-page, on that card
    // AFTER it has been composited over the page. `plain` is already whichever
    // of those is hardest to read on, so the translucent case needs no second
    // rule. The opaque case keeps naming `bg-elev` explicitly, because `plain`
    // is the SUNKEN surface on the light themes and switching to it there
    // would move colours that v2.9.0 already measured and shipped.
    const softBase = translucent ? plain : theme.vars['bg-elev'];
    const onSoft = (hue) => {
      const edge = ramp(hue, toward, plain, TARGET.nonText);
      const surface = mix(softBase, edge, softPct);
      return ramp(hue, toward, surface, TARGET.accentInk);
    };

    const value = {
      fg,
      fgMuted,
      fgFaint,
      accentInk,
      accentOnSoft: onSoft(accent.color),
      accentSolid,
      accentEdge,
      onAccent,
      // Hover moves the fill FURTHER from its own ink, so the state change can
      // never cost contrast — the usual "lighten on hover" reflex does exactly
      // that on a white-on-colour button.
      accentHover: mix(accentSolid, onAccent === '#ffffff' ? '#000000' : '#ffffff', 0.13),
      ok: statusInk(statuses.ok),
      warn: statusInk(statuses.warn),
      err: statusInk(statuses.err),
      okEdge: statusEdge(statuses.ok),
      warnEdge: statusEdge(statuses.warn),
      errEdge: statusEdge(statuses.err),
      okOnSoft: onSoft(statuses.ok),
      warnOnSoft: onSoft(statuses.warn),
      errOnSoft: onSoft(statuses.err),
      softPct,
      plain,
    };
    if (paletteCache.size >= 256) paletteCache.delete(paletteCache.keys().next().value);
    paletteCache.set(key, value);
    return value;
  }

  // ══════════════════════════════════════════════════════════ token block

  /**
   * The semantic token block for a resolved appearance, as CSS declarations.
   *
   * @param {object} settings
   * @param {{inPage?: boolean}} [opts] `inPage: true` for surfaces drawn ON a
   *   web page (the YouTube panel, the page/selection cards). Those may end up
   *   over a <video>, where a backdrop blur forces the compositor to read the
   *   video's pixels — which drops it out of its hardware overlay plane and
   *   turns OFF driver-side enhancement like RTX Video Super Resolution. With
   *   `videoSafeUi` on (the default) such surfaces get `--gxt-backdrop: none`.
   *   NOTE `blur(0px)` is NOT a safe substitute: it still creates a backdrop
   *   root and still costs the readback. The property must be `none`.
   *
   *   `cardOpaque` is the user's in-context escape hatch for exactly these
   *   surfaces: it drops the translucency and paints them on the theme's
   *   DEEPEST background, so a busy page can never bleed through a translation.
   */
  function tokens(settings, opts = {}) {
    const { theme, accent, density, surface, dark } = resolve(settings);
    const opaque = !!(opts.inPage && settings?.cardOpaque);
    /**
     * The opacity the surfaces built from these tokens will really have.
     *
     * Only in-page surfaces are translucent over content the extension does not
     * control; the popup paints on its own window, so its palette stays the
     * opaque one. «مات» makes an in-page card opaque too — and on the theme's
     * DEEPEST colour rather than the elevated one, which is strictly easier to
     * read on, so the opaque palette is right there as well.
     */
    const opacity = surface.id==='solid' || opaque ? 100 : number(settings?.uiOpacity,parseFloat(surface.vars['card-alpha']),opts.inPage ? 84 : 55,100);
    const cardAlpha = opts.inPage && !opaque ? opacity / 100 : undefined;
    const statuses = {ok:color(settings?.uiSuccessColor)||STATUS.ok,warn:color(settings?.uiWarningColor)||STATUS.warn,err:color(settings?.uiErrorColor)||STATUS.err};
    const p = palette(theme, accent, cardAlpha, statuses);
    const lines = [];
    const put = (name, value) => lines.push(`--gxt-${name}: ${value};`);

    // ── surfaces + structure (authored) ────────────────────────────────
    for (const [key, value] of Object.entries(theme.vars || {})) put(key, value);
    for (const [key, value] of Object.entries(density.vars)) put(key, value);
    for (const [key, value] of Object.entries(surface.vars)) put(key, value);
    put('card-alpha', `${opacity}%`);
    const blur = number(settings?.uiBlur,parseFloat(surface.vars.blur),0,28);
    put('blur', px(blur));

    const scale = number(settings?.uiScale,1,0.85,1.2);
    const textScale = scale * number(settings?.uiTextScale,1,0.9,1.3);
    const titleScale = number(settings?.uiTitleScale,1,0.9,1.3);
    const spacingScale = scale * number(settings?.uiSpacingScale,1,0.8,1.4);
    const controlScale = scale * number(settings?.uiControlScale,1,0.85,1.25);
    const d = density.vars;
    for (const key of Object.keys(d).filter(k=>k.startsWith('fs-'))) put(key,px(parseFloat(d[key])*textScale*(/^(fs-lg|fs-xl|fs-2xl)$/.test(key)?titleScale:1)));
    put('fs-heading',px(parseFloat(d['fs-md'])*textScale*titleScale));
    for (const key of [...Object.keys(d).filter(k=>k.startsWith('sp-')), 'row-y']) put(key,px(parseFloat(d[key])*spacingScale));
    put('card-p',d['card-p'].split(' ').map(v=>px(parseFloat(v)*spacingScale)).join(' '));
    for (const key of ['tap','ctl-h','ctl-h-sm','ctl-px','ctl-px-sm','sw-w','sw-h','sw-knob']) put(key,px(Math.max(/^(tap|ctl-h|ctl-h-sm|sw-h)$/.test(key)?24:0,parseFloat(d[key])*controlScale)));
    const switchH=Math.max(24,parseFloat(d['sw-h'])*controlScale),switchW=parseFloat(d['sw-w'])*controlScale;
    put('sw-knob',px(switchH-6));
    put('sw-travel',px(switchW-switchH));
    const switchSmallH=Math.max(24,24*controlScale),switchSmallW=40*controlScale;
    put('sw-sm-w',px(switchSmallW));put('sw-sm-h',px(switchSmallH));
    put('sw-sm-knob',px(switchSmallH-6));put('sw-sm-travel',px(switchSmallW-switchSmallH));
    put('weight',Math.round(number(settings?.uiWeight,400,350,650)));
    put('weight-strong',Math.min(850,Math.round(number(settings?.uiWeight,400,350,650))+300));

    // ── ink (derived to hit AAA on this exact background) ──────────────
    put('fg', p.fg);
    put('fg-muted', p.fgMuted);
    put('fg-faint', p.fgFaint);

    // A solid surface has nothing behind it to blur, so opaque mode also
    // retires the (already video-unsafe) backdrop filter.
    const videoSafe = opts.inPage && settings?.videoSafeUi !== false;
    put(
      'backdrop',
      surface.id === 'glass' && blur>0 && !videoSafe && !opaque ? `blur(${px(blur)})` : 'none'
    );

    // ── accent ramp ───────────────────────────────────────────────────
    put('accent', p.accentEdge);
    put('accent-brand', accent.color);
    put('accent-solid', p.accentSolid);
    put('accent-fg', p.onAccent);
    put('accent-ink', p.accentInk);
    put('accent-on-soft', p.accentOnSoft);
    put('accent-hover', p.accentHover);
    const softPct = Math.round(p.softPct * 100);
    put('accent-soft', `color-mix(in srgb, ${p.accentEdge} ${softPct}%, transparent)`);
    put('accent-line', `color-mix(in srgb, ${p.accentEdge} 45%, transparent)`);
    const secondary = color(settings?.uiSecondaryColor) || accent.color;
    put('secondary',ramp(secondary,theme.toward,p.plain,TARGET.nonText));
    put('secondary-ink',ramp(secondary,theme.toward,p.plain,TARGET.accentInk));
    put('heading-ink',color(settings?.uiSecondaryColor)?ramp(secondary,theme.toward,p.plain,TARGET.accentInk):p.fg);
    put('input-bg',settings?.uiInputStyle==='outline'?'transparent':'var(--gxt-bg-sunken)');
    put('input-line',settings?.uiInputStyle==='outline'?'var(--gxt-line-strong)':'var(--gxt-line)');
    put('panel-line',settings?.uiPanelStyle==='quiet'?'transparent':settings?.uiPanelStyle==='accent'?'var(--gxt-secondary)':settings?.uiPanelStyle==='contrast'?ramp(theme.vars['line-strong'],theme.toward,p.plain,TARGET.nonText):'var(--gxt-line)');
    put('scrollbar-width',settings?.uiScrollbar==='auto'?'auto':'thin');

    // Opaque mode overrides the alpha AND the surface: `bg` is the theme's
    // deepest colour, so «مات» really is black on graphite/midnight instead of
    // a merely-solid grey. Declared after the surface loop, so it wins.
    if (opaque) {
      put('card-alpha', '100%');
      put('card', 'var(--gxt-bg)');
    } else {
      put('card', 'color-mix(in srgb, var(--gxt-bg-elev) var(--gxt-card-alpha), transparent)');
    }

    // ── the subtitle scrim ────────────────────────────────────────────
    //
    // Its own alpha, and therefore its own ink. Reusing `--gxt-fg` would derive
    // the caption's text against the CARD's composite (84%, or 100% in «مات»),
    // which is not the surface the caption has — the precise mistake v2.9.5
    // fixed on the page cards. «مات» applies here too: a viewer who asked for
    // solid surfaces asked for a solid caption as well.
    const capAlpha = opaque ? undefined : CAP_ALPHA;
    const cap = palette(theme, accent, capAlpha, statuses);
    put('cap-alpha', opaque ? '100%' : `${Math.round(CAP_ALPHA * 100)}%`);
    put(
      'cap-bg',
      opaque
        ? 'var(--gxt-bg)'
        : 'color-mix(in srgb, var(--gxt-bg-elev) var(--gxt-cap-alpha), transparent)'
    );
    put('cap-fg', cap.fg);
    /**
     * The original line of a bilingual caption.
     *
     * A lower OPACITY carried this before, which is the one thing this design
     * system refuses to do. But the replacement has to be a colour that is
     * actually a step DOWN, and `fgMuted` is not: its 10:1 target is so close to
     * the ceiling on this surface that `ramp` lands on #eff0f3 — 11.40 vs 10.01,
     * a difference nobody can see. Rendered side by side in
     * dev/player-preview.html the second line was indistinguishable from the
     * first, so the hierarchy rested entirely on the .72em size.
     *
     * `fgFaint` is the right level: 7.21:1 measured against the hardest
     * composite, so still AAA for body text, and a visible step. Size and colour
     * now both carry it, which is what the rest of the product does.
     */
    put('cap-fg-muted', cap.fgFaint);
    put('cap-line', `color-mix(in srgb, ${cap.accentEdge} 38%, transparent)`);
    // The classic high-contrast bar, kept as a token rather than as a literal in
    // one stylesheet: a viewer who prefers maximum legibility over a matching
    // surface can still have it (see `ytCapTheme`), and both options then come
    // from the same place.
    put('cap-plain-bg', 'rgba(8, 8, 8, .78)');
    put('cap-plain-fg', '#ffffff');
    /**
     * The classic bar's second line.
     *
     * It was `opacity: .85` on the `.orig` element. Opacity there does not thin
     * the scrim (that belongs to the parent) but it does thin the INK over it, so
     * it is still a contrast cost paid for a hierarchy that the .72em size already
     * expresses. Measured: this grey on the plain scrim composited over a white
     * frame is 7.6:1, i.e. AAA, and it does not move when the frame does.
     */
    put('cap-plain-fg-muted', '#e6e8ea');

    // ── status ────────────────────────────────────────────────────────
    put('ok', p.ok);
    put('warn', p.warn);
    put('err', p.err);
    put('ok-edge', p.okEdge);
    put('warn-edge', p.warnEdge);
    put('err-edge', p.errEdge);
    put('ok-on-soft', p.okOnSoft);
    put('warn-on-soft', p.warnOnSoft);
    put('err-on-soft', p.errOnSoft);
    put('ok-soft', `color-mix(in srgb, ${p.okEdge} ${softPct}%, transparent)`);
    put('warn-soft', `color-mix(in srgb, ${p.warnEdge} ${softPct}%, transparent)`);
    put('err-soft', `color-mix(in srgb, ${p.errEdge} ${softPct}%, transparent)`);

    // ── shape ─────────────────────────────────────────────────────────
    const radius = number(settings?.uiRadius,13,0,26);
    put('radius-sm', px(radius*9/13));
    put('radius-md', px(radius));
    put('radius-lg', px(radius*18/13));
    put('radius-xl', px(radius*24/13));
    put('radius-pill', settings?.uiButtonShape==='square'?'2px':settings?.uiButtonShape==='rounded'?'var(--gxt-radius-sm)':'9999px');
    put('switch-radius',settings?.uiSwitchShape==='square'?'4px':'9999px');
    put('switch-knob-radius',settings?.uiSwitchShape==='square'?'2px':'50%');

    // ── elevation (one shadow colour per theme, three heights) ─────────
    const strength=number(settings?.uiShadow,1,0,1.5);
    const sh = (y, blur, alpha) => strength===0?'none':
      `0 ${y}px ${blur}px rgba(${theme.shadowRgb}, ${Math.min(1,theme.shadowAlpha * alpha * strength).toFixed(3)})`;
    put('elev-1', sh(2, 8, 0.5));
    put('elev-2', sh(8, 24, 0.75));
    put('elev-3', sh(18, 44, 1));
    // Legacy aliases — content.css and the YouTube panel still read these.
    put('shadow', `var(--gxt-elev-3)`);
    put('shadow-sm', `var(--gxt-elev-1)`);

    // ── focus ─────────────────────────────────────────────────────────
    // Two rings: an inner one in the surface colour so the outer accent ring
    // stays visible on top of a filled control, and an outer accent ring that
    // clears 3:1 against the background by construction (accentEdge).
    put('focus-ring', `0 0 0 2px var(--gxt-bg), 0 0 0 4px ${p.accentEdge}`);
    put('focus-ring-inset', `inset 0 0 0 2px ${p.accentEdge}`);

    // ── motion ────────────────────────────────────────────────────────
    let systemReduce=false;
    try {systemReduce=!!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;} catch {}
    const reduced=settings?.uiMotion==='reduce'||systemReduce;
    const speed=number(settings?.uiMotionSpeed,1,0.5,2);
    put('dur-1', `${reduced?0:Math.round(120/speed)}ms`);
    put('dur-2', `${reduced?0:Math.round(180/speed)}ms`);
    put('dur-3', `${reduced?0:Math.round(260/speed)}ms`);
    put('ease', 'cubic-bezier(.2, 0, 0, 1)');
    put('ease-emphasized', 'cubic-bezier(.2, .8, .25, 1)');
    put('motion', 'var(--gxt-dur-2) var(--gxt-ease)');

    // ── type aliases kept for surfaces not yet on the 7-step scale ─────
    put('fs-body', 'var(--gxt-fs-md)');
    put('fs-title', 'var(--gxt-fs-sm)');
    put('fs-small', 'var(--gxt-fs-xs)');

    put('ui-dir',globalThis.GXT.i18n?.direction(settings) || 'rtl');
    put('switch-sign',globalThis.GXT.i18n?.direction(settings) === 'ltr' ? 1 : -1);
    put('content-dir',globalThis.GXT.targetDirection(settings?.targetLang || 'fa'));
    put('caption-dir',globalThis.GXT.targetDirection(settings?.ytTargetLang || 'fa'));
    put('scheme', dark ? 'dark' : 'light');
    put('font', '"Vazirmatn", "Segoe UI", Tahoma, sans-serif');
    return lines.join(' ');
  }

  /**
   * Apply the tokens to a real element (the popup's <html>, or a shadow host).
   * Also stamps data-theme / data-scheme so a stylesheet can special-case a
   * theme, and sets color-scheme so native controls follow along.
   */
  function apply(el, settings, opts = {}) {
    if (!el) return;
    const { theme, accent, density, surface, dark } = resolve(settings);
    globalThis.GXT.i18n?.configure(settings);
    // Only extension-owned roots get language attributes, never the host page.
    if(el !== globalThis.document?.documentElement || globalThis.location?.protocol === 'chrome-extension:') globalThis.GXT.i18n?.apply(el.shadowRoot || el);
    el.style.setProperty('--gxt-ui-dir',globalThis.GXT.i18n?.direction() || 'rtl');
    el.setAttribute('data-theme', theme.id);
    el.setAttribute('data-accent', accent.id);
    el.setAttribute('data-density', density.id);
    el.setAttribute('data-surface', surface.id);
    el.setAttribute('data-scheme', dark ? 'dark' : 'light');
    el.setAttribute('data-preset',PRESETS.some(p=>p.id===settings?.uiPreset)?settings.uiPreset:'custom');
    // Strip what a previous apply() wrote — INCLUDING color-scheme, which used
    // to be added afterwards with setProperty and therefore landed in a
    // different position each time, so the style attribute was never stable.
    const kept = el.style.cssText.replace(/(--gxt-[^;]+|color-scheme\s*:[^;]+);\s*/g, '');
    el.style.cssText =
      `${kept} ${tokens(settings,opts)} color-scheme: ${dark ? 'dark' : 'light'};`.trim();
  }

  /** Watch the OS light/dark setting (only meaningful while uiTheme==='auto'). */
  function onSchemeChange(callback) {
    try {
      const mq = globalThis.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => callback(mq.matches);
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    } catch {
      return () => {};
    }
  }

  globalThis.GXT = Object.assign(globalThis.GXT || {}, {
    themeReady: true,
    theme: {
      THEMES,
      ACCENTS,
      DENSITIES,
      SURFACES,
      PRESETS,
      APPEARANCE_DEFAULTS,
      APPEARANCE_KEYS,
      presetSettings,
      resetSettings,
      settingsKey,
      cacheSize: () => paletteCache.size,
      TARGET,
      // v3.2.5 — the subtitle scrim's opacity, exported so the conformance
      // suite measures the shipped constant rather than a copy of it.
      CAP_ALPHA,
      resolve,
      tokens,
      apply,
      palette,
      prefersDark,
      onSchemeChange,
      // Colour maths, exported so the conformance suite measures the shipped
      // implementation rather than a copy of it.
      luminance,
      contrast,
      mix,
      ramp,
      // v2.9.5 — what a translucent surface really becomes, and the surface
      // set a palette is measured against. The conformance suite composites
      // with these rather than a reimplementation of them.
      compositeOver,
      surfacesFor,
    },
  });
})();
