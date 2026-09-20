/**
 * Shared settings module.
 *
 * Loaded by the service worker (via importScripts), the content scripts
 * (via the manifest), and the popup (via a <script> tag). It attaches a
 * single `GXT` namespace to globalThis. Written as a classic script on
 * purpose so the whole extension stays build-free.
 */
'use strict';
(() => {
  if (globalThis.GXT && globalThis.GXT.settingsReady) return;

  const SETTINGS_KEY = 'settings';
  const API_KEYS_KEY = 'apiKeys';        // string[] — Gemini keys, rotated on quota
  const LEGACY_API_KEY_KEY = 'apiKey';   // v1.0 single-key storage, migrated on read
  const OPENAI_KEY_KEY = 'openaiApiKey';
  const MODEL_LIST_KEY = 'modelList';
  const OPENAI_MODEL_LIST_KEY = 'openaiModelList';
  /** v2.5.1 — what the local bridge last reported it could speak and hear. */
  const LOCAL_VOICE_LIST_KEY = 'localVoiceList';
  /** v2.5.5 — today's request count and measured cap, PER API key. */
  const KEY_USAGE_KEY = 'keyUsage';
  const STATS_KEY = 'stats';

  const DEFAULTS = Object.freeze({
    enabled: true,
    // UI, regional display and translation output are independent preferences.
    uiLanguage: 'auto',
    localeVersion: 1,
    regionLocale: 'auto',
    calendar: 'auto',
    numberingSystem: 'auto',
    hourCycle: 'auto',
    weekStart: 'auto',
    timeZone: 'auto',
    targetLang: 'fa',
    xTargetLang:'inherit',pageTargetLang:'inherit',imageTargetLang:'inherit',summaryTargetLang:'inherit',webTargetLang:'inherit',fileTargetLang:'inherit',mangaTargetLang:'inherit',composeTargetLang:'en',
    translationRegion: 'iran',

    /** 'auto' translates tweets as they scroll into view; 'manual' shows a "ترجمه" link. */
    mode: 'auto',
    /** 'gemini' (primary) or 'openai' (any OpenAI-compatible endpoint). */
    provider: 'gemini',
    /** Google's newest free-tier workhorse (released 2026-07-21). */
    model: 'gemini-3.6-flash',
    openaiBaseUrl: '',
    openaiModel: '',
    /** Bundled font id, 'x-default' (X's own font), or '_custom' + customFont. */
    font: 'Vazirmatn',
    customFont: '',
    /** Requests/day the user's plan allows; 0 = unknown. Drives the usage bar. */
    dailyQuota: 0,
    /** Hide the original text and show only the Persian translation. */
    replaceOriginal: false,
    /** Also translate profile bios. */
    translateBios: true,
    /** YouTube subtitle translation (pill button in the player). */
    youtube: true,
    /** Opt-in: start translating automatically on every video that has
     *  captions, with the settings already saved — no click on the pill.
     *  A manual «stop» still wins for that video (see youtube.js). */
    ytAuto: false,
    /** Subtitle font: 'inherit' follows the extension font, or a bundled id. */
    ytFont: 'inherit',
    /** Subtitle engine override: 'inherit' follows the global provider, or a
     *  provider id (gemini | openai | google | bing) just for YouTube. */
    ytProvider: 'inherit',
    /** YouTube-only overrides. Empty model follows the chosen provider. */
    ytModel: '',
    ytTargetLang: 'fa',
    /** General web players are opt-in; dubbing still requires a player click. */
    webVideoEnabled: false,
    webVideoSubtitles: true,
    webVideoDub: true,
    /** Auto uses captions when available, otherwise audio-native Gemini Live. */
    webVideoDubEngine: 'auto',
    webVideoDisplay: 'auto',
    webVideoSiteMode: 'all',
    webVideoBlockedSites: [],
    webVideoAllowedSites: [],
    webVideoCaptionPosition: { x:50, y:72, manual:false },
    /** Subtitle size multiplier (0.6–2.2). */
    ytScale: 1,
    /** Subtitle position, % of player: X = center from left, Y = from bottom. */
    ytPosX: 50,
    ytPosY: 11,
    /** Rolling mode: how far ahead of the playhead to translate (seconds). */
    ytAheadSec: 90,
    /** Opt-in: only translate a tweet after ~1s of actual visibility. */
    dwellMode: false,
    /** Opt-in: auto-click a long post's "Show more" so the FULL text is
     *  expanded and translated, instead of translating the truncated preview
     *  and re-translating after a manual expand. */
    expandLongPosts: false,
    /** Origins (https://example.com) that auto-translate on load. */
    autoSites: [],
    /** Tweets per request. Larger = fewer API calls, slower first paint. */
    batchSize: 8,
    /** Debounce window (ms) used to batch tweets that appear together. */
    batchDelayMs: 350,

    // ------------------------------------------------------------- v1.8.0
    // Every new capability ships behind its own switch. Defaults preserve
    // the pre-1.8 behavior except pure quality/coverage fixes (block mode,
    // Shorts, the two new context-menu items), each still toggleable.

    /** Page translation: sentence-level block units with inline-tag
     *  preservation (fixes translations broken mid-sentence by <b>/<a>). */
    pageBlockMode: true,
    /** Page translation: keep translating content that appears later
     *  (infinite scroll, SPAs, menus opened after the first pass). */
    pageDynamic: false,
    /** Page translation: show the Persian under the original instead of
     *  replacing it (requires pageBlockMode). */
    pageBilingual: false,
    /** Page translation: also translate placeholder/title/alt/aria-label. */
    pageAttrs: false,
    /** Page translation: also translate same-page iframes. */
    pageFrames: false,
    /** Floating «ترجمه» chip right after selecting text (on pages where the
     *  page module is active: auto-sites or after any context-menu use). */
    selectionButton: false,
    /** X: small "ترجمهٔ تصویر" button on tweet images. */
    xImageButton: false,
    /** X: Persian→English button under the compose/reply box. */
    composerTranslate: false,
    /** X (experimental): also translate Community Notes and Articles. */
    xExtraZones: false,
    /** Context menu: «ترجمهٔ این تصویر به فارسی» on any image. */
    imageTranslate: true,
    /** Context menu: «خلاصهٔ فارسی» for the page or the selection. */
    summarizer: true,
    /** YouTube: also mount on /shorts/ pages. */
    ytShorts: true,
    /** YouTube: merge caption fragments into sentences before translating. */
    ytSentenceMerge: false,
    /** YouTube: show the original line under the Persian one. */
    ytBilingual: false,
    /**
     * YouTube: how the subtitle box is painted (v3.2.5).
     *
     *   'theme'  — the user's theme, accent hairline and derived ink. Measured
     *              at 11.40:1 in its worst case (see CAP_ALPHA in
     *              shared/theme.js), i.e. better than the old fixed bar.
     *   'plain'  — the classic near-black bar with white text, for maximum
     *              contrast over difficult footage.
     *
     * Default 'theme': the caption was the last surface in the product that did
     * not look like the product, and the themed one is not a legibility
     * trade-off. 'plain' stays a click away in the gear sheet, and the OS asking
     * for `prefers-contrast: more` selects it without any setting at all.
     */
    ytCapTheme: 'theme',
    /** Personal glossary, one per line: «term = ترجمه» or «term → ترجمه». */
    glossary: '',
    /** Free-form extra instruction appended to every translation prompt. */
    customPrompt: '',
    /** OpenAI-compatible: optional backup model tried on 404/timeout. */
    openaiFallbackModel: '',
    /**
     * Full prompt replacements (v1.8.5). Keys: tweet | generic | image |
     * summary | compose. An empty/absent value uses the built-in default; a
     * non-empty value REPLACES that base prompt (glossary/customPrompt still
     * append on top). Advanced — a broken override can degrade quality.
     */
    promptOverrides: {},

    // -------------------------------------------------------------- v2.0.0
    // Appearance. These drive EVERY surface the extension draws (popup, the
    // box on X, the page/selection cards, the YouTube panel) through the
    // shared token module in shared/theme.js.

    /** Theme preset: auto | graphite | midnight | daylight | paper. */
    uiTheme: 'auto',
    /** Accent color id: sky | violet | emerald | rose | amber | cyan. */
    uiAccent: 'sky',
    /** Spacing scale: comfortable | compact. */
    uiDensity: 'comfortable',
    /** Surface treatment: glass | solid. */
    uiSurface: 'glass',
    /** v3.7.5 composition presets + independent semantic-token overrides.
     * Null inherits the legacy geometry/surface; old settings retain their look. */
    uiPreset: 'custom',
    uiRadius: null,
    uiShadow: null,
    uiOpacity: null,
    uiBlur: null,
    uiScale: 1,
    uiTextScale: 1,
    uiTitleScale: 1,
    uiSpacingScale: 1,
    uiControlScale: 1,
    uiWeight: 400,
    uiMotion: 'auto',
    uiMotionSpeed: 1,
    uiButtonShape: 'pill',
    uiSwitchShape: 'pill',
    uiInputStyle: 'filled',
    uiPanelStyle: 'bordered',
    uiScrollbar: 'thin',
    uiCustomAccent: '',
    uiSecondaryColor: '',
    uiSuccessColor: '',
    uiWarningColor: '',
    uiErrorColor: '',
    uiBackground: '',
    uiCardColor: '',
    /** Show every explanation inline instead of behind its ⓘ button.
     *  OFF keeps the UI calm; ON is the guided/beginner mode. */
    showHints: false,
    /**
     * Never use backdrop blur on UI drawn over a page (v2.0.1). A
     * `backdrop-filter` forces the browser to read the pixels behind the
     * element, which pulls the video out of its hardware overlay plane and
     * silently switches OFF GPU video enhancement — RTX Video Super
     * Resolution, and the same class of driver-side HDR/upscaling. ON by
     * default: the visual cost is tiny, the playback cost is not. The popup
     * itself never covers a video, so it keeps its glass either way.
     */
    videoSafeUi: true,
    /**
     * Opaque mode for everything the extension draws ON a page (v2.1.0): the
     * result card, the page pill, the toast, the YouTube panel. OFF (the
     * default) keeps the translucent surface the design is built around; ON
     * makes it fully solid on the theme's deepest background — the escape
     * hatch for busy/bright sites where text behind the card fights the
     * translation. Every card and the pill carry the toggle, so it is one
     * click away exactly where the problem shows up.
     */
    cardOpaque: false,

    // ------------------------------------------------------------- v2.0.2
    // Hardware video enhancement helper. Unrelated to translation, but it is
    // the same compositing problem the extension had to solve for its own UI —
    // so the knowledge lives here now. Both OFF by default: they change how
    // OTHER sites present their video.

    /** Strip presentation blockers (rounded corners, filters, masks, blend
     *  modes, backdrop blur) from videos on every site, so the browser can keep
     *  the video on its hardware overlay plane and the GPU driver can apply
     *  RTX Video Super Resolution / HDR. Fully reversible. */
    vsrHelper: false,
    /** Also refuse VP9/AV1 so adaptive players fall back to H.264, which every
     *  GPU decodes in hardware (software decode = no video surface = no VSR).
     *  Caps such sites at 1080p; needs a page reload. */
    vsrForceH264: false,

    // ------------------------------------------------------------- v2.2.0
    // Persian text-to-speech. Two tiers, always both available and always
    // switchable: a keyless engine with no limits, and a premium one whose
    // delivery can be steered. Neither is a dead end for the other.

    /** Speech engine: 'bing' (free, keyless, unlimited — the default),
     *  'gemini' (premium, prompt-steerable, small free quota), or 'openai'
     *  (any OpenAI-compatible /audio/speech endpoint, including a local one). */
    ttsEngine: 'bing',
    /** Show the 🔊 button on translation cards. */
    ttsButton: true,
    /** v2.5.1 — offer «خواندن» in the right-click menu of EVERY site, for the
     *  selection and for the page, exactly like the two translate entries. The
     *  speech engine was already general; only its reach was not. */
    ttsAnywhere: true,
    /** Read foreign text by translating it first. Off means a non-Persian
     *  selection is spoken in its own language by the chosen voice — which is
     *  what a language learner wants and what a Persian reader does not. */
    ttsTranslateFirst: true,
    /** Speaking rate multiplier (0.5–2). Bing applies it as SSML prosody,
     *  OpenAI as `speed`; Gemini has no rate parameter and ignores it. */
    ttsRate: 1,
    /** Voice per engine — kept separately so switching engines and back does
     *  not silently discard the voice the user picked. */
    ttsVoiceBing: 'fa-IR-DilaraNeural',
    ttsVoiceGemini: 'Kore',
    ttsVoiceOpenai: 'alloy',
    /** Gemini speech model. Preview models get renamed often, so this is a
     *  plain editable value with a fallback chain behind it. */
    ttsModelGemini: 'gemini-3.1-flash-tts-preview',
    /** OpenAI-compatible speech model id — free text, because vendors rename
     *  and deprecate these constantly (gpt-4o-mini-tts was deprecated in
     *  Feb 2026) and a local server uses its own names entirely. */
    ttsModelOpenai: 'gpt-4o-mini-tts',
    /** Delivery direction for Gemini speech (tone, pace, accent). Empty uses
     *  the built-in Persian direction in prompt.js. */
    ttsStyle: '',
    /** Cache ceiling for synthesized audio, in megabytes. */
    ttsCacheMb: 250,

    // -------------------------------------------------------- v2.5.0 bridge
    // The local companion service (bridge/bridge.py). Everything about it is
    // opt-in: it is a separate program the user chooses to run.

    /** Talk to the local bridge at all. */
    bridgeEnabled: false,
    /** Loopback port it listens on. */
    bridgePort: 8765,
    /** Shared token, shown in the bridge's own window. Anything with a side
     *  effect requires it — a web page cannot read a loopback response, but it
     *  can fire a request at one. */
    bridgeToken: '',
    // ---------------------------------------------- v2.5.8 manga chapters

    /** Keep translating pages that appear later. A reader loads as you
     *  scroll, so a chapter translated on arrival is half untranslated by the
     *  time you reach the bottom without this. */
    mangaAuto: true,
    /**
     * How many pages the local pipeline works on at once.
     *
     * Measured, not guessed: a page costs ~2s of OCR, ~0.5s of inpainting and
     * ~14s WAITING on the translation model. Overlapping pages overlaps the
     * waiting — three at a time cut six pages from ~102s to ~53s here. The GPU
     * stages stay serialised by MangaTranslator's own inference locks, so this
     * trades nothing for the gain. Raise it only if your translation service
     * tolerates the parallel requests.
     */
    mangaConcurrency: 3,

    /** Use the bridge to transcribe videos that have no caption track. */
    bridgeAsr: false,
    /** Whisper model size; bigger is better and slower. */
    bridgeAsrModel: 'small',

    // ------------------------------------------------------------- v2.4.0
    // Live Persian dubbing for YouTube. Off by default — it speaks out loud
    // and turns the original audio down, which no one should get by surprise.

    /** Speak the Persian subtitle aloud over the video. */
    ytDub: false,
    /** Original audio level while the Persian voice is speaking, in percent.
     *  Not zero by default: hearing the original underneath keeps tone,
     *  music and effects, and makes a missed line obvious rather than eerie. */
    ytDubDuck: 12,
    /** 'live' renders just ahead of the playhead; 'full' renders the whole
     *  video before playback so the timing is exact from the first second. */
    ytDubMode: 'live',
    /** How far ahead of the playhead to render speech, in seconds. Must stay
     *  under ytAheadSec — a line cannot be spoken before it is translated. */
    ytDubAheadSec: 45,
    /**
     * Ceiling on how much faster a line may be read to fit its slot.
     *
     * Lowered from 1.75 in v2.4.5 after listening: past roughly 1.3 the voice
     * stops sounding like a dub and starts sounding rushed, and the engine now
     * has a better tool for tight lines — see ytDubCompress. Speeding up is
     * the LAST resort, not the first.
     */
    ytDubMaxRate: 1.3,

    /**
     * Rewrite a line SHORTER when it will not fit, instead of gabbling it.
     *
     * This is what a human dubbing writer does. Costs one small text call for
     * the minority of lines that overrun, and it is cached, so a rewatch is
     * free. Only for AI providers — the keyless machine translators cannot
     * rewrite, and those users fall back to speeding up alone.
     */
    ytDubCompress: true,
    /** Above this rate, try shortening the line before reading it faster. */
    ytDubComfortRate: 1.12,

    /**
     * Which dubbing engine to use.
     *
     *  'caption' — read the translated subtitles aloud. Free, exactly
     *              synchronized, needs the video to have captions.
     *  'live'    — stream the video's AUDIO to Gemini Live and play back the
     *              Persian it speaks. Needs no captions at all, carries tone
     *              across, costs Live API quota, and runs a few seconds behind.
     */
    ytDubEngine: 'caption',
    /** Empty = the client's own default live model. */
    ytLiveModel: '',

    /**
     * Which spoken language the live engine should translate (BCP-47 base
     * code); empty means every language it hears.
     *
     * This exists because a video often carries TWO conversations at once — an
     * anime reaction has Japanese playing under an English commentator — and
     * the model, given no instruction, dutifully translates both on top of
     * each other. There is no source-language field in the Live API, so the
     * filtering is done here: see `matchesSource` in content/dub.js.
     */
    ytLiveSourceLang: '',
    /** Original audio level during a live session, in percent. Lower than the
     *  caption path's duck because live speech is near-continuous. */
    ytLiveDuck: 10,

    /**
     * Show the Persian subtitle overlay.
     *
     * Separate from ytDub since v2.4.5: the two were entangled, so turning the
     * text off also silenced the voice. They are different outputs of the same
     * pipeline and each deserves its own switch.
     */
    ytSubtitles: true,

    /**
     * Per-model advanced tuning (v1.9.0). Keyed by model id — each model the
     * user selects gets its own entry: `{ thinkingLevel?, temperature? }`.
     * `thinkingLevel` ∈ minimal|low|medium|high (absent = the built-in "low"
     * floor; Gemini only). `temperature` ∈ 0..2 (absent = each task's own
     * default). Both feed the cache namespace, so changing them re-translates
     * only that model's cached items. See resolveModelTuning / activeModelId.
     */
    modelTuning: {},

    // ══════════════════════════════════════════════════════════ v3.0.0

    /**
     * Politeness register of the Persian output.
     *
     * Persian's رسمی/محاوره‌ای distinction is not decoration — a news bulletin
     * written in the register of a group chat reads as broken, and the reverse
     * reads as a machine. Until now the model INFERRED it from the author
     * hint, which is clever but silent and unpredictable: the same account
     * could come back formal on one post and casual on the next.
     *
     * 'auto' keeps that inference (and is still the default, because it is
     * right most of the time); 'formal' and 'casual' pin it. Per-site
     * overrides make this genuinely useful — رسمی on a government site,
     * محاوره‌ای on a timeline. Folded into the cache namespace.
     */
    register: 'auto',

    /**
     * Two-pass translation: the model reviews its own Persian for calques,
     * register drift and awkward phrasing before the text is shown.
     *
     * Costs roughly double, so it is OFF by default and deliberately scoped to
     * acts the user chose — a subtitle export, an article, a summary — never
     * to timeline scrolling. See `reviewPrompt` in background/prompt.js.
     */
    qualityMode: false,

    /** Stream long single-shot answers (summaries, page units) as they arrive
     *  instead of after the whole response. No cost change; large perceived
     *  speed change on exactly the slowest surfaces. */
    streaming: true,

    /**
     * Reuse the system prompt through Gemini's explicit context cache.
     *
     * The tweet prompt alone is ~6.6k characters and was re-sent with EVERY
     * batch. Cached content is billed at a fraction of input, and the cache is
     * keyed by prompt content, so it survives model/tuning changes cleanly.
     */
    contextCache: true,

    /**
     * Translation memory: remember the Persian chosen for a term or name and
     * reuse it everywhere.
     *
     * Consistency is the single clearest difference between amateur and
     * professional translation — «Michael» must not be مایکل here and
     * مایکائیل three posts later. It also gets CHEAPER over time: known terms
     * ship as short hints instead of being re-reasoned.
     */
    memoryEnabled: true,
    /** Terms remembered before the oldest are pruned. */
    memoryMax: 4000,

    /**
     * Per-origin setting overrides: `{ 'https://example.com': { …patch } }`.
     *
     * The answer to "55 global switches": what people actually want is «on
     * THIS site, behave this way» — bilingual on a docs site, replace-original
     * on a news site, formal register on a government site, off entirely on
     * their bank. Only the keys that differ are stored, so a profile stays
     * small and keeps inheriting everything the user changes globally later.
     */
    sitePrefs: {},

    /** Translate YouTube titles, descriptions and comments, not just the
     *  captions. Comments are the most slang-dense text on the platform and
     *  were entirely untouched. */
    ytPageText: false,

    /** Offer «افزودن به Anki» on translation cards, and collect pairs. */
    ankiExport: false,
  });

  /** Thinking levels offered in the popup (ascending effort). */
  const THINKING_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high']);

  /** Prompt ids that support a full override (see promptOverrides). */
  const PROMPT_IDS = Object.freeze(['tweet', 'generic', 'image', 'summary', 'compose', 'review']);

  /** Bundled webfonts (fonts/ folder, declared in content/fonts.css). */
  const BUNDLED_FONTS = Object.freeze([
    { id: 'Vazirmatn', get label() { return globalThis.GXT.i18n.t("shared_settings_BUNDLED_FONTS_4"); } },
    { id: 'Shabnam', get label() { return globalThis.GXT.i18n.t("shared_settings_BUNDLED_FONTS_3"); } },
    { id: 'Sahel', get label() { return globalThis.GXT.i18n.t("shared_settings_BUNDLED_FONTS_2"); } },
    { id: 'Samim', get label() { return globalThis.GXT.i18n.t("shared_settings_BUNDLED_FONTS_1"); } },
  ]);

  /**
   * Tried in order when the configured Gemini model is unavailable (404) or
   * unresponsive (timeout). The newest Flash sits first; flash-lite is the
   * fast, high-quota recovery target when a heavier model stalls. Older but
   * broadly-available models stay in the chain as last resorts.
   */
  const FALLBACK_MODELS = Object.freeze([
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-flash-latest',
    'gemini-2.5-flash',
  ]);

  /** Shown in the popup before the live list has been fetched. Newest first —
   *  Google released 3.6 Flash + 3.5 Flash-Lite on 2026-07-21 (⟳ fetches the
   *  real list your key can access). */
  const CURATED_MODELS = Object.freeze([
    { id: 'gemini-3.6-flash', get note() { return globalThis.GXT.i18n.t("shared_settings_CURATED_MODELS_7"); } },
    { id: 'gemini-3.5-flash-lite', get note() { return globalThis.GXT.i18n.t("shared_settings_CURATED_MODELS_6"); } },
    { id: 'gemini-3.5-flash', get note() { return globalThis.GXT.i18n.t("shared_settings_CURATED_MODELS_5"); } },
    { id: 'gemini-3.1-flash-lite', get note() { return globalThis.GXT.i18n.t("shared_settings_CURATED_MODELS_4"); } },
    { id: 'gemini-flash-latest', get note() { return globalThis.GXT.i18n.t("shared_settings_CURATED_MODELS_3"); } },
    { id: 'gemini-3.1-pro', get note() { return globalThis.GXT.i18n.t("shared_settings_CURATED_MODELS_2"); } },
    { id: 'gemini-2.5-flash', get note() { return globalThis.GXT.i18n.t("shared_settings_CURATED_MODELS_1"); } },
  ]);

  /**
   * Sort model ids newest-first by their version number.
   *
   * The API returns them in no useful order, and "newest" is the only ordering
   * a person actually wants when picking one. Version digits are compared
   * numerically, so 3.10 correctly outranks 3.9 — which a string sort gets
   * backwards, and which stops being hypothetical the moment Google ships it.
   */
  function modelRank(id) {
    const match = /(\d+)\.(\d+)/.exec(String(id) || '');
    if (!match) return -1;
    return Number(match[1]) * 1000 + Number(match[2]);
  }

  function byNewest(a, b) {
    const diff = modelRank(b.id) - modelRank(a.id);
    return diff || String(a.id).localeCompare(String(b.id));
  }

  /**
   * Split one discovered Gemini model list into the three lists the interface
   * actually offers: translation, speech, and live dubbing.
   *
   * v2.5.1. `/models` has always returned all of them together — the old code
   * simply threw the speech and live entries away, which is why every engine
   * except translation needed a hand-edited list, and why a new speech model
   * could not appear without someone editing this file. The classification
   * follows the API's OWN metadata (`supportedGenerationMethods`) wherever it
   * can, and falls back to the naming Google has used consistently, so a model
   * released tomorrow lands in the right list without being known here.
   *
   * @param {Array<{id: string, displayName?: string, methods?: string[]}>} models
   * @returns {{text: Array, tts: Array, live: Array}}
   */
  function classifyModels(models) {
    const text = [];
    const tts = [];
    const live = [];
    for (const model of models || []) {
      const id = String(model?.id || '');
      if (!id) continue;
      const methods = model.methods || [];
      // Not translation models in any sense, and offering them would only
      // produce confusing failures.
      if (/embedding|aqa|imagen|veo|image-generation|transcribe/i.test(id)) continue;
      if (methods.includes('bidiGenerateContent') || (!methods.length && /\blive\b|-live-/i.test(id) && !/transcribe/i.test(id))) {
        live.push(model);
      } else if (/tts/i.test(id)) {
        tts.push(model);
      } else if (!methods.length || methods.includes('generateContent')) {
        text.push(model);
      }
    }
    return { text: text.sort(byNewest), tts: tts.sort(byNewest), live: live.sort(byNewest) };
  }

  /** The same job for an OpenAI-compatible server, which reports nothing but
   *  ids — so the split can only be by name, and anything unrecognised stays
   *  available as a text model rather than disappearing. */
  function classifyOpenaiModels(models) {
    const speech = [];
    const text = [];
    for (const model of models || []) {
      const id = String(model?.id || '');
      if (!id) continue;
      if (/tts|speech|voice|audio-preview/i.test(id)) speech.push(model);
      else if (!/embedding|whisper|moderation|dall-e|image/i.test(id)) text.push(model);
    }
    return { text, speech };
  }

  /**
   * Known Google free-tier daily request limits (RPD), per model, so the
   * usage bar can be drawn automatically with no user input. These are
   * published defaults that Google adjusts over time; whenever the API
   * returns a real "daily quota exceeded" error we parse the true number
   * out of it and that learned value takes precedence (see service-worker).
   */
  const MODEL_DAILY_LIMITS = Object.freeze({
    'gemini-3.6-flash': 1500,
    'gemini-3.5-flash-lite': 1500,
    'gemini-3.5-flash': 1500,
    'gemini-3-flash': 1500,
    'gemini-flash-latest': 1500,
    'gemini-3.1-flash-lite': 1500,
    'gemini-2.5-flash': 250,
    'gemini-2.5-flash-lite': 1000,
    'gemini-2.5-pro': 50,
    'gemini-3.1-pro': 100,
  });

  /** Best-effort free-tier RPD for a model id (0 = unknown). PER PROJECT — see
   *  quotaSummary, which is where that distinction actually bites. */
  function defaultDailyLimit(model) {
    if (!model) return 0;
    if (MODEL_DAILY_LIMITS[model]) return MODEL_DAILY_LIMITS[model];
    if (/pro/i.test(model)) return 100;
    if (/lite/i.test(model)) return 1000;
    if (/flash/i.test(model)) return 1500;
    return 0;
  }

  // ------------------------------------------------------- quota (v2.5.5)
  //
  // WHAT WENT WRONG, because the shape of the fix follows directly from it:
  //
  // The usage bar divided a FLEET-WIDE numerator by a SINGLE-KEY denominator.
  // `dayApiCalls` counted every Gemini request made today across every key,
  // while the denominator was `defaultDailyLimit(model)` — the cap Google
  // applies to ONE project. With a dozen keys that bar is arithmetically
  // guaranteed to read "over quota" long before anything is exhausted: 1800
  // calls against a 1500 ceiling, painted red, while translation carries on
  // perfectly because eleven keys still have room.
  //
  // So the unit of accounting is now THE KEY, not the profile:
  //
  //  * usage is recorded per key, at the moment that key serves a request;
  //  * a key's cap is MEASURED where possible — when Google answers a daily
  //    quota 429 it is telling us exactly what that key's ceiling was, and
  //    that beats any table shipped in this file;
  //  * "exhausted" is ground truth, never a guess: it means Google refused
  //    that key for the day and the extension parked it until the reset.
  //
  // Which leaves one honest unknown: keys belonging to the SAME Google
  // project share a single quota, and nothing the client can see reveals the
  // grouping. So the fleet ceiling is an upper bound, reported as such, and
  // narrowed by measurement as keys actually hit their limits.

  /** Per-key state after a day of use. `limit` is 0 until measured. */
  const emptyKeyUsage = () => ({ calls: 0, exhausted: false, limit: 0, lastAt: 0 });

  /**
   * Everything the stats tab needs about quota, computed from facts.
   *
   * Pure on purpose — this is the piece that was wrong, so it is the piece
   * that gets tested directly rather than through the UI.
   *
   * @param {{keys?: string[], usage?: object, model?: string, override?: number}} input
   *   `keys`     the configured API keys, in order
   *   `usage`    `{ [key]: {calls, exhausted, limit} }` recorded today
   *   `model`    the active model id, for the published per-project cap
   *   `override` the user's manual daily cap, PER KEY, 0 = automatic
   * @returns {{
   *   perKey: Array<{key, calls, limit, exhausted, pct, measured}>,
   *   used: number, limit: number, pct: number,
   *   keyCount: number, exhaustedCount: number, activeCount: number,
   *   state: 'ok'|'warn'|'exhausted', limitSource: 'override'|'measured'|'default'|'none',
   *   measuredKeys: number, sharedProjectRisk: boolean
   * }}
   */
  function quotaSummary({ keys = [], usage = {}, model = '', override = 0 } = {}) {
    const published = defaultDailyLimit(model);
    const manual = Number(override) > 0 ? Number(override) : 0;

    const perKey = keys.map((key) => {
      const record = { ...emptyKeyUsage(), ...(usage[key] || {}) };
      const calls = Math.max(0, Number(record.calls) || 0);
      // A cap the API itself taught us about THIS key wins over the table:
      // a paid project, a different tier or a model we guessed wrong about
      // are all invisible from here and all reported truthfully by a 429.
      const measured = Number(record.limit) > 0 ? Number(record.limit) : 0;
      const limit = manual || measured || published;
      return {
        key,
        calls,
        limit,
        measured: !!measured,
        exhausted: !!record.exhausted,
        // An exhausted key is at 100% whatever the arithmetic says: Google
        // has refused it, and showing 62% next to "exhausted" is nonsense.
        pct: record.exhausted ? 100 : limit > 0 ? Math.min(100, Math.round((calls / limit) * 100)) : 0,
      };
    });

    const used = perKey.reduce((sum, entry) => sum + entry.calls, 0);
    const limit = perKey.reduce((sum, entry) => sum + entry.limit, 0);
    const exhaustedCount = perKey.filter((entry) => entry.exhausted).length;
    const measuredKeys = perKey.filter((entry) => entry.measured).length;
    const keyCount = keys.length;
    const activeCount = keyCount - exhaustedCount;

    // The traffic light is driven by what is KNOWN, not by a ratio of two
    // estimates. Red only when every key really has been refused — that is
    // the only moment translation actually stops.
    const state =
      keyCount > 0 && exhaustedCount >= keyCount
        ? 'exhausted'
        : exhaustedCount > 0 || (limit > 0 && used / limit >= 0.85)
          ? 'warn'
          : 'ok';

    return {
      perKey,
      used,
      limit,
      pct: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
      keyCount,
      exhaustedCount,
      activeCount,
      state,
      limitSource: manual ? 'override' : measuredKeys ? 'measured' : published ? 'default' : 'none',
      measuredKeys,
      // Two or more keys MIGHT sit in one Google project and share one quota,
      // which no client-side signal can reveal. Said out loud rather than
      // quietly pretending the ceiling is exact.
      sharedProjectRisk: keyCount > 1 && measuredKeys < keyCount,
    };
  }

  // ------------------------------------------------------ secrets (v2.7.0)
  //
  // Diagnostics are rendered into the PAGE's own DOM — the box on X, the card
  // on any site — and a page can read its own DOM. Until this existed, every
  // attempts log carried the full Gemini key, so any site that could make one
  // translation fail could read every key the user owned. The fix is not to
  // hide the diagnostics (they are the point) but to make the identifier in
  // them not be the credential.
  //
  // The popup is the extension's OWN origin and keeps showing full keys.

  /** Shapes that are credentials, not identifiers: Google AI and OpenAI keys. */
  const KEYISH_RE = /AIza[0-9A-Za-z_-]{20,}|\bsk-[A-Za-z0-9_-]{16,}/g;

  /** Enough of a key to tell it apart from the others in a list — the whole
   *  job an attempts log needs it for — and not enough to use. */
  function maskKey(key) {
    const s = String(key || '');
    if (!s) return '';
    if (s.length <= 12) return `${s.slice(0, 2)}…${s.slice(-2)}`;
    return `${s.slice(0, 6)}…${s.slice(-4)}`;
  }

  /** Redact key-shaped substrings from free text. Providers do echo the
   *  offending key back in error messages; their habits must not become our
   *  leak, so every string that leaves for a content script goes through this. */
  const scrubSecrets = (text) => String(text ?? '').replace(KEYISH_RE, (m) => maskKey(m));

  // --------------------------------------------------------------- v2.2.0
  // Speech. Verified against the live services on 2026-07-28.

  /**
   * Bing read-aloud voices. Azure has exactly TWO Persian neural voices —
   * anything else (fa-IR-SaraNeural and friends) is rejected with a 500. The
   * multilingual voices below DO answer with Persian text and are offered as
   * an experiment, not a recommendation: Persian is not on their official
   * language list, so judge them by ear before trusting one.
   */
  const TTS_BING_VOICES = Object.freeze([
    { id: 'fa-IR-DilaraNeural', get label() { return globalThis.GXT.i18n.t("shared_settings_TTS_BING_VOICES_5"); } },
    { id: 'fa-IR-FaridNeural', get label() { return globalThis.GXT.i18n.t("shared_settings_TTS_BING_VOICES_4"); } },
    { id: 'en-US-AvaMultilingualNeural', get label() { return globalThis.GXT.i18n.t("shared_settings_TTS_BING_VOICES_3"); } },
    { id: 'en-US-AndrewMultilingualNeural', get label() { return globalThis.GXT.i18n.t("shared_settings_TTS_BING_VOICES_2"); } },
    { id: 'de-DE-SeraphinaMultilingualNeural', get label() { return globalThis.GXT.i18n.t("shared_settings_TTS_BING_VOICES_1"); } },
  ]);

  /** The 30 prebuilt Gemini speech voices. The first few are the ones that
   *  read Persian most naturally in testing; the rest are offered in full so
   *  the choice is never limited by our shortlist. */
  const TTS_GEMINI_VOICES = Object.freeze([
    'Kore', 'Puck', 'Charon', 'Aoede', 'Leda', 'Zephyr', 'Fenrir', 'Orus',
    'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
    'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
    'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
    'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
  ]);

  /** Curated Gemini speech models, newest first. */
  const TTS_GEMINI_MODELS = Object.freeze([
    { id: 'gemini-3.1-flash-tts-preview', get note() { return globalThis.GXT.i18n.t("shared_settings_TTS_GEMINI_MODELS_3"); } },
    { id: 'gemini-2.5-flash-preview-tts', get note() { return globalThis.GXT.i18n.t("shared_settings_TTS_GEMINI_MODELS_2"); } },
    { id: 'gemini-2.5-pro-preview-tts', get note() { return globalThis.GXT.i18n.t("shared_settings_TTS_GEMINI_MODELS_1"); } },
  ]);

  /**
   * Fallback chain for speech ONLY. The text chain must never be used here:
   * a text model rejects `responseModalities: ["AUDIO"]` outright, so falling
   * into it would turn a recoverable "model renamed" 404 into a hard error.
   * Preview model ids are renamed often — this is the safety net for that.
   */
  const TTS_FALLBACK_MODELS = Object.freeze([
    'gemini-3.1-flash-tts-preview',
    'gemini-2.5-flash-preview-tts',
  ]);

  /** Common OpenAI voice names. The field stays free-text: a local server
   *  (openedai-speech, Kokoro, Piper bridges) uses entirely its own names. */
  const TTS_OPENAI_VOICES = Object.freeze([
    'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse',
  ]);

  /** Engines offered in the popup. */
  const TTS_ENGINES = Object.freeze([
    { id: 'bing', get label() { return globalThis.GXT.i18n.t("shared_settings_TTS_ENGINES_8"); }, get note() { return globalThis.GXT.i18n.t("shared_settings_TTS_ENGINES_7"); } },
    { id: 'gemini', get label() { return globalThis.GXT.i18n.t("shared_settings_TTS_ENGINES_6"); }, get note() { return globalThis.GXT.i18n.t("shared_settings_TTS_ENGINES_5"); } },
    { id: 'openai', get label() { return globalThis.GXT.i18n.t("shared_settings_TTS_ENGINES_4"); }, get note() { return globalThis.GXT.i18n.t("shared_settings_TTS_ENGINES_3"); } },
    { id: 'bridge', get label() { return globalThis.GXT.i18n.t("shared_settings_TTS_ENGINES_2"); }, get note() { return globalThis.GXT.i18n.t("shared_settings_TTS_ENGINES_1"); } },
  ]);

  /** The voice setting key for an engine. */
  function ttsVoiceKey(engine) {
    if (engine === 'gemini') return 'ttsVoiceGemini';
    if (engine === 'openai') return 'ttsVoiceOpenai';
    // The bridge drives the SAME Microsoft voices from Python, so it shares
    // Bing's voice setting: switching engines must not silently change who is
    // speaking.
    return 'ttsVoiceBing';
  }

  /**
   * Everything the TTS layer needs for the active engine, normalized:
   * `{ engine, voice, rate, style, model }`. Keeping this in one place means
   * the worker, the cache key and the popup can never disagree about which
   * voice is actually in use.
   */
  function resolveTts(settings) {
    const s = settings || {};
    const engine = ['bing', 'gemini', 'openai', 'bridge'].includes(s.ttsEngine) ? s.ttsEngine : 'bing';
    const rawRate = Number(s.ttsRate);
    const rate = Number.isFinite(rawRate) && rawRate > 0 ? Math.max(0.5, Math.min(2, rawRate)) : 1;
    const voice = (s[ttsVoiceKey(engine)] || DEFAULTS[ttsVoiceKey(engine)] || '').trim();
    const model =
      engine === 'gemini' ? (s.ttsModelGemini || DEFAULTS.ttsModelGemini).trim()
      : engine === 'openai' ? (s.ttsModelOpenai || '').trim()
      : '';
    return { engine, voice, rate, model, style: (s.ttsStyle || '').trim() };
  }

  /** Common OpenAI-compatible endpoints, offered as suggestions. */
  const OPENAI_PRESETS = Object.freeze([
    'https://openrouter.ai/api/v1',
    'https://api.openai.com/v1',
    'https://api.deepseek.com/v1',
    'https://api.groq.com/openai/v1',
    'https://api.x.ai/v1',
    'http://localhost:11434/v1',
    'http://localhost:1234/v1',
  ]);


  // Content languages are independent of the two supported interface languages.
  const TARGET_LANGUAGES = 'af am ar az be bg bn bs ca cs cy da de el en eo es et eu fa fi fil fr ga gl gu he hi hr hu hy id is it ja ka kk km kn ko ku ky la lo lt lv mk ml mn mr ms mt my ne nl no pa pl ps pt ro ru sd si sk sl so sq sr su sv sw ta te tg th tk tr uk ur uz vi yi zh zu zh-CN zh-TW pt-BR'.split(' ');
  function validTarget(value) {
    if(typeof value !== 'string' || !/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(value) || value.length>35) return false;
    try { Intl.getCanonicalLocales(value);return true; } catch {return false;}
  }
  function forScope(settings,scope) {const value=settings?.[scope+'TargetLang'];return {...settings,targetLang:validTarget(value)?value:settings?.targetLang||'fa'};}
  function targetName(value='fa',display='en') {
    const code=validTarget(value)?value:'fa';
    if(code==='fa'&&display==='en')return 'Iranian Persian';
    try {return new Intl.DisplayNames([display],{type:'language'}).of(code)||code;}catch{return code;}
  }
  function targetDirection(value='fa') {
    try {const locale=new Intl.Locale(value);return (locale.getTextInfo?.()||locale.textInfo)?.direction || (/^(ar|fa|he|ur|ps|sd|yi|dv)(-|$)/.test(value)?'rtl':'ltr');}catch{return 'ltr';}
  }
  function targetInput(input,inherit=false) {
    if(!input)return;
    const doc=input.ownerDocument,root=input.getRootNode();let list=root.querySelector('#gxt-target-languages');
    if(!list){list=doc.createElement('datalist');list.id='gxt-target-languages';
      for(const code of TARGET_LANGUAGES){const option=doc.createElement('option');option.value=code;option.label=targetName(code,globalThis.GXT.i18n.language());list.append(option);}
      (root.body||root).append(list);
    }
    input.setAttribute('list',list.id);input.setAttribute('dir','ltr');input.setAttribute('maxlength','35');
    globalThis.GXT.i18n.bind(input,'placeholder',()=>globalThis.GXT.i18n.t(inherit?'target.inheritHint':'target.codeHint'));
    input.addEventListener('input',()=>input.setCustomValidity((inherit&&input.value==='inherit')||validTarget(input.value)?'':globalThis.GXT.i18n.t('target.invalid')));
  }

  const storage = () => chrome.storage.local;

  function normalizeSettings(stored) {
    const raw = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : null;
    // A settings record without localeVersion predates 3.7.7. Resolve migration
    // on read; the existing serialized writer persists it with the next change.
    // Never write from a read: that could overwrite a concurrent settings edit.
    const legacy = raw && raw.localeVersion == null;
    const result = { ...DEFAULTS, ...(legacy ? {
      uiLanguage:'fa', regionLocale:'fa-IR', calendar:'persian',
      numberingSystem:'arabext', hourCycle:'h23', timeZone:'Asia/Tehran',weekStart:'sat'
    } : {}), ...raw, localeVersion:1 };
    for (const key of ['uiLanguage','regionLocale','calendar','numberingSystem','hourCycle','timeZone','weekStart','targetLang','ytTargetLang','xTargetLang','pageTargetLang','imageTargetLang','summaryTargetLang','webTargetLang','fileTargetLang','mangaTargetLang','composeTargetLang','translationRegion']) {
      if (!isSettingValue(key,result[key])) result[key] = DEFAULTS[key];
    }
    return result;
  }

  async function getSettings() {
    const raw = await storage().get(SETTINGS_KEY);
    const result = normalizeSettings(raw[SETTINGS_KEY]);
    globalThis.GXT.i18n?.configure(result);
    return result;
  }

  /**
   * All settings writes are serialized (v2.4.5).
   *
   * Every write is a read-modify-write of one storage key, so two of them
   * started in the same tick both read the ORIGINAL value and the second one
   * silently discards the first. Flipping «دوبله» and «نمایش متن زیرنویس» in
   * quick succession did exactly that — one of the two would not stick, with
   * nothing to see but a checkbox that appeared to undo itself.
   *
   * The same class of bug was fixed for `modelTuning` in v1.9.0 with a local
   * queue; it belongs here instead, where it protects every caller and every
   * pair of settings rather than the one that happened to be noticed.
   */
  let writeQueue = Promise.resolve();

  // Every real document context (popup and isolated content scripts) writes
  // through the worker's one queue. A queue in each tab cannot prevent two
  // tabs from reading and overwriting the same old settings object.
  const useWorkerMutations = () => typeof document !== 'undefined'
    && chrome.runtime?.getURL?.('').startsWith('chrome-extension://');

  async function requestSettingsMutation(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) {
      const error = new Error(result?.error || globalThis.GXT.i18n.t("shared_settings_error_1"));
      error.code = result?.code || 'SETTINGS_FAILED';
      throw error;
    }
  }

  function isSettingValue(name, value) {
    if (!Object.hasOwn(DEFAULTS, name)) return false;
    const choices = {
      translationRegion:['iran','source'],
      uiLanguage:['auto','fa','en'], regionLocale:['auto','fa-IR','en-US','en-GB'],
      calendar:['auto','persian','gregory'], numberingSystem:['auto','arabext','latn'],
      hourCycle:['auto','h12','h23'],weekStart:['auto','sat','sun','mon']
    };
    if (['xTargetLang','pageTargetLang','imageTargetLang','summaryTargetLang','webTargetLang','fileTargetLang','mangaTargetLang','composeTargetLang'].includes(name)) return value==='inherit'||validTarget(value);
    if (['targetLang','ytTargetLang'].includes(name)) return validTarget(value);
    if (choices[name]) return choices[name].includes(value);
    if (name === 'localeVersion') return value === 1;
    if (name === 'timeZone') {
      if(value === 'auto') return true;
      if(typeof value !== 'string' || value.length > 100) return false;
      try { new Intl.DateTimeFormat('en',{timeZone:value}); return true; } catch { return false; }
    }
    const expected = DEFAULTS[name];
    if (expected === null && ['uiRadius', 'uiShadow', 'uiOpacity', 'uiBlur'].includes(name)) return value === null || (typeof value === 'number' && Number.isFinite(value));
    if (Array.isArray(expected)) return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
    if (value === null || typeof value !== typeof expected) return false;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof expected === 'object' && Array.isArray(value)) return false;
    if (name === 'promptOverrides') return Object.values(value).every((entry) => typeof entry === 'string');
    return true;
  }

  function setSettings(patch) {
    if (useWorkerMutations()) return requestSettingsMutation({ type: 'SETTINGS_PATCH', patch });
    return setSettings0(() => patch);
  }

  /**
   * The same serialized write, but the patch is COMPUTED from the current
   * value inside the queue (v3.0.0).
   *
   * `setSettings({sitePrefs})` cannot be used to edit one entry of a map: the
   * caller would have to read `sitePrefs`, modify it, and write it back, and
   * that read happens outside the queue — so two profile edits in the same
   * tick lose one, which is exactly the lost-update bug this queue was built
   * for in v2.4.5. Passing a FUNCTION moves the read inside the lock.
   */
  function setSettings0(compute, { replace = false } = {}) {
    const result = writeQueue
      .then(async () => {
        const current = await getSettings();
        const patch = (await compute(current)) || {};
        await storage().set({ [SETTINGS_KEY]: replace ? patch : { ...current, ...patch } });
      });
      // One failed write (quota, closing context) must not wedge the queue for
      // every write after it.
    writeQueue = result.catch(() => {});
    return result;
  }

  // ═══════════════════════════════════ translation memory storage (v3.0.0)
  //
  // The persistence half only. What counts as a term, how a hint is built and
  // how a match is scored live in shared/memory.js, so this file keeps being
  // "everything that is stored" and nothing else.

  async function migrateLocaleInstall(reason) {
    if(reason !== 'update') return;
    return setSettings0(async current => {
      const raw=(await storage().get(SETTINGS_KEY))[SETTINGS_KEY];
      if(raw?.localeVersion != null) return {};
      const migrated=normalizeSettings(raw || {});
      return Object.fromEntries(['uiLanguage','localeVersion','regionLocale','calendar','numberingSystem','hourCycle','weekStart','timeZone'].map(key=>[key,migrated[key]]));
    });
  }

  const MEMORY_KEY = 'transMemory';

  /** `{ terms: { [sourceLower]: {s, t, n, at} }, count }` — `s` keeps the
   *  original casing, `t` the Persian, `n` how often it has been confirmed. */
  const emptyMemory = () => ({ terms: {}, count: 0 });

  async function getMemory() {
    const raw = await storage().get(MEMORY_KEY);
    const value = raw[MEMORY_KEY];
    return value && typeof value === 'object' && value.terms ? value : emptyMemory();
  }

  /** Serialized like the settings write, and for the same reason: several
   *  translations finishing at once each want to add what they learned. */
  let memoryQueue = Promise.resolve();
  let memoryGeneration = 0;

  function updateMemory(compute, { generation } = {}) {
    const result = memoryQueue
      .then(async () => {
        const current = await getMemory();
        if (generation !== undefined && generation !== memoryGeneration) return current;
        const next = (await compute(current)) || current;
        next.count = Object.keys(next.terms).length;
        await storage().set({ [MEMORY_KEY]: next });
        return next;
      });
    // Repair the queue without converting a failed user operation into success.
    memoryQueue = result.catch(() => {});
    return result;
  }

  async function clearMemory() {
    memoryGeneration += 1;
    await updateMemory(() => emptyMemory());
  }

  /** Fold a backup's memory into the live one. Returns how many terms the
   *  memory holds afterwards. */
  async function mergeMemory(incoming, mode = 'merge') {
    const next = await updateMemory((current) => {
      const base = mode === 'replace' ? emptyMemory() : current;
      const terms = { ...base.terms };
      for (const [key, entry] of Object.entries(incoming.terms || {})) {
        if (!entry || typeof entry !== 'object' || !entry.t) continue;
        const existing = terms[key];
        // A term confirmed more often wins; ties go to the more recent.
        if (existing?.pinned && !entry.pinned) continue;
        if (!existing || (entry.pinned && !existing.pinned) ||
            (entry.n || 1) > (existing.n || 1) ||
            ((entry.n || 1) === (existing.n || 1) && (entry.at || 0) > (existing.at || 0))) {
          terms[key] = {
            s: String(entry.s || key), t: String(entry.t), n: entry.n || 1, at: entry.at || 0,
            ...(entry.pinned ? { pinned: true } : {}),
          };
        }
      }
      return { ...base, terms };
    });
    return next.count;
  }

  /** @returns {Promise<string[]>} Gemini API keys (legacy single key migrates). */
  async function getApiKeys() {
    const raw = await storage().get([API_KEYS_KEY, LEGACY_API_KEY_KEY]);
    const list = Array.isArray(raw[API_KEYS_KEY]) ? raw[API_KEYS_KEY] : null;
    if (list) return list.filter(Boolean);
    const legacy = (raw[LEGACY_API_KEY_KEY] || '').trim();
    return legacy ? [legacy] : [];
  }

  async function setApiKeys(keys) {
    const clean = [...new Set((keys || []).map((k) => String(k).trim()).filter(Boolean))];
    await storage().set({ [API_KEYS_KEY]: clean });
  }

  async function getOpenaiKey() {
    const raw = await storage().get(OPENAI_KEY_KEY);
    return raw[OPENAI_KEY_KEY] || '';
  }

  async function setOpenaiKey(key) {
    await storage().set({ [OPENAI_KEY_KEY]: (key || '').trim() });
  }

  /** Identifier of the active provider+model — the cache-key namespace. */
  function modelCacheId(settings) {
    if (settings.provider === 'openai') {
      return `openai:${settings.openaiBaseUrl}:${settings.openaiModel}`;
    }
    // Machine-translation engines always target Persian; the engine name is
    // the whole namespace.
    if (settings.provider === 'google') return 'google:fa';
    if (settings.provider === 'bing') return 'bing:fa';
    return `gemini:${settings.model}`;
  }

  /** The model id the per-model tuning applies to, for the active provider.
   *  Gemini → its model; OpenAI → its model; keyless MT engines → '' (none). */
  function activeModelId(settings) {
    if (settings.provider === 'openai') return (settings.openaiModel || '').trim();
    if (settings.provider === 'google' || settings.provider === 'bing') return '';
    return (settings.model || '').trim();
  }

  /**
   * Resolve a model's advanced tuning to `{ thinkingLevel, temperature }` with
   * invalid/absent values normalized to null (= use defaults). `temperature`
   * is clamped to a sane 0..2; `thinkingLevel` must be a known level.
   */
  function resolveModelTuning(settings, modelId) {
    const map =
      settings && settings.modelTuning && typeof settings.modelTuning === 'object'
        ? settings.modelTuning
        : {};
    const entry = (modelId && map[modelId]) || {};
    const level = THINKING_LEVELS.includes(entry.thinkingLevel) ? entry.thinkingLevel : null;
    const t = entry.temperature;
    const temperature = typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= 2 ? t : null;
    return { thinkingLevel: level, temperature };
  }

  /**
   * Short stable hash of everything that reshapes the prompt or the model's
   * output: glossary + custom instruction + full prompt overrides + the active
   * model's advanced tuning (thinking level, temperature). Empty string when
   * all are unset, so users who change nothing keep their existing cache
   * untouched; changing any of them re-namespaces (and thus re-translates).
   */
  function promptExtrasHash(settings) {
    const ov =
      settings.promptOverrides && typeof settings.promptOverrides === 'object'
        ? settings.promptOverrides
        : {};
    const tuning = resolveModelTuning(settings, activeModelId(settings));
    const parts = [
      (settings.glossary || '').trim(),
      (settings.customPrompt || '').trim(),
      ...PROMPT_IDS.map((k) => (ov[k] || '').trim()),
      tuning.thinkingLevel || '',
      tuning.temperature == null ? '' : `t${tuning.temperature}`,
      // v3.0.0 — both change the Persian that comes back, so a cached entry
      // from the other setting must not be served. 'auto' and false are the
      // shipped defaults and hash to nothing, so existing caches survive.
      settings.register && settings.register !== 'auto' ? `r${settings.register}` : '',
      settings.qualityMode ? 'q2' : '',
    ];
    if (!parts.some(Boolean)) return '';
    const s = parts.join('\u0001');
    let h = 5381;
    for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /** Cache namespace = provider+model, plus the personalization hash when a
   *  glossary/custom instruction is set (they change the output). */
  function cacheNamespace(settings) {
    const extras = promptExtrasHash(settings);
    const base = modelCacheId(settings) + (settings.targetLang && settings.targetLang !== 'fa' ? ':target='+settings.targetLang : '') + (settings.translationRegion === 'source' ? ':dates=source' : '');
    return extras ? `${base}#x${extras}` : base;
  }

  /** Effective YouTube settings only; file/page prompts keep their own scope. */
  function youtubeSettings(settings = {}) {
    const out = { ...settings };
    if (['gemini', 'openai', 'google', 'bing'].includes(settings.ytProvider)) out.provider = settings.ytProvider;
    const model = typeof settings.ytModel === 'string' ? settings.ytModel.trim() : '';
    if (model && out.provider === 'gemini') out.model = model;
    if (model && out.provider === 'openai') out.openaiModel = model;
    out.ytTargetLang = validTarget(settings.ytTargetLang) ? settings.ytTargetLang : 'fa';
    return out;
  }

  function youtubeTranslationKey(settings = {}) {
    const effective = youtubeSettings(settings);
    return JSON.stringify([cacheNamespace(effective), effective.ytTargetLang, effective.openaiFallbackModel || '', settings.ytSentenceMerge === true]);
  }

  /** Serialized per-site switch shared by popup and player controls. */
  function setWebVideoSiteBlocked(hostname, blocked) {
    const host = String(hostname || '').trim().toLowerCase();
    if (!host || host.length>253 || !/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.')) return Promise.reject(new Error(globalThis.GXT.i18n.t("shared_settings_setWebVideoSiteBlocked_1")));
    if (useWorkerMutations()) return requestSettingsMutation({type:'WEB_VIDEO_SITE',hostname:host,blocked:!!blocked});
    return setSettings0(current => {
      const sites = Array.isArray(current.webVideoBlockedSites) ? current.webVideoBlockedSites : [];
      const list = sites.filter(s=>s!==host);
      if (blocked) list.push(host);
      const patch = {webVideoBlockedSites:list};
      if (!blocked && current.webVideoSiteMode==='allowlist') {
        patch.webVideoAllowedSites = [...new Set([...(Array.isArray(current.webVideoAllowedSites)?current.webVideoAllowedSites:[]),host])];
      }
      return patch;
    });
  }

  // ══════════════════════════════════════════ per-site profiles (v3.0.0)

  /** Politeness registers offered in the UI, with what each instructs. */
  const REGISTERS = Object.freeze([
    { id: 'auto', get label() { return globalThis.GXT.i18n.t("shared_settings_REGISTERS_3"); } },
    { id: 'formal', get label() { return globalThis.GXT.i18n.t("shared_settings_REGISTERS_2"); } },
    { id: 'casual', get label() { return globalThis.GXT.i18n.t("shared_settings_REGISTERS_1"); } },
  ]);

  /**
   * Settings that may be overridden per site.
   *
   * An allow-list, not "anything": a per-site override of the API key or the
   * provider would be a support nightmare and a security surprise, and a
   * per-site THEME would make the product feel broken. These are the ones that
   * describe how a PAGE should be treated.
   */
  const SITE_KEYS = Object.freeze([
    'enabled',
    'register',
    'qualityMode',
    'pageBlockMode',
    'pageBilingual',
    'pageDynamic',
    'pageAttrs',
    'pageFrames',
    'replaceOriginal',
    'selectionButton',
    'cardOpaque',
    'ttsTranslateFirst',
  ]);

  /** `https://example.com` for a page the extension can hold a profile for. */
  function originOf(url) {
    try {
      const parsed = new URL(String(url || ''));
      return /^https?:$/.test(parsed.protocol) ? parsed.origin : '';
    } catch {
      return '';
    }
  }

  /**
   * Apply a site's profile on top of the global settings.
   *
   * Only the allow-listed keys are taken, so a profile written by an older (or
   * newer) version cannot smuggle in a setting this build does not expect —
   * and a key the user has not overridden keeps INHERITING the global value,
   * which is what makes a profile stay small and stay correct as they change
   * their mind globally later.
   */
  function settingsForOrigin(settings, origin) {
    const key = originOf(origin) || String(origin || '');
    const prefs = settings?.sitePrefs;
    const patch = key && prefs && typeof prefs === 'object' ? prefs[key] : null;
    if (!patch || typeof patch !== 'object') return settings;
    const out = { ...settings };
    for (const name of SITE_KEYS) {
      if (name in patch) out[name] = patch[name];
    }
    return out;
  }

  /** Write (or clear) one key of a site's profile. Passing `undefined` removes
   *  the override so the site goes back to inheriting the global value. */
  function setSiteSetting(origin, name, value) {
    const key = originOf(origin);
    if (!key || !SITE_KEYS.includes(name)) return Promise.resolve();
    if (useWorkerMutations()) return requestSettingsMutation({ type: 'SITE_SETTING', origin: key, name, value });
    return setSettings0((current) => {
      const prefs = { ...(current.sitePrefs || {}) };
      const entry = { ...(prefs[key] || {}) };
      if (value === undefined) delete entry[name];
      else entry[name] = value;
      if (Object.keys(entry).length) prefs[key] = entry;
      else delete prefs[key];
      return { sitePrefs: prefs };
    });
  }

  /** Drop a whole site profile. */
  function clearSitePrefs(origin) {
    const key = originOf(origin);
    if (!key) return Promise.resolve();
    if (useWorkerMutations()) return requestSettingsMutation({ type: 'SITE_CLEAR', origin: key });
    return setSettings0((current) => {
      const prefs = { ...(current.sitePrefs || {}) };
      delete prefs[key];
      return { sitePrefs: prefs };
    });
  }

  // ═══════════════════════════════════════ backup / restore (v3.0.0)

  /**
   * Everything a user would be devastated to lose, in one object.
   *
   * WHY THIS EXISTS: twelve API keys, a glossary, five prompt overrides,
   * per-model tuning and a translation memory all lived in one Chrome
   * profile's local storage with NO export path. A profile reset, a reinstall
   * or a new machine lost all of it, unrecoverably. That was the only
   * irreversible failure mode in the product.
   *
   * Keys are opt-in (`includeKeys`) so the ordinary export is a file that can
   * be emailed or synced without handing over credentials — the safe thing has
   * to be the easy thing.
   */
  const BACKUP_FORMAT = 'tarjoman-backup';
  const BACKUP_VERSION = 1;

  async function exportBackup({ includeKeys = false, includeMemory = true } = {}) {
    const [settings, keys, openaiKey, extra] = await Promise.all([
      getSettings(),
      includeKeys ? getApiKeys() : Promise.resolve([]),
      includeKeys ? getOpenaiKey() : Promise.resolve(''),
      storage().get([MEMORY_KEY, KEY_USAGE_KEY, STATS_KEY]),
    ]);
    // The defaults are not data: storing only what DIFFERS keeps a backup
    // readable, small, and — the real reason — forward-compatible, because a
    // setting this build has never heard of is simply not mentioned.
    const changed = {};
    for (const [name, value] of Object.entries(settings)) {
      if (name === 'localeVersion') { changed[name] = 1; continue; }
      if (name === 'bridgeToken' && !includeKeys) continue;
      if (JSON.stringify(value) !== JSON.stringify(DEFAULTS[name])) changed[name] = value;
    }
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      savedAt: new Date().toISOString(),
      appVersion: (() => {
        try {
          return chrome.runtime.getManifest().version;
        } catch {
          return '';
        }
      })(),
      settings: changed,
      apiKeys: includeKeys ? keys : [],
      openaiKey: includeKeys ? openaiKey : '',
      memory: includeMemory ? extra[MEMORY_KEY] || null : null,
      stats: extra[STATS_KEY] || null,
    };
  }

  /**
   * Restore a backup. Returns a plain-language report of what was applied, so
   * the UI can tell the truth instead of "done".
   *
   * `merge` (the default) keeps anything the file does not mention, which is
   * what someone moving to a new machine wants. `replace` makes the profile
   * match the file exactly.
   */
  async function importBackup(data, { mode = 'merge' } = {}) {
    if (!data || data.format !== BACKUP_FORMAT) {
      throw new Error(globalThis.GXT.i18n.t("shared_settings_importBackup_2"));
    }
    if (Number(data.version) > BACKUP_VERSION) {
      throw new Error(globalThis.GXT.i18n.t("shared_settings_importBackup_1"));
    }
    const incoming = data.settings && typeof data.settings === 'object' ? data.settings : {};
    // Only keys this build knows: a backup is untrusted input like any other
    // file, and writing arbitrary names into the settings object would let a
    // hand-edited file put the extension into a state no code expects.
    const clean = {};
    for (const [name, value] of Object.entries(incoming)) {
      if (!isSettingValue(name, value)) continue;
      clean[name] = value;
    }
    const report = {
      settings: Object.keys(clean).length,
      apiKeys: 0,
      openaiKey: false,
      memory: 0,
      skipped: Object.keys(incoming).length - Object.keys(clean).length,
    };
    if (mode === 'replace') {
      await setSettings0(() => clean, { replace: true });
    } else {
      await setSettings(clean);
    }
    if (Array.isArray(data.apiKeys) && data.apiKeys.length) {
      const existing = mode === 'replace' ? [] : await getApiKeys();
      const merged = [...new Set([...existing, ...data.apiKeys.map((k) => String(k).trim())])];
      await setApiKeys(merged);
      report.apiKeys = merged.length;
    }
    if (typeof data.openaiKey === 'string' && data.openaiKey.trim()) {
      await setOpenaiKey(data.openaiKey);
      report.openaiKey = true;
    }
    if (data.memory && typeof data.memory === 'object') {
      const restored = await mergeMemory(data.memory, mode);
      report.memory = restored;
    }
    return report;
  }

  /**
   * Google free-tier daily quotas reset at midnight US-Pacific time.
   * Returns the Pacific day key (for rollover) and the reset timestamp.
   */
  const pacificDayFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  let pacificResetCache = null;
  function pacificDayAndReset(now = new Date()) {
    const dayKey = pacificDayFormatter.format(now);
    if (pacificResetCache?.dayKey === dayKey) return { ...pacificResetCache };
    // A Pacific calendar day can be 23 or 25 hours. Find the actual date
    // boundary instead of adding a fixed 24 hours to a local clock reading.
    let before = Math.floor(now.getTime() / 1000);
    let after = before + 27 * 60 * 60;
    while (after - before > 1) {
      const mid = Math.floor((before + after) / 2);
      if (pacificDayFormatter.format(new Date(mid * 1000)) === dayKey) before = mid;
      else after = mid;
    }
    pacificResetCache = { dayKey, resetTs: after * 1000 };
    return { ...pacificResetCache };
  }

  /**
   * Subscribe to storage changes. The callback receives
   * `{ settings, apiKeyChanged }` where `settings` is the new settings
   * object (or undefined if settings did not change) and `apiKeyChanged`
   * covers every provider's credentials.
   */
  function onStorageChanged(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const settingsChange = changes[SETTINGS_KEY];
      if(settingsChange) globalThis.GXT.i18n?.configure(normalizeSettings(settingsChange.newValue));
      callback({
        settings: settingsChange
          ? normalizeSettings(settingsChange.newValue)
          : undefined,
        apiKeyChanged:
          API_KEYS_KEY in changes ||
          LEGACY_API_KEY_KEY in changes ||
          OPENAI_KEY_KEY in changes,
      });
    });
  }

  globalThis.GXT = Object.assign(globalThis.GXT || {}, {
    settingsReady: true,
    TARGET_LANGUAGES,validTarget,targetName,targetDirection,targetInput,forScope,
    normalizeSettings,
    migrateLocaleInstall,
    isSettingValue,
    DEFAULTS,
    BUNDLED_FONTS,
    FALLBACK_MODELS,
    CURATED_MODELS,
    // v2.5.1 — one discovery pass, three lists.
    classifyModels,
    classifyOpenaiModels,
    modelRank,
    MODEL_DAILY_LIMITS,
    defaultDailyLimit,
    // v2.5.5 — per-key quota accounting.
    quotaSummary,
    emptyKeyUsage,
    // v2.7.0 — credentials never reach a page's DOM.
    maskKey,
    scrubSecrets,
    OPENAI_PRESETS,
    // v2.2.0 — speech
    TTS_ENGINES,
    TTS_BING_VOICES,
    TTS_GEMINI_VOICES,
    TTS_GEMINI_MODELS,
    TTS_FALLBACK_MODELS,
    TTS_OPENAI_VOICES,
    ttsVoiceKey,
    resolveTts,
    SETTINGS_KEY,
    API_KEYS_KEY,
    OPENAI_KEY_KEY,
    MODEL_LIST_KEY,
    OPENAI_MODEL_LIST_KEY,
    LOCAL_VOICE_LIST_KEY,
    KEY_USAGE_KEY,
    STATS_KEY,
    getSettings,
    setSettings,
    getApiKeys,
    setApiKeys,
    getOpenaiKey,
    setOpenaiKey,
    modelCacheId,
    promptExtrasHash,
    cacheNamespace,
    youtubeSettings,
    youtubeTranslationKey,
    setWebVideoSiteBlocked,
    PROMPT_IDS,
    THINKING_LEVELS,
    activeModelId,
    resolveModelTuning,
    pacificDayAndReset,
    onStorageChanged,
    // ─────────────────────────────────────────────────────────── v3.0.0
    setSettings0,
    isSettingValue,
    REGISTERS,
    SITE_KEYS,
    originOf,
    settingsForOrigin,
    setSiteSetting,
    clearSitePrefs,
    MEMORY_KEY,
    emptyMemory,
    getMemory,
    updateMemory,
    memoryGeneration: () => memoryGeneration,
    clearMemory,
    mergeMemory,
    BACKUP_FORMAT,
    BACKUP_VERSION,
    exportBackup,
    importBackup,
  });
})();
