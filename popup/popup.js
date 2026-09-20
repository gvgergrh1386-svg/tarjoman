/**
 * Popup controller. Settings are written straight to chrome.storage.local;
 * the service worker and content scripts pick changes up live via
 * storage.onChanged. Credentials get explicit save-and-verify flows.
 */
'use strict';
(() => {
  // Design-preview fallback: when opened as a plain page outside Chrome's
  // extension context, run against an in-memory mock so the UI stays testable.
  if (!globalThis.chrome?.storage?.local) {
    const mem = {};
    globalThis.chrome = {
      storage: {
        local: {
          async get(query) {
            if (query == null) return { ...mem };
            if (typeof query === 'string') return { [query]: mem[query] };
            if (Array.isArray(query)) {
              const out = {};
              for (const key of query) out[key] = mem[key];
              return out;
            }
            const out = {};
            for (const [key, fallback] of Object.entries(query)) out[key] = mem[key] ?? fallback;
            return out;
          },
          async set(patch) { Object.assign(mem, patch); },
          async remove(keys) { for (const key of [].concat(keys)) delete mem[key]; },
        },
        onChanged: { addListener() {} },
      },
      runtime: {
        id: 'dev-preview',
        getURL: (path) => `../${path}`,
        async sendMessage() {
          return { ok: false, get error() { return globalThis.GXT.i18n.t("popup_popup_message_50"); }, code: 'DEV' };
        },
      },
      permissions: { async request() { return true; } },
    };
  }

  const GXTS = globalThis.GXT;
  const $ = (id) => document.getElementById(id);
  const ui = {
    enabled: $('enabled'),
    provider: $('provider'),
    geminiSection: $('geminiSection'),
    openaiSection: $('openaiSection'),
    mtSection: $('mtSection'),
    apiKeys: $('apiKeys'),
    saveKey: $('saveKey'),
    keyStatus: $('keyStatus'),
    model: $('model'),
    refreshModels: $('refreshModels'),
    modelHint: $('modelHint'),
    oaiBase: $('oaiBase'),
    oaiKey: $('oaiKey'),
    oaiModel: $('oaiModel'),
    oaiModels: $('oaiModels'),
    oaiPresets: $('oaiPresets'),
    oaiSave: $('oaiSave'),
    oaiStatus: $('oaiStatus'),
    font: $('font'),
    customFont: $('customFont'),
    fontPreview: $('fontPreview'),
    replaceOriginal: $('replaceOriginal'),
    translateBios: $('translateBios'),
    dwellMode: $('dwellMode'),
    batchSize: $('batchSize'),
    youtube: $('youtube'),
    glossary: $('glossary'),
    customPrompt: $('customPrompt'),
    openaiFallbackModel: $('openaiFallbackModel'),
    promptTarget: $('promptTarget'),
    promptEditor: $('promptEditor'),
    promptSave: $('promptSave'),
    promptReset: $('promptReset'),
    promptStatus: $('promptStatus'),
    promptState: $('promptState'),
    modelTuningCard: $('modelTuningCard'),
    tuningModelName: $('tuningModelName'),
    thinkingRow: $('thinkingRow'),
    thinkingLevel: $('thinkingLevel'),
    temperature: $('temperature'),
    // Two places show the per-key chips: under the key box (where they are
    // managed) and inside the stats details. They used to share one id, so
    // getElementById always returned the first and the stats list stayed empty.
    keyList: $('keyList'),
    statsKeyList: $('statsKeyList'),
    autoSitesBlock: $('autoSitesBlock'),
    autoSites: $('autoSites'),
    quotaCard: $('quotaCard'),
    quotaBlock: $('quotaBlock'),
    quotaUsed: $('quotaUsed'),
    quotaCapNote: $('quotaCapNote'),
    quotaFill: $('quotaFill'),
    quotaLine: $('quotaLine'),
    // v2.5.5 — the per-key quota view.
    quotaVerdict: $('quotaVerdict'),
    quotaKeysFold: $('quotaKeysFold'),
    quotaKeys: $('quotaKeys'),
    resetLine: $('resetLine'),
    dailyQuota: $('dailyQuota'),
    tileToday: $('tileToday'),
    tileTotal: $('tileTotal'),
    tileCache: $('tileCache'),
    statsEmpty: $('statsEmpty'),
    statsDetails: $('statsDetails'),
    statsBreakdown: $('statsBreakdown'),
    resetStats: $('resetStats'),
    clearCache: $('clearCache'),
    // v2.0.0 — chrome of the redesigned shell
    brandSub: $('brandSub'),
    providerTag: $('providerTag'),
    versionTag: $('versionTag'),
    search: $('search'),
    searchClear: $('searchClear'),
    searchCount: $('searchCount'),
    noResults: $('noResults'),
    appearanceBtn: $('appearanceBtn'),
    // v2.9.0 — the drill-down shell and the "act on this page" card
    navBack: $('navBack'),
    appLogo: $('appLogo'),
    viewTitle: $('viewTitle'),
    ctxCard: $('ctxCard'),
    ctxHost: $('ctxHost'),
    ctxNote: $('ctxNote'),
    ctxActions: $('ctxActions'),
    actScreen: $('actScreen'),
    actTranslate: $('actTranslate'),
    actSummary: $('actSummary'),
    actRead: $('actRead'),
    autoSiteRow: $('autoSiteRow'),
    autoSiteToggle: $('autoSiteToggle'),
    setupCard: $('setupCard'),
    setupGo: $('setupGo'),
    autoSitesEmpty: $('autoSitesEmpty'),
    sheet: $('sheet'),
    sheetScrim: $('sheetScrim'),
    sheetClose: $('sheetClose'),
    themeGrid: $('themeGrid'),
    accentRow: $('accentRow'),
    surfaceSeg: $('surfaceSeg'),
    densitySeg: $('densitySeg'),
    showHints: $('showHints'),
    resetAppearance: $('resetAppearance'),
    // v2.0.2 — RTX Video helper
    vsrHelper: $('vsrHelper'),
    vsrForceH264: $('vsrForceH264'),
    vsrCheck: $('vsrCheck'),
    vsrReport: $('vsrReport'),
  };

  /** Live copy of the appearance-related settings, so every control can
   *  re-render the whole UI from one place without a storage round-trip. */
  let look = {};

  const faNum = (n) => globalThis.GXT.i18n ? globalThis.GXT.i18n.number(n) : Number(n || 0).toLocaleString('fa-IR');

  /** sendMessage that resolves to null instead of throwing when the worker is
   *  asleep or restarting. Every caller here treats a null as "not available
   *  right now", which is the honest reading and never a crash. */
  const send = (message) => chrome.runtime.sendMessage(message).catch(() => null);

  /** The shipped version, from the manifest — the only place it is authored.
   *  Falls back to whatever the markup says, which is all the dev preview has. */
  const appVersion = () => {
    try {
      const version = chrome.runtime.getManifest?.().version;
      if (version) return `v${version}`;
    } catch {
      /* no extension context (design preview) */
    }
    return ui.versionTag?.textContent || '';
  };

  function setStatus(el, text, kind = '') {
    el.textContent = text;
    el.className = `status${kind ? ` ${kind}` : ''}`;
  }

  // ------------------------------------------------------------------- fonts

  /** Make the bundled fonts usable inside the popup for the live preview. */
  function injectFontFaces() {
    const rules = [];
    for (const font of GXTS.BUNDLED_FONTS) {
      for (const [file, weight] of [['Regular', 400], ['Bold', 700]]) {
        rules.push(
          `@font-face{font-family:"${font.id}";src:url("${chrome.runtime.getURL(
            `fonts/${font.id}-${file}.woff2`
          )}") format("woff2");font-weight:${weight};font-display:swap;}`
        );
      }
    }
    const style = document.createElement('style');
    style.textContent = rules.join('\n');
    document.head.appendChild(style);
  }

  function populateFontSelect(settings) {
    ui.font.replaceChildren();
    const add = (value, label) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      ui.font.appendChild(option);
    };
    for (const font of GXTS.BUNDLED_FONTS) add(font.id, font.label);
    add('x-default', globalThis.GXT.i18n.t("popup_popup_populateFontSelect_2"));
    add('_custom', globalThis.GXT.i18n.t("popup_popup_populateFontSelect_1"));
    ui.font.value = settings.font;
    updateFontPreview(settings);
  }

  function updateFontPreview(settings) {
    ui.customFont.classList.toggle('hidden', settings.font !== '_custom');
    const name =
      settings.font === 'x-default'
        ? ''
        : settings.font === '_custom'
          ? (settings.customFont || '').trim()
          : settings.font;
    ui.fontPreview.style.fontFamily = name
      ? `"${name.replace(/"/g, '')}", "Segoe UI", Tahoma, sans-serif`
      : '"Segoe UI", Tahoma, sans-serif';
  }

  // ------------------------------------------------------------------ models

  /**
   * The translation-model dropdown.
   *
   * `liveList` is the RAW discovery result — since v2.5.1 it also carries the
   * speech and live-dubbing models, which have their own pickers and would be
   * a trap here (a TTS model rejects a text request outright). Classifying
   * inside means every caller, including the one restoring a list cached by an
   * older version, gets the same filtered dropdown.
   */
  function populateModels(liveList, selected) {
    ui.model.replaceChildren();
    const seen = new Set();
    const add = (id, label) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const option = document.createElement('option');
      option.value = id;
      option.textContent = label || id;
      ui.model.appendChild(option);
    };
    for (const m of GXTS.CURATED_MODELS) add(m.id, `${m.id} — ${m.note}`);
    for (const m of GXTS.classifyModels(liveList).text) {
      add(m.id, m.displayName && m.displayName !== m.id ? `${m.id} (${m.displayName})` : m.id);
    }
    if (selected) add(selected);
    ui.model.value = selected;
  }

  function populateOaiModelList(list) {
    ui.oaiModels.replaceChildren();
    for (const m of list || []) {
      const option = document.createElement('option');
      option.value = m.id;
      ui.oaiModels.appendChild(option);
    }
  }

  /** The speech-capable half of the same server's catalogue, offered as
   *  suggestions under the free-text speech-model field. */
  function populateOaiSpeechList(list) {
    const datalist = $('ttsOpenaiModels');
    if (!datalist) return;
    datalist.replaceChildren();
    for (const m of list || []) {
      const option = document.createElement('option');
      option.value = m.id;
      datalist.appendChild(option);
    }
  }

  /**
   * Fill a <select> from a discovered list while never losing the saved value.
   *
   * A list fetched from a live service can legitimately not contain what the
   * user picked last month — the model may be gone, or the key may have lost
   * access to it. Dropping it would silently rewrite their choice on the next
   * save, so it is kept, marked, and still selected.
   */
  function fillSelect(select, entries, selected, { emptyLabel = '' } = {}) {
    if (!select) return;
    select.replaceChildren();
    const seen = new Set();
    const add = (value, label) => {
      if (seen.has(value)) return;
      seen.add(value);
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label || value;
      select.appendChild(option);
    };
    if (emptyLabel) add('', emptyLabel);
    for (const entry of entries || []) add(entry.id, entry.label || entry.id);
    if (selected && !seen.has(selected)) add(selected, globalThis.GXT.i18n.t("popup_popup_fillSelect_1", {v0:(selected)}));
    select.value = selected || '';
  }

  /** Curated entries first (they carry the Persian notes), discovered ones
   *  after — so a model released today is present even before anyone has
   *  written a description for it. */
  function mergeModelEntries(curated, discovered) {
    const entries = (curated || []).map((m) => ({ id: m.id, label: `${m.id} — ${m.note}` }));
    const known = new Set(entries.map((e) => e.id));
    for (const model of discovered || []) {
      if (known.has(model.id)) continue;
      known.add(model.id);
      entries.push({
        id: model.id,
        label:
          model.displayName && model.displayName !== model.id
            ? `${model.id} (${model.displayName})`
            : model.id,
      });
    }
    return entries;
  }

  /** Speech and live-dubbing model lists, from the same discovery pass that
   *  feeds the translation dropdown. */
  function populateEngineModels(groups, settings) {
    fillSelect(
      $('ttsModelGemini'),
      mergeModelEntries(GXTS.TTS_GEMINI_MODELS, groups?.tts),
      settings.ttsModelGemini || GXTS.DEFAULTS.ttsModelGemini
    );
    fillSelect(
      $('ytLiveModel'),
      (groups?.live || []).map((m) => ({ id: m.id })),
      settings.ytLiveModel,
      { get emptyLabel() { return globalThis.GXT.i18n.t("popup_popup_populateEngineModels_1"); } }
    );
  }

  /** The local machine's own catalogue: the Microsoft voices behind the
   *  keyless engine, and the Whisper sizes for caption-less video. */
  function populateLocalVoices(local, settings) {
    if (Array.isArray(local?.voices) && local.voices.length) {
      localVoices = local.voices;
      const engine = $('ttsEngine')?.value || settings?.ttsEngine || 'bing';
      if (engine === 'bing' || engine === 'bridge') populateVoices(engine, settings);
    }
    // The Whisper sizes are AUGMENTED, never replaced: the options written by
    // hand carry Persian descriptions ("متعادل (small) — پیشنهادی") that a
    // bare model id could not, so discovery only adds what is missing and
    // marks what is already downloaded.
    const asr = $('bridgeAsrModel');
    if (asr && Array.isArray(local?.asrModels) && local.asrModels.length) {
      const cached = local.asrCached || [];
      const isCached = (id) => cached.some((repo) => String(repo).toLowerCase().includes(id));
      const known = new Set([...asr.options].map((o) => o.value));
      for (const id of local.asrModels) {
        if (known.has(id)) continue;
        known.add(id);
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        asr.appendChild(option);
      }
      for (const option of asr.options) {
        const base = option.textContent.replace(/ ✓$/, '');
        option.textContent = isCached(option.value) ? `${base} ✓` : base;
      }
      asr.value = settings?.bridgeAsrModel || 'small';
    }
  }

  /**
   * ⟳ — ask every engine what it can run, and repaint every list.
   *
   * Before v2.5.1 this button asked Google for translation models only, and
   * the speech and dubbing engines were stuck with lists written by hand into
   * shared/settings.js — so a newly released voice model needed a code edit to
   * become selectable. One pass now feeds all of them. Each source is
   * independent: no key, a local-only setup, or a bridge that is not running
   * simply contributes nothing instead of failing the refresh.
   */
  let modelListRevision = 0;
  async function refreshModelList({ includeLocal = true } = {}) {
    const revision = ++modelListRevision;
    const settings = await GXTS.getSettings();
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'LIST_MODELS', provider: 'gemini' });
    } catch {
      res = null;
    }
    const latest = await GXTS.getSettings();
    if (revision !== modelListRevision) return null;
    if (res?.ok) {
      discoveredGroups = res.groups || GXTS.classifyModels(res.models);
      populateModels(res.models, latest.model);
      populateEngineModels(discoveredGroups, latest);
    }
    // An OpenAI-compatible service is configured separately and may be the
    // only one present, so it is asked in its own right rather than as a
    // fallback for Gemini.
    if (settings.openaiBaseUrl) {
      try {
        const oai = await chrome.runtime.sendMessage({ type: 'LIST_MODELS', provider: 'openai' });
        const current = await GXTS.getSettings();
        if (revision !== modelListRevision) return null;
        if (oai?.ok && current.openaiBaseUrl === settings.openaiBaseUrl) {
          populateOaiModelList(oai.groups?.text?.length ? oai.groups.text : oai.models);
          populateOaiSpeechList(oai.groups?.speech);
        }
      } catch {
        /* server unreachable: keep the list already shown */
      }
    }
    if (includeLocal && settings.bridgeEnabled) {
      try {
        const local = await chrome.runtime.sendMessage({ type: 'LIST_LOCAL_MODELS' });
        const current = await GXTS.getSettings();
        if (revision !== modelListRevision) return null;
        if (local?.ok && current.bridgeEnabled && current.bridgePort === settings.bridgePort && current.bridgeToken === settings.bridgeToken) populateLocalVoices(local, current);
      } catch {
        /* bridge not running: the curated voices stay */
      }
    }
    return res;
  }

  // ------------------------------------------------------------------- stats

  function statRow(label, value) {
    const row = document.createElement('div');
    row.className = 'stat-row';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    return row;
  }

  /** "at HH:MM (Z left)" for the quota reset. Uses floor on TOTAL minutes so a
   *  near-hour remainder can never render as "…and 60 minutes". */
  function formatReset(resetTs) {
    const totalMin = Math.floor(Math.max(0, resetTs - Date.now()) / 60000);
    const hours = Math.floor(totalMin / 60);
    const minutes = totalMin % 60;
    const at = globalThis.GXT.i18n.time(resetTs, { hour: '2-digit', minute: '2-digit' });
    const leftText =
      hours > 0 ? globalThis.GXT.i18n.t("popup_popup_leftText_2", {v0:(faNum(hours)), v1:(faNum(minutes))}) : globalThis.GXT.i18n.t("popup_popup_leftText_1", {v0:(faNum(minutes))});
    return globalThis.GXT.i18n.t("popup_popup_formatReset_1", {v0:(at), v1:(leftText)});
  }

  async function loadStats() {
    let data = null;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
      if (res?.ok) data = res;
    } catch {
      /* worker unreachable; leave stats empty */
    }
    ui.quotaCard.classList.add('hidden');
    ui.quotaBlock.classList.add('hidden');
    ui.quotaKeysFold?.classList.add('hidden');
    ui.resetLine.textContent = '';
    ui.statsBreakdown.replaceChildren();
    renderKeyList(null);
    if (!data) {
      ui.statsEmpty.classList.remove('hidden');
      ui.statsDetails.classList.add('hidden');
      return;
    }
    const { stats, resetTs, keys, quota, provider } = data;

    // Headline tiles: today's translations, all-time, and the cache-hit rate.
    const totalItems = (stats.translated || 0) + (stats.cacheHits || 0);
    const rate = totalItems ? Math.round((stats.cacheHits / totalItems) * 100) : 0;
    ui.tileToday.textContent = faNum(stats.dayTranslated || 0);
    ui.tileTotal.textContent = faNum(stats.translated || 0);
    globalThis.GXT.i18n.bind(ui.tileCache, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_loadStats_3", {v0:(faNum(rate))})));
    const hasActivity = totalItems > 0 || (stats.apiCalls || 0) > 0;
    ui.statsEmpty.classList.toggle('hidden', hasActivity);

    // Collapsible detail: per-feature counts (proves every source is captured)
    // + all-time API calls + per-key status.
    const sources = [
      ['items_tweet', globalThis.GXT.i18n.t("popup_popup_sources_6")],
      ['items_subtitle', globalThis.GXT.i18n.t("popup_popup_sources_5")],
      ['items_page', globalThis.GXT.i18n.t("popup_popup_sources_4")],
      ['items_selection', globalThis.GXT.i18n.t("popup_popup_sources_3")],
      ['items_image', globalThis.GXT.i18n.t("popup_popup_sources_2")],
      ['items_summary', globalThis.GXT.i18n.t("popup_popup_sources_1")],
    ];
    let rows = 0;
    for (const [key, label] of sources) {
      if (stats[key]) {
        ui.statsBreakdown.appendChild(statRow(label, faNum(stats[key])));
        rows += 1;
      }
    }
    if (stats.dayApiCalls) {
      ui.statsBreakdown.appendChild(statRow(globalThis.GXT.i18n.t("popup_popup_loadStats_2"), faNum(stats.dayApiCalls)));
      rows += 1;
    }
    if (stats.apiCalls) {
      ui.statsBreakdown.appendChild(statRow(globalThis.GXT.i18n.t("popup_popup_loadStats_1"), faNum(stats.apiCalls)));
      rows += 1;
    }
    // The per-key quota rows below carry each key AND its state, so repeating
    // the plain key list underneath them would be the same twelve rows twice.
    const quotaShowsKeys = provider === 'gemini' && (quota?.keyCount || 0) > 1;
    renderKeyList(keys, { statsList: !quotaShowsKeys });
    ui.statsDetails.classList.toggle('hidden', rows === 0 && !(keys && keys.total > 1));

    renderQuota(provider, quota, resetTs, keys);
  }

  /**
   * The daily-quota card.
   *
   * v2.5.5 — rewritten around the fact that was wrong before: Google's daily
   * quota belongs to a KEY (strictly, to that key's project), not to this
   * profile. The old card divided every request made today across every key by
   * ONE key's cap, so twelve keys produced «۱۸۰۰ / ۱۵۰۰» in red while all
   * twelve were happily translating. Three rules now:
   *
   *   1. The denominator is the sum of the PER-KEY caps.
   *   2. Red means Google actually refused every key — the extension knows
   *      this for certain, because a daily-quota 429 is what parks a key.
   *   3. Where a cap has been measured it says so, and where it is a guess it
   *      says that too, instead of presenting both as the same kind of number.
   */
  function renderQuota(provider, quota, resetTs, keysInfo) {
    if (provider !== 'gemini') return;
    // Gemini selected but no keys / no known cap: show the shell so the
    // manual-cap control stays reachable.
    ui.quotaCard.classList.remove('hidden');
    if (!quota || !quota.keyCount || !quota.limit) return;

    ui.quotaBlock.classList.remove('hidden');
    const { used, limit, pct, keyCount, exhaustedCount, activeCount, state } = quota;
    ui.quotaFill.style.width = `${pct}%`;
    ui.quotaFill.className =
      `quota-fill${state === 'exhausted' ? ' full' : state === 'warn' ? ' warn' : ''}`;
    // A bar that only exists as a coloured width is invisible to a screen
    // reader; the same number is published on the progressbar role.
    const bar = $('quotaBar');
    if (bar) {
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
      bar.setAttribute('aria-valuetext', globalThis.GXT.i18n.t("background_service_worker_handlers_29", {v0:(faNum(used)), v1:(faNum(limit))}));
    }
    ui.quotaUsed.textContent = `${faNum(used)} / ${faNum(limit)}`;
    globalThis.GXT.i18n.bind(ui.quotaLine, "textContent", () => (keyCount > 1
        ? globalThis.GXT.i18n.t("popup_popup_renderQuota_12", {v0:(faNum(pct)), v1:(faNum(keyCount))})
        : globalThis.GXT.i18n.t("popup_popup_renderQuota_11", {v0:(faNum(pct))})));

    globalThis.GXT.i18n.bind(ui.quotaCapNote, "textContent", () => (quota.limitSource === 'override'
        ? globalThis.GXT.i18n.t("popup_popup_renderQuota_10")
        : quota.limitSource === 'measured'
          ? globalThis.GXT.i18n.t("popup_popup_renderQuota_9", {v0:(faNum(quota.measuredKeys))})
          : globalThis.GXT.i18n.t("popup_popup_renderQuota_8")));

    // The headline sentence: what is TRUE right now, not a percentage of a
    // guess. "Nothing is exhausted" is the answer to the question the user
    // actually has, and it is the one the old card got wrong.
    const verdict = ui.quotaVerdict;
    if (verdict) {
      verdict.className = `quota-verdict ${state}`;
      globalThis.GXT.i18n.bind(verdict, "textContent", () => (state === 'exhausted'
          ? globalThis.GXT.i18n.t("popup_popup_renderQuota_7", {v0:(faNum(keyCount))})
          : exhaustedCount > 0
            ? globalThis.GXT.i18n.t("popup_popup_renderQuota_6", {v0:(faNum(exhaustedCount)), v1:(faNum(activeCount))})
            : keyCount > 1
              ? globalThis.GXT.i18n.t("popup_popup_renderQuota_5", {v0:(faNum(keyCount))})
              : globalThis.GXT.i18n.t("popup_popup_renderQuota_4")));
    }
    if (resetTs) globalThis.GXT.i18n.bind(ui.resetLine, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderQuota_3", {v0:(formatReset(resetTs))})));

    // Per-key rows. Only worth opening for a fleet; with one key the bar above
    // already IS the per-key view.
    const fold = ui.quotaKeysFold;
    const box = ui.quotaKeys;
    if (!fold || !box) return;
    fold.classList.toggle('hidden', keyCount < 2);
    if (keyCount < 2) return;
    // Key status (invalid / briefly cooling) belongs on the same row as that
    // key's usage — they are two facts about one key, and splitting them
    // across two lists made the reader match them up by eye.
    const statusOf = new Map((keysInfo?.list || []).map((entry) => [entry.key, entry]));
    box.replaceChildren();
    for (const entry of quota.perKey) {
      const status = statusOf.get(entry.key);
      const row = document.createElement('div');
      row.className = `qkey${entry.exhausted ? ' exhausted' : entry.pct >= 85 ? ' warn' : ''}`;
      const code = document.createElement('code');
      code.textContent = entry.key;
      const num = document.createElement('span');
      num.className = 'qnum';
      if (status?.status === 'invalid') {
        globalThis.GXT.i18n.bind(num, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderQuota_2")));
        row.classList.add('exhausted');
      } else if (entry.exhausted) {
        globalThis.GXT.i18n.bind(num, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderQuota_1")));
      } else if (status?.status === 'cooling') {
        // A SHORT cooldown is a per-minute rate limit, not a daily one —
        // calling both "quota finished" would be a lie about a key that will
        // be usable again in seconds.
        const at = globalThis.GXT.i18n.time(status.coolUntil, {
          hour: '2-digit',
          minute: '2-digit',
        });
        globalThis.GXT.i18n.bind(num, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderKeyList_2", {v0:(at)})));
      } else {
        num.textContent = `${faNum(entry.calls)} / ${faNum(entry.limit)}`;
        if (entry.measured) num.classList.add('qmeasured');
      }
      const bar = document.createElement('div');
      bar.className = 'qbar';
      const fill = document.createElement('i');
      fill.style.width = `${entry.pct}%`;
      bar.appendChild(fill);
      row.append(code, num, bar);
      box.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- provider

  const PROVIDER_LABEL = {
    gemini: 'Gemini',
    openai: 'OpenAI',
    google: 'Google Translate',
    bing: 'Bing',
  };

  function showProviderSections(provider) {
    const isMT = provider === 'google' || provider === 'bing';
    ui.geminiSection.classList.toggle('hidden', provider !== 'gemini');
    ui.openaiSection.classList.toggle('hidden', provider !== 'openai');
    ui.mtSection.classList.toggle('hidden', !isMT);
    ui.providerTag.textContent = PROVIDER_LABEL[provider] || provider;
  }

  /** One-line status under the app name: which engine is active and whether
   *  it is actually usable. Replaces three separate hint paragraphs. */
  function setBrandStatus(text, warn) {
    ui.brandSub.textContent = text;
    ui.brandSub.classList.toggle('warn', !!warn);
  }

  function refreshBrandStatus(settings, keyCount) {
    const label = PROVIDER_LABEL[settings.provider] || settings.provider;
    if (!settings.enabled) return setBrandStatus(globalThis.GXT.i18n.t("popup_popup_refreshBrandStatus_4"), true);
    if (settings.provider === 'gemini' && !keyCount) {
      return setBrandStatus(globalThis.GXT.i18n.t("popup_popup_refreshBrandStatus_3"), true);
    }
    if (settings.provider === 'openai' && !(settings.openaiBaseUrl && settings.openaiModel)) {
      return setBrandStatus(globalThis.GXT.i18n.t("popup_popup_refreshBrandStatus_2"), true);
    }
    setBrandStatus(globalThis.GXT.i18n.t("popup_popup_refreshBrandStatus_1", {v0:(label)}), false);
  }

  /** Re-read what the status line needs (used after any change that could
   *  flip it: master switch, provider, credentials). */
  async function syncBrandStatus() {
    const [settings, keys] = await Promise.all([GXTS.getSettings(), GXTS.getApiKeys()]);
    refreshBrandStatus(settings, keys.length);
  }

  // Host permission each keyless MT engine needs (covered by the extension's
  // broad optional https host grant, requested from the user on demand).
  const MT_ORIGIN = {
    google: 'https://translate.googleapis.com/*',
    bing: 'https://www.bing.com/*',
  };

  // ------------------------------------------------------- key status list

  /** Per-key live status (keys shown unmasked, as explicitly requested).
   *  Rendered into BOTH lists: beside the key box and in the stats details. */
  function renderKeyList(keysInfo, { statsList = true } = {}) {
    const targets = [ui.keyList, statsList ? ui.statsKeyList : null].filter(Boolean);
    if (!statsList) ui.statsKeyList?.replaceChildren();
    for (const target of targets) target.replaceChildren();
    if (!keysInfo || keysInfo.total < 2) return;
    for (const entry of keysInfo.list) {
      const stateEl = document.createElement('span');
      if (entry.status === 'ok') {
        globalThis.GXT.i18n.bind(stateEl, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderKeyList_3")));
        stateEl.className = 'chip ok';
      } else if (entry.status === 'cooling') {
        const at = globalThis.GXT.i18n.time(entry.coolUntil, {
          hour: '2-digit',
          minute: '2-digit',
        });
        globalThis.GXT.i18n.bind(stateEl, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderKeyList_2", {v0:(at)})));
        stateEl.className = 'chip warn';
      } else {
        globalThis.GXT.i18n.bind(stateEl, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderKeyList_1")));
        stateEl.className = 'chip err';
      }
      for (const target of targets) {
        const row = document.createElement('div');
        row.className = 'key-row';
        const keyEl = document.createElement('code');
        keyEl.textContent = entry.key;
        row.append(stateEl.cloneNode(true), keyEl);
        target.appendChild(row);
      }
    }
  }

  // ------------------------------------------------------------- auto sites

  async function renderAutoSites() {
    const settings = await GXTS.getSettings();
    const sites = settings.autoSites || [];
    ui.autoSitesBlock.classList.toggle('hidden', !sites.length);
    ui.autoSitesEmpty?.classList.toggle('hidden', sites.length > 0);
    ui.autoSites.replaceChildren();
    for (const origin of sites) {
      const row = document.createElement('div');
      row.className = 'site-row';
      const name = document.createElement('code');
      name.textContent = origin;
      const remove = document.createElement('button');
      remove.className = 'icon-btn tiny';
      remove.type = 'button';
      globalThis.GXT.i18n.bind(remove, "title", () => (globalThis.GXT.i18n.t("popup_popup_renderAutoSites_2", {v0:(origin)})));
      globalThis.GXT.i18n.bind(remove,'ariaLabel',()=>(globalThis.GXT.i18n.t("popup_popup_renderAutoSites_1", {v0:(origin)})));
      remove.textContent = '✕';
      remove.addEventListener('click', async () => {
        const current = (await GXTS.getSettings()).autoSites || [];
        await GXTS.setSettings({ autoSites: current.filter((s) => s !== origin) });
        try {
          await chrome.permissions?.remove?.({ origins: [`${origin}/*`] });
        } catch {
          /* harmless */
        }
        void renderAutoSites();
        void refreshContext();
        void renderSummaries();
      });
      row.append(remove, name);
      ui.autoSites.appendChild(row);
    }
  }

  // ══════════════════════════════════════ "in this page" card (v2.9.0)
  //
  // The popup's new first job. Everything here mirrors a path that already
  // existed elsewhere (the context menu, the keyboard commands, the auto-site
  // toggle) — the defect being fixed is that none of them were reachable from
  // the surface people actually click.

  /** The active tab, or null when the query is not permitted / has no answer. */
  async function currentTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch {
      return null;
    }
  }

  /** `https://example.com` for a normal page; null for anything the extension
   *  cannot act on (chrome://, the Web Store, a file:// path, a port). */
  function originOf(url) {
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return null;
      if (parsed.port) return null; // match patterns cannot express a port
      return parsed.origin;
    } catch {
      return null;
    }
  }

  /** Hosts with their own dedicated engine, where whole-page translation is
   *  not what the user wants and auto-site registration is deliberately
   *  refused by the worker. */
  const OWN_ENGINE = {
    get 'x.com'() { return globalThis.GXT.i18n.t("popup_popup_refreshContext_4"); },
    get 'mobile.x.com'() { return globalThis.GXT.i18n.t("popup_popup_refreshContext_4"); },
    get 'twitter.com'() { return globalThis.GXT.i18n.t("popup_popup_refreshContext_4"); },
    get 'mobile.twitter.com'() { return globalThis.GXT.i18n.t("popup_popup_refreshContext_4"); },
    get 'www.youtube.com'() { return globalThis.GXT.i18n.t("popup_popup_refreshContext_2"); },
    get 'm.youtube.com'() { return globalThis.GXT.i18n.t("popup_popup_refreshContext_2"); },
    get 'music.youtube.com'() { return globalThis.GXT.i18n.t("popup_popup_refreshContext_2"); },
  };

  let contextTab = null;

  async function refreshContext() {
    contextTab = await currentTab();
    const url = contextTab?.url || '';
    const origin = originOf(url);
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
    const own = OWN_ENGINE[host];
    // Acting only needs a TAB. Reading its URL needs `activeTab`, which Chrome
    // grants when the toolbar icon is clicked — but not necessarily by every
    // other route into this window. Gating the buttons on the URL would make
    // them silently dead in that case, so they are gated on the tab alone and
    // the worker reports honestly when a page cannot host a content script.
    const actionable = contextTab?.id != null;
    // The auto-site switch genuinely needs the origin: it is what gets granted.
    const canAutoSite = !!origin && !own;

    globalThis.GXT.i18n.bind(ui.ctxHost, "textContent", () => (host || (actionable ? globalThis.GXT.i18n.t("popup_popup_refreshContext_8") : globalThis.GXT.i18n.t("popup_popup_refreshContext_7"))));
    for (const button of [ui.actTranslate, ui.actSummary, ui.actRead, ui.actScreen]) {
      button.disabled = !actionable;
    }
    ui.autoSiteToggle.disabled = !canAutoSite;
    ui.autoSiteRow.classList.toggle('hidden', !canAutoSite);

    const settings = await GXTS.getSettings();
    ui.autoSiteToggle.checked = !!origin && (settings.autoSites || []).includes(origin);

    /**
     * The per-site profile (v3.0.0).
     *
     * Shown only where a profile can exist — it is keyed by origin, so a
     * chrome:// page or a file has nowhere to store one. «مثل همه‌جا» is a
     * real option rather than a default value, because "inherit" and
     * "happens to match the global right now" are different states: the
     * first keeps following the global setting when it changes later.
     */
    const siteSelect = $('siteRegister');
    if (siteSelect) {
      if (!siteSelect.options.length) {
        const inherit = document.createElement('option');
        inherit.value = '';
        globalThis.GXT.i18n.bind(inherit, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_refreshContext_6")));
        siteSelect.appendChild(inherit);
        for (const entry of GXTS.REGISTERS) {
          const option = document.createElement('option');
          option.value = entry.id;
          option.textContent = entry.label;
          siteSelect.appendChild(option);
        }
      }
      const profile = (settings.sitePrefs || {})[origin] || {};
      siteSelect.value = profile.register || '';
      siteSelect.disabled = !origin;
      $('siteProfileRow')?.classList.toggle('hidden', !origin);
      siteSelect.classList.toggle('hidden', !origin);
    }

    globalThis.GXT.i18n.bind(ui.ctxNote, "textContent", () => (!actionable
      ? globalThis.GXT.i18n.t("popup_popup_refreshContext_5")
      : own === globalThis.GXT.i18n.t("popup_popup_refreshContext_4")
        ? globalThis.GXT.i18n.t("popup_popup_refreshContext_3")
        : own === globalThis.GXT.i18n.t("popup_popup_refreshContext_2")
          ? globalThis.GXT.i18n.t("popup_popup_refreshContext_1")
          : ''));
  }

  /** Fire one page action and get out of the way — the result appears on the
   *  page, and a popup left open would cover it. */
  async function runAction(action, button) {
    if (contextTab?.id == null) return;
    // Only `disabled` is touched: the primary button holds an <svg> beside its
    // label, and the usual save-and-restore of `textContent` would delete it.
    button.disabled = true;
    const res = await chrome.runtime
      .sendMessage({ type: 'RUN_TAB_ACTION', action, tabId: contextTab.id })
      .catch(() => null);
    if (res?.ok) {
      window.close();
      return;
    }
    button.disabled = false;
    globalThis.GXT.i18n.bind(ui.ctxNote, "textContent", () => (res?.error || globalThis.GXT.i18n.t("popup_popup_runAction_1")));
  }

  ui.actTranslate?.addEventListener('click', () => void runAction('page', ui.actTranslate));
  ui.actSummary?.addEventListener('click', () => void runAction('summary', ui.actSummary));
  ui.actRead?.addEventListener('click', () => void runAction('read', ui.actRead));
  /**
   * v3.0.0 — the only action here that is not about THIS page.
   *
   * It needs a tab to run in (the picker and the selection overlay are drawn
   * by a content script), but what it reads is a screen the user chooses —
   * a game, an installer, a video player. That is why it sits in the action
   * card rather than in a settings screen: it is a thing you DO.
   */
  $('actScreen')?.addEventListener('click', () => void runAction('screen', $('actScreen')));

  $('siteRegister')?.addEventListener('change', async () => {
    const origin = originOf(contextTab?.url || '');
    if (!origin) return;
    const value = $('siteRegister').value;
    await GXTS.setSiteSetting(origin, 'register', value || undefined);
    setStatus($('siteStatus'), value
      ? globalThis.GXT.i18n.t("popup_popup_message_49")
      : globalThis.GXT.i18n.t("popup_popup_message_48"), 'ok');
    void renderSummaries();
  });

  ui.autoSiteToggle?.addEventListener('change', async () => {
    const origin = originOf(contextTab?.url || '');
    if (!origin) return;
    const on = ui.autoSiteToggle.checked;
    if (on) {
      // FIRST async call in the gesture. Any `await` before
      // chrome.permissions.request kills the user_gesture flag and the prompt
      // never appears — the v1.9.5 lesson, which cost two releases.
      const granted = await chrome.permissions
        ?.request?.({ origins: [`${origin}/*`] })
        .catch(() => false);
      if (!granted) {
        ui.autoSiteToggle.checked = false;
        globalThis.GXT.i18n.bind(ui.ctxNote, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_message_47")));
        return;
      }
    }
    const sites = (await GXTS.getSettings()).autoSites || [];
    await GXTS.setSettings({
      autoSites: on ? [...new Set([...sites, origin])] : sites.filter((s) => s !== origin),
    });
    if (!on) {
      try {
        await chrome.permissions?.remove?.({ origins: [`${origin}/*`] });
      } catch {
        /* the origin may be covered by a broader grant; harmless */
      }
    }
    globalThis.GXT.i18n.bind(ui.ctxNote, "textContent", () => (on
      ? globalThis.GXT.i18n.t("popup_popup_message_46")
      : globalThis.GXT.i18n.t("popup_popup_message_45")));
    void renderAutoSites();
    void renderSummaries();
  });

  // ------------------------------------------------------------------ events

  ui.enabled.addEventListener('change', async () => {
    await GXTS.setSettings({ enabled: ui.enabled.checked });
    void syncBrandStatus();
  });
  ui.replaceOriginal.addEventListener('change', () =>
    GXTS.setSettings({ replaceOriginal: ui.replaceOriginal.checked })
  );
  ui.translateBios.addEventListener('change', () =>
    GXTS.setSettings({ translateBios: ui.translateBios.checked })
  );
  ui.youtube.addEventListener('change', () => GXTS.setSettings({ youtube: ui.youtube.checked }));
  ui.dwellMode.addEventListener('change', () =>
    GXTS.setSettings({ dwellMode: ui.dwellMode.checked })
  );

  // v1.8: every new capability is a plain boolean setting wired the same way.
  const BOOL_SETTINGS = [
    'pageBlockMode',
    'pageDynamic',
    'pageBilingual',
    'pageAttrs',
    'pageFrames',
    'selectionButton',
    'imageTranslate',
    'summarizer',
    'xImageButton',
    'composerTranslate',
    'xExtraZones',
    'ytShorts',
    'ytAuto',
    'ytSentenceMerge',
    'ytBilingual',
    'webVideoSubtitles',
    'webVideoDub',
    // v2.4.0 — live dubbing. The in-player ⚙ panel owns the fine controls;
    // this is just the master switch.
    'ytDub',
    'ytSubtitles',
    'bridgeEnabled',
    'bridgeAsr',
    // v2.5.8 — keep translating pages that load as you scroll.
    'mangaAuto',
    'expandLongPosts',
    // v2.2.0 — the 🔊 button on translation cards.
    'ttsButton',
    // v2.5.1 — speech reaches every site, and how foreign text is handled.
    'ttsAnywhere',
    'ttsTranslateFirst',
    // v2.0.1 / v2.1.0 — these live in the appearance sheet, but they are plain
    // booleans like the rest, so the generic wiring covers them.
    'videoSafeUi',
    'cardOpaque',
    // v3.0.0 — quality and reach.
    'qualityMode',
    'memoryEnabled',
    'ytPageText',
    'ankiExport',
  ];
  for (const id of BOOL_SETTINGS) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('change', () => {
      const patch = { [id]: el.checked };
      // Bilingual page display renders through the block engine.
      if (id === 'pageBilingual' && el.checked) {
        patch.pageBlockMode = true;
        const block = $('pageBlockMode');
        if (block) block.checked = true;
      }
      // Two of these booleans live inside the appearance sheet, whose controls
      // are re-rendered from the `look` snapshot. Without this the next
      // renderSheet() would repaint the checkbox from a stale value and appear
      // to undo the change.
      if (id in look) look[id] = el.checked;
      void GXTS.setSettings(patch).then(renderSummaries);
    });
  }

  const wireTextSetting = (el, key) => {
    let timer = null;
    el.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void GXTS.setSettings({ [key]: el.value });
      }, 500);
    });
  };
  wireTextSetting(ui.glossary, 'glossary');
  wireTextSetting(ui.customPrompt, 'customPrompt');
  // The permission request must be the first asynchronous operation in this
  // click handler: awaiting settings first loses Chrome's user gesture.
  $('webVideoEnabled').addEventListener('change', async () => {
    const checkbox=$('webVideoEnabled'), enabled=checkbox.checked;
    checkbox.disabled=true;
    try {
      if (enabled) {
        const granted=await chrome.permissions?.request?.({origins:['http://*/*','https://*/*']});
        if (!granted) {checkbox.checked=false; globalThis.GXT.i18n.bind($('webVideoStatus'), "textContent", () => (globalThis.GXT.i18n.t("popup_popup_message_44"))); return;}
      }
      await GXTS.setSettings({webVideoEnabled:enabled});
      globalThis.GXT.i18n.bind($('webVideoStatus'), "textContent", () => (enabled?globalThis.GXT.i18n.t("popup_popup_message_43"):globalThis.GXT.i18n.t("popup_popup_message_42")));
    } catch(error) {checkbox.checked=!enabled; $('webVideoStatus').textContent=error.message;}
    finally {checkbox.disabled=false;}
  });
  for (const id of ['webVideoDisplay','webVideoSiteMode','webVideoDubEngine','ytProvider','ytTargetLang','ytModel']) {
    $(id).addEventListener('change',()=>void GXTS.setSettings({[id]:$(id).value.trim()}).catch(error=>{$('webVideoStatus').textContent=error.message;}));
  }
  const siteLines = value => [...new Set(value.split(/[\s,]+/).filter(Boolean).map(value=>{
    const url=new URL(/^https?:\/\//i.test(value)?value:`https://${value}`);
    if (!/^https?:$/.test(url.protocol)||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash||!url.hostname||url.hostname.includes('*')) throw new Error(globalThis.GXT.i18n.t("popup_popup_siteLines_1"));
    return url.hostname.toLowerCase();
  }))];
  for (const id of ['webVideoAllowedSites','webVideoBlockedSites']) {
    $(id).addEventListener('change',async()=>{
      try {const list=siteLines($(id).value); await GXTS.setSettings({[id]:list}); $(id).value=list.join('\n'); globalThis.GXT.i18n.bind($('webVideoStatus'), "textContent", () => (globalThis.GXT.i18n.t("popup_popup_message_41")));}
      catch(error){$('webVideoStatus').textContent=error.message;}
    });
  }
  let webVideoSiteHost='',webVideoSiteRule='',webVideoSiteIsOff=false;
  function loadWebVideo(settings) {
    for (const id of ['webVideoEnabled','webVideoSubtitles','webVideoDub']) if(document.activeElement!==$(id)) $(id).checked=!!settings[id];
    for (const id of ['webVideoDisplay','webVideoSiteMode','webVideoDubEngine','ytProvider','ytTargetLang','ytModel']) if(document.activeElement!==$(id)) $(id).value=settings[id]??GXTS.DEFAULTS[id];
    for (const id of ['webVideoAllowedSites','webVideoBlockedSites']) if(document.activeElement!==$(id)) $(id).value=(Array.isArray(settings[id])?settings[id]:[]).join('\n');
    const matches=s=>webVideoSiteHost===s||webVideoSiteHost.endsWith(`.${s}`);
    webVideoSiteRule=(settings.webVideoBlockedSites||[]).find(matches)||'';
    webVideoSiteIsOff=!!webVideoSiteRule||(settings.webVideoSiteMode==='allowlist'&&!(settings.webVideoAllowedSites||[]).some(matches));
    $('webVideoCurrentSite').disabled=!webVideoSiteHost;
    globalThis.GXT.i18n.bind($('webVideoCurrentSite'), "textContent", () => (webVideoSiteHost?globalThis.GXT.i18n.t("popup_popup_loadWebVideo_2", {v0:(webVideoSiteIsOff?globalThis.GXT.i18n.t("popup_popup_loadWebVideo_4"):globalThis.GXT.i18n.t("popup_popup_loadWebVideo_3")), v1:(webVideoSiteRule||webVideoSiteHost)}):globalThis.GXT.i18n.t("popup_popup_loadWebVideo_1")));
    $('ytModel').disabled=['google','bing'].includes(settings.ytProvider==='inherit'?settings.provider:settings.ytProvider);
  }
  $('webVideoCurrentSite').addEventListener('click',async()=>{
    try {await GXTS.setWebVideoSiteBlocked(webVideoSiteRule||webVideoSiteHost,!webVideoSiteIsOff); loadWebVideo(await GXTS.getSettings()); globalThis.GXT.i18n.bind($('webVideoStatus'), "textContent", () => (globalThis.GXT.i18n.t("popup_popup_message_40")));}
    catch(error){$('webVideoStatus').textContent=error.message;}
  });
  ui.openaiFallbackModel.addEventListener('change', () =>
    GXTS.setSettings({ openaiFallbackModel: ui.openaiFallbackModel.value.trim() })
  );

  // ══════════════════════════════════════════ navigation shell (v2.9.0)
  //
  // Four tabs became a home list of named destinations, each one screen deep.
  // The reason is measured, not stylistic: «قابلیت‌ها» alone held seven cards
  // and about thirty controls on a single 2000px scroll, while X's own
  // settings sat on a different tab — so neither "where do I change this?" nor
  // "what does this window contain?" had an answer you could see.
  //
  // Only the CONTAINERS moved. Every control id is where it was, so all the
  // wiring above (much of it the product of specific bug fixes) is untouched.

  /** Work that a destination needs done before it is shown. Kept here so the
   *  popup can open without paying for any of it — before v2.9, opening the
   *  window woke the service worker for statistics nobody was looking at. */
  const ON_ENTER = {
    stats: () => loadStats(),
    custom: () => loadPromptEditor(),
    bridge: () => refreshBridge(),
    // v3.0.0 — the memory list is the only one of these that costs a message,
    // and it is worth paying only when someone is looking at it.
    quality: () => loadMemory(),
  };

  const views = () => [...document.querySelectorAll('.view')];

  function currentView() {
    return document.querySelector('.view.active')?.dataset.view || 'home';
  }

  /**
   * Show one destination.
   *
   * Focus moves to the destination itself rather than staying on the row that
   * was clicked: without it, a screen-reader or keyboard user activates a
   * button and is told nothing changed, and Tab continues from a control that
   * is no longer on screen.
   */
  function goto(name, { focus = true } = {}) {
    const target = document.getElementById(`view-${name}`) || document.getElementById('view-home');
    const isHome = target.id === 'view-home';
    /**
     * Arriving somewhere ends the search — v2.9.5.
     *
     * MEASURED before the fix: search «یوتیوب», then open the «یوتیوب» result.
     * You land on a page showing 1 of its 3 cards with 4 rows hidden, because
     * the term was still filtering while `goto` had taken over which views are
     * shown. Nothing on screen explains it, so the section simply appears to be
     * missing «متن زیرنویس» and «دوبله» — the product looks smaller than it is,
     * at the exact moment someone is exploring it.
     *
     * Following a result means "take me there", not "keep filtering", which is
     * what every drill-down search does. `resetFilter` does not navigate, so
     * this cannot re-enter.
     */
    if (document.body.classList.contains('searching')) resetFilter();
    for (const view of views()) {
      const active = view === target;
      view.classList.toggle('active', active);
      view.toggleAttribute('hidden', !active);
    }
    ui.navBack.classList.toggle('hidden', isHome);
    ui.appLogo.classList.toggle('hidden', !isHome);
    globalThis.GXT.i18n.bind(ui.viewTitle, "textContent", () => (isHome ? globalThis.GXT.i18n.t("popup_popup_renderSheet_1") : target.dataset.title || globalThis.GXT.i18n.t("popup_popup_renderSheet_1")));
    document.querySelector('main').scrollTop = 0;
    if (focus) target.focus({ preventScroll: true });
    void ON_ENTER[target.dataset.view]?.();
  }

  /** The row that opened the current destination, so Back can return focus to
   *  it — what every real back button does, and the thing that makes keyboard
   *  travel through a drill-down list bearable. */
  let originRow = null;

  function setupNav() {
    for (const row of document.querySelectorAll('.nav-row[data-goto]')) {
      row.addEventListener('click', () => {
        originRow = row;
        goto(row.dataset.goto);
      });
    }
    // Appearance is edited in the sheet, but it still needs a place in the list
    // — otherwise the only way to reach a theme, a font or the text size is to
    // recognise a palette icon, and search cannot see inside a dialog at all.
    for (const row of document.querySelectorAll('.nav-row[data-sheet]')) {
      row.addEventListener('click', openSheet);
    }
    ui.navBack.addEventListener('click', () => {
      const row = originRow;
      goto('home', { focus: false });
      (row?.isConnected ? row : document.querySelector('.nav-row'))?.focus();
      originRow = null;
    });
  }

  /**
   * The live one-line state under each destination.
   *
   * This is what makes a drill-down list better than tabs rather than merely
   * tidier: "is bilingual on?" is answerable from the home screen instead of
   * two clicks away. Everything here reads settings that are already loaded or
   * chrome.storage directly — never a message to the service worker, which
   * would wake it on every popup open for a subtitle.
   */
  async function renderSummaries(known) {
    const settings = known || (await GXTS.getSettings());
    const on = (flag, label) => (flag ? label : null);
    const join = (...parts) => parts.filter(Boolean).join(' · ') || globalThis.GXT.i18n.t("content_youtube_togglePanel_74");

    const keys = await GXTS.getApiKeys();
    globalThis.GXT.i18n.bind($('sumEngine'), "textContent", () => (settings.provider === 'gemini'
        ? `Gemini · ${settings.model}${keys.length > 1 ? globalThis.GXT.i18n.t("popup_popup_renderSummaries_24", {v0:(faNum(keys.length))}) : ''}`
        : settings.provider === 'openai'
          ? `${settings.openaiModel || 'OpenAI'}${settings.openaiBaseUrl ? '' : globalThis.GXT.i18n.t("popup_popup_renderSummaries_23")}`
          : PROVIDER_LABEL[settings.provider] || settings.provider));

    globalThis.GXT.i18n.bind($('sumX'), "textContent", () => (join(
      settings.mode === 'auto' ? globalThis.GXT.i18n.t("shared_theme_THEMES_10") : globalThis.GXT.i18n.t("popup_popup_renderSummaries_22"),
      on(settings.replaceOriginal, globalThis.GXT.i18n.t("content_render_toggle_2")),
      on(settings.translateBios, globalThis.GXT.i18n.t("popup_popup_renderSummaries_21")),
      on(settings.dwellMode, globalThis.GXT.i18n.t("popup_popup_renderSummaries_20"))
    )));

    globalThis.GXT.i18n.bind($('sumYoutube'), "textContent", () => (settings.youtube === false
      ? globalThis.GXT.i18n.t("content_youtube_togglePanel_74")
      : join(
          on(settings.ytSubtitles !== false, globalThis.GXT.i18n.t("shared_video_sources_label_1")),
          on(settings.ytDub, globalThis.GXT.i18n.t("content_web_video_createManager_28")),
          on(settings.ytBilingual, globalThis.GXT.i18n.t("popup_popup_renderSummaries_17")),
          on(settings.ytAuto, globalThis.GXT.i18n.t("popup_popup_renderSummaries_19"))
        )));

    const siteCount = (settings.autoSites || []).length;
    globalThis.GXT.i18n.bind($('sumWeb'), "textContent", () => (join(
      on(settings.pageBlockMode, globalThis.GXT.i18n.t("popup_popup_renderSummaries_18")),
      on(settings.pageDynamic, globalThis.GXT.i18n.t("content_page_translate_acts_1")),
      on(settings.pageBilingual, globalThis.GXT.i18n.t("popup_popup_renderSummaries_17")),
      siteCount ? globalThis.GXT.i18n.t("popup_popup_renderSummaries_16", {v0:(faNum(siteCount))}) : null
    )));

    const engineLabel =
      (GXTS.TTS_ENGINES.find((e) => e.id === (settings.ttsEngine || 'bing')) || {}).label ||
      settings.ttsEngine;
    const voice = settings[GXTS.ttsVoiceKey(settings.ttsEngine || 'bing')] || '';
    $('sumVoice').textContent = `${engineLabel}${voice ? ` · ${voice.replace(/^fa-IR-|Neural$/g, '')}` : ''}`;

    globalThis.GXT.i18n.bind($('sumBridge'), "textContent", () => (settings.bridgeEnabled
      ? globalThis.GXT.i18n.t("popup_popup_renderSummaries_15", {v0:(faNum(settings.bridgePort || 8765))})
      : globalThis.GXT.i18n.t("popup_popup_renderSummaries_14")));

    globalThis.GXT.i18n.bind($('sumVideo'), "textContent", () => (join(
      on(settings.vsrHelper, globalThis.GXT.i18n.t("popup_popup_renderSummaries_13")),
      on(settings.vsrForceH264, globalThis.GXT.i18n.t("popup_popup_renderSummaries_12")),
      on(settings.videoSafeUi !== false, globalThis.GXT.i18n.t("popup_popup_renderSummaries_11"))
    )));

    const glossaryLines = (settings.glossary || '').split('\n').filter((l) => l.trim()).length;
    const overrides = Object.keys(settings.promptOverrides || {}).length;
    const customParts = [
      glossaryLines ? globalThis.GXT.i18n.t("popup_popup_message_3", {v0:(faNum(glossaryLines))}) : null,
      settings.customPrompt?.trim() ? globalThis.GXT.i18n.t("popup_popup_customParts_2") : null,
      overrides ? globalThis.GXT.i18n.t("popup_popup_customParts_1", {v0:(faNum(overrides))}) : null,
    ].filter(Boolean);
    // Nothing customised is not "off" — it is the untouched default, and the
    // row should describe what lives there instead of implying a disabled
    // feature.
    globalThis.GXT.i18n.bind($('sumCustom'), "textContent", () => (customParts.length
      ? customParts.join(' · ')
      : globalThis.GXT.i18n.t("popup_popup_renderSummaries_10")));

    // Statistics come straight from storage: the same object the worker
    // writes, with the same Pacific-day rollover applied, so the home screen
    // can show today's count without starting the worker.
    try {
      const stored = (await chrome.storage.local.get(GXTS.STATS_KEY))[GXTS.STATS_KEY];
      const today = GXTS.pacificDayAndReset().day;
      const dayCount = stored && stored.day === today ? stored.dayTranslated || 0 : 0;
      const total = stored?.translated || 0;
      globalThis.GXT.i18n.bind($('sumStats'), "textContent", () => (total
        ? globalThis.GXT.i18n.t("popup_popup_renderSummaries_9", {v0:(faNum(dayCount)), v1:(faNum(total))})
        : globalThis.GXT.i18n.t("popup_popup_renderSummaries_8")));
    } catch {
      globalThis.GXT.i18n.bind($('sumStats'), "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderSummaries_7")));
    }

    // Read the manifest, not another element's rendered text: building UI
    // text out of UI text makes this line depend on init ORDER, and it
    // silently shows the static fallback if it ever runs first (v2.9.5).
    // v3.0.0 — the new destinations answer "what is it set to?" from the home
    // list, exactly like every other row.
    const registerLabel = (GXTS.REGISTERS.find((r) => r.id === (settings.register || 'auto'))
      || GXTS.REGISTERS[0]).label;
    globalThis.GXT.i18n.bind($('sumQuality'), "textContent", () => (join(
      registerLabel,
      on(settings.qualityMode, globalThis.GXT.i18n.t("popup_popup_renderSummaries_6")),
      on(settings.memoryEnabled !== false, globalThis.GXT.i18n.t("popup_popup_renderSummaries_5"))
    )));
    globalThis.GXT.i18n.bind($('sumUpdates'), "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderSummaries_4", {v0:(appVersion())})));
    const profiledSites = Object.keys(settings.sitePrefs || {}).length;
    globalThis.GXT.i18n.bind($('sumBackup'), "textContent", () => (profiledSites
      ? globalThis.GXT.i18n.t("popup_popup_renderSummaries_3", {v0:(faNum(profiledSites))})
      : globalThis.GXT.i18n.t("popup_popup_renderSummaries_2")));

    globalThis.GXT.i18n.bind($('sumAbout'), "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderSummaries_1", {v0:(appVersion())})));

    const themeLabel = (T.THEMES.find((x) => x.id === settings.uiTheme) || T.THEMES[0]).label;
    const densityLabel = (T.DENSITIES.find((x) => x.id === settings.uiDensity) || {}).label || '';
    const accentLabel = (T.ACCENTS.find((x) => x.id === settings.uiAccent) || {}).label || '';
    $('sumLook').textContent = [themeLabel, accentLabel, densityLabel].filter(Boolean).join(' · ');
  }

  // -------------------------------------------------------- prompt editor

  /**
   * background/prompt.js, loaded only when the prompt editor is opened.
   *
   * It is a thousand lines whose only job in this window is to hand the editor
   * the built-in text of one prompt, and it used to be a <script> tag parsed on
   * every single popup open — for a screen most users never visit. Loading it
   * on demand takes the cost off the path that matters. (It is chrome-free, so
   * it is safe to run in this document.)
   */
  let promptModuleLoad = null;
  function ensurePromptModule() {
    if (globalThis.GXT?.prompt?.defaultPromptText) return Promise.resolve(true);
    if (!promptModuleLoad) {
      promptModuleLoad = new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = '../background/prompt.js';
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
      });
    }
    return promptModuleLoad;
  }

  function defaultPromptText(id) {
    try {
      return globalThis.GXT.prompt.defaultPromptText(id) || '';
    } catch {
      return '';
    }
  }

  async function loadPromptEditor() {
    await ensurePromptModule();
    const id = ui.promptTarget.value;
    const settings = await GXTS.getSettings();
    const overrides = settings.promptOverrides || {};
    const override = (overrides[id] || '').trim();
    ui.promptEditor.value = override || defaultPromptText(id);
    globalThis.GXT.i18n.bind(ui.promptState, "textContent", () => (override
      ? globalThis.GXT.i18n.t("popup_popup_loadPromptEditor_2")
      : globalThis.GXT.i18n.t("popup_popup_loadPromptEditor_1")));
    // `var(--accent)` / `var(--muted)` were written here since v1.8.5 and never
    // existed: the tokens are --gxt-accent-ink and --gxt-fg-muted, so this line
    // has been a silent no-op for eight releases. Using the class the rest of
    // the window uses means it cannot drift again.
    ui.promptState.className = `status${override ? ' ok' : ''}`;
  }

  ui.promptTarget.addEventListener('change', () => {
    setStatus(ui.promptStatus, '');
    void loadPromptEditor();
  });

  ui.promptSave.addEventListener('click', async () => {
    const id = ui.promptTarget.value;
    const text = ui.promptEditor.value;
    const settings = await GXTS.getSettings();
    const overrides = { ...(settings.promptOverrides || {}) };
    // Saving text identical to (or emptier than) the default clears the
    // override, so the prompt tracks future built-in improvements.
    let message;
    if (!text.trim() || text.trim() === defaultPromptText(id).trim()) {
      delete overrides[id];
      message = globalThis.GXT.i18n.t("popup_popup_message_39");
    } else {
      overrides[id] = text;
      message = globalThis.GXT.i18n.t("popup_popup_message_38");
    }
    await GXTS.setSettings({ promptOverrides: overrides });
    await loadPromptEditor();
    setStatus(ui.promptStatus, message, 'ok');
  });

  ui.promptReset.addEventListener('click', async () => {
    const id = ui.promptTarget.value;
    const settings = await GXTS.getSettings();
    const overrides = { ...(settings.promptOverrides || {}) };
    delete overrides[id];
    await GXTS.setSettings({ promptOverrides: overrides });
    ui.promptEditor.value = defaultPromptText(id);
    await loadPromptEditor();
    setStatus(ui.promptStatus, globalThis.GXT.i18n.t("popup_popup_message_37"), 'ok');
  });
  // ------------------------------------------------ per-model tuning (v1.9.0)

  /** Reflect the active model's advanced tuning. Hidden for keyless MT engines
   *  (no model); the thinking-level row is hidden for OpenAI (Gemini-only). */
  async function loadModelTuning() {
    const settings = await GXTS.getSettings();
    const model = GXTS.activeModelId(settings);
    const isMT = settings.provider === 'google' || settings.provider === 'bing';
    if (isMT || !model) {
      ui.modelTuningCard.classList.add('hidden');
      return;
    }
    ui.modelTuningCard.classList.remove('hidden');
    ui.tuningModelName.textContent = model;
    ui.thinkingRow.classList.toggle('hidden', settings.provider !== 'gemini');
    const tuning = GXTS.resolveModelTuning(settings, model);
    ui.thinkingLevel.value = tuning.thinkingLevel || '';
    ui.temperature.value = tuning.temperature == null ? '' : String(tuning.temperature);
  }

  /** Merge one tuning field into the active model's entry (empty value clears
   *  it); prune empty entries so the map never accumulates blanks. Writes are
   *  serialized through a queue: the thinking-level and temperature controls
   *  are separate read-modify-write cycles on the same object, so changing both
   *  in quick succession would otherwise let the later write clobber the
   *  earlier one. */
  let tuningQueue = Promise.resolve();
  function saveTuningField(field, value) {
    tuningQueue = tuningQueue
      .then(async () => {
        const settings = await GXTS.getSettings();
        const model = GXTS.activeModelId(settings);
        if (!model) return;
        const map = { ...(settings.modelTuning || {}) };
        const entry = { ...(map[model] || {}) };
        if (value == null || value === '') delete entry[field];
        else entry[field] = value;
        if (Object.keys(entry).length) map[model] = entry;
        else delete map[model];
        await GXTS.setSettings({ modelTuning: map });
      })
      .catch(() => {});
    return tuningQueue;
  }

  ui.thinkingLevel.addEventListener('change', () => {
    void saveTuningField('thinkingLevel', ui.thinkingLevel.value || null);
  });
  ui.temperature.addEventListener('change', () => {
    const raw = ui.temperature.value.trim();
    if (raw === '') {
      void saveTuningField('temperature', null);
      return;
    }
    let n = parseFloat(raw);
    if (!Number.isFinite(n)) {
      void loadModelTuning(); // revert unparseable input
      return;
    }
    n = Math.max(0, Math.min(2, Math.round(n * 100) / 100));
    ui.temperature.value = String(n);
    void saveTuningField('temperature', n);
  });

  ui.batchSize.addEventListener('change', () => {
    const value = Math.max(1, Math.min(20, parseInt(ui.batchSize.value, 10) || 8));
    void GXTS.setSettings({ batchSize: value });
  });
  ui.model.addEventListener('change', async () => {
    await GXTS.setSettings({ model: ui.model.value });
    void loadModelTuning();
    void renderSummaries();
  });
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', () => {
      if (radio.checked) void GXTS.setSettings({ mode: radio.value }).then(renderSummaries);
    });
  }

  ui.provider.addEventListener('change', async () => {
    const provider = ui.provider.value;
    // Machine-translation engines need their host origin before the worker
    // can reach them; ask now and revert the choice if the user declines.
    const origin = MT_ORIGIN[provider];
    if (origin && chrome.permissions?.request) {
      const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
      if (!granted) {
        ui.provider.value = (await GXTS.getSettings()).provider;
        return;
      }
    }
    await GXTS.setSettings({ provider });
    showProviderSections(provider);
    void syncBrandStatus();
    void loadModelTuning();
    void renderSummaries();
    if (statsActive()) void loadStats();
  });

  // -------------------------------------------------- local bridge (v2.5.0)

  const CAP_LABELS = {
    get tts() { return globalThis.GXT.i18n.t("popup_popup_CAP_LABELS_4"); },
    get asr() { return globalThis.GXT.i18n.t("popup_popup_CAP_LABELS_3"); },
    get manga() { return globalThis.GXT.i18n.t("popup_popup_CAP_LABELS_2"); },
    get upscale() { return globalThis.GXT.i18n.t("popup_popup_CAP_LABELS_1"); },
  };

  function paintBridgeChip(settings, health) {
    const chip = $('bridgeChip');
    if (!chip) return;
    if (!settings.bridgeEnabled) { globalThis.GXT.i18n.bind(chip, "textContent", () => (globalThis.GXT.i18n.t("content_youtube_togglePanel_74"))); chip.className = 'chip-mini warn'; return; }
    if (!health) { globalThis.GXT.i18n.bind(chip, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_paintBridgeChip_3"))); chip.className = 'chip-mini warn'; return; }
    if (health.ok && health.name === 'tarjoman-bridge') {
      const ready = Object.values(health.capabilities || {}).filter((c) => c.available).length;
      globalThis.GXT.i18n.bind(chip, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_paintBridgeChip_2", {v0:(faNum(ready))})));
      chip.className = 'chip-mini';
    } else {
      globalThis.GXT.i18n.bind(chip, "textContent", () => (health.code === 'OFFLINE' ? globalThis.GXT.i18n.t("popup_popup_paintBridgeChip_1") : globalThis.GXT.i18n.t("content_youtube_label_2")));
      chip.className = 'chip-mini warn';
    }
  }

  /**
   * Escape text that came from somewhere other than this file.
   *
   * The bridge report below is built with innerHTML, and every interesting
   * value in it — the error string, the version, each capability's hint — is
   * whatever answered on `http://127.0.0.1:<port>`. The port is a user setting,
   * so that is NOT necessarily our bridge: any local process can answer, and
   * some other program's crash message would be injected as markup into the
   * extension's own page. MV3's CSP stops it becoming script execution, which
   * leaves defacing the settings window — still not something a stray local
   * service gets to do.
   */
  const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  /**
   * Report the bridge honestly.
   *
   * A capability that is missing is shown with the command that installs it,
   * NOT as a failure. The difference between "broken" and "not installed yet"
   * is the entire user experience of an optional companion app.
   */
  function renderBridgeReport(health) {
    const box = $('bridgeReport');
    if (!box) return;
    box.classList.remove('hidden');
    // `ok:true` alone is not proof this is our bridge — anything at all could
    // be listening on a local port, and reporting «متصل شد — نسخهٔ undefined»
    // is worse than saying plainly that the answer was not recognised.
    const isBridge = health?.ok && health.name === 'tarjoman-bridge' && health.capabilities;
    if (!isBridge) {
      const message =
        health?.code === 'OFFLINE'
          ? globalThis.GXT.i18n.t("popup_popup_message_36")
          : health?.code === 'BAD_TOKEN'
            ? globalThis.GXT.i18n.t("popup_popup_message_35")
            : health?.ok
              ? globalThis.GXT.i18n.t("popup_popup_message_34")
              : escapeHtml(health?.error || globalThis.GXT.i18n.t("popup_popup_renderUpdates_8"));
      // The first three branches are our own literals (one carries a <code>
      // tag on purpose); only the last is foreign, and it is escaped above.
      box.innerHTML = `<p class="warn">${message}</p>`;
      return;
    }
    const rows = Object.entries(health.capabilities || {}).map(([id, cap]) => {
      // `id` is a key from the foreign JSON, so it can only be trusted after
      // CAP_LABELS has failed to recognise it.
      const label = escapeHtml(CAP_LABELS[id] || id);
      return cap.available
        ? `<li>✅ ${label}</li>`
        : `<li>⬜ ${label} <span class="faint">— ${escapeHtml(cap.hint || globalThis.GXT.i18n.t("popup_popup_renderUpdates_8"))}</span></li>`;
    });
    globalThis.GXT.i18n.bind(box, "innerHTML", () => (globalThis.GXT.i18n.t("popup_popup_renderBridgeReport_2", {v0:(escapeHtml(health.version)), v1:(rows.join(''))}) +
      (health.ffmpeg ? '' : globalThis.GXT.i18n.t("popup_popup_renderBridgeReport_1"))));
  }

  async function refreshBridge({ force = false } = {}) {
    // Read the CHECKBOX, not storage. The change handler that calls this also
    // starts the write, and re-reading storage here raced it — the section
    // stayed hidden until the popup was reopened.
    const on = $('bridgeEnabled') ? $('bridgeEnabled').checked : false;
    $('bridgeSection')?.classList.toggle('hidden', !on);
    const settings = { ...(await GXTS.getSettings()), bridgeEnabled: on };
    if (!on) { paintBridgeChip(settings, null); return null; }
    const health = await chrome.runtime.sendMessage({ type: 'BRIDGE_HEALTH', force }).catch(() => null);
    paintBridgeChip(settings, health);
    return health;
  }

  $('bridgeEnabled')?.addEventListener('change', () => void refreshBridge());
  $('bridgeCheck')?.addEventListener('click', async () => {
    const button = $('bridgeCheck');
    button.disabled = true;
    globalThis.GXT.i18n.bind(button, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_checkUpdates_5")));
    const health = await refreshBridge({ force: true });
    renderBridgeReport(health);
    // A bridge that just answered can also say which voices and Whisper sizes
    // it has — asking now means the lists are current the moment the user
    // walks over to them, without a second button to press.
    if (health?.ok) {
      const local = await chrome.runtime.sendMessage({ type: 'LIST_LOCAL_MODELS' }).catch(() => null);
      if (local?.ok) populateLocalVoices(local, await GXTS.getSettings());
    }
    button.disabled = false;
    globalThis.GXT.i18n.bind(button, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_message_33")));
  });
  if ($('bridgeToken')) wireTextSetting($('bridgeToken'), 'bridgeToken');
  $('bridgePort')?.addEventListener('change', () => {
    const port = Math.max(1024, Math.min(65535, parseInt($('bridgePort').value, 10) || 8765));
    $('bridgePort').value = String(port);
    void GXTS.setSettings({ bridgePort: port });
  });
  $('bridgeAsrModel')?.addEventListener('change', () =>
    void GXTS.setSettings({ bridgeAsrModel: $('bridgeAsrModel').value }));

  // v2.5.8 — how many manga pages the local pipeline overlaps.
  $('mangaConcurrency')?.addEventListener('input', () => {
    const value = $('mangaConcurrency').value;
    if ($('mangaConcurrencyVal')) $('mangaConcurrencyVal').textContent = faNum(value);
  });
  $('mangaConcurrency')?.addEventListener('change', () =>
    void GXTS.setSettings({ mangaConcurrency: Number($('mangaConcurrency').value) || 3 }));

  // ---------------------------------------------------- subtitles (v2.3.0)

  $('openSubtitles')?.addEventListener('click', () => {
    // A full page, not a popup panel: it takes file drops, shows progress over
    // minutes, and must survive the popup closing.
    const url = chrome.runtime.getURL('pages/subtitles.html');
    if (chrome.tabs?.create) chrome.tabs.create({ url });
    else window.open(url, '_blank');
    window.close();
  });

  // ------------------------------------------------------- speech (v2.2.0)

  const faRate = (n) =>
    `${globalThis.GXT.i18n.number(n, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}×`;

  /** sendMessage that resolves to null instead of throwing when the worker is
   *  restarting — every TTS control here is optional UI, never a hard failure. */
  const ttsSend = (message) => send(message);
  let previewJob = 0, previewAudio = null, previewSettings = '';
  const previewLabel = $('ttsTest')?.textContent;
  const voiceIdentity = settings => JSON.stringify([GXTS.resolveTts(settings), settings.openaiBaseUrl, settings.bridgePort, settings.bridgeToken, settings.bridgeEnabled]);
  function stopTtsPreview() {
    previewJob += 1;
    previewAudio?.pause();
    previewAudio = null;
    if ($('ttsTest')) { $('ttsTest').disabled = false; $('ttsTest').textContent = previewLabel; }
  }
  GXTS.onStorageChanged(({ settings, apiKeyChanged }) => {
    const next = settings ? voiceIdentity(settings) : previewSettings;
    if (apiKeyChanged || (previewSettings && next !== previewSettings)) stopTtsPreview();
    previewSettings = next;
  });
  window.addEventListener('pagehide', stopTtsPreview);

  /** The Microsoft voice catalogue as last reported by the local bridge —
   *  the real list, rather than the five this file knows by heart. Empty
   *  until a refresh has succeeded, which is the normal state. */
  let localVoices = [];
  /** The last discovery, split into translation / speech / live. */
  let discoveredGroups = null;
  chrome.storage.onChanged.addListener(async(changes,area)=>{
    if(area!=='local'||!(GXTS.MODEL_LIST_KEY in changes))return;
    discoveredGroups=GXTS.classifyModels(changes[GXTS.MODEL_LIST_KEY].newValue);
    populateEngineModels(discoveredGroups,await GXTS.getSettings());
  });

  /** Fill the voice list for an engine, keeping the user's saved choice when
   *  it is still valid for that engine. */
  function populateVoices(engine, settings) {
    const select = $('ttsVoice');
    if (!select) return;
    select.replaceChildren();
    const seen = new Set();
    const add = (value, label) => {
      if (seen.has(value)) return;
      seen.add(value);
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    };
    if (engine === 'gemini') {
      for (const v of GXTS.TTS_GEMINI_VOICES) add(v, v);
    } else if (engine === 'openai') {
      for (const v of GXTS.TTS_OPENAI_VOICES) add(v, v);
    } else {
      // Bing and the bridge drive the SAME Microsoft voices, so they share
      // this list. The curated five stay at the top — they are the ones worth
      // reaching for — and everything the machine discovered follows.
      for (const v of GXTS.TTS_BING_VOICES) add(v.id, v.label);
      for (const v of localVoices) {
        add(v.id, v.locale?.startsWith('fa') ? `${v.label} — ${v.id}` : globalThis.GXT.i18n.t("popup_popup_populateVoices_1", {v0:(v.id)}));
      }
    }
    const saved = settings[GXTS.ttsVoiceKey(engine)] || GXTS.DEFAULTS[GXTS.ttsVoiceKey(engine)];
    // A voice saved before a list changed must not silently vanish: keep it.
    if (saved && ![...select.options].some((o) => o.value === saved)) add(saved, saved);
    select.value = saved;
  }

  /** Show only the fields the chosen engine actually uses. */
  function showTtsSections(engine) {
    const hint = $('ttsVoiceHint');
    if (hint) {
      globalThis.GXT.i18n.bind(hint, "textContent", () => (engine === 'bing' ? globalThis.GXT.i18n.t("popup_popup_showTtsSections_3") : engine === 'gemini' ? globalThis.GXT.i18n.t("popup_popup_showTtsSections_2") : globalThis.GXT.i18n.t("popup_popup_showTtsSections_1")));
    }
    $('ttsGeminiModelField')?.classList.toggle('hidden', engine !== 'gemini');
    $('ttsOpenaiModelField')?.classList.toggle('hidden', engine !== 'openai');
    // Gemini has no speaking-rate parameter — its pace comes from the style
    // direction instead. Saying so beats a control that silently does nothing.
    const help = $('ttsRateHelp');
    if (help) help.classList.toggle('hidden', engine !== 'gemini');
    $('ttsRate')?.toggleAttribute('disabled', engine === 'gemini');
    // The delivery direction is a Gemini-only concept (the text IS the prompt
    // there); Bing and OpenAI take no such instruction.
    $('ttsStyle')?.closest('details')?.classList.toggle('hidden', engine !== 'gemini');
  }

  async function refreshTtsCacheNote() {
    const note = $('ttsCacheNote');
    if (!note) return;
    const response = await ttsSend({ type: 'TTS_CACHE_STATS' });
    if (!response?.ok || !response.count) {
      globalThis.GXT.i18n.bind(note, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_refreshTtsCacheNote_2")));
      return;
    }
    const mb = (response.bytes / (1024 * 1024)).toFixed(1);
    globalThis.GXT.i18n.bind(note, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_refreshTtsCacheNote_1", {v0:(faNum(response.count)), v1:(faNum(mb))})));
  }

  function wireTts() {
    const engineSelect = $('ttsEngine');
    if (!engineSelect) return;
    for (const engine of GXTS.TTS_ENGINES) {
      const option = document.createElement('option');
      option.value = engine.id;
      option.textContent = engine.label;
      option.title = engine.note;
      engineSelect.appendChild(option);
    }
    const modelSelect = $('ttsModelGemini');

    engineSelect.addEventListener('change', async () => {
      const engine = engineSelect.value;
      // Bing needs its origin before the worker can reach it. Request FIRST:
      // any await before chrome.permissions.request kills the user gesture and
      // the prompt never appears (the v1.9.5 lesson).
      if (engine === 'bing' && chrome.permissions?.request) {
        const granted = await chrome.permissions
          .request({ origins: ['https://www.bing.com/*'] })
          .catch(() => false);
        if (!granted) {
          engineSelect.value = (await GXTS.getSettings()).ttsEngine;
          return;
        }
      }
      await GXTS.setSettings({ ttsEngine: engine });
      populateVoices(engine, await GXTS.getSettings());
      showTtsSections(engine);
    });

    $('ttsVoice')?.addEventListener('change', async () => {
      const engine = engineSelect.value;
      await GXTS.setSettings({ [GXTS.ttsVoiceKey(engine)]: $('ttsVoice').value });
    });

    modelSelect?.addEventListener('change', () =>
      GXTS.setSettings({ ttsModelGemini: modelSelect.value })
    );

    // The live dubbing engine's model. Empty = let live.js pick, which is the
    // right default: it already falls through to a general live model when the
    // key has no access to the dedicated speech-translation one.
    $('ytLiveModel')?.addEventListener('change', () =>
      GXTS.setSettings({ ytLiveModel: $('ytLiveModel').value })
    );

    $('refreshDubModels')?.addEventListener('click',async()=>{
      const button=$('refreshDubModels'),status=$('dubModelsStatus');button.disabled=true;globalThis.GXT.i18n.bind(status, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_wireTts_11")));
      try {
        const res=await refreshModelList({includeLocal:false});
        globalThis.GXT.i18n.bind(status, "textContent", () => (res?.ok?globalThis.GXT.i18n.t("popup_popup_wireTts_10", {v0:(faNum(res.groups?.live?.length??GXTS.classifyModels(res.models).live.length))}):(res?.error||globalThis.GXT.i18n.t("popup_popup_wireTts_9"))));
      }catch{globalThis.GXT.i18n.bind(status, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_wireTts_8")));}finally{button.disabled=false;}
    });

    // The same discovery the ⟳ beside the translation model runs — offered
    // here too, because this is where someone looking for a newer VOICE model
    // actually is.
    $('refreshTtsModels')?.addEventListener('click', async () => {
      const button = $('refreshTtsModels');
      const hint = $('ttsRefreshHint');
      const original = hint?.textContent || '';
      button.disabled = true;
      if (hint) globalThis.GXT.i18n.bind(hint, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_wireTts_7")));
      const res = await refreshModelList();
      if (hint) {
        const groups = res?.ok ? GXTS.classifyModels(res.models) : null;
        globalThis.GXT.i18n.bind(hint, "textContent", () => (groups
          ? globalThis.GXT.i18n.t("popup_popup_wireTts_6", {v0:(faNum(groups.tts.length)), v1:(faNum(groups.live.length))}) +
            (localVoices.length ? globalThis.GXT.i18n.t("popup_popup_wireTts_5", {v0:(faNum(localVoices.length))}) : '')
          : localVoices.length
            ? globalThis.GXT.i18n.t("popup_popup_wireTts_4", {v0:(faNum(localVoices.length))})
            : res?.code === 'NO_KEY'
              ? globalThis.GXT.i18n.t("popup_popup_wireTts_3")
              : original));
      }
      button.disabled = false;
    });

    let openaiModelTimer = null;
    $('ttsModelOpenai')?.addEventListener('input', () => {
      clearTimeout(openaiModelTimer);
      openaiModelTimer = setTimeout(
        () => GXTS.setSettings({ ttsModelOpenai: $('ttsModelOpenai').value.trim() }),
        400
      );
    });

    const rate = $('ttsRate');
    rate?.addEventListener('input', () => {
      $('ttsRateVal').textContent = faRate(rate.value);
    });
    rate?.addEventListener('change', () => GXTS.setSettings({ ttsRate: Number(rate.value) }));

    let styleTimer = null;
    $('ttsStyle')?.addEventListener('input', () => {
      clearTimeout(styleTimer);
      styleTimer = setTimeout(() => GXTS.setSettings({ ttsStyle: $('ttsStyle').value.trim() }), 500);
    });

    $('ttsTest')?.addEventListener('click', async () => {
      stopTtsPreview();
      const myJob = previewJob;
      const button = $('ttsTest');
      const original = button.textContent;
      button.disabled = true;
      globalThis.GXT.i18n.bind(button, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_wireTts_2")));
      const response = await ttsSend({
        type: 'TTS_SPEAK',
        get text() { return globalThis.GXT.i18n.t("popup_popup_response_1"); },
      });
      if (myJob !== previewJob) return;
      button.disabled = false;
      button.textContent = original;
      if (!response?.ok) {
        setStatus($('ttsCacheNote'), response?.error || globalThis.GXT.i18n.t("popup_popup_wireTts_1"), 'warn');
        return;
      }
      // The popup is a normal extension page, so a plain <audio> is fine here —
      // the Web Audio path in the content script exists for page CSP, which
      // does not apply to this document.
      previewAudio = new Audio(`data:${response.mime};base64,${response.data}`);
      void previewAudio.play().catch(() => {});
      void refreshTtsCacheNote();
    });

    $('ttsClearCache')?.addEventListener('click', async () => {
      await ttsSend({ type: 'TTS_CLEAR_CACHE' });
      void refreshTtsCacheNote();
    });
  }

  function loadTts(settings) {
    previewSettings = voiceIdentity(settings);
    const cfg = GXTS.resolveTts(settings);
    const engineSelect = $('ttsEngine');
    if (!engineSelect) return;
    engineSelect.value = cfg.engine;
    populateVoices(cfg.engine, settings);
    showTtsSections(cfg.engine);
    // Speech and live-dubbing models come from the same place the translation
    // dropdown does: the curated entries, plus whatever the last ⟳ discovered.
    populateEngineModels(discoveredGroups, settings);
    const openaiModel = $('ttsModelOpenai');
    if (openaiModel) openaiModel.value = settings.ttsModelOpenai || '';
    const rate = $('ttsRate');
    if (rate) {
      rate.value = String(cfg.rate);
      $('ttsRateVal').textContent = faRate(cfg.rate);
    }
    const style = $('ttsStyle');
    if (style) style.value = settings.ttsStyle || '';
    void refreshTtsCacheNote();
  }

  ui.font.addEventListener('change', async () => {
    await GXTS.setSettings({ font: ui.font.value });
    updateFontPreview(await GXTS.getSettings());
  });

  let customFontTimer = null;
  ui.customFont.addEventListener('input', () => {
    clearTimeout(customFontTimer);
    customFontTimer = setTimeout(async () => {
      await GXTS.setSettings({ customFont: ui.customFont.value.trim() });
      updateFontPreview(await GXTS.getSettings());
    }, 400);
  });

  ui.dailyQuota.addEventListener('change', () => {
    const value = Math.max(0, parseInt(ui.dailyQuota.value, 10) || 0);
    void GXTS.setSettings({ dailyQuota: value }).then(loadStats);
  });

  ui.saveKey.addEventListener('click', async () => {
    const keys = ui.apiKeys.value
      .split('\n')
      .map((k) => k.trim())
      .filter(Boolean);
    await GXTS.setApiKeys(keys);
    if (!keys.length) {
      setStatus(ui.keyStatus, globalThis.GXT.i18n.t("popup_popup_message_32"), 'warn');
      return;
    }
    setStatus(ui.keyStatus, globalThis.GXT.i18n.t("popup_popup_checkUpdates_5"));
    ui.saveKey.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'TEST_KEY', keys });
      if (res?.ok) {
        const all = res.valid === res.total;
        setStatus(
          ui.keyStatus,
          globalThis.GXT.i18n.t("popup_popup_message_31", {v0:(faNum(res.valid)), v1:(faNum(res.total)), v2:(all ? '✓' : '— ' + (res.error || ''))}),
          all ? 'ok' : 'warn'
        );
        await refreshModelList();
      } else {
        setStatus(ui.keyStatus, res?.error || globalThis.GXT.i18n.t("popup_popup_message_30"), 'err');
      }
    } catch {
      setStatus(ui.keyStatus, globalThis.GXT.i18n.t("popup_popup_message_29"), 'err');
    }
    ui.saveKey.disabled = false;
    void syncBrandStatus();
    void renderSummaries();
    if (statsActive()) void loadStats();
  });

  ui.refreshModels.addEventListener('click', async () => {
    ui.refreshModels.disabled = true;
    globalThis.GXT.i18n.bind(ui.modelHint, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_message_28")));
    const res = await refreshModelList();
    if (res?.ok) {
      // Report the three lists separately: one pass fills all of them, and a
      // single total would hide that the speech and dubbing pickers just
      // refreshed too.
      const groups = discoveredGroups || GXTS.classifyModels(res.models);
      globalThis.GXT.i18n.bind(ui.modelHint, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_message_27", {v0:(faNum(groups.text.length))}) +
        globalThis.GXT.i18n.t("popup_popup_message_26", {v0:(faNum(groups.tts.length)), v1:(faNum(groups.live.length))})));
    } else if (res?.code === 'NO_KEY') globalThis.GXT.i18n.bind(ui.modelHint, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_message_25")));
    else globalThis.GXT.i18n.bind(ui.modelHint, "textContent", () => (res?.error || globalThis.GXT.i18n.t("popup_popup_message_24")));
    ui.refreshModels.disabled = false;
  });

  ui.oaiSave.addEventListener('click', async () => {
    const baseUrl = ui.oaiBase.value.trim().replace(/\/+$/, '');
    const model = ui.oaiModel.value.trim();
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
      setStatus(ui.oaiStatus, globalThis.GXT.i18n.t("popup_popup_message_23"), 'err');
      return;
    }
    ui.oaiSave.disabled = true;
    try {
      // Chrome needs origin permission before the worker may call this host.
      // Match patterns cannot carry a port, so build the origin from
      // protocol+hostname only (a port would be rejected as invalid, which
      // silently broke the localhost Ollama / LM Studio presets).
      if (chrome.permissions?.request) {
        const parsed = new URL(baseUrl);
        const origin = `${parsed.protocol}//${parsed.hostname}/*`;
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) {
          setStatus(ui.oaiStatus, globalThis.GXT.i18n.t("popup_popup_message_22"), 'err');
          ui.oaiSave.disabled = false;
          return;
        }
      }
      await GXTS.setOpenaiKey(ui.oaiKey.value);
      await GXTS.setSettings({ openaiBaseUrl: baseUrl, openaiModel: model });
      void loadModelTuning();
      setStatus(ui.oaiStatus, globalThis.GXT.i18n.t("popup_popup_checkUpdates_5"));
      const res = await chrome.runtime.sendMessage({ type: 'LIST_MODELS', provider: 'openai' });
      if (res?.ok) {
        populateOaiModelList(res.models);
        const known = model && res.models.some((m) => m.id === model);
        setStatus(
          ui.oaiStatus,
          globalThis.GXT.i18n.t("popup_popup_message_21", {v0:(faNum(res.models.length))}) +
            (model && !known ? globalThis.GXT.i18n.t("popup_popup_message_20") : ''),
          model && !known ? 'warn' : 'ok'
        );
      } else {
        setStatus(ui.oaiStatus, res?.error || globalThis.GXT.i18n.t("popup_popup_message_19"), 'err');
      }
    } catch (error) {
      setStatus(ui.oaiStatus, String(error?.message || error), 'err');
    }
    ui.oaiSave.disabled = false;
    void syncBrandStatus();
    void renderSummaries();
    if (statsActive()) void loadStats();
  });

  ui.oaiModel.addEventListener('change', async () => {
    await GXTS.setSettings({ openaiModel: ui.oaiModel.value.trim() });
    void loadModelTuning();
  });

  ui.clearCache.addEventListener('click', async () => {
    ui.clearCache.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
      globalThis.GXT.i18n.bind(ui.clearCache, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_message_18")));
      setTimeout(() => {
        globalThis.GXT.i18n.bind(ui.clearCache, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_message_17")));
        ui.clearCache.disabled = false;
      }, 1500);
    } catch {
      ui.clearCache.disabled = false;
    }
  });

  ui.resetStats.addEventListener('click', async () => {
    ui.resetStats.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'RESET_STATS' });
      await loadStats();
      globalThis.GXT.i18n.bind(ui.resetStats, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_message_16")));
      setTimeout(() => {
        globalThis.GXT.i18n.bind(ui.resetStats, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_message_15")));
        ui.resetStats.disabled = false;
      }, 1500);
    } catch {
      ui.resetStats.disabled = false;
    }
  });

  // Live stats: while the popup is open on the آمار tab, a background
  // translation writing the stats object refreshes the view (debounced so a
  // burst of writes doesn't hammer the render).
  const statsActive = () =>
    $('view-stats').classList.contains('active') && !document.body.classList.contains('searching');
  let statsRefreshTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[GXTS.STATS_KEY] && statsActive()) {
      clearTimeout(statsRefreshTimer);
      statsRefreshTimer = setTimeout(() => void loadStats(), 400);
    }
  });

  // ===================================================== appearance (v2.0.0)
  //
  // The whole UI is driven by the token module: `look` holds the appearance
  // settings, applying it re-points the semantic CSS variables on <html>, and
  // every surface (popup, X box, page cards, YouTube panel) follows the same
  // choice because they all read the same tokens.

  const T = globalThis.GXT.theme;
  let appearanceWrites=0;
  let appearanceRevision=0;
  const appearanceFields = [
    ['uiRadius',globalThis.GXT.i18n.t("popup_popup_appearanceFields_11"),0,26,1,13,'px'],
    ['uiShadow',globalThis.GXT.i18n.t("popup_popup_appearanceFields_10"),0,1.5,0.1,1,'×'],
    ['uiOpacity',globalThis.GXT.i18n.t("popup_popup_appearanceFields_9"),55,100,1,84,'%'],
    ['uiBlur',globalThis.GXT.i18n.t("popup_popup_appearanceFields_8"),0,28,1,16,'px'],
    ['uiScale',globalThis.GXT.i18n.t("popup_popup_appearanceFields_7"),0.85,1.2,0.05,1,'×'],
    ['uiTextScale',globalThis.GXT.i18n.t("popup_popup_appearanceFields_6"),0.9,1.3,0.05,1,'×'],
    ['uiTitleScale',globalThis.GXT.i18n.t("popup_popup_appearanceFields_5"),0.9,1.3,0.05,1,'×'],
    ['uiSpacingScale',globalThis.GXT.i18n.t("popup_popup_appearanceFields_4"),0.8,1.4,0.05,1,'×'],
    ['uiControlScale',globalThis.GXT.i18n.t("popup_popup_appearanceFields_3"),0.85,1.25,0.05,1,'×'],
    ['uiWeight',globalThis.GXT.i18n.t("popup_popup_appearanceFields_2"),350,650,50,400,''],
    ['uiMotionSpeed',globalThis.GXT.i18n.t("popup_popup_appearanceFields_1"),0.5,2,0.1,1,'×'],
  ];
  const appearanceOptions = [
    ['uiButtonShape',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_19"),[['pill',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_18")],['rounded',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_16")],['square',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_15")]]],
    ['uiSwitchShape',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_17"),[['pill',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_16")],['square',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_15")]]],
    ['uiInputStyle',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_14"),[['filled',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_13")],['outline',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_12")]]],
    ['uiPanelStyle',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_11"),[['bordered',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_10")],['quiet',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_9")],['accent',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_8")],['contrast',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_7")]]],
    ['uiScrollbar',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_6"),[['thin',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_5")],['auto',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_4")]]],
    ['uiMotion',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_3"),[['auto',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_2")],['reduce',globalThis.GXT.i18n.t("popup_popup_appearanceOptions_1")]]],
  ];
  const appearanceColors = [
    ['uiCustomAccent',globalThis.GXT.i18n.t("popup_popup_appearanceColors_6"),'#1d9bf0'],['uiSecondaryColor',globalThis.GXT.i18n.t("popup_popup_appearanceColors_5"),'#7c5cf5'],
    ['uiSuccessColor',globalThis.GXT.i18n.t("popup_popup_appearanceColors_4"),'#12b981'],['uiWarningColor',globalThis.GXT.i18n.t("popup_popup_appearanceColors_3"),'#eab308'],
    ['uiErrorColor',globalThis.GXT.i18n.t("content_youtube_label_2"),'#f43f5e'],['uiBackground',globalThis.GXT.i18n.t("popup_popup_appearanceColors_2"),'#0e1014'],['uiCardColor',globalThis.GXT.i18n.t("popup_popup_appearanceColors_1"),'#171a21'],
  ];
  function buildAppearanceControls() {
    const parent=$('appearanceControls');
    for(const [key,label,min,max,step,fallback,suffix] of appearanceFields) {
      const row=document.createElement('label');row.className='appearance-control';row.htmlFor=key;
      const text=document.createElement('span');text.textContent=label;
      const output=document.createElement('output');output.htmlFor=key;output.id=`${key}Value`;
      const control=document.createElement('input');control.type='range';control.id=key;control.min=min;control.max=max;control.step=step;
      control.addEventListener('input',()=>{look[key]=Number(control.value);look.uiPreset='custom';output.textContent=`${faNum(control.value)}${suffix}`;applyLook();});
      control.addEventListener('change',()=>saveLook({[key]:Number(control.value)}));
      row.append(text,output,control);parent.append(row);
    }
    for(const [key,label,options] of appearanceOptions) {
      const row=document.createElement('label');row.className='field slim';row.htmlFor=key;row.textContent=label;
      const control=document.createElement('select');control.id=key;
      for(const [value,text] of options){const o=document.createElement('option');o.value=value;o.textContent=text;control.append(o);}
      control.addEventListener('change',()=>saveLook({[key]:control.value}));row.append(control);parent.append(row);
    }
    const note=document.createElement('p');note.className='row-help open';globalThis.GXT.i18n.bind(note, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_buildAppearanceControls_2")));parent.append(note);
    for(const [key,label,fallback] of appearanceColors){
      const row=document.createElement('div');row.className='appearance-color';
      const caption=document.createElement('label');caption.htmlFor=key;caption.textContent=label;
      const control=document.createElement('input');control.id=key;control.type='color';control.value=fallback;
      control.addEventListener('input',()=>{look[key]=control.value;look.uiPreset='custom';applyLook();});
      control.addEventListener('change',()=>saveLook({[key]:control.value}));
      const reset=document.createElement('button');reset.type='button';reset.className='ghost';globalThis.GXT.i18n.bind(reset, "textContent", () => (globalThis.GXT.i18n.t("shared_theme_THEMES_10")));globalThis.GXT.i18n.bind(reset,'ariaLabel',()=>(globalThis.GXT.i18n.t("popup_popup_buildAppearanceControls_1", {v0:(label)})));reset.addEventListener('click',()=>saveLook({[key]:''}));
      row.append(caption,control,reset);$('appearanceColors').append(row);
    }
  }

  GXTS.onStorageChanged(({settings})=>{
    if(!settings)return;
    loadWebVideo(settings);
    if(!appearanceWrites && T.settingsKey(settings)!==T.settingsKey(look)) {
      look=Object.fromEntries(T.APPEARANCE_KEYS.map(key=>[key,key==='videoSafeUi'?settings[key]!==false:(settings[key]??T.APPEARANCE_DEFAULTS[key])]));
      applyLook();renderSheet();
    }
  });

  function applyLook() {
    T.apply(document.documentElement, look);
    document.body.classList.toggle('hints-on', !!look.showHints);
  }

  /** Change one appearance setting: apply instantly, then persist.
   *
   *  The sheet is rebuilt from the new state rather than patched, which is the
   *  simplest thing that can be correct — but it destroys the node that was
   *  just clicked, so the focus position is captured and restored around it.
   *  Without that, choosing a theme with the keyboard silently dropped focus
   *  to <body>. */
  function saveLook(patch) {
    const revision=++appearanceRevision;
    const active = document.activeElement;
    const group = active?.closest?.('[role="radiogroup"]') || null;
    const index = group ? [...group.querySelectorAll('[role="radio"]')].indexOf(active) : -1;
    if (!Object.hasOwn(patch,'uiPreset') && Object.keys(patch).some(k=>k.startsWith('ui'))) patch={...patch,uiPreset:'custom'};
    Object.assign(look, patch);
    applyLook();
    renderSheet();
    if (group && index >= 0) {
      group.querySelectorAll('[role="radio"]')[index]?.focus();
    }
    appearanceWrites++;
    void GXTS.setSettings(patch).then(() => { globalThis.GXT.i18n.bind($('appearanceStatus'), "textContent", () => (globalThis.GXT.i18n.t("popup_popup_saveLook_1")));renderSummaries(); })
      .catch(error=>{$('appearanceStatus').textContent=error.message;})
      .finally(async()=>{
        appearanceWrites--;
        if(appearanceWrites)return;
        try {
          const stored=await GXTS.getSettings();
          if(appearanceWrites||revision!==appearanceRevision)return;
          // Another popup may have written while this save was pending. Read
          // the serialized result once rather than retaining an optimistic
          // snapshot that no longer matches storage. Failed writes recover too.
          if(T.settingsKey(stored)!==T.settingsKey(look)){
            look=Object.fromEntries(T.APPEARANCE_KEYS.map(key=>[key,key==='videoSafeUi'?stored[key]!==false:(stored[key]??T.APPEARANCE_DEFAULTS[key])]));
            applyLook();renderSheet();
          }
        }catch{}
      });
  }

  /** A segmented-control option. `role=radio` + `aria-checked` is what makes a
   *  row of buttons announce as one choice with N options instead of N
   *  unrelated buttons — the container carries role=radiogroup in the markup. */
  /**
   * One tab stop per group — v2.9.5.
   *
   * These groups already implement arrow-key movement, which is the half of
   * the ARIA radiogroup pattern that only makes sense with the other half:
   * exactly ONE member is tabbable, and the arrows move within. Without it the
   * appearance sheet cost 16 tab stops (5 themes + 6 accents + 2 surfaces + 3
   * densities) to cross instead of 4, and Tab and the arrows did the same job.
   *
   * `[role=radio]` here are real <button>s, so their tabindex must be set
   * explicitly; a group with nothing checked still needs a way in, hence the
   * fallback to the first option.
   */
  function rovingTabindex(container) {
    const options = [...container.querySelectorAll('[role="radio"]')];
    if (!options.length) return;
    const checked = options.find((o) => o.getAttribute('aria-checked') === 'true');
    for (const option of options) {
      option.tabIndex = option === (checked || options[0]) ? 0 : -1;
    }
  }

  function segButton(label, active, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', active ? 'true' : 'false');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * Arrow-key movement inside a radio group, as the ARIA pattern requires.
   * Applied to the theme grid, the accent dots and both segmented controls.
   */
  function wireRadioKeys(container) {
    container.addEventListener('keydown', (event) => {
      const keys = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      const options = [...container.querySelectorAll('[role="radio"]')];
      const index = options.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      // RTL: ArrowLeft advances, ArrowRight goes back. ArrowDown/Up are
      // direction-independent, which is why both pairs are handled.
      const step =
        event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? 1
          : event.key === 'ArrowRight' || event.key === 'ArrowUp'
            ? -1
            : 0;
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? options.length - 1
            : (index + step + options.length) % options.length;
      options[next].click();
      // Choosing re-renders the sheet from the new state, which replaces these
      // very nodes — so focus has to be re-attached to the rebuilt equivalent
      // or the next arrow key does nothing.
      const rebuilt = [...container.querySelectorAll('[role="radio"]')];
      (rebuilt[next] || options[next]).focus();
    });
  }

  /** Build the appearance sheet from the token tables — adding a theme or an
   *  accent in shared/theme.js is enough to make it appear here. */
  function renderSheet() {
    $('presetGrid').replaceChildren();
    for(const preset of T.PRESETS){
      const button=segButton(preset.label,look.uiPreset===preset.id,()=>saveLook(T.presetSettings(preset.id)));
      button.className='preset-card';button.title=preset.note;button.setAttribute('aria-label',`${preset.label} — ${preset.note}`);
      const thumb=document.createElement('span');thumb.className='preset-thumb';thumb.setAttribute('aria-hidden','true');
      T.apply(thumb,T.presetSettings(preset.id));
      const line=document.createElement('i'),chip=document.createElement('b');globalThis.GXT.i18n.bind(line, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderSheet_1")));chip.textContent='Aa';thumb.append(line,chip);button.prepend(thumb);$('presetGrid').append(button);
    }
    rovingTabindex($('presetGrid'));
    for(const [key,,min,max,step,fallback,suffix] of appearanceFields){const control=$(key);if(!control)continue;control.value=look[key]??fallback;control.disabled=(['uiBlur','uiOpacity'].includes(key)&&look.uiSurface==='solid')||(key==='uiMotionSpeed'&&look.uiMotion==='reduce');$(`${key}Value`).textContent=`${faNum(control.value)}${suffix}`;}
    for(const [key] of appearanceOptions)if($(key))$(key).value=look[key]??T.APPEARANCE_DEFAULTS[key];
    for(const [key,,fallback] of appearanceColors)if($(key))$(key).value=look[key]||fallback;
    // Themes: each card is a miniature of the real UI in that theme, painted
    // with that theme's OWN derived palette — so the preview cannot drift away
    // from what picking it actually does.
    ui.themeGrid.replaceChildren();
    for (const theme of T.THEMES) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'theme-card';
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', look.uiTheme === theme.id ? 'true' : 'false');
      const mini = document.createElement('span');
      mini.className = 'theme-mini';
      const bg = theme.vars ? theme.vars.bg : theme.swatch[0];
      const elev = theme.vars ? theme.vars['bg-elev'] : theme.swatch[1];
      const fg = theme.vars ? T.palette(theme, T.ACCENTS[0]).fg : '#8b98a5';
      mini.style.background =
        theme.id === 'auto' ? `linear-gradient(135deg, ${bg} 50%, ${elev} 50%)` : bg;
      mini.style.color = fg;
      mini.style.borderColor = theme.vars ? theme.vars.line : 'transparent';
      mini.append(
        document.createElement('i'),
        document.createElement('i'),
        document.createElement('i')
      );
      const name = document.createElement('span');
      name.className = 'theme-name';
      name.textContent = theme.label;
      card.title = theme.note || theme.label;
      card.setAttribute('aria-label', `${theme.label}${theme.note ? ` — ${theme.note}` : ''}`);
      card.append(mini, name);
      card.addEventListener('click', () => saveLook({ uiTheme: theme.id,uiBackground:'',uiCardColor:'' }));
      ui.themeGrid.appendChild(card);
    }

    // Accent dots. The tick uses the accent's own derived foreground, so it
    // stays legible on the light accents too.
    ui.accentRow.replaceChildren();
    for (const accent of T.ACCENTS) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'accent-dot';
      dot.setAttribute('role', 'radio');
      dot.setAttribute('aria-checked', !look.uiCustomAccent && look.uiAccent === accent.id ? 'true' : 'false');
      dot.style.setProperty('--dot', accent.color);
      dot.style.setProperty(
        '--check',
        T.contrast('#ffffff', accent.color) >= T.contrast('#000000', accent.color)
          ? '#ffffff'
          : '#000000'
      );
      dot.title = accent.label;
      dot.setAttribute('aria-label', accent.label);
      dot.addEventListener('click', () => saveLook({ uiAccent: accent.id,uiCustomAccent:'' }));
      ui.accentRow.appendChild(dot);
    }

    ui.surfaceSeg.replaceChildren(
      ...T.SURFACES.map((s) =>
        segButton(s.label, look.uiSurface === s.id, () => saveLook({ uiSurface: s.id }))
      )
    );
    ui.densitySeg.replaceChildren(
      ...T.DENSITIES.map((d) =>
        segButton(d.label, look.uiDensity === d.id, () => saveLook({ uiDensity: d.id }))
      )
    );
    for (const group of [ui.themeGrid, ui.accentRow, ui.surfaceSeg, ui.densitySeg]) {
      rovingTabindex(group);
    }
    ui.showHints.checked = !!look.showHints;
    // The sheet also hosts one plain boolean; mirror it so a reset — or a
    // change made from the «◐» button on an in-page card — is reflected here.
    const opaque = $('cardOpaque');
    if (opaque && look.cardOpaque !== undefined) opaque.checked = !!look.cardOpaque;
  }

  // A modal dialog has to keep focus inside it and give it back on close.
  // Without this, Tab walked straight out of the sheet into the settings
  // behind it, which are visually covered and were still operable.
  let sheetReturnFocus = null;

  const FOCUSABLE =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  /**
   * The window behind a modal must be inert, not merely covered — v2.9.5.
   *
   * The Tab trap below stops keyboard focus escaping, but it is the only thing
   * that did: the settings behind the scrim stayed reachable by a screen
   * reader's virtual cursor and by any pointer event the scrim did not
   * intercept. `inert` removes them from the accessibility tree and from hit
   * testing in one attribute (Chrome 102+, and the manifest requires 116), so
   * «مودال» becomes true for every input method rather than for Tab alone.
   */
  const behindSheet = () => [document.querySelector('.appbar'), document.querySelector('main')];

  function openSheet() {
    sheetReturnFocus = document.activeElement;
    ui.sheet.classList.remove('hidden');
    for (const region of behindSheet()) region?.setAttribute('inert', '');
    ui.sheetClose.focus();
  }

  function closeSheet() {
    ui.sheet.classList.add('hidden');
    // Inertness is lifted BEFORE focus is restored: focusing a node inside an
    // inert subtree silently does nothing, which would strand focus on <body>.
    for (const region of behindSheet()) region?.removeAttribute('inert');
    if (sheetReturnFocus?.isConnected) sheetReturnFocus.focus();
    else ui.appearanceBtn.focus();
    sheetReturnFocus = null;
  }

  const sheetOpen = () => !ui.sheet.classList.contains('hidden');

  ui.sheet.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const items = [...ui.sheet.querySelectorAll(FOCUSABLE)].filter(
      (el) => !el.disabled && el.offsetParent !== null
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  ui.appearanceBtn.addEventListener('click', openSheet);
  ui.sheetClose.addEventListener('click', closeSheet);
  ui.sheetScrim.addEventListener('click', closeSheet);
  ui.showHints.addEventListener('change', () => saveLook({ showHints: ui.showHints.checked }));
  ui.resetAppearance.addEventListener('click', () =>
    // videoSafeUi is deliberately NOT here any more: it moved to «کیفیت
    // ویدیو», where its two siblings live. Resetting how the window LOOKS must
    // not silently change how video is composited.
    saveLook(T.resetSettings())
  );

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (sheetOpen()) closeSheet();
      else if (ui.search.value) clearSearch();
      else if (currentView() !== 'home') goto('home');
      return;
    }
    // Ctrl/⌘+F is the reflex for "find a setting"; honour it instead of
    // letting Chrome's own find bar open over a 400px window.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      ui.search.focus();
      ui.search.select();
    }
  });
  // While the theme is "auto", follow the OS switching between light and dark.
  T.onSchemeChange(() => {
    if (look.uiTheme === 'auto') applyLook();
  });

  // ═══════════════════════════════════════════ accessibility wiring (v2.9.0)
  //
  // WHAT WAS WRONG
  // ──────────────
  // Roughly forty switches were `<input type=checkbox>` elements sized 0×0
  // inside a <label> that wrapped only the track — so they had NO accessible
  // name at all. A screen reader announced forty anonymous checkboxes. The
  // «؟» buttons never reported whether they were expanded, and the help text
  // they revealed was not associated with the control it explained.
  //
  // Fixing that by hand would mean writing ~120 ids into the markup and
  // remembering them forever. Instead every relationship is derived here from
  // the structure that already exists, once, at startup: a row cannot be added
  // without getting its label, because nobody has to remember to add one.

  let a11ySeq = 0;
  const nextId = (prefix) => `${prefix}-${(a11ySeq += 1)}`;

  function helpFor(button) {
    const main = button.closest('.row-main');
    if (main) return main.querySelector('.row-help');
    const holder = button.closest('.field-row, .card-head');
    if (!holder) return null;
    let node = holder.nextElementSibling;
    while (node && !node.classList.contains('row-help')) node = node.nextElementSibling;
    return node;
  }

  function wireA11y() {
    // 1. Every switch takes its name from its row title and its description
    //    from the row's help paragraph.
    for (const input of document.querySelectorAll('.switch input')) {
      if (input.getAttribute('aria-label')) continue; // already named explicitly
      const row = input.closest('.row-item');
      const title = row?.querySelector('.row-title');
      if (title) {
        if (!title.id) title.id = nextId('ttl');
        input.setAttribute('aria-labelledby', title.id);
      }
      const help = row?.querySelector('.row-help');
      if (help) {
        if (!help.id) help.id = nextId('hlp');
        input.setAttribute('aria-describedby', help.id);
      }
    }

    // 2. The «؟» disclosure: state, target and a name that says what it opens.
    for (const button of document.querySelectorAll('.info')) {
      const help = helpFor(button);
      if (!help) continue;
      if (!help.id) help.id = nextId('hlp');
      button.setAttribute('aria-controls', help.id);
      button.setAttribute('aria-expanded', help.classList.contains('open') ? 'true' : 'false');
      const subject =
        button.closest('.row-main')?.querySelector('.row-title')?.textContent?.trim() ||
        button.closest('.field-row')?.querySelector('.lbl')?.textContent?.trim() ||
        button.closest('.card-head')?.querySelector('h2')?.textContent?.trim() ||
        '';
      if (subject) globalThis.GXT.i18n.bind(button,'ariaLabel',()=>(globalThis.GXT.i18n.t("popup_popup_wireA11y_1", {v0:(subject)})));
      button.addEventListener('click', () => {
        const open = help.classList.toggle('open');
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    // 3. A <select> or <input> that is not inside its own <label> still needs
    //    one. Everything here either has a wrapping label, an explicit
    //    aria-label or an .lbl in a .field-row — this catches the last case.
    for (const field of document.querySelectorAll('.field-row .lbl[for]')) {
      const control = document.getElementById(field.getAttribute('for'));
      const help = helpFor(field.parentElement.querySelector('.info') || field);
      if (control && help) {
        if (!help.id) help.id = nextId('hlp');
        control.setAttribute('aria-describedby', help.id);
      }
    }
  }

  // ════════════════════════════════════════════════════ search (v2.9.0)
  //
  // ~55 settings across ten destinations. Typing searches all of them at once
  // and shows each hit UNDER THE NAME OF ITS SECTION — in a drill-down
  // structure a result you cannot place is a result you cannot act on. (The
  // v2.0 search filtered four tabs in place, which worked only because every
  // tab was already on screen.)

  const normalize = (text) =>
    String(text || '')
      .toLowerCase()
      .replace(/ي/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/‌/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /**
   * Drop every trace of a filter, WITHOUT navigating.
   *
   * Split out in v2.9.5 because filtering and navigation are two systems that
   * both own `hidden` on a view, and they were fighting. Keeping the reset
   * navigation-free lets `goto` call it safely — see the note there.
   */
  function resetFilter() {
    ui.search.value = '';
    ui.searchClear.classList.add('hidden');
    document.body.classList.remove('searching');
    for (const card of document.querySelectorAll('.view:not(#view-home) .card')) {
      card.classList.remove('no-match', 'filtered');
      for (const row of card.querySelectorAll('.row-item')) row.classList.remove('no-match');
    }
    for (const view of views()) view.classList.remove('searchhit');
    for (const row of document.querySelectorAll('.nav-row')) row.classList.remove('no-match');
    ui.noResults.classList.add('hidden');
    ui.searchCount.textContent = '';
  }

  function clearSearch() {
    runSearch('');
    ui.search.focus();
  }

  function runSearch(raw) {
    const term = normalize(raw);

    if (!term) {
      resetFilter();
      // Leaving search returns to wherever the user was, not to the top.
      goto(currentView(), { focus: false });
      return;
    }

    ui.searchClear.classList.remove('hidden');
    document.body.classList.add('searching');
    const cards = document.querySelectorAll('.view:not(#view-home) .card');

    // Destinations are results too: "where do I change the font?" is a
    // question about NAVIGATION, and in a drill-down shell it has no answer
    // unless the list itself is searchable.
    let navHits = 0;
    for (const row of document.querySelectorAll('.nav-row')) {
      const text = normalize(`${row.dataset.k || ''} ${row.textContent}`);
      const hit = text.includes(term);
      row.classList.toggle('no-match', !hit);
      if (hit) navHits += 1;
    }
    document.getElementById('view-home').classList.toggle('searchhit', navHits > 0);
    document.getElementById('view-home').toggleAttribute('hidden', navHits === 0);

    let hits = navHits;
    for (const card of cards) {
      const headText = normalize(
        `${card.dataset.k || ''} ${card.querySelector('h2')?.textContent || ''}`
      );
      const rows = [...card.querySelectorAll('.row-item')];
      // A card is more than its rows: the speech card is all <select>s, the
      // bridge card mixes rows with fields, and the prompt editor has no rows
      // at all. Everything OUTSIDE the rows is searched as one body of text, so
      // «سرعت خواندن» and «دقت رونویسی» are findable without listing every
      // field's words in the card's keywords — which is what made the keyword
      // lists drift into duplicating their own rows and matching too widely.
      const bodyText = normalize(
        [...card.children]
          .filter((child) => !child.classList.contains('row-item'))
          .map((child) => child.textContent)
          .join(' ')
      );
      const cardHit = headText.includes(term) || bodyText.includes(term);
      let rowHits = 0;
      for (const row of rows) {
        const hit =
          cardHit || normalize(`${row.dataset.k || ''} ${row.textContent}`).includes(term);
        row.classList.toggle('no-match', !hit);
        if (hit) rowHits += 1;
      }
      const show = cardHit || rowHits > 0;
      card.classList.toggle('no-match', !show);
      // A card matched only through its rows is stripped down to those rows.
      card.classList.toggle('filtered', show && !cardHit);
      if (show) hits += rowHits || 1;
    }

    // Show every section that still has a visible card, under its own name.
    let sections = navHits > 0 ? 1 : 0;
    for (const view of views()) {
      if (view.id === 'view-home') continue;
      const visible = view.querySelector('.card:not(.no-match)');
      view.classList.toggle('searchhit', !!visible);
      view.toggleAttribute('hidden', !visible);
      if (visible) sections += 1;
    }
    ui.noResults.classList.toggle('hidden', sections > 0);
    globalThis.GXT.i18n.bind(ui.searchCount, "textContent", () => (sections
      ? globalThis.GXT.i18n.t("popup_popup_runSearch_2", {v0:(faNum(hits)), v1:(faNum(sections))})
      : globalThis.GXT.i18n.t("popup_popup_runSearch_1")));
    document.querySelector('main').scrollTop = 0;
  }

  ui.search.addEventListener('input', () => runSearch(ui.search.value));
  ui.searchClear.addEventListener('click', clearSearch);

  // =============================== RTX Video helper (v2.0.2) ===============
  //
  // Two switches and a diagnosis. The helper runs on every site, so enabling
  // it asks for the broad host permission first and reverts if declined.

  const VSR_HOSTS = ['https://*/*', 'http://*/*'];

  /** Plain-Persian names for the CSS blockers, so the report reads like an
   *  explanation rather than a stylesheet dump. */
  const VSR_LABEL = {
    get 'border-radius'() { return globalThis.GXT.i18n.t("popup_popup_VSR_LABEL_10"); },
    get filter() { return globalThis.GXT.i18n.t("popup_popup_VSR_LABEL_9"); },
    get '-webkit-filter'() { return globalThis.GXT.i18n.t("popup_popup_VSR_LABEL_9"); },
    get 'backdrop-filter'() { return globalThis.GXT.i18n.t("popup_popup_VSR_LABEL_8"); },
    get 'mask-image'() { return globalThis.GXT.i18n.t("popup_popup_VSR_LABEL_7"); },
    get '-webkit-mask-image'() { return globalThis.GXT.i18n.t("popup_popup_VSR_LABEL_7"); },
    get 'clip-path'() { return globalThis.GXT.i18n.t("popup_popup_VSR_LABEL_6"); },
    get 'mix-blend-mode'() { return globalThis.GXT.i18n.t("popup_popup_VSR_LABEL_5"); },
    get 'box-shadow'() { return globalThis.GXT.i18n.t("popup_popup_VSR_LABEL_4"); },
    get 'will-change'() { return globalThis.GXT.i18n.t("popup_popup_VSR_LABEL_3"); },
    get opacity() { return globalThis.GXT.i18n.t("popup_popup_VSR_LABEL_2"); },
    get transform() { return globalThis.GXT.i18n.t("popup_popup_VSR_LABEL_1"); },
  };

  const vsrNames = (list) => {
    const seen = new Set();
    for (const entry of list || []) {
      const property = String(entry).split(':')[1] || entry;
      seen.add(VSR_LABEL[property] || property);
    }
    return [...seen];
  };

  function vsrLine(parent, text, cls) {
    const li = document.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    parent.appendChild(li);
  }

  function renderVsrReport(res) {
    ui.vsrReport.classList.remove('hidden');
    ui.vsrReport.replaceChildren();
    const head = document.createElement('div');
    head.className = 'vsr-head';
    const dot = document.createElement('span');
    dot.className = 'vsr-dot';
    head.append(dot, document.createTextNode(''));
    ui.vsrReport.appendChild(head);
    const list = document.createElement('ul');

    if (!res?.ok) {
      dot.classList.add('err');
      globalThis.GXT.i18n.bind(head.lastChild, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderVsrReport_14")));
      vsrLine(list, globalThis.GXT.i18n.t("popup_popup_renderVsrReport_13"));
      vsrLine(list, globalThis.GXT.i18n.t("popup_popup_renderVsrReport_12"));
      ui.vsrReport.appendChild(list);
      return;
    }
    if (res.canvasOnly) {
      dot.classList.add('err');
      globalThis.GXT.i18n.bind(head.lastChild, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderVsrReport_11")));
      vsrLine(list, globalThis.GXT.i18n.t("popup_popup_renderVsrReport_10"));
      ui.vsrReport.appendChild(list);
      return;
    }
    if (!res.videos.length) {
      dot.classList.add('warn');
      globalThis.GXT.i18n.bind(head.lastChild, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_renderVsrReport_9")));
      vsrLine(list, globalThis.GXT.i18n.t("popup_popup_renderVsrReport_8"));
      ui.vsrReport.appendChild(list);
      return;
    }

    const video = res.videos[0];
    const worst = video.verdict;
    dot.classList.add(worst === 'no' ? 'err' : worst === 'unknown' ? 'warn' : '');
    globalThis.GXT.i18n.bind(head.lastChild, "textContent", () => (video.w && video.h
        ? globalThis.GXT.i18n.t("popup_popup_renderVsrReport_7", {v0:(faNum(video.w)), v1:(faNum(video.h)), v2:(faNum(video.cssW)), v3:(faNum(video.cssH))})
        : globalThis.GXT.i18n.t("popup_popup_renderVsrReport_6")));

    const applied = vsrNames(video.applied);
    const remaining = vsrNames(video.remaining);
    if (applied.length) {
      vsrLine(list, globalThis.GXT.i18n.t("popup_popup_renderVsrReport_5", {v0:(applied.join(globalThis.GXT.i18n.t("popup_popup_message_2")))}), 'vsr-fixed');
    }
    if (remaining.length) {
      vsrLine(list, globalThis.GXT.i18n.t("popup_popup_renderVsrReport_3", {v0:(remaining.join(globalThis.GXT.i18n.t("popup_popup_message_2"))), v1:(res.running ? '' : globalThis.GXT.i18n.t("popup_popup_renderVsrReport_4"))}));
    }
    if (!applied.length && !remaining.length) {
      vsrLine(list, globalThis.GXT.i18n.t("popup_popup_renderVsrReport_2"), 'vsr-fixed');
    }
    for (const note of video.notes || []) vsrLine(list, note);
    if (res.videos.length > 1) vsrLine(list, globalThis.GXT.i18n.t("popup_popup_renderVsrReport_1", {v0:(faNum(res.videos.length))}));
    ui.vsrReport.appendChild(list);
  }

  ui.vsrCheck.addEventListener('click', async () => {
    ui.vsrCheck.disabled = true;
    let res = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) res = await chrome.tabs.sendMessage(tab.id, { type: 'GXT_VSR_REPORT' });
    } catch {
      res = null; // no content script in that tab
    }
    renderVsrReport(res);
    ui.vsrCheck.disabled = false;
  });

  ui.vsrHelper.addEventListener('change', async () => {
    if (ui.vsrHelper.checked) {
      // Runs on every site, so ask before switching it on.
      const granted = await chrome.permissions
        ?.request?.({ origins: VSR_HOSTS })
        .catch(() => false);
      if (!granted) {
        ui.vsrHelper.checked = false;
        return;
      }
    }
    await GXTS.setSettings({ vsrHelper: ui.vsrHelper.checked });
    if (!ui.vsrHelper.checked) ui.vsrReport.classList.add('hidden');
  });

  ui.vsrForceH264.addEventListener('change', () =>
    GXTS.setSettings({ vsrForceH264: ui.vsrForceH264.checked })
  );


  // ══════════════════════════════════════════════ v3.0.0 — quality controls

  function loadQuality(settings) {
    const select = $('register');
    if (select && !select.options.length) {
      for (const entry of GXTS.REGISTERS) {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = entry.label;
        select.appendChild(option);
      }
    }
    if (select) select.value = settings.register || 'auto';
    const quality = $('qualityMode');
    if (quality) quality.checked = !!settings.qualityMode;
    const memory = $('memoryEnabled');
    if (memory) memory.checked = settings.memoryEnabled !== false;
  }

  $('register')?.addEventListener('change', () => {
    void GXTS.setSettings({ register: $('register').value }).then(() => renderSummaries());
  });

  /** The memory screen. Read-only apart from a pin and a wipe — the memory is
   *  built by USE, and a list you have to curate by hand is a chore nobody
   *  performs. */
  async function loadMemory() {
    const res = await send({ type: 'GET_MEMORY', limit: 400 });
    const list = $('memList');
    const count = $('memCount');
    if (count) count.textContent = faNum(res?.count || 0);
    if (!list) return;
    globalThis.GXT.i18n.bind(list, "textContent", () => (res?.lines?.length
      ? res.lines.join('\n')
      : globalThis.GXT.i18n.t("popup_popup_loadMemory_1")));
  }

  $('memRefresh')?.addEventListener('click', () => void loadMemory());

  $('memClear')?.addEventListener('click', async () => {
    await send({ type: 'CLEAR_MEMORY' });
    setStatus($('memStatus'), globalThis.GXT.i18n.t("popup_popup_message_14"), 'ok');
    void loadMemory();
  });

  $('memPin')?.addEventListener('click', async () => {
    const source = $('memTerm').value.trim();
    const target = $('memValue').value.trim();
    if (!source || !target) {
      setStatus($('memStatus'), globalThis.GXT.i18n.t("popup_popup_message_13"), 'warn');
      return;
    }
    const res = await send({ type: 'PIN_TERM', source, target });
    if (res?.ok) {
      setStatus($('memStatus'), globalThis.GXT.i18n.t("popup_popup_message_12", {v0:(source), v1:(target)}), 'ok');
      $('memTerm').value = '';
      $('memValue').value = '';
      void loadMemory();
    } else {
      setStatus($('memStatus'), globalThis.GXT.i18n.t("popup_popup_message_11"), 'warn');
    }
  });

  // ═══════════════════════════════════ v3.0.0 — "check for updates" for all
  //
  // The requirement this satisfies: a model line-up changes every few weeks,
  // so a shipped list is stale on release day. Every engine is asked what
  // exists RIGHT NOW, and the answer names anything newer than the current
  // choice — which is the actual question behind the button, and far more
  // useful than "the list was refreshed".

  const ENGINE_LABEL = {
    gemini: 'Gemini',
    get openai() { return globalThis.GXT.i18n.t("popup_popup_ENGINE_LABEL_3"); },
    get bridge() { return globalThis.GXT.i18n.t("popup_popup_ENGINE_LABEL_2"); },
    get extension() { return globalThis.GXT.i18n.t("popup_popup_ENGINE_LABEL_1"); },
  };

  function renderUpdates(result) {
    const box = $('updReport');
    if (!box) return;
    box.replaceChildren();
    box.classList.remove('hidden');
    const add = (text, cls) => {
      const line = document.createElement('div');
      line.className = `vsr-line${cls ? ` ${cls}` : ''}`;
      line.textContent = text;
      box.appendChild(line);
      return line;
    };

    for (const [id, info] of Object.entries(result.engines || {})) {
      const name = ENGINE_LABEL[id] || id;
      if (!info?.ok) {
        add(`${name}: ${info?.hint || globalThis.GXT.i18n.t("popup_popup_renderUpdates_8")}`, 'warn');
        continue;
      }
      if (id === 'extension') {
        add(globalThis.GXT.i18n.t("popup_popup_renderUpdates_6", {v0:(name), v1:(info.version)})
          + (info.channel === 'unpacked' ? globalThis.GXT.i18n.t("popup_popup_renderUpdates_7") : ''), 'ok');
        continue;
      }
      if (id === 'bridge') {
        add(globalThis.GXT.i18n.t("popup_popup_renderUpdates_6", {v0:(name), v1:(info.version)}), 'ok');
        for (const pkg of info.deps?.packages || []) {
          if (pkg.missing) {
            add(globalThis.GXT.i18n.t("popup_popup_renderUpdates_5", {v0:(pkg.name), v1:(pkg.why)}), 'warn');
            add(`    ${pkg.install}`, 'cmd');
          } else if (pkg.differs) {
            add(globalThis.GXT.i18n.t("popup_popup_renderUpdates_4", {v0:(pkg.name), v1:(pkg.installed), v2:(pkg.latest)}), 'warn');
            add(`    ${pkg.install}`, 'cmd');
          } else {
            add(`  ${pkg.name}: ${pkg.installed}`, 'ok');
          }
        }
        continue;
      }
      // A cloud engine: how many models, and is anything newer than mine?
      add(globalThis.GXT.i18n.t("popup_popup_renderUpdates_3", {v0:(name), v1:(faNum(info.total))}), 'ok');
      if (info.newer?.length) {
        add(globalThis.GXT.i18n.t("popup_popup_renderUpdates_2", {v0:(info.current), v1:(info.newer.join(globalThis.GXT.i18n.t("popup_popup_message_2")))}), 'warn');
      } else if (info.current) {
        add(globalThis.GXT.i18n.t("popup_popup_renderUpdates_1", {v0:(info.current)}), 'ok');
      }
    }
  }

  async function checkUpdates(scope, button) {
    const status = $('updStatus');
    const label = button?.querySelector('span');
    const was = label?.textContent;
    if (button) button.disabled = true;
    if (label) globalThis.GXT.i18n.bind(label, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_checkUpdates_5")));
    setStatus(status, globalThis.GXT.i18n.t("popup_popup_checkUpdates_4"));
    try {
      const result = await send({ type: 'CHECK_UPDATES', scope: scope || 'all' });
      if (!result?.ok) {
        setStatus(status, globalThis.GXT.i18n.t("popup_popup_checkUpdates_1"), 'warn');
        return;
      }
      renderUpdates(result);
      // The lists that just came back feed the pickers immediately — the
      // point of the button is a NEWER MODEL, not a report about one.
      const settings = await GXTS.getSettings();
      const groups = result.engines?.gemini?.groups;
      if (groups) populateEngineModels(groups, settings);
      const oai = result.engines?.openai?.groups;
      if (oai) {
        populateOaiModelList(oai.text || []);
        populateOaiSpeechList(oai.speech || []);
      }
      const anyNew = Object.values(result.engines || {}).some((e) => e?.newer?.length)
        || (result.engines?.bridge?.deps?.packages || []).some((p) => p.missing || p.differs);
      setStatus(status, anyNew ? globalThis.GXT.i18n.t("popup_popup_checkUpdates_3") : globalThis.GXT.i18n.t("popup_popup_checkUpdates_2"),
        anyNew ? 'warn' : 'ok');
    } catch {
      setStatus(status, globalThis.GXT.i18n.t("popup_popup_checkUpdates_1"), 'warn');
    } finally {
      if (button) button.disabled = false;
      if (label && was) label.textContent = was;
    }
  }

  $('checkAllUpdates')?.addEventListener('click', (e) => void checkUpdates('all', e.currentTarget));
  $('refreshOaiModels')?.addEventListener('click', () => void refreshModelList({ includeLocal: false }));

  // ══════════════════════════════════════════════ v3.0.0 — self-diagnosis

  async function runDiagnose(button) {
    const box = $('diagReport');
    if (button) button.disabled = true;
    try {
      const tab = await currentTab();
      const res = await send({ type: 'DIAGNOSE', tabId: tab?.id });
      if (!box) return;
      box.replaceChildren();
      box.classList.remove('hidden');
      for (const check of res?.checks || []) {
        const line = document.createElement('div');
        line.className = `vsr-line ${check.ok ? 'ok' : 'warn'}`;
        line.textContent = `${check.ok ? '✓' : '✕'} ${check.label}`
          + (check.detail ? ` — ${check.detail}` : '');
        box.appendChild(line);
        if (!check.ok && check.fix) {
          const fix = document.createElement('div');
          fix.className = 'vsr-line cmd';
          fix.textContent = `    ${check.fix}`;
          box.appendChild(fix);
        }
      }
      if (!res?.checks?.some((c) => !c.ok)) {
        const line = document.createElement('div');
        line.className = 'vsr-line ok';
        globalThis.GXT.i18n.bind(line, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_runDiagnose_1")));
        box.appendChild(line);
      }
    } finally {
      if (button) button.disabled = false;
    }
  }

  $('runDiagnose')?.addEventListener('click', (e) => void runDiagnose(e.currentTarget));

  // ═══════════════════════════════════════════ v3.0.0 — backup & restore

  $('bkExport')?.addEventListener('click', async () => {
    const status = $('bkStatus');
    const includeKeys = !!$('bkKeys')?.checked;
    setStatus(status, globalThis.GXT.i18n.t("popup_popup_message_10"));
    const res = await send({ type: 'EXPORT_BACKUP', includeKeys, includeMemory: true });
    if (!res?.ok) {
      setStatus(status, globalThis.GXT.i18n.t("popup_popup_message_9"), 'warn');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tarjoman-backup-${stamp}${includeKeys ? '-with-keys' : ''}.json`;
    link.click();
    // Revoked on a timer, not immediately: the download is asynchronous and
    // revoking too early cancels it on some Chrome builds.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus(status, includeKeys
      ? globalThis.GXT.i18n.t("popup_popup_message_8")
      : globalThis.GXT.i18n.t("popup_popup_message_7"), 'ok');
  });

  $('bkImport')?.addEventListener('click', () => $('bkFile')?.click());

  let backupImportRevision = 0;
  $('bkFile')?.addEventListener('change', async (event) => {
    const status = $('bkImportStatus');
    const file = event.target.files?.[0];
    if (!file) return;
    const revision = ++backupImportRevision;
    const mode = $('bkMode')?.value === 'replace' ? 'replace' : 'merge';
    event.target.value = ''; // so choosing the same file twice re-triggers
    setStatus(status, globalThis.GXT.i18n.t("popup_popup_message_6"));
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      if (revision !== backupImportRevision) return;
      setStatus(status, globalThis.GXT.i18n.t("popup_popup_message_5"), 'warn');
      return;
    }
    if (revision !== backupImportRevision) return;
    const res = await send({ type: 'IMPORT_BACKUP', data, mode });
    if (revision !== backupImportRevision) return;
    if (!res?.ok) {
      setStatus(status, res?.error || globalThis.GXT.i18n.t("popup_popup_message_4"), 'warn');
      return;
    }
    const r = res.report || {};
    const parts = [globalThis.GXT.i18n.t("popup_popup_parts_1", {v0:(faNum(r.settings || 0))})];
    if (r.apiKeys) parts.push(globalThis.GXT.i18n.t("background_service_worker_handlers_33", {v0:(faNum(r.apiKeys))}));
    if (r.memory) parts.push(globalThis.GXT.i18n.t("popup_popup_message_3", {v0:(faNum(r.memory))}));
    setStatus(status, globalThis.GXT.i18n.t("popup_popup_message_1", {v0:(parts.join(globalThis.GXT.i18n.t("popup_popup_message_2")))}), 'ok');
    // Everything on screen was built from the settings that just changed.
    setTimeout(() => { if (revision === backupImportRevision) location.reload(); }, 900);
  });

  // -------------------------------------------------------------------- init

  function wireLocale(settings) {
    const I=GXTS.i18n;
    I.configure(settings);I.apply(document);
    for(const [scope,view] of [['x','x'],['compose','x'],['page','web'],['image','web'],['summary','web'],['web','youtube'],['file','youtube'],['manga','bridge']]) {
      const id=scope+'TargetLang';let input=$(id);
      if(!input){const label=document.createElement('label');label.className='field';const caption=document.createElement('span');caption.dataset.i18n='target.'+scope;label.append(caption);input=document.createElement('input');input.type='text';input.id=id;label.append(input);$('view-'+view).prepend(label);}
      GXTS.targetInput(input,true);input.value=settings[id]||'inherit';
      input.addEventListener('change',async()=>{if(!GXTS.isSettingValue(id,input.value)){input.reportValidity();return;}await GXTS.setSettings({[id]:input.value});});
    }
    GXTS.targetInput($('targetLang'));GXTS.targetInput($('ytTargetLang'));I.apply(document);
    const keys=['uiLanguage','targetLang','regionLocale','calendar','numberingSystem','hourCycle','weekStart','timeZone','translationRegion'];
    const preview=()=> { $('localePreview').textContent=I.t('region.preview',{number:I.number(12345.6),date:I.date(Date.now()),time:I.time(Date.now())}); };
    for(const key of keys) {
      const el=$(key);el.value=settings[key];
      el.addEventListener('change',async()=>{
        if(!GXTS.isSettingValue(key,el.value)) {el.setCustomValidity(I.t('region.invalid'));el.reportValidity();return;}
        el.setCustomValidity('');
        await GXTS.setSettings({[key]:el.value,localeVersion:1});
        const next=await GXTS.getSettings();I.configure(next);I.apply(document);preview();
        $('localeStatus').textContent=I.t('region.saved');
        void renderSummaries(next);
        if(key === 'uiLanguage') location.reload();
      });
    }
    preview();I.onChange(preview);
  }

  async function init() {
    GXTS.i18n.configure(await GXTS.getSettings());
    setupNav();
    injectFontFaces();
    wireA11y();
    wireTts();
    ui.versionTag.textContent = appVersion();
    const [settings, apiKeys, openaiKey, stored] = await Promise.all([
      GXTS.getSettings(),
      GXTS.getApiKeys(),
      GXTS.getOpenaiKey(),
      chrome.storage.local.get([
        GXTS.MODEL_LIST_KEY, GXTS.OPENAI_MODEL_LIST_KEY, GXTS.LOCAL_VOICE_LIST_KEY,
      ]),
    ]);
    wireLocale(settings);
    // Classify what the last refresh found, so the speech and dubbing lists
    // open already populated instead of waiting for another round trip.
    discoveredGroups = GXTS.classifyModels(stored[GXTS.MODEL_LIST_KEY]);
    const cachedLocal = stored[GXTS.LOCAL_VOICE_LIST_KEY];
    if (Array.isArray(cachedLocal?.voices)) localVoices = cachedLocal.voices;
    // Appearance first, so the UI never flashes the fallback theme.
    look = Object.fromEntries(T.APPEARANCE_KEYS.map(key=>[key,key==='videoSafeUi'?settings[key]!==false:(settings[key]??T.APPEARANCE_DEFAULTS[key])]));
    buildAppearanceControls();
    applyLook();
    renderSheet();
    for (const group of [$('presetGrid'),ui.themeGrid, ui.accentRow, ui.surfaceSeg, ui.densitySeg]) {
      wireRadioKeys(group);
    }
    const videoTab=await currentTab();
    try {const url=new URL(videoTab?.url);webVideoSiteHost=/^https?:$/.test(url.protocol)?url.hostname:'';}catch{}
    loadWebVideo(settings);

    ui.enabled.checked = settings.enabled;
    ui.provider.value = settings.provider;
    showProviderSections(settings.provider);
    refreshBrandStatus(settings, apiKeys.length);

    ui.apiKeys.value = apiKeys.join('\n');
    ui.replaceOriginal.checked = settings.replaceOriginal;
    ui.translateBios.checked = settings.translateBios;
    const modeRadio = document.querySelector(`input[name="mode"][value="${settings.mode}"]`);
    if (modeRadio) modeRadio.checked = true;

    populateModels(stored[GXTS.MODEL_LIST_KEY], settings.model);
    globalThis.GXT.i18n.bind(ui.modelHint, "textContent", () => (globalThis.GXT.i18n.t("popup_popup_init_2")));

    ui.oaiBase.value = settings.openaiBaseUrl;
    ui.oaiKey.value = openaiKey;
    ui.oaiModel.value = settings.openaiModel;
    for (const preset of GXTS.OPENAI_PRESETS) {
      const option = document.createElement('option');
      option.value = preset;
      ui.oaiPresets.appendChild(option);
    }
    populateOaiModelList(stored[GXTS.OPENAI_MODEL_LIST_KEY]);
    populateOaiSpeechList(GXTS.classifyOpenaiModels(stored[GXTS.OPENAI_MODEL_LIST_KEY]).speech);
    if (cachedLocal) populateLocalVoices(cachedLocal, settings);

    populateFontSelect(settings);
    ui.customFont.value = settings.customFont;
    ui.dailyQuota.value = settings.dailyQuota || '';
    ui.youtube.checked = settings.youtube !== false;
    ui.dwellMode.checked = !!settings.dwellMode;
    // v1.8 toggles + personalization fields.
    for (const id of BOOL_SETTINGS) {
      const el = $(id);
      if (el) el.checked = !!settings[id];
    }
    ui.vsrHelper.checked = !!settings.vsrHelper;
    ui.vsrForceH264.checked = !!settings.vsrForceH264;
    ui.glossary.value = settings.glossary || '';
    ui.customPrompt.value = settings.customPrompt || '';
    ui.openaiFallbackModel.value = settings.openaiFallbackModel || '';
    loadTts(settings);
    loadQuality(settings);
    // v2.5.0 — the bridge fields. The health probe is deliberately NOT run at
    // init: the companion app is usually not running, and a failed loopback
    // request on every popup open would be pure noise. The chip says
    // «بررسی نشده» until the user asks.
    if ($('bridgeToken')) $('bridgeToken').value = settings.bridgeToken || '';
    if ($('bridgePort')) $('bridgePort').value = String(settings.bridgePort || 8765);
    if ($('bridgeAsrModel')) $('bridgeAsrModel').value = settings.bridgeAsrModel || 'small';
    if ($('mangaConcurrency')) {
      const value = Math.max(1, Math.min(4, Number(settings.mangaConcurrency) || 3));
      $('mangaConcurrency').value = String(value);
      if ($('mangaConcurrencyVal')) $('mangaConcurrencyVal').textContent = faNum(value);
    }
    $('bridgeSection')?.classList.toggle('hidden', !settings.bridgeEnabled);
    paintBridgeChip(settings, null);
    // The prompt editor is NOT loaded here any more — it pulls in a thousand
    // lines of prompt text for a screen that is two clicks away. `ON_ENTER`
    // loads it the moment «شخصی‌سازی ترجمه» is opened.
    await loadModelTuning();
    // Batch-size select: surface a custom stored value as its own option so
    // the control never displays a wrong number.
    const batch = String(settings.batchSize || GXTS.DEFAULTS.batchSize);
    if (![...ui.batchSize.options].some((o) => o.value === batch)) {
      const custom = document.createElement('option');
      custom.value = batch;
      custom.textContent = faNum(batch);
      ui.batchSize.appendChild(custom);
    }
    ui.batchSize.value = batch;
    await renderAutoSites();

    const ready =
      settings.provider === 'gemini'
        ? apiKeys.length > 0
        : settings.provider === 'openai'
          ? !!(settings.openaiBaseUrl && settings.openaiModel)
          : true;
    if (settings.provider === 'gemini' && !apiKeys.length) {
      setStatus(ui.keyStatus, globalThis.GXT.i18n.t("popup_popup_init_1"), 'warn');
    }
    // First run gets one card and one button instead of a wall of switches and
    // a textarea labelled «کلیدهای API» — which is a fine label for someone who
    // knows what an API key is, and no help at all to everyone else.
    ui.setupCard.classList.toggle('hidden', ready);

    // Statistics used to load on EVERY popup open, waking the service worker
    // for a screen the user was not looking at 90% of the time. The home
    // summary reads the same numbers straight out of storage instead, and the
    // full view loads them when it is opened (see ON_ENTER).
    await Promise.all([refreshContext(), renderSummaries(settings)]);
  }

  ui.setupGo?.addEventListener('click', () => goto('engine'));

  void init();
})();
