/**
 * Service worker: message router between content scripts / popup and the
 * translation providers, plus context menus (selection / full-page / auto-site
 * translation) and dynamic content-script registration for auto-translate
 * sites. Owns statistics (aligned to the Pacific-midnight Gemini quota reset),
 * the learned daily quota, and the action badge. All state that must survive
 * worker shutdown lives in chrome.storage.local / storage.session.
 */
'use strict';
importScripts(
  '../shared/settings.js',
  // v3.0.0 - translation memory. Pure semantics over the storage layer in
  // settings.js, so it must load after it.
  '../shared/memory.js',
  '../shared/subtitles.js', '../shared/workshop.js',
  'prompt.js', 'subtitle-prompts.js', 'abort.js', 'cache.js', 'gemini.js', 'openai.js', 'mt.js',
  // v2.2.0 — speech. tts.js reads GXT.mt.bingSession and GXT.gemini.synthesize,
  // so it must load after both.
  'audio-cache.js', 'tts.js',
  // v2.4.5 — the audio-native dubbing path. Independent of tts.js: it never
  // synthesizes text, it streams sound to Gemini and gets sound back.
  'live.js',
  // v2.5.0 — the local companion service. Optional in every sense: if it
  // is not running, every call returns OFFLINE and nothing else changes.
  'bridge.js', 'workshop.js'
);

const GXTBG = globalThis.GXT;

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

// -------------------------------------------------------------------- stats

async function getStats() {
  const raw = await chrome.storage.local.get(GXTBG.STATS_KEY);
  const { dayKey } = GXTBG.pacificDayAndReset();
  const stats = {
    translated: 0,
    apiCalls: 0,
    cacheHits: 0,
    day: dayKey,
    dayApiCalls: 0,
    // Items translated today (mirrors `translated` but resets with the Pacific
    // day, like dayApiCalls) — a live "today" figure for the stats panel.
    dayTranslated: 0,
    learnedDailyLimit: 0,
    // The model the learned limit belongs to; a learned cap is model-specific
    // and must not leak onto a different model's usage bar.
    learnedDailyLimitModel: '',
    // Per-feature item counts, so the popup can prove every translation
    // source is being captured.
    items_tweet: 0,
    items_subtitle: 0,
    items_page: 0,
    items_selection: 0,
    items_image: 0,
    items_summary: 0,
    ...(raw[GXTBG.STATS_KEY] || {}),
  };
  if (stats.day !== dayKey) {
    stats.day = dayKey;
    stats.dayApiCalls = 0;
    stats.dayTranslated = 0;
  }
  return stats;
}

/**
 * All stats writes are serialized through this queue. Tweet groups run in
 * Promise.all and the generic pipeline can run concurrently from other tabs;
 * unserialized read-modify-write cycles were losing increments.
 */
let statsQueue = Promise.resolve();

function bumpStats(patch) {
  statsQueue = statsQueue
    .then(async () => {
      const stats = await getStats();
      for (const [key, value] of Object.entries(patch)) {
        stats[key] = (stats[key] || 0) + value;
      }
      // Every place that adds to the all-time `translated` also advances the
      // daily figure, in one spot so no call site can forget it.
      if (patch.translated) stats.dayTranslated = (stats.dayTranslated || 0) + patch.translated;
      await chrome.storage.local.set({ [GXTBG.STATS_KEY]: stats });
    })
    .catch(() => {});
  return statsQueue;
}

// ------------------------------------------------------ per-key usage (v2.5.5)
//
// The quota bar used to divide a fleet-wide call count by ONE key's cap, so a
// dozen keys made "over quota" arithmetically certain while translation was
// still working perfectly. Usage is therefore recorded against the key that
// actually served each request, which is the only unit Google's daily quota
// is expressed in.

/** `{ day, keys: { [key]: {calls, exhausted, limit, lastAt} } }` */
async function getKeyUsage(model) {
  const raw = await chrome.storage.local.get(GXTBG.KEY_USAGE_KEY);
  const { dayKey } = GXTBG.pacificDayAndReset();
  const stored = raw[GXTBG.KEY_USAGE_KEY] || {};
  // Google's quota resets at Pacific midnight, so the record does too — and a
  // stale day must never carry yesterday's exhaustion into today, which would
  // show every key as dead until it happened to be tried again.
  if (stored.day !== dayKey) return { day: dayKey, keys: {}, models: {} };
  return {
    day: dayKey,
    keys: model ? stored.models?.[model] || {} : stored.keys || {},
    models: stored.models || {},
  };
}

/** Writes ride the SAME queue as bumpStats: these counters are updated from
 *  concurrent batches, and an unserialized read-modify-write loses increments
 *  exactly when traffic is heaviest. */
function bumpKeyUsage(event) {
  if (!event?.key) return statsQueue;
  statsQueue = statsQueue
    .then(async () => {
      const usage = await getKeyUsage();
      const record = { ...GXTBG.emptyKeyUsage(), ...(usage.keys[event.key] || {}) };
      if (event.kind === 'exhausted') {
        record.exhausted = true;
        // What Google reported is this key's REAL cap. Prefer it over the
        // published table, and fall back to "it stopped here" — which is a
        // measurement too, just a coarser one.
        record.limit = Number(event.limit) > 0 ? Number(event.limit) : record.calls || record.limit;
      } else {
        record.calls = (record.calls || 0) + 1;
      }
      record.lastAt = Date.now();
      usage.keys[event.key] = record;
      if (event.model) {
        const records = usage.models[event.model] || {};
        const perModel = { ...GXTBG.emptyKeyUsage(), ...(records[event.key] || {}) };
        if (event.kind === 'exhausted') {
          perModel.exhausted = true;
          perModel.limit = Number(event.limit) > 0 ? Number(event.limit) : perModel.calls || perModel.limit;
        } else {
          perModel.calls = (perModel.calls || 0) + 1;
        }
        perModel.lastAt = record.lastAt;
        usage.models[event.model] = { ...records, [event.key]: perModel };
      }
      await chrome.storage.local.set({ [GXTBG.KEY_USAGE_KEY]: usage });
    })
    .catch(() => {});
  return statsQueue;
}

// gemini.js reports; this side persists. Registered once, at worker start.
GXTBG.gemini.setUsageReporter(bumpKeyUsage);

/** Push the user's audio-cache ceiling into the cache. Done at worker start
 *  and on every settings change, because a setting nothing reads is a lie. */
async function applyAudioCacheLimit(settings) {
  const s = settings || (await GXTBG.getSettings());
  GXTBG.audioCache.setMaxMb(s.ttsCacheMb);
}
void applyAudioCacheLimit();

function noteLearnedDailyLimit(limit, model) {
  statsQueue = statsQueue
    .then(async () => {
      const stats = await getStats();
      if (stats.learnedDailyLimit !== limit || stats.learnedDailyLimitModel !== model) {
        stats.learnedDailyLimit = limit;
        stats.learnedDailyLimitModel = model || '';
        await chrome.storage.local.set({ [GXTBG.STATS_KEY]: stats });
      }
    })
    .catch(() => {});
  return statsQueue;
}

// ---------------------------------------------------------------- providers

/**
 * Resolve the active provider into a uniform interface:
 * {configured, isGemini, cacheId, translate(group), translateTexts(texts, kind)}
 */
async function getProviderCtx(settings, providerOverride) {
  // A per-feature override (e.g. YouTube's own engine picker) selects the
  // provider; credentials/model/baseUrl still come from the shared settings.
  const provider = providerOverride || settings.provider;
  const effSettings = provider === settings.provider ? settings : { ...settings, provider };
  // Personalization (glossary + custom instruction + full prompt overrides)
  // shapes the output, so it is part of the prompt AND of the cache namespace.
  const overrides =
    settings.promptOverrides && typeof settings.promptOverrides === 'object'
      ? settings.promptOverrides
      : null;
  const hasOverride = overrides && Object.values(overrides).some((v) => (v || '').trim());
  // Per-model advanced tuning (v1.9.0): the thinking level + temperature the
  // user picked for THIS model (of the effective provider). Also shapes output,
  // so it rides on `extra` and is already folded into the cache namespace.
  const tuning = GXTBG.resolveModelTuning(effSettings, GXTBG.activeModelId(effSettings));
  const hasTuning = tuning.thinkingLevel != null || tuning.temperature != null;
  // v3.0.0 — the register and the quality pass shape the output exactly like a
  // glossary does, so they travel the same way and are already folded into the
  // cache namespace by promptExtrasHash.
  const register = settings.register && settings.register !== 'auto' ? settings.register : '';
  const extra =
    (settings.glossary || '').trim() || (settings.customPrompt || '').trim() ||
    hasOverride || hasTuning || register || settings.qualityMode || settings.targetLang !== 'fa' || settings.translationRegion === 'source'
      ? {
          targetLang:settings.targetLang || 'fa',
          translationRegion:settings.translationRegion || 'iran',
          glossary: settings.glossary,
          custom: settings.customPrompt,
          overrides,
          thinkingLevel: tuning.thinkingLevel,
          temperature: tuning.temperature,
          register,
          qualityMode: !!settings.qualityMode,
          contextCache: settings.contextCache !== false,
        }
      : null;
  if (provider === 'google' || provider === 'bing') {
    // Keyless machine-translation engines: always configured, no quota state.
    const engine = provider;
    return {
      configured: true,
      isGemini: false,
      isMT: true,
      provider,
      cacheId: GXTBG.cacheNamespace(effSettings),
      translate: (group) => GXTBG.mt.translateBatch(group, { engine, targetLang:settings.targetLang || 'fa' }),
      translateTexts: (texts) => GXTBG.mt.translateTexts(texts, { engine, targetLang:settings.targetLang || 'fa' }),
    };
  }
  if (provider === 'openai') {
    const key = await GXTBG.getOpenaiKey();
    const base = {
      key,
      model: settings.openaiModel,
      baseUrl: settings.openaiBaseUrl,
      fallbackModel: settings.openaiFallbackModel,
      extra,
    };
    const context = {
      configured: !!(settings.openaiBaseUrl && settings.openaiModel),
      isGemini: false,
      provider,
      credentialId: await GXTBG.cache.keyFor(key || '', 'pending-credential', '', 0),
      extra,
      cacheId: GXTBG.cacheNamespace(effSettings),
      translate: (group) => GXTBG.openai.translateBatch(group, base),
      translateTexts: (texts, kind, context) =>
        GXTBG.openai.translateTexts(texts, { ...base, kind, context }),
      reviewTexts: (texts, sources, kind) =>
        GXTBG.openai.reviewTexts(texts, sources, { ...base, kind }),
      reviewText: (text, source) => GXTBG.openai.reviewText({ ...base, text, source }),
      translateImage: (mime, data) => GXTBG.openai.translateImage({ ...base, mime, data }),
      summarize: (text) => GXTBG.openai.summarize({ ...base, text }),
      composeEnglish: (text) => GXTBG.openai.composeEnglish({ ...base, text }),
      compressForDub: (text, budget) => GXTBG.openai.compressForDub({ ...base, text, budget }),
    };
    context.setExtra = (value) => {
      base.extra = value;
      context.extra = value;
    };
    return context;
  }
  const keys = await GXTBG.getApiKeys();
  const base = { keys, model: settings.model, extra };
  const context = {
    configured: keys.length > 0,
    isGemini: true,
    provider: 'gemini',
    credentialId: await GXTBG.cache.keyFor(JSON.stringify(keys), 'pending-credential', '', 0),
    keys,
    extra,
    cacheId: GXTBG.cacheNamespace(effSettings),
    translate: (group) => GXTBG.gemini.translateBatch(group, base),
    translateTexts: (texts, kind, context) =>
      GXTBG.gemini.translateTexts(texts, { ...base, kind, context }),
    reviewTexts: (texts, sources, kind) =>
      GXTBG.gemini.reviewTexts(texts, sources, { ...base, kind }),
    reviewText: (text, source) => GXTBG.gemini.reviewText({ ...base, text, source }),
    translateImage: (mime, data) => GXTBG.gemini.translateImage({ ...base, mime, data }),
    summarize: (text) => GXTBG.gemini.summarize({ ...base, text }),
    composeEnglish: (text) => GXTBG.gemini.composeEnglish({ ...base, text }),
    compressForDub: (text, budget) => GXTBG.gemini.compressForDub({ ...base, text, budget }),
  };
  context.setExtra = (value) => {
    base.extra = value;
    context.extra = value;
  };
  return context;
}

/** Credential hygiene for everything that leaves for a content script; the
 *  implementation is shared (and unit-tested) in shared/settings.js. */
const maskKey = GXTBG.maskKey;
const scrub = GXTBG.scrubSecrets;

/**
 * Diagnostics for an error, as delivered to a CONTENT SCRIPT.
 *
 * The user asked for failures to be researchable without a debugger, and they
 * still are: provider, model, HTTP status, Google's status string, the quota
 * id, the raw message and every key that was tried are all here.
 *
 * What is NOT here is the key itself, and that is a correctness requirement,
 * not a preference. This object is rendered into the page's own DOM (the box
 * on X, the card on any site), and a page's own scripts can read their DOM.
 * Shipping the raw key there would hand every Gemini key the user owns to any
 * site that manages to make one translation fail. The popup runs on the
 * extension's own origin and still shows the full key (see TEST_KEY /
 * GET_STATS) — that is where "hide nothing" is safe to honor.
 */
function errorDetail(error, settings) {
  const providerLabel =
    settings.provider === 'openai'
      ? `openai (${settings.openaiBaseUrl})`
      : settings.provider === 'google'
        ? 'google-translate'
        : settings.provider === 'bing'
          ? 'bing-translate'
          : 'gemini';
  const modelLabel =
    settings.provider === 'openai'
      ? settings.openaiModel
      : settings.provider === 'google' || settings.provider === 'bing'
        ? settings.provider
        : settings.model;
  return {
    provider: providerLabel,
    model: modelLabel,
    code: error.code || 'ERR',
    http: error.http || 0,
    apiStatus: error.apiStatus || '',
    quotaId: error.quotaId || '',
    retryAfterMs: error.retryAfterMs || 0,
    raw: scrub(error.raw || ''),
    attempts: (error.attempts || []).map((attempt) => ({
      ...attempt,
      key: maskKey(attempt.key),
      raw: scrub(attempt.raw || ''),
    })),
  };
}

// ------------------------------------------------------- tweet translation

// Request sharing must follow operation identity, including A→B→A changes.
// Compare semantic settings from the storage event itself, so there is no
// asynchronous initialization window and visual-only changes keep sharing.
let translationSettingsGeneration = 0;
function translationSettingsIdentity(raw) {
  const settings = { ...GXTBG.DEFAULTS, ...(raw || {}) };
  return JSON.stringify([GXTBG.cacheNamespace(settings), GXTBG.youtubeTranslationKey(settings),
    settings.openaiFallbackModel || '', settings.batchSize, settings.memoryEnabled, settings.enabled,
    ...['x','page','image','summary','web','file','manga','compose'].map(scope=>GXTBG.forScope(settings,scope).targetLang)]);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const setting = changes[GXTBG.SETTINGS_KEY];
  if ((setting && translationSettingsIdentity(setting.oldValue) !== translationSettingsIdentity(setting.newValue))
      || [GXTBG.API_KEYS_KEY, GXTBG.OPENAI_KEY_KEY, 'apiKey'].some(key => key in changes)) {
    translationSettingsGeneration += 1;
  }
});

function translationFlightKey(scope, payload, settings, ctx, epoch, memoryGeneration, minute) {
  // Full ordered payload: the model reads surrounding batch items and chosen
  // style examples too. Do not splice one pending item into a different batch.
  // Caller DOM/request ids are excluded by the caller; output is remapped.
  return GXTBG.cache.keyFor(JSON.stringify([scope, payload, ctx.cacheId, ctx.credentialId || '',
    ctx.extra || null, settings.openaiFallbackModel || '', settings.batchSize, epoch, memoryGeneration,
    GXTBG.prompt.PROMPT_VERSION, GXTBG.prompt.GENERIC_PROMPT_VERSION, GXTBG.subtitlePrompts.VERSION]), 'pending-request', '', 0);
}

/** A delayed fallback may update only the choice that started its request. */
function persistFallback(settings, model) {
  return GXTBG.setSettings0((current) => (
    current.model === settings.model && current.provider === settings.provider
      && current.ytProvider === settings.ytProvider
      ? { model } : {}
  ));
}

const stableTweetFlights = new Map();
const stableTweetWriters = new Map();
const tweetMetrics = { requests:0, cacheHits:0, shared:0, completed:0, totalMs:0 };

async function translateStableTweets(items, settings, ctx, cacheGeneration, requestEpoch) {
  const startedAt = Date.now();tweetMetrics.requests += items.length;
  // Cache lookup precedes both memory selection and provider availability.
  // Memory and neighboring posts guide the first translation, never its identity.
  const keys = await Promise.all(items.map(it => GXTBG.cache.keyFor(
    JSON.stringify([it.contentId, String(it.text || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim()]),
    'x-content-1', GXTBG.cacheNamespace(settings), 0)));
  const owners = [];
  const promises = items.map((item, index) => {
    const cacheKey = keys[index];
    const flightKey = JSON.stringify([cacheGeneration, requestEpoch, cacheKey]);
    const current = stableTweetFlights.get(flightKey);
    if (current && !item.force) {tweetMetrics.shared++;return current;}
    const writer = {}; stableTweetWriters.set(cacheKey, writer);
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    stableTweetFlights.set(flightKey, promise);
    owners.push({ ...item, id: String(index), _stableKey: cacheKey, _force: item.force === true,
      _accept: () => stableTweetWriters.get(cacheKey) === writer && requestEpoch === translationSettingsGeneration,
      _replacement: () => {const p=stableTweetFlights.get(flightKey);return p!==promise?p:null;},
      _resolve: value => {
        resolve(value);
        if (stableTweetFlights.get(flightKey) === promise) stableTweetFlights.delete(flightKey);
        if (stableTweetWriters.get(cacheKey) === writer) stableTweetWriters.delete(cacheKey);
      } });
    return promise;
  });
  if (owners.length) {
    try {
      const hits = await GXTBG.cache.getMany(owners.filter(x => !x._force).map(x => x._stableKey));
      const misses = [];
      for (const item of owners) {
        const hit = hits[item._stableKey];
        if (hit) {tweetMetrics.cacheHits++;item._resolve({ok:true,t:hit.t,sl:hit.sl,cached:true});}
        else misses.push(item);
      }
      if (owners.length > misses.length) void bumpStats({cacheHits:owners.length-misses.length});
      if (misses.length) {
        await attachMemory(ctx, misses.map(x => x.text));
        const result = await translateTweetRequest(misses, settings, ctx, cacheGeneration);
        for (const item of misses) {
          let value=result.results[item.id];
          if(!item._accept()) {
            const replacement=item._replacement();
            if(replacement)value=await replacement;
            else {const latest=(await GXTBG.cache.getMany([item._stableKey]))[item._stableKey];if(latest)value={ok:true,t:latest.t,sl:latest.sl,cached:true};}
          }
          item._resolve(value);
        }
      }
    } catch (error) {
      for (const item of owners) item._resolve({ok:false,code:error.code||'ERR',error:scrub(error.message||error)});
    }
  }
  const values = await Promise.all(promises);
  tweetMetrics.completed += items.length;tweetMetrics.totalMs += (Date.now()-startedAt)*items.length;
  return {ok:true,results:Object.fromEntries(items.map((item,i)=>[item.id,values[i]]))};
}

async function handleTranslateBatch({ items }) {
  const cacheGeneration = GXTBG.cache.generation();
  const requestEpoch = translationSettingsGeneration;
  const memoryGeneration = GXTBG.memoryGeneration();
  const minute = Math.floor(Date.now() / 60000);
  if (!Array.isArray(items) || !items.length) return { ok: true, results: {} };
  const settings = GXTBG.forScope(await GXTBG.getSettings(),'x');
  const ctx = await getProviderCtx(settings);
  if (items.every(it => typeof it.contentId === 'string' && it.contentId.length <= 30000)) {
    return translateStableTweets(items, settings, ctx, cacheGeneration, requestEpoch);
  }
  if (!ctx.configured) return { ok: false, code: 'NO_KEY' };
  await attachMemory(ctx, items.map((item) => String(item?.text || '')));

  const canonical = items.map((it, i) => ({id: String(i), text: it.text, lang: it.lang || 'auto', author: it.author || '', ctx: it.ctx || ''}));
  const key = await translationFlightKey('tweet', canonical.map(({id, ...item}) => item), settings, ctx, requestEpoch, memoryGeneration, minute);
  const result = await GXTBG.cache.coalesce(key, () => translateTweetRequest(canonical, settings, ctx, cacheGeneration), {generation: cacheGeneration});
  return { ...result, results: Object.fromEntries(items.map((it, i) => [it.id, {...result.results[String(i)]}])) };
}

async function translateTweetRequest(items, settings, ctx, cacheGeneration) {

  const results = {};
  // Identical short replies can mean different things under different quotes.
  const sourceFor = (item) => JSON.stringify([item.text, item.author || '', item.ctx || '']);
  const keys = await Promise.all(
    items.map((it) => it._stableKey || GXTBG.cache.keyFor(sourceFor(it), it.lang || 'auto', ctx.cacheId))
  );
  const hits = await GXTBG.cache.getMany(keys);
  // Migrate a verifiable old entry lazily, including the context-free timeline
  // variant. Opaque legacy hashes are retained; unrelated entries are untouched.
  for (const it of items.filter(x => x._stableKey && !x._force && !hits[x._stableKey])) {
    const legacyKeys = await Promise.all([...new Set([it.ctx || '', ''])].map(context =>
      GXTBG.cache.keyFor(JSON.stringify([it.text,it.author||'',context]),it.lang||'auto',ctx.cacheId)));
    const legacy = await GXTBG.cache.getMany(legacyKeys);
    const hit = legacyKeys.map(key => legacy[key]).find(Boolean);
    if (hit) { hits[it._stableKey] = hit; await GXTBG.cache.setMany([[it._stableKey,hit]], {generation:cacheGeneration,accept:it._accept}); }
  }
  const misses = [];
  items.forEach((it, idx) => {
    const cached = it._force ? undefined : hits[keys[idx]];
    if (cached !== undefined) {
      results[it.id] = { ok: true, t: cached.t, sl: cached.sl || '', cached: true };
    } else {
      misses.push(it);
    }
  });
  const hitCount = items.length - misses.length;
  if (hitCount) void bumpStats({ cacheHits: hitCount });

  const groups = chunk(misses, Math.max(1, Math.min(20, settings.batchSize)));
  await Promise.all(
    groups.map(async (group) => {
      try {
        if (!ctx.configured) throw Object.assign(new Error(globalThis.GXT.i18n.t("background_service_worker_translateTweetRequest_2")),{code:'NO_KEY'});
        const first = await ctx.translate(group);
        const map = first.map;
        const usedModel = first.model;
        const softFallback = first.softFallback;
        let apiCalls = 1;
        // A model can return a syntactically valid batch while dropping one
        // protected token in one item. The shared parser rejects only that
        // item; retry the small set once instead of losing the whole batch.
        const holes = group
          .map((item, index) => ({ item, index }))
          .filter(({ index }) => !map.get(index));
        if (holes.length) {
          try {
            const retry = await ctx.translate(holes.map(({ item }) => item));
            apiCalls += 1;
            holes.forEach(({ index }, retryIndex) => {
              const value = retry.map.get(retryIndex);
              if (value) map.set(index, value);
            });
          } catch {
            /* Preserve valid first-pass results; missing items report below. */
          }
        }
        if (settings.qualityMode && ctx.reviewTexts) {
          const candidates = group
            .map((item, index) => ({ item, index, value: map.get(index) }))
            .filter(({ value }) => value && typeof value.t === 'string' && value.t.trim());
          if (candidates.length) {
            try {
              const reviewed = await ctx.reviewTexts(
                candidates.map(({ value }) => value.t),
                candidates.map(({ item }) => item.text),
                'tweet'
              );
              apiCalls += 1;
              candidates.forEach(({ index, value }, reviewIndex) => {
                const edited = reviewed.list[reviewIndex];
                if (typeof edited === 'string' && edited.trim()) {
                  map.set(index, { ...value, t: edited });
                }
              });
            } catch {
              /* Quality mode is an enhancement; retain the faithful first pass. */
            }
          }
        }
        // A hard Gemini fallback (the chosen model 404'd) is persisted so the
        // popup reflects reality and future cache keys line up. A SOFT fallback
        // (the chosen model timed out) is transient: keep the user's saved model
        // and cache under it, so their choice is honored and re-probed later.
        let cacheId = ctx.cacheId;
        if (ctx.isGemini && usedModel && usedModel !== settings.model && !softFallback) {
          await persistFallback(settings, usedModel);
          cacheId = GXTBG.cacheNamespace({ ...settings, provider: 'gemini', model: usedModel })
            + (ctx.memoryCacheSuffix || '');
        }
        const toStore = [];
        for (let gi = 0; gi < group.length; gi += 1) {
          const item = group[gi];
          const value = map.get(gi);
          if (value && typeof value.t === 'string' && value.t.trim()) {
            results[item.id] = { ok: true, t: value.t, sl: value.sl || '', cached: false };
            toStore.push([
              item._stableKey || await GXTBG.cache.keyFor(sourceFor(item), item.lang || 'auto', cacheId),
              { t: value.t, sl: value.sl || '' },
            ]);
          } else {
            results[item.id] = {
              ok: false,
              code: 'MISSING',
              get error() { return globalThis.GXT.i18n.t("background_service_worker_translateTweetRequest_1"); },
            };
          }
        }
        for (const pair of toStore) {
          const owner = group.find(it => it._stableKey === pair[0]);
          await GXTBG.cache.setMany([pair], { generation: cacheGeneration, accept: owner?._accept });
        }
        void bumpStats({
          apiCalls,
          dayApiCalls: apiCalls,
          translated: toStore.length,
          items_tweet: toStore.length,
        });
      } catch (error) {
        if (error.dailyLimit) void noteLearnedDailyLimit(error.dailyLimit, settings.model);
        const detail = errorDetail(error, settings);
        for (const item of group) {
          results[item.id] = {
            ok: false,
            code: error.code || 'ERR',
            error: scrub(error.message || error),
            detail,
          };
        }
      }
    })
  );
  return { ok: true, results };
}

// ---------------------------------------- generic translation (low-token)

/**
 * Plain string-array translation for selection / page / subtitle features.
 * Response: {ok, list: (string|null)[], failed?: {code, error, detail}}.
 * Nulls mark items whose chunk failed; `failed` describes the first failure.
 */
/**
 * Attach translation-memory hints to a provider context, in place.
 *
 * `ctx.extra` may be null when the user has set no glossary, no custom
 * instruction and no tuning — in that case one is created, because a memory
 * hint is exactly as much a part of the prompt as a glossary entry is.
 */
async function attachMemory(ctx, texts) {
  if(ctx.extra?.targetLang && ctx.extra.targetLang !== 'fa') return;
  try {
    if (ctx.isMT) return;
    const hints = await GXTBG.memory?.hintsForRequest?.(texts);
    if (!hints) return;
    const target = ctx.extra || {};
    if (!ctx.extra) {
      ctx.extra = target;
      ctx.setExtra?.(target);
    }
    target.memory = hints;
    // A correction changes the actual request. Reusing a pre-correction hit
    // would prevent the provider from ever seeing the user's pinned term.
    const entries = Object.entries(hints).sort(([a], [b]) => a.localeCompare(b));
    ctx.memoryCacheSuffix = '#m' + await GXTBG.cache.keyFor(JSON.stringify(entries), 'memory', '', 0);
    ctx.cacheId += ctx.memoryCacheSuffix;
  } catch {
    /* memory is an optimisation; it must never fail a translation */
  }
}

/**
 * Learn from what came back (v3.0.0).
 *
 * Fire-and-forget on purpose: the user is waiting for text on screen, and
 * nothing about remembering a term is worth a millisecond of that.
 */
function learnFrom(sources, targets, generation) {
  try {
    const pairs = [];
    for (let i = 0; i < sources.length; i += 1) {
      if (typeof targets[i] === 'string' && targets[i]) {
        pairs.push({ source: sources[i], target: targets[i] });
      }
    }
    if (pairs.length) void GXTBG.memory?.remember?.(pairs, { generation })?.catch(() => {});
  } catch {
    /* never fatal */
  }
}

async function handleTranslateTexts({ texts, kind, context, quality, source, captionKind }) {
  const cacheGeneration = GXTBG.cache.generation();
  const memoryGeneration = GXTBG.memoryGeneration();
  const requestEpoch = translationSettingsGeneration;
  const minute = Math.floor(Date.now() / 60000);
  if (!Array.isArray(texts) || !texts.length) return { ok: true, list: [] };
  const clean = texts.map((t) => String(t ?? ''));
  const storedSettings = await GXTBG.getSettings();
  const youtubeScope = kind === 'subtitle' && ((source == null && quality !== true) || source === 'youtube');
  const settings = youtubeScope ? GXTBG.youtubeSettings(storedSettings) : GXTBG.forScope(storedSettings,source==='web-video'?'web':kind==='subtitle'?'file':'page');
  const promptKind = youtubeScope ? (captionKind === 'auto' ? 'youtube-auto' : 'youtube-manual') : kind;
  const kindKey = ['subtitle', 'page', 'selection'].includes(kind) ? kind : 'page';
  // YouTube may pin its own engine for subtitles, independent of the global one.
  const providerOverride =
    youtubeScope && settings.ytProvider && settings.ytProvider !== 'inherit'
      ? settings.ytProvider
      : null;
  const effSettings = providerOverride ? { ...settings, provider: providerOverride } : settings;
  const ctx = await getProviderCtx(settings, providerOverride);
  if (!ctx.configured) return { ok: false, code: 'NO_KEY' };
  if (youtubeScope && !ctx.isMT) ctx.setExtra?.({ ...(ctx.extra || {}), targetLang:settings.ytTargetLang });
  if (youtubeScope && ctx.isMT) ctx.translateTexts = texts => GXTBG.mt.translateTexts(texts, {engine:ctx.provider,targetLang:settings.ytTargetLang});
  // Live subtitle latency matters more than a second editorial call. A saved
  // subtitle file can opt in explicitly; page/selection work uses quality mode
  // directly. Keyless MT providers have no review implementation.
  const useQualityPass = !!(
    settings.qualityMode && ctx.reviewTexts
    && !youtubeScope && (kindKey !== 'subtitle' || quality === true)
  );
  // v3.0.0 — established renderings for terms that actually appear in THIS
  // request. Resolved once here rather than per chunk: the memory scan is
  // cheap but it is not free, and every chunk shares the same vocabulary.
  await attachMemory(ctx, clean);
  // Preceding source lines the model may read for continuity (subtitles),
  // never translated or emitted. Bounded so the request can't balloon.
  const ctxLines = Array.isArray(context)
    ? context.map((t) => String(t ?? '')).filter(Boolean).slice(-6)
    : null;
  // The tag carries the GENERIC prompt version, so these keys are bound to it
  // alone (version 0) — a tweet-prompt bump must not flush page/subtitle work.
  // Page markup, subtitle style, the actual editing pass and surrounding
  // dialogue all affect output. In particular, a live draft must never satisfy
  // a later subtitle export that explicitly requests the quality pass.
  const tag = JSON.stringify([
    youtubeScope ? `yt${GXTBG.subtitlePrompts.VERSION}:${settings.ytTargetLang}:${captionKind === 'auto' ? 'auto' : 'manual'}` : `g${GXTBG.prompt.GENERIC_PROMPT_VERSION}`, kindKey, useQualityPass,
    ctx.isMT ? null : ctxLines,
  ]);
  const flightKey = await translationFlightKey('generic', [clean, tag, promptKind, source || '', quality === true, ctxLines], settings, ctx, requestEpoch, memoryGeneration, minute);
  const result = await GXTBG.cache.coalesce(flightKey, () => translateTextsRequest({clean, kind, kindKey, ctxLines, tag, promptKind, youtubeScope, useQualityPass, settings, effSettings, ctx, cacheGeneration, memoryGeneration}), {generation: cacheGeneration});
  return {...result, ...(result.list ? {list:[...result.list]} : {})};
}

async function translateTextsRequest({clean, kind, kindKey, ctxLines, tag, promptKind, youtubeScope, useQualityPass, settings, effSettings, ctx, cacheGeneration, memoryGeneration}) {
  const keys = await Promise.all(clean.map((t) => GXTBG.cache.keyFor(t, tag, ctx.cacheId, 0)));
  const hits = await GXTBG.cache.getMany(keys);
  const list = new Array(clean.length).fill(null);
  const missIdx = [];
  clean.forEach((t, i) => {
    const hit = hits[keys[i]];
    if (hit !== undefined) list[i] = hit.t;
    else missIdx.push(i);
  });
  const hitCount = clean.length - missIdx.length;
  if (hitCount) void bumpStats({ cacheHits: hitCount });

  // Chunk by item count AND character budget so one request never balloons.
  const maxItems = kind === 'subtitle' ? 60 : 40;
  const buildGroups = (indices, cap) => {
    const out = [];
    let current = [];
    let chars = 0;
    for (const i of indices) {
      const len = clean[i].length;
      if (current.length && (current.length >= cap || chars + len > 6000)) {
        out.push(current);
        current = [];
        chars = 0;
      }
      current.push(i);
      chars += len;
    }
    if (current.length) out.push(current);
    return out;
  };

  let failed = null;
  const runGroups = async (groups) => {
    for (const group of groups) {
      try {
        const translated = await ctx.translateTexts(
          group.map((i) => clean[i]),
          youtubeScope ? promptKind : kindKey,
          ctxLines
        );
        let out = translated.list;
        const usedModel = translated.model;
        const softFallback = translated.softFallback;
        let apiCalls = 1;
        if (useQualityPass) {
          const reviewRows = out
            .map((draft, i) => ({ draft, i }))
            .filter(({ draft }) => typeof draft === 'string' && draft.trim());
          try {
            if (reviewRows.length) {
              const reviewed = await ctx.reviewTexts(
                reviewRows.map(({ draft }) => draft),
                reviewRows.map(({ i }) => clean[group[i]]),
                kindKey
              );
              reviewRows.forEach(({ i }, reviewIndex) => {
                const edited = reviewed.list[reviewIndex];
                if (typeof edited === 'string' && edited.trim()) out[i] = edited;
              });
              apiCalls += 1;
            }
          } catch {
            /* Keep the valid first pass when the optional editor is unavailable. */
          }
        }
        // Hard Gemini fallback (chosen model 404'd): persist it (like the tweet
        // path) so future requests skip the dead model, and rebase the cache
        // keys so these results are found under the new model's namespace. A
        // SOFT fallback (chosen model timed out) is transient — keep the user's
        // model and cache under it (their choice is re-probed after a cooldown).
        let writeCacheId = ctx.cacheId;
        if (ctx.isGemini && usedModel && usedModel !== settings.model && !softFallback) {
          await persistFallback(settings, usedModel);
          writeCacheId = GXTBG.cacheNamespace({
            ...settings,
            provider: 'gemini',
            model: usedModel,
          }) + (ctx.memoryCacheSuffix || '');
        }
        const toStore = [];
        for (let gi = 0; gi < group.length; gi += 1) {
          const t = out[gi];
          if (typeof t === 'string' && t.trim()) {
            list[group[gi]] = t;
            toStore.push([await GXTBG.cache.keyFor(clean[group[gi]], tag, writeCacheId, 0), { t }]);
          }
        }
        await GXTBG.cache.setMany(toStore, { generation: cacheGeneration });
        if((youtubeScope ? settings.ytTargetLang : settings.targetLang || 'fa') === 'fa') learnFrom(group.map((i) => clean[i]), group.map((_, gi) => out[gi]), memoryGeneration);
        void bumpStats({
          apiCalls,
          dayApiCalls: apiCalls,
          translated: toStore.length,
          [`items_${kindKey}`]: toStore.length,
        });
      } catch (error) {
        if (error.dailyLimit) void noteLearnedDailyLimit(error.dailyLimit, settings.model);
        failed = {
          code: error.code || 'ERR',
          error: scrub(error.message || error),
          detail: errorDetail(error, effSettings),
        };
        // Quota/key problems will hit every remaining chunk too — stop early.
        if (['RATE_LIMIT', 'BAD_KEY', 'NO_KEY'].includes(error.code)) return true;
      }
    }
    return false;
  };

  const hardStop = await runGroups(buildGroups(missIdx, maxItems));
  // Second pass: even with the indexed protocol a model occasionally drops
  // single items. Retry just the holes once, in small groups; anything still
  // missing stays null and the caller keeps the original text.
  if (!hardStop) {
    const holes = missIdx.filter((i) => list[i] == null);
    if (holes.length) await runGroups(buildGroups(holes, 20));
  }
  // A first-pass transient error that the holes retry fully recovered is not
  // a failure — don't make the caller show a false "partially failed".
  if (failed && missIdx.every((i) => list[i] != null)) failed = null;
  return { ok: true, list, failed };
}

// ---------------------------------------------- context menus + injection

const MENU = {
  selection: 'gxt-sel', page: 'gxt-page', auto: 'gxt-auto', image: 'gxt-img', summary: 'gxt-sum',
  // v2.5.0 — hand-off to the user's own two applications, via the bridge.
  manga: 'gxt-manga', upscale: 'gxt-upscale',
  // v2.5.8 — the whole chapter, not one image.
  chapter: 'gxt-chapter',
  // v2.5.1 — speech, on every site, alongside the translate entries.
  read: 'gxt-read', readPage: 'gxt-read-page',
};
const URL_PATTERNS = ['http://*/*', 'https://*/*'];
// Broad host access requested ONCE for image translation, so the worker can
// fetch an image from any site/CDN without a fresh per-host prompt each time.
// These match the manifest's optional_host_permissions.
const IMAGE_HOST_ORIGINS = ['https://*/*', 'http://*/*'];

/**
 * Rebuild the context menu.
 *
 * Serialized, because it is removeAll-then-create with an `await` in the
 * middle and it has two independent callers (install/startup, and every
 * settings change that alters which items exist). Two overlapping runs
 * interleave as removeAll → removeAll → create → create, and the second set of
 * `create` calls fails with "duplicate id" — leaving whichever items Chrome
 * rejected missing until the next rebuild.
 */
let menuQueue = Promise.resolve();

function setupMenus() {
  menuQueue = menuQueue.then(buildMenus).catch(() => {});
  return menuQueue;
}

/** One rebuild, start to finish. Resolves only when every item exists, which
 *  is what makes queueing these meaningful. */
function buildMenus() {
  return new Promise((done) => {
    chrome.contextMenus.removeAll(() => {
      void (async () => {
        try {
          await createMenuItems();
        } finally {
          done();
        }
      })();
    });
  });
}

async function createMenuItems() {
  const settings = await GXTBG.getSettings();
  chrome.contextMenus.create({
    id: MENU.selection,
    get title() { return globalThis.GXT.i18n.t("background_service_worker_createMenuItems_9"); },
    contexts: ['selection'],
    documentUrlPatterns: URL_PATTERNS,
  });
  chrome.contextMenus.create({
    id: MENU.page,
    get title() { return globalThis.GXT.i18n.t("background_service_worker_createMenuItems_8"); },
    contexts: ['page', 'selection', 'link', 'image', 'video'],
    documentUrlPatterns: URL_PATTERNS,
  });
  if (settings.imageTranslate !== false) {
    chrome.contextMenus.create({
      id: MENU.image,
      get title() { return globalThis.GXT.i18n.t("background_service_worker_createMenuItems_7"); },
      contexts: ['image'],
      documentUrlPatterns: URL_PATTERNS,
    });
  }
  if (settings.summarizer !== false) {
    chrome.contextMenus.create({
      id: MENU.summary,
      get title() { return globalThis.GXT.i18n.t("background_service_worker_createMenuItems_6"); },
      contexts: ['page', 'selection'],
      documentUrlPatterns: URL_PATTERNS,
    });
  }
  // v2.5.1 — the same speech engine that reads X posts, offered as an
  // ordinary right-click action on every site. Two entries, mirroring the
  // two translate entries above: what is selected, or the whole article.
  if (settings.ttsAnywhere !== false) {
    chrome.contextMenus.create({
      id: MENU.read,
      get title() { return globalThis.GXT.i18n.t("content_page_translate_maybeShowSelChip_1"); },
      contexts: ['selection'],
      documentUrlPatterns: URL_PATTERNS,
    });
    chrome.contextMenus.create({
      id: MENU.readPage,
      get title() { return globalThis.GXT.i18n.t("background_service_worker_createMenuItems_5"); },
      contexts: ['page'],
      documentUrlPatterns: URL_PATTERNS,
    });
  }
  // The bridge items appear only when the bridge is switched on. There is
  // no point offering to send an image to a program the user has not set
  // up — and a menu entry that always fails is worse than no entry.
  if (settings.bridgeEnabled) {
    chrome.contextMenus.create({
      id: MENU.manga,
      get title() { return globalThis.GXT.i18n.t("background_service_worker_createMenuItems_4"); },
      contexts: ['image'],
      documentUrlPatterns: URL_PATTERNS,
    });
    // v2.5.8 — the entry that makes this usable for actually reading:
    // the whole chapter, in one run, instead of one right-click per page.
    chrome.contextMenus.create({
      id: MENU.chapter,
      get title() { return globalThis.GXT.i18n.t("background_service_worker_createMenuItems_3"); },
      contexts: ['page', 'image'],
      documentUrlPatterns: URL_PATTERNS,
    });
    chrome.contextMenus.create({
      id: MENU.upscale,
      get title() { return globalThis.GXT.i18n.t("background_service_worker_createMenuItems_2"); },
      contexts: ['video', 'link'],
      documentUrlPatterns: URL_PATTERNS,
    });
  }
  chrome.contextMenus.create({
    id: MENU.auto,
    get title() { return globalThis.GXT.i18n.t("background_service_worker_createMenuItems_1"); },
    contexts: ['page', 'selection', 'link', 'image', 'video'],
    documentUrlPatterns: URL_PATTERNS,
  });
}

/** Inject the page-translate module once per tab (idempotent). When the
 *  user enabled iframe translation, inject into every frame. */
async function ensureInjected(tabId) {
  const settings = await GXTBG.getSettings();
  const allFrames = !!settings.pageFrames;
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => !!globalThis.__gxtPageLoaded,
  });
  if (!probe?.result || allFrames) {
    // The module's own load guard makes double injection harmless.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames },
      files: [
        'shared/settings.js',
        'shared/theme.js',
        'content/ui.js',
        'content/page-translate.js',
        // v2.5.8 — chapter mode. Cheap to carry: it registers a listener and
        // does nothing at all until asked.
        'content/manga.js',
        // v3.0.0 - screen-region OCR. Same reasoning: a listener and nothing
        // more until the user asks for it.
        'content/screen.js',
      ],
    });
  }
}

/** Best-effort toast in the tab (injects the UI module first). Used for
 *  outcomes the user would otherwise experience as "nothing happened", e.g.
 *  declining Chrome's host-permission prompt. */
async function notifyTab(tab, text) {
  if (tab?.id == null) return;
  try {
    await ensureInjected(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'GXT_TOAST', text });
  } catch {
    /* page not injectable (chrome://, PDF viewer, web store) */
  }
}

async function toggleAutoSite(info, tab) {
  let origin;
  try {
    const url = new URL(info.pageUrl);
    if (!/^https?:$/.test(url.protocol)) return;
    if (url.port) return; // match patterns cannot express ports
    origin = url.origin;
  } catch {
    return;
  }
  // Request the host permission up front, inside the user gesture — the very
  // first async op. A prior `await` (e.g. getSettings) consumes the gesture, so
  // enabling a NOT-yet-granted site would silently fail (the same class of bug
  // that broke image translation off X). request() resolves true instantly with
  // no prompt when the origin is already granted (the disable path), so calling
  // it unconditionally is harmless.
  const granted = await chrome.permissions
    .request({ origins: [`${origin}/*`] })
    .catch(() => false);
  const settings = await GXTBG.getSettings();
  const sites = settings.autoSites || [];
  const enabled = sites.includes(origin);
  let message;
  if (enabled) {
    await GXTBG.setSettings({ autoSites: sites.filter((s) => s !== origin) });
    try {
      await chrome.permissions.remove({ origins: [`${origin}/*`] });
    } catch {
      /* permission may be shared; harmless */
    }
    message = globalThis.GXT.i18n.t("background_service_worker_toggleAutoSite_3", {v0:(origin)});
  } else {
    if (!granted) {
      await notifyTab(tab, globalThis.GXT.i18n.t("background_service_worker_toggleAutoSite_2"));
      return;
    }
    await GXTBG.setSettings({ autoSites: [...sites, origin] });
    message = globalThis.GXT.i18n.t("background_service_worker_toggleAutoSite_1", {v0:(origin)});
  }
  await registerAutoSites();
  if (tab?.id != null) {
    try {
      await ensureInjected(tab.id);
      await chrome.tabs.sendMessage(tab.id, { type: 'GXT_TOAST', text: message });
      if (!enabled) await chrome.tabs.sendMessage(tab.id, { type: 'GXT_PAGE' });
    } catch {
      /* tab not injectable (chrome:// etc.) */
    }
  }
}

/** Keep dynamic registrations in sync with settings.autoSites. */
async function registerAutoSites() {
  const settings = await GXTBG.getSettings();
  const sites = (settings.autoSites || []).filter((origin) =>
    /^https?:\/\/[^/]+$/.test(origin)
  );
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const stale = existing.filter((s) => s.id.startsWith('gxt-auto:')).map((s) => s.id);
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  } catch {
    /* nothing registered yet */
  }
  for (const origin of sites) {
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: `gxt-auto:${origin}`,
          matches: [`${origin}/*`],
          js: [
            'shared/settings.js',
            'shared/theme.js',
            'content/ui.js',
            'content/page-translate.js',
          ],
          runAt: 'document_idle',
          allFrames: !!settings.pageFrames,
          persistAcrossSessions: true,
        },
      ]);
    } catch {
      /* origin permission missing (revoked): skip silently */
    }
  }
}

/**
 * Register (or remove) the RTX-Video helper content scripts (v2.0.2).
 *
 * These run on EVERY http(s) page, which is why they are opt-in and why the
 * popup asks for the broad host permission before switching them on. The
 * MAIN-world codec script is separate: it must run at document_start, in the
 * page's own world, and only exists while its own sub-setting is on.
 */
async function registerVsrScripts() {
  const settings = await GXTBG.getSettings();
  const ids = ['gxt-vsr', 'gxt-vsr-main'];
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const stale = existing.filter((s) => ids.includes(s.id)).map((s) => s.id);
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  } catch {
    /* nothing registered yet */
  }
  if (!settings.vsrHelper) return;
  const scripts = [
    {
      id: 'gxt-vsr',
      matches: URL_PATTERNS,
      js: ['shared/settings.js', 'content/vsr.js'],
      runAt: 'document_idle',
      allFrames: true, // embedded players live in iframes
      persistAcrossSessions: true,
    },
  ];
  if (settings.vsrForceH264) {
    scripts.push({
      id: 'gxt-vsr-main',
      matches: URL_PATTERNS,
      js: ['content/vsr-main.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
      persistAcrossSessions: true,
    });
  }
  for (const script of scripts) {
    try {
      await chrome.scripting.registerContentScripts([script]);
    } catch {
      /* host permission not granted (yet): the popup asks for it on enable */
    }
  }
}

// Web video is registered only after explicit opt-in and browser permission.
// A serial queue prevents A→B→A settings changes from racing unregister/register.
const WEB_VIDEO_SCRIPT_ID = 'gxt-web-video';
const WEB_VIDEO_FILES = ['shared/settings.js','shared/memory.js','shared/theme.js','content/dub.js','shared/video-sources.js','content/web-video.js'];
let webVideoQueue = Promise.resolve();
function registerWebVideo() {
  webVideoQueue = webVideoQueue.then(async () => {
    if (!chrome.scripting?.getRegisteredContentScripts || !chrome.permissions?.contains) return;
    const settings = await GXTBG.getSettings();
    const granted = await chrome.permissions.contains({origins:URL_PATTERNS});
    const wanted = settings.enabled && settings.webVideoEnabled && granted;
    const registered = (await chrome.scripting.getRegisteredContentScripts()).some(s => s.id === WEB_VIDEO_SCRIPT_ID);
    if (!wanted) {
      if (registered) await chrome.scripting.unregisterContentScripts({ids:[WEB_VIDEO_SCRIPT_ID]});
      return;
    }
    if (registered) return;
    await chrome.scripting.registerContentScripts([{id:WEB_VIDEO_SCRIPT_ID,matches:URL_PATTERNS,
      excludeMatches:['*://*.youtube.com/*','*://youtube.com/*','*://youtu.be/*'],js:WEB_VIDEO_FILES,
      runAt:'document_idle',allFrames:true,persistAcrossSessions:true}]);
    // Activation affects already-open players too. The module is idempotent;
    // denied/restricted frames fail independently and never break the queue.
    const tabs = await chrome.tabs.query({url:URL_PATTERNS});
    await Promise.allSettled(tabs.filter(tab => tab.id != null && !/^https?:\/\/(?:[^/]+\.)?(?:youtube\.com|youtu\.be)(?:\/|$)/i.test(tab.url || '')).map(tab =>
      chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},files:WEB_VIDEO_FILES})));
  }).catch(error => console.warn(globalThis.GXT.i18n.t("background_service_worker_registerWebVideo_1"), scrub(error?.message || error)));
  return webVideoQueue;
}
chrome.permissions?.onAdded?.addListener(() => { void registerWebVideo(); });
chrome.permissions?.onRemoved?.addListener(() => { void registerWebVideo(); });

/** Image-menu flow: make sure we may fetch the image host, then translate
 *  in the worker and stream the result back to the tab's floating card. */
async function handleImageMenu(info, tab) {
  const src = info.srcUrl || '';
  if (!src) return;
  if (/^https?:/i.test(src)) {
    // Fetching arbitrary images needs cross-origin host access. Ask for the
    // BROAD optional host permission ONCE — not per image host — so the user
    // grants a single "all sites" prompt and then image translation works
    // everywhere with no further prompts (each CDN/site used to prompt again).
    // Must be the FIRST async call: any earlier `await` consumes the user
    // gesture and makes request() throw. request() is silent-true once granted.
    const granted = await chrome.permissions
      .request({ origins: IMAGE_HOST_ORIGINS })
      .catch(() => false);
    // Silence used to be the only feedback when the prompt was declined.
    if (!granted) return void notifyTab(tab, globalThis.GXT.i18n.t("background_service_worker_handleImageMenu_1"));
  } else if (!/^data:image\//i.test(src)) {
    // blob:/filesystem: URLs are not reachable from the worker.
    return void notifyTab(tab, globalThis.GXT.i18n.t("background_service_worker_handleMangaMenu_1"));
  }
  await ensureInjected(tab.id);
  await chrome.tabs.sendMessage(tab.id, { type: 'GXT_IMAGE_BEGIN' });
  const res = await handlers.TRANSLATE_IMAGE({ url: src });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'GXT_IMAGE_RESULT', res });
  } catch {
    /* tab navigated away */
  }
}

/**
 * Chapter flow (v2.5.8): hand the whole reader to the local pipeline.
 *
 * The permission request comes FIRST and before any await, for the same
 * reason it does below — the click's user gesture is spent by the first
 * `await`, and `permissions.request` throws without one. The tab does the
 * rest, because it, unlike this worker, is guaranteed to still be alive in
 * two minutes.
 */
async function handleChapterMenu(tab) {
  const granted = await chrome.permissions
    .request({ origins: IMAGE_HOST_ORIGINS })
    .catch(() => false);
  if (!granted) return void notifyTab(tab, globalThis.GXT.i18n.t("background_service_worker_handleChapterMenu_1"));
  const settings = await GXTBG.getSettings();
  await ensureInjected(tab.id);
  await chrome.tabs.sendMessage(tab.id, {
    type: 'GXT_MANGA_CHAPTER',
    auto: settings.mangaAuto !== false,
  });
}

/**
 * Manga-menu flow: the same image, translated by the user's own local
 * application instead of by a vision model.
 *
 * It shares handleImageMenu's shape for one reason that is easy to get wrong:
 * the worker has to FETCH the page image itself, which needs cross-origin host
 * access, and `permissions.request` only counts as user-initiated while the
 * click's gesture is still alive. Any `await` before it — even a toast — spends
 * the gesture and the call throws. So the request comes first, and only then
 * does anything else happen.
 */
async function handleMangaMenu(info, tab) {
  const src = info.srcUrl || '';
  if (!src) return;
  if (/^https?:/i.test(src)) {
    const granted = await chrome.permissions
      .request({ origins: IMAGE_HOST_ORIGINS })
      .catch(() => false);
    if (!granted) return void notifyTab(tab, globalThis.GXT.i18n.t("background_service_worker_handleMangaMenu_2"));
  } else if (!/^data:image\//i.test(src)) {
    return void notifyTab(tab, globalThis.GXT.i18n.t("background_service_worker_handleMangaMenu_1"));
  }
  await ensureInjected(tab.id);
  // A local page takes several seconds, and a context menu gives no feedback
  // of its own — so the wait is visible in the page from the first moment.
  await chrome.tabs.sendMessage(tab.id, { type: 'GXT_MANGA_BEGIN', src });
  const res = await handlers.BRIDGE_MANGA({ url: src });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'GXT_MANGA_RESULT', src, res });
  } catch {
    /* tab navigated away */
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    if (tab?.id == null) return;
    try {
      if (info.menuItemId === MENU.selection) {
        await ensureInjected(tab.id);
        await chrome.tabs.sendMessage(tab.id, {
          type: 'GXT_SELECTION',
          fallbackText: info.selectionText || '',
        });
      } else if (info.menuItemId === MENU.page) {
        await ensureInjected(tab.id);
        await chrome.tabs.sendMessage(tab.id, { type: 'GXT_PAGE' });
      } else if (info.menuItemId === MENU.image) {
        await handleImageMenu(info, tab);
      } else if (info.menuItemId === MENU.summary) {
        await ensureInjected(tab.id);
        await chrome.tabs.sendMessage(tab.id, {
          type: 'GXT_SUMMARY',
          fallbackText: info.selectionText || '',
        });
      } else if (info.menuItemId === MENU.read) {
        await ensureInjected(tab.id);
        await chrome.tabs.sendMessage(tab.id, {
          type: 'GXT_READ',
          fallbackText: info.selectionText || '',
        });
      } else if (info.menuItemId === MENU.readPage) {
        await ensureInjected(tab.id);
        await chrome.tabs.sendMessage(tab.id, { type: 'GXT_READ_PAGE' });
      } else if (info.menuItemId === MENU.manga) {
        await handleMangaMenu(info, tab);
      } else if (info.menuItemId === MENU.chapter) {
        await handleChapterMenu(tab);
      } else if (info.menuItemId === MENU.upscale) {
        const result = await handlers.BRIDGE_UPSCALE({
          url: info.srcUrl || info.linkUrl || info.pageUrl || '',
          title: tab.title || '',
          page: info.pageUrl || '',
        });
        await notifyTab(
          tab,
          result.ok
            ? globalThis.GXT.i18n.t("background_service_worker_message_7") + (result.launched ? globalThis.GXT.i18n.t("background_service_worker_message_6") : '.')
            : `Anime Studio: ${result.error || globalThis.GXT.i18n.t("background_service_worker_message_5")}`
        );
      } else if (info.menuItemId === MENU.auto) {
        await toggleAutoSite(info, tab);
      }
    } catch {
      /* page not injectable (chrome://, PDF viewer, web store) */
    }
  })();
});

// v1.8: keyboard shortcuts (configurable at chrome://extensions/shortcuts).
chrome.commands?.onCommand?.addListener((command) => {
  void (async () => {
    if (command === 'toggle-enabled') {
      const settings = await GXTBG.getSettings();
      await GXTBG.setSettings({ enabled: !settings.enabled });
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) return;
    try {
      await ensureInjected(tab.id);
      if (command === 'translate-page') {
        await chrome.tabs.sendMessage(tab.id, { type: 'GXT_PAGE' });
      } else if (command === 'translate-selection') {
        await chrome.tabs.sendMessage(tab.id, { type: 'GXT_SELECTION', fallbackText: '' });
      } else if (command === 'translate-screen') {
        await chrome.tabs.sendMessage(tab.id, { type: 'GXT_SCREEN' });
      } else if (command === 'read-selection') {
        // One key for both directions: pressing it again while something is
        // being read stops it, so speech can never be left running invisibly.
        await chrome.tabs.sendMessage(tab.id, { type: 'GXT_READ', fallbackText: '', toggle: true });
      }
    } catch {
      /* page not injectable */
    }
  })();
});

// ---------------------------------------------- plain-text tools (v1.8)

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** A sensible file name for a downloaded image.
 *
 *  `new URL(dataUrl).pathname` is the entire base64 payload, so a data: image
 *  would otherwise be "named" with a megabyte of it. */
function fileNameFromUrl(url) {
  if (/^data:/i.test(url)) return 'page.png';
  try {
    return (new URL(url).pathname.split('/').pop() || 'page.png').slice(0, 80);
  } catch {
    return 'page.png';
  }
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** One manga page. Above this it is not a page, it is a mistake. */
const MAX_PAGE_BYTES = 24 * 1024 * 1024;
/**
 * Total base64 a single chapter hand-off may hold in the worker.
 *
 * An MV3 worker has no special memory budget; this whole payload exists twice
 * over (the array of strings, then the JSON body), so the real footprint is
 * roughly double. 192 MB of base64 ≈ 144 MB of images ≈ a long webtoon
 * chapter, and stays far from the point where Chrome kills the worker.
 */
const MAX_CHAPTER_BYTES = 192 * 1024 * 1024;

/** Keep the deadline and size ceiling active through the image body read. */
async function fetchImageBytes(url, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let reader;
  const tooLarge = () => Object.assign(new Error(globalThis.GXT.i18n.t("background_service_worker_tooLarge_1")), { code: 'IMG_TOO_LARGE' });
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw Object.assign(new Error(globalThis.GXT.i18n.t("background_service_worker_fetchImageBytes_3", {v0:(response.status)})), {
        code: 'FETCH_IMG', http: response.status,
      });
    }
    if (Number(response.headers?.get('Content-Length')) > maxBytes) throw tooLarge();
    let buffer;
    if (response.body?.getReader) {
      reader = response.body.getReader();
      const parts = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw tooLarge();
        parts.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      buffer = bytes.buffer;
    } else {
      buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) throw tooLarge();
    }
    if (!buffer.byteLength) throw Object.assign(new Error(globalThis.GXT.i18n.t("background_service_worker_fetchImageBytes_2")), { code: 'FETCH_IMG' });
    return { buffer, mime: response.headers?.get('Content-Type') || '' };
  } catch (error) {
    if (controller.signal.aborted) {
      throw Object.assign(new Error(globalThis.GXT.i18n.t("background_service_worker_fetchImageBytes_1")), { code: 'TIMEOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    controller.abort();
  }
}

/** Shared wrapper for the plain-text AI tools: provider gate + errors. */
async function runAiTool(statKey, cacheTag, cacheKeySource, run, targetLang) {
  const cacheGeneration = GXTBG.cache.generation();
  const settings = GXTBG.forScope(await GXTBG.getSettings(),cacheTag==='compose'?'compose':cacheTag==='summary'?'summary':cacheTag==='image'?'image':'web');
  if(GXTBG.validTarget(targetLang)) settings.targetLang=targetLang;
  const ctx = await getProviderCtx(settings);
  if(cacheTag==='compose'&&ctx.setExtra)ctx.setExtra({...ctx.extra,targetLang:settings.targetLang});
  if (!ctx.configured) return { ok: false, code: 'NO_KEY' };
  if (ctx.isMT) {
    return {
      ok: false,
      code: 'NEED_AI',
      get error() { return globalThis.GXT.i18n.t("background_service_worker_runAiTool_1"); },
    };
  }
  let cacheKey = null;
  if (cacheKeySource) {
    // Version 0: the image/summary prompts have their own lifecycle — they are
    // not invalidated by a tweet-prompt bump (see cache.keyFor).
    cacheKey = await GXTBG.cache.keyFor(cacheKeySource, cacheTag, ctx.cacheId, 0);
    const hits = await GXTBG.cache.getMany([cacheKey]);
    const hit = hits[cacheKey];
    if (hit !== undefined) {
      void bumpStats({ cacheHits: 1 });
      return { ok: true, t: hit.t, cached: true };
    }
  }
  try {
    const { text } = await run(ctx, settings);
    if (cacheKey) await GXTBG.cache.setMany([[cacheKey, { t: text }]], { generation: cacheGeneration });
    void bumpStats({ apiCalls: 1, dayApiCalls: 1, translated: 1, [statKey]: 1 });
    return { ok: true, t: text };
  } catch (error) {
    if (error.dailyLimit) void noteLearnedDailyLimit(error.dailyLimit, settings.model);
    return {
      ok: false,
      code: error.code || 'ERR',
      error: scrub(error.message || error),
      detail: errorDetail(error, settings),
    };
  }
}

/** Fetch an image and translate every piece of foreign text in it. */
async function handleTranslateImage({ url }) {
  return runAiTool('items_image', 'image', url, async (ctx) => {
    let image;
    try {
      image = await fetchImageBytes(url, MAX_IMAGE_BYTES);
    } catch (error) {
      if (error.code) throw error;
      const err = new Error(globalThis.GXT.i18n.t("background_service_worker_err_1"));
      err.code = 'FETCH_IMG';
      throw err;
    }
    const mime = /^image\//.test(image.mime) ? image.mime.split(';')[0] : 'image/jpeg';
    const data = bufToBase64(image.buffer);
    return ctx.translateImage(mime, data);
  });
}

// ------------------------------------------------------------------ router

/**
 * Is there a model newer than the one in use? (v3.0.0)
 *
 * `modelRank` already sorts a line-up NUMERICALLY (so 3.10 outranks 3.9,
 * which a string sort gets wrong). "Newer" here means: entries the discovery
 * pass returned that rank above the current choice — which is exactly the
 * question behind a «به‌روزرسانی» button, and a far more useful answer than
 * "the list was refreshed".
 */
function newerThan(current, list) {
  if (!current || !Array.isArray(list)) return [];
  const mine = GXTBG.modelRank(current);
  return list
    .map((entry) => (typeof entry === 'string' ? entry : entry.id))
    .filter((id) => id && id !== current && GXTBG.modelRank(id) > mine)
    .slice(0, 5);
}

const handlers = {
  async SETTINGS_PATCH({ patch }) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.entries(patch).some(([name, value]) => !GXTBG.isSettingValue(name, value))) {
      return { ok: false, code: 'BAD_SETTINGS' };
    }
    await GXTBG.setSettings(patch);
    return { ok: true };
  },

  async WEB_VIDEO_SITE({hostname, blocked}) {
    if (typeof hostname !== 'string' || typeof blocked !== 'boolean') return {ok:false,code:'BAD_SETTINGS'};
    await GXTBG.setWebVideoSiteBlocked(hostname, blocked);
    return {ok:true};
  },

  async SITE_SETTING({ origin, name, value }) {
    if (!GXTBG.originOf(origin) || !GXTBG.SITE_KEYS.includes(name) ||
        (value !== undefined && !GXTBG.isSettingValue(name, value))) {
      return { ok: false, code: 'BAD_SETTINGS' };
    }
    await GXTBG.setSiteSetting(origin, name, value);
    return { ok: true };
  },

  async SITE_CLEAR({ origin }) {
    if (!GXTBG.originOf(origin)) return { ok: false, code: 'BAD_SETTINGS' };
    await GXTBG.clearSitePrefs(origin);
    return { ok: true };
  },

  TRANSLATE_BATCH: handleTranslateBatch,

  // ══════════════════════════════════════════════ v3.0.0 — backup & memory

  /**
   * Everything the user would be devastated to lose, as one JSON object.
   *
   * Twelve API keys, a glossary, prompt overrides, per-model tuning and the
   * translation memory all lived in one Chrome profile with no export path: a
   * profile reset, a reinstall or a new machine lost all of it. This was the
   * only irreversible failure mode in the product.
   */
  async EXPORT_BACKUP({ includeKeys, includeMemory }) {
    const data = await GXTBG.exportBackup({
      includeKeys: !!includeKeys,
      includeMemory: includeMemory !== false,
    });
    return { ok: true, data };
  },

  async IMPORT_BACKUP({ data, mode }) {
    try {
      const report = await GXTBG.importBackup(data, { mode: mode === 'replace' ? 'replace' : 'merge' });
      // Menus, auto-sites and the badge all derive from settings that may have
      // just changed wholesale; rebuild rather than wait for the next toggle.
      setupMenus();
      void registerAutoSites();
      void registerVsrScripts();
  void registerWebVideo();
      void updateBadge();
      return { ok: true, report };
    } catch (error) {
      return { ok: false, code: 'BAD_BACKUP', error: String(error.message || error) };
    }
  },

  async GET_MEMORY({ limit }) {
    const memory = await GXTBG.getMemory();
    const lines = GXTBG.memory.toLines(memory);
    return {
      ok: true,
      count: memory.count || 0,
      lines: typeof limit === 'number' ? lines.slice(0, limit) : lines,
    };
  },

  /** A correction the user made by hand. Pinned, so nothing overwrites it. */
  async PIN_TERM({ source, target }) {
    const clean = String(source || '').trim();
    const value = String(target || '').trim();
    if (!clean || !value) return { ok: false, code: 'EMPTY_INPUT' };
    const count = await GXTBG.memory.pin(clean, value);
    return { ok: true, count };
  },

  async FORGET_TERM({ source }) {
    await GXTBG.memory.forget(String(source || ''));
    const memory = await GXTBG.getMemory();
    return { ok: true, count: memory.count || 0 };
  },

  async CLEAR_MEMORY() {
    await GXTBG.clearMemory();
    return { ok: true, count: 0 };
  },

  // ═══════════════════════════════════════════ v3.0.0 — the editing pass

  /**
   * Run the second (editing) pass over Persian the model has already produced.
   *
   * Exposed as its own message rather than folded into the translators
   * because it is a DELIBERATE act: the caller — a card's «ویرایش دقیق»
   * button, a subtitle export — decides that this particular text is worth
   * roughly double. Folding it into every translation would double the cost of
   * scrolling a timeline, which is not a trade anyone asked for.
   */
  async REVIEW_TEXT({ text, source, targetLang }) {
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, code: 'EMPTY_INPUT', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_45"); } };
    const settings = GXTBG.forScope(await GXTBG.getSettings(),'x');
    if(GXTBG.validTarget(targetLang))settings.targetLang=targetLang;
    const ctx = await getProviderCtx(settings);
    if (!ctx.configured) return { ok: false, code: 'NO_KEY' };
    if (!ctx.reviewText) {
      return { ok: false, code: 'UNSUPPORTED', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_44"); } };
    }
    try {
      const result = await ctx.reviewText(clean, String(source || ''));
      void bumpStats({ apiCalls: 1, dayApiCalls: 1 });
      return { ok: true, text: result.text, changed: result.text.trim() !== clean };
    } catch (error) {
      return {
        ok: false,
        code: error.code || 'ERR',
        error: scrub(error.message || error),
        detail: errorDetail(error, settings),
      };
    }
  },

  // ═════════════════════════════════ v3.0.0 — "check for updates", everywhere
  //
  // THE REQUIREMENT: model line-ups change every few weeks, and an extension
  // that ships a hard-coded list is obsolete the moment it is published. Every
  // model picker, every engine and every local dependency therefore has a
  // control that goes and ASKS what exists right now.
  //
  // One handler serves all of them so a new engine cannot be added with the
  // "check" left out — the shape is a map of engine → result, and the UI
  // renders whatever it finds.

  async CHECK_UPDATES({ scope }) {
    const settings = await GXTBG.getSettings();
    const want = (name) => !scope || scope === 'all' || scope === name;
    const out = { ok: true, at: Date.now(), engines: {} };

    if (want('gemini')) {
      out.engines.gemini = await (async () => {
        try {
          const keys = await GXTBG.getApiKeys();
          if (!keys.length) return { ok: false, code: 'NO_KEY', get hint() { return globalThis.GXT.i18n.t("background_live_connect_5"); } };
          let lastError = null;
          for (const key of keys) {
            try {
              const models = await GXTBG.gemini.listModels(key);
              await chrome.storage.local.set({ [GXTBG.MODEL_LIST_KEY]: models });
              const groups = GXTBG.classifyModels(models);
              return {
                ok: true,
                total: models.length,
                groups,
                // What the user is actually asking: is there something newer
                // than what I have selected?
                newer: newerThan(settings.model, groups.text),
                current: settings.model,
              };
            } catch (error) {
              lastError = error;
            }
          }
          return { ok: false, code: lastError?.code || 'ERR', hint: scrub(lastError?.message || '') };
        } catch (error) {
          return { ok: false, code: 'ERR', hint: scrub(error.message || error) };
        }
      })();
    }

    if (want('openai')) {
      out.engines.openai = await (async () => {
        if (!settings.openaiBaseUrl) return { ok: false, code: 'NOT_SET', get hint() { return globalThis.GXT.i18n.t("background_service_worker_handlers_43"); } };
        try {
          const key = await GXTBG.getOpenaiKey();
          const models = await GXTBG.openai.listModels({ baseUrl: settings.openaiBaseUrl, key });
          await chrome.storage.local.set({ [GXTBG.OPENAI_MODEL_LIST_KEY]: models });
          const groups = GXTBG.classifyOpenaiModels(models);
          return {
            ok: true,
            total: models.length,
            groups,
            newer: newerThan(settings.openaiModel, groups.text),
            current: settings.openaiModel,
          };
        } catch (error) {
          return { ok: false, code: error.code || 'ERR', hint: scrub(error.message || error) };
        }
      })();
    }

    if (want('bridge')) {
      out.engines.bridge = await (async () => {
        try {
          const health = await GXTBG.bridge.health(settings, { force: true });
          if (!health?.ok) {
            return { ok: false, code: 'OFFLINE', get hint() { return globalThis.GXT.i18n.t("background_service_worker_handlers_42"); } };
          }
          // The bridge reports its own dependency versions and what upgrades
          // it can see — the local half of "is any of this out of date?".
          const deps = await GXTBG.bridge.updates(settings).catch(() => null);
          const voices = await GXTBG.bridge.voices(settings).catch(() => null);
          if (voices) await chrome.storage.local.set({ [GXTBG.LOCAL_VOICE_LIST_KEY]: voices });
          return {
            ok: true,
            version: health.version,
            capabilities: health.capabilities || {},
            deps: deps || null,
            voices: voices || null,
          };
        } catch (error) {
          return { ok: false, code: 'OFFLINE', hint: scrub(error.message || error) };
        }
      })();
    }

    if (want('extension')) {
      out.engines.extension = {
        ok: true,
        version: chrome.runtime.getManifest().version,
        // An unpacked extension has no update channel; saying so plainly beats
        // a button that silently does nothing.
        channel: chrome.runtime.getManifest().update_url ? 'store' : 'unpacked',
      };
    }

    return out;
  },


  /**
   * Read text out of a captured screen region and translate it (v3.0.0).
   *
   * The pixels go to the LOCAL bridge and no further: only the recognised
   * TEXT is sent to a translation engine, and only when the user's engine is
   * a cloud one. That ordering is the whole privacy story of this feature and
   * it is why OCR is not done in the cloud even though it would be easier.
   */
  async OCR_TRANSLATE({ image }) {
    if (!image) return { ok: false, code: 'EMPTY_INPUT', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_41"); } };
    const settings = await GXTBG.getSettings();
    if (!settings.bridgeEnabled) {
      return {
        ok: false,
        code: 'NO_BRIDGE',
        get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_40"); },
      };
    }
    let read;
    try {
      read = await GXTBG.bridge.ocr(settings, { image });
    } catch (error) {
      return { ok: false, code: 'OFFLINE', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_39"); }, detail: { raw: String(error.message || error) } };
    }
    if (!read?.ok) {
      return { ok: false, code: read?.code || 'OCR_FAILED', error: read?.error || globalThis.GXT.i18n.t("background_service_worker_handlers_38"), hint: read?.hint };
    }
    const lines = (read.boxes || []).map((b) => b.text).filter(Boolean);
    if (!lines.length) return { ok: true, text: '', translated: '', lines: 0, boxes: [] };

    // Reuse the ordinary generic pipeline: cache, memory, key rotation, the
    // holes retry — all of it applies here exactly as it does to a web page.
    const result = await handleTranslateTexts({ texts: lines, kind: 'page' });
    const translated = (result.list || []).map((t, i) => t || lines[i]);
    return {
      ok: true,
      text: lines.join('\n'),
      translated: translated.join('\n'),
      lines: lines.length,
      boxes: (read.boxes || []).map((b, i) => ({ ...b, fa: translated[i] || '' })),
      failed: result.failed || null,
    };
  },

  // ══════════════════════════════════════════════ v3.0.0 — self-diagnosis

  /**
   * One button that answers "why isn't it working?" in order of likelihood.
   *
   * Written for someone who does not read stack traces: every check returns a
   * plain Persian sentence and, when it fails, the ONE thing to do about it.
   * The order is deliberate — a missing key makes every later check
   * meaningless, so the report stops being alarming once the real cause is
   * found.
   */
  async DIAGNOSE({ tabId }) {
    const settings = await GXTBG.getSettings();
    const checks = [];
    const add = (id, label, ok, detail, fix) => checks.push({ id, label, ok, detail, fix });

    add('enabled', globalThis.GXT.i18n.t("background_service_worker_handlers_37"), !!settings.enabled,
      settings.enabled ? '' : globalThis.GXT.i18n.t("background_service_worker_handlers_36"),
      settings.enabled ? '' : globalThis.GXT.i18n.t("background_service_worker_handlers_35"));

    const provider = settings.provider;
    if (provider === 'gemini') {
      const keys = await GXTBG.getApiKeys();
      add('key', globalThis.GXT.i18n.t("background_service_worker_handlers_34"), keys.length > 0,
        keys.length ? globalThis.GXT.i18n.t("background_service_worker_handlers_33", {v0:(keys.length)}) : globalThis.GXT.i18n.t("background_service_worker_handlers_32"),
        keys.length ? '' : globalThis.GXT.i18n.t("background_service_worker_handlers_31"));
      if (keys.length) {
        const usage = await getKeyUsage(settings.model);
        const quota = GXTBG.quotaSummary({
          keys, usage: usage.keys, model: settings.model, override: settings.dailyQuota,
        });
        add('quota', globalThis.GXT.i18n.t("background_service_worker_handlers_30"), quota.state !== 'exhausted',
          globalThis.GXT.i18n.t("background_service_worker_handlers_29", {v0:(quota.used), v1:(quota.limit)}),
          quota.state === 'exhausted'
            ? globalThis.GXT.i18n.t("background_service_worker_handlers_28")
            : '');
        // The only check that proves the whole chain: network + key + model.
        try {
          const { count } = await GXTBG.gemini.testKey(keys[0]);
          add('reach', globalThis.GXT.i18n.t("background_service_worker_handlers_26"), true, globalThis.GXT.i18n.t("background_service_worker_handlers_27", {v0:(count)}), '');
        } catch (error) {
          add('reach', globalThis.GXT.i18n.t("background_service_worker_handlers_26"), false,
            scrub(error.message || error),
            error.code === 'BAD_KEY'
              ? globalThis.GXT.i18n.t("background_service_worker_handlers_25")
              : globalThis.GXT.i18n.t("background_service_worker_handlers_24"));
        }
      }
    } else if (provider === 'openai') {
      add('key', globalThis.GXT.i18n.t("background_service_worker_handlers_23"), !!settings.openaiBaseUrl,
        settings.openaiBaseUrl || globalThis.GXT.i18n.t("background_service_worker_handlers_22"),
        settings.openaiBaseUrl ? '' : globalThis.GXT.i18n.t("background_service_worker_handlers_21"));
    } else {
      add('key', globalThis.GXT.i18n.t("background_service_worker_handlers_20"), true, provider, '');
    }

    if (settings.bridgeEnabled) {
      const health = await GXTBG.bridge.health(settings, { force: true }).catch(() => null);
      add('bridge', globalThis.GXT.i18n.t("background_service_worker_handlers_19"), !!health?.ok,
        health?.ok ? globalThis.GXT.i18n.t("background_service_worker_handlers_18", {v0:(health.version)}) : globalThis.GXT.i18n.t("background_service_worker_handlers_17"),
        health?.ok ? '' : globalThis.GXT.i18n.t("background_service_worker_handlers_16"));
    }

    // Can we act on the page in front of the user right now?
    if (tabId != null) {
      try {
        await ensureInjected(tabId);
        add('tab', globalThis.GXT.i18n.t("background_service_worker_handlers_15"), true, '', '');
      } catch (error) {
        add('tab', globalThis.GXT.i18n.t("background_service_worker_handlers_15"), false,
          scrub(error.message || error),
          globalThis.GXT.i18n.t("background_service_worker_handlers_14"));
      }
    }

    const firstProblem = checks.find((c) => !c.ok);
    return { ok: true, checks, verdict: firstProblem ? firstProblem.fix || firstProblem.detail : '' };
  },

  async ENSURE_YOUTUBE_HELPER(message, sender) {
    if (sender?.tab?.id == null || !/^https:\/\/www\.youtube\.com\//.test(sender.url || '')) return {ok:false,code:'FORBIDDEN'};
    await chrome.scripting.executeScript({target:{tabId:sender.tab.id,frameIds:[sender.frameId || 0]},world:'MAIN',files:['content/yt-main.js']});
    return {ok:true};
  },
  TRANSLATE_TEXTS: handleTranslateTexts,
  TRANSLATE_WORKSHOP: translateWorkshop,
  CANCEL_WORKSHOP: cancelWorkshop,
  TRANSLATE_IMAGE: handleTranslateImage,

  /** Persian bullet summary of page/selection/thread text (v1.8).
   *  `async` matters: the router awaits every handler, and a handler that
   *  returned a bare object on its early-exit path threw inside the listener,
   *  so the caller's sendMessage never resolved (v1.9.6 fix). */
  async TRANSLATE_SUMMARY({ text }) {
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, code: 'EMPTY_INPUT', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_13"); } };
    return runAiTool('items_summary', 'summary', clean, (ctx) => ctx.summarize(clean));
  },

  /** Persian composer draft → natural English X post (v1.8). */
  async TRANSLATE_COMPOSE({ text }) {
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, code: 'EMPTY_INPUT', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_12"); } };
    // No cache: drafts are one-off by nature.
    return runAiTool('items_tweet', 'compose', null, (ctx) => ctx.composeEnglish(clean));
  },

  /**
   * Shorten one Persian line so it can be SPOKEN inside `budget` characters
   * (v2.4.5). Cached by line+budget, so a rewatch — and a second pass over the
   * same line at the same slot — costs nothing.
   */
  async DUB_COMPRESS({ text, budget, targetLang }) {
    const clean = String(text || '').trim();
    const target = Math.max(10, Math.round(Number(budget) || 0));
    if (!clean || !target) return { ok: false, code: 'EMPTY_INPUT', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_11"); } };
    // Already short enough: never spend a call to be told so.
    if (clean.length <= target) return { ok: true, t: clean, cached: true, unchanged: true };
    // The budget is part of the key: the same line squeezed into a different
    // slot is a different answer.
    return runAiTool('items_subtitle', `dubc${target}`, clean, (ctx) => ctx.compressForDub(clean, target),targetLang);
  },

  // ------------------------------------------------ local bridge (v2.5.0)

  /** What the companion service on this machine can do right now. `force`
   *  skips the short health cache, for the «بررسی اتصال» button. */
  async BRIDGE_HEALTH({ force }) {
    const settings = await GXTBG.getSettings();
    return GXTBG.bridge.health(settings, { force: !!force });
  },

  /** Send an image to MangaTranslator's local pipeline — OCR, inpainting and
   *  typesetting that no cloud vision call comes close to.
   *
   *  The reply carries the finished page as a data URL when the bridge sent
   *  one, so the caller can show the translated page in place instead of
   *  reciting a file path the browser cannot open. */
  async BRIDGE_MANGA({ url }) {
    const settings = await GXTBG.getSettings();
    if (!settings.bridgeEnabled) return { ok: false, code: 'OFF', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_4"); } };
    if (!url) return { ok: false, code: 'FETCH', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_10"); } };
    try {
      const { buffer } = await fetchImageBytes(url, MAX_PAGE_BYTES);
      const name = fileNameFromUrl(url);
      const result = await GXTBG.bridge.manga(settings, { image: bufToBase64(buffer), name });
      if (result?.ok && result.data) {
        return { ...result, dataUrl: `data:${result.mime || 'image/png'};base64,${result.data}`, data: undefined };
      }
      return result;
    } catch (error) {
      return { ok: false, code: error.code || 'FAILED', error: scrub(error?.message || error) };
    }
  },

  // -------------------------------------------------- manga chapter (v2.5.8)
  //
  // The worker does the two things a page cannot: it fetches the images with
  // host permission (so a CDN's CORS policy is irrelevant), and it talks to
  // the loopback bridge. Everything else — finding the pages, showing them,
  // driving the poll loop — stays in the tab, deliberately: an MV3 worker is
  // shut down when idle, and a two-minute chapter would outlive it. The
  // content script polling keeps it awake exactly as long as work exists.

  /** Fetch every page, then hand the whole chapter to the local pipeline. */
  async MANGA_START({ urls }) {
    const settings = await GXTBG.getSettings();
    if (!settings.bridgeEnabled) return { ok: false, code: 'OFF', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_4"); } };
    const list = Array.isArray(urls) ? urls.slice(0, 200) : [];
    if (!list.length) return { ok: false, code: 'EMPTY', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_9"); } };

    const pages = [];
    const indexMap = [];
    const skipped = [];
    let bytes = 0;
    let truncated = false;
    // Fetched a few at a time: a chapter is dozens of megabytes and firing
    // every request at once makes a site's CDN throttle or drop them.
    const FETCH_AT_ONCE = 4;
    for (let start = 0; start < list.length && !truncated; start += FETCH_AT_ONCE) {
      const slice = list.slice(start, start + FETCH_AT_ONCE);
      const fetched = await Promise.all(slice.map(async (url, offset) => {
        try {
          const { buffer } = await fetchImageBytes(url, MAX_PAGE_BYTES);
          return { url, at: start + offset, image: bufToBase64(buffer), name: fileNameFromUrl(url) };
        } catch (error) {
          return { url, error: String(error?.message || error) };
        }
      }));
      for (const item of fetched) {
        // A page the site refused is skipped, never fatal: nineteen translated
        // pages beat a chapter that failed because one image 404'd.
        if (item.error) {
          skipped.push(item.url);
          continue;
        }
        // Every page is held in memory as base64 (a third larger than the file)
        // AND again inside the JSON body sent to the bridge. Two hundred pages
        // of a high-resolution webtoon is gigabytes, and the worker is killed
        // long before that — taking the whole chapter with it. Stop at a
        // ceiling and translate what fits, which is a partial chapter instead
        // of no chapter.
        if (bytes + item.image.length > MAX_CHAPTER_BYTES) {
          truncated = true;
          break;
        }
        bytes += item.image.length;
        indexMap.push(item.at);
        pages.push({ image: item.image, name: item.name });
      }
    }
    if (!pages.length) {
      return { ok: false, code: 'FETCH', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_8"); } };
    }
    const started = await GXTBG.bridge.mangaStart(settings, {
      pages,
      concurrency: settings.mangaConcurrency || 3,
    });
    if (!started?.ok) return started;
    // `indexMap[i]` is the position in the caller's ORIGINAL list of the page
    // the bridge knows as `i` — without it, one unreachable image would shift
    // every later page onto the wrong picture.
    return { ...started, indexMap, skipped, truncated };
  },

  async MANGA_STATUS({ job }) {
    const settings = await GXTBG.getSettings();
    return GXTBG.bridge.mangaStatus(settings, { job });
  },

  /** One finished page, as a data URL the tab can display directly. */
  async MANGA_PAGE({ job, index }) {
    const settings = await GXTBG.getSettings();
    const result = await GXTBG.bridge.mangaPage(settings, { job, index });
    if (result?.ok && result.data) {
      return { ...result, dataUrl: `data:${result.mime || 'image/png'};base64,${result.data}`, data: undefined };
    }
    return result;
  },

  async MANGA_CANCEL({ job }) {
    const settings = await GXTBG.getSettings();
    return GXTBG.bridge.mangaCancel(settings, { job });
  },

  async MANGA_ARCHIVE({ job }) {
    const settings = await GXTBG.getSettings();
    const result = await GXTBG.bridge.mangaArchive(settings, { job });
    if (result?.ok && result.data) {
      return {
        ...result,
        dataUrl: `data:${result.mime || 'application/vnd.comicbook+zip'};base64,${result.data}`,
        data: undefined,
      };
    }
    return result;
  },

  /** Queue a video for Anime Studio's TensorRT upscaler. */
  async BRIDGE_UPSCALE({ url, title, page }) {
    const settings = await GXTBG.getSettings();
    if (!settings.bridgeEnabled) return { ok: false, code: 'OFF', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_4"); } };
    return GXTBG.bridge.upscale(settings, { url, title, page, launch: true });
  },

  /** Transcribe one window of audio. The caller passes `offsetMs` so the
   *  returned cues land on the video's real timeline, not the chunk's zero. */
  async BRIDGE_ASR({ audio, language, offsetMs }) {
    const settings = await GXTBG.getSettings();
    if (!settings.bridgeEnabled || !settings.bridgeAsr) {
      return { ok: false, code: 'OFF', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_7"); } };
    }
    return GXTBG.bridge.transcribe(settings, {
      audio, language, offsetMs, model: settings.bridgeAsrModel || 'small',
    });
  },

  // ------------------------------------------------------ speech (v2.2.0)

  /**
   * Split text into speakable pieces. The player asks for this ONCE, then
   * requests pieces one at a time — so playback starts after the first short
   * piece instead of after the whole article, each piece caches on its own,
   * and stopping mid-way costs nothing further.
   */
  async TTS_SPLIT({ text }) {
    const parts = GXTBG.tts.split(text);
    if (!parts.length) return { ok: false, code: 'EMPTY_INPUT', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_6"); } };
    return { ok: true, parts };
  },

  /** Synthesize one piece. Cache-first: audio is the most expensive thing
   *  this extension produces, and a replay must cost nothing.
   *
   *  `rate` overrides the saved speaking rate for THIS call only — the dub
   *  builder uses it to make a line fit its time slot. It is folded into the
   *  cache key (via cfg) so a re-timed line never collides with the normal one. */
  async TTS_SPEAK({ text, rate }) {
    const cacheGeneration = GXTBG.audioCache.generation();
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, code: 'EMPTY_INPUT', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_6"); } };
    const settings = await GXTBG.getSettings();
    const cfg = GXTBG.resolveTts(
      typeof rate === 'number' && Number.isFinite(rate) ? { ...settings, ttsRate: rate } : settings
    );
    const endpoint = cfg.engine === 'openai'
      ? String(settings.openaiBaseUrl || '').trim().replace(/\/+$/, '')
      : cfg.engine === 'bridge' ? GXTBG.bridge._internal.baseUrl(settings) : '';
    const cacheKey = await GXTBG.audioCache.keyFor({ text: clean, ...cfg, endpoint });
    const hit = await GXTBG.audioCache.get(cacheKey);
    if (hit) return { ok: true, ...hit, engine: cfg.engine, voice: cfg.voice, cached: true };

    try {
      const opts = { ...cfg };
      if (cfg.engine === 'gemini') opts.keys = await GXTBG.getApiKeys();
      if (cfg.engine === 'openai') {
        opts.baseUrl = settings.openaiBaseUrl;
        opts.key = await GXTBG.getOpenaiKey();
      }
      // The bridge needs the whole settings object (port + token), not a
      // credential pair.
      if (cfg.engine === 'bridge') opts.settings = settings;
      const clip = await GXTBG.tts.speak(clean, opts);
      await GXTBG.audioCache.put(cacheKey, { mime: clip.mime, data: clip.data }, { generation: cacheGeneration });
      // Speech rides the daily API budget only when it actually spends it.
      // Bing is keyless and the bridge is this machine — neither costs quota.
      if (cfg.engine !== 'bing' && cfg.engine !== 'bridge') await bumpStats({ apiCalls: 1, dayApiCalls: 1 });
      return { ok: true, mime: clip.mime, data: clip.data, engine: clip.engine, voice: clip.voice };
    } catch (error) {
      return {
        ok: false,
        code: error.code || 'ERR',
        error: scrub(error.message || error),
        // errorDetail labels the TRANSLATION provider; a speech failure has
        // its own engine and model, and reporting the translator's would send
        // the user debugging the wrong thing.
        detail: {
          ...errorDetail(error, settings),
          provider: `tts:${cfg.engine}`,
          model: cfg.model || cfg.voice,
        },
      };
    }
  },

  /** Audio-cache size, for the stats panel. */
  async TTS_CACHE_STATS() {
    return { ok: true, ...(await GXTBG.audioCache.stats()) };
  },

  async TTS_CLEAR_CACHE() {
    return { ok: await GXTBG.audioCache.clearAll() };
  },

  /** Validate a set of Gemini keys (used by the popup's save-and-test). */
  async TEST_KEY({ keys }) {
    const list = (keys || []).slice(0, 10);
    if (!list.length) return { ok: false, code: 'NO_KEY' };
    let valid = 0;
    let modelCount = 0;
    let firstError = '';
    for (const key of list) {
      try {
        const { count } = await GXTBG.gemini.testKey(key);
        valid += 1;
        if (!modelCount) modelCount = count;
      } catch (error) {
        if (!firstError) {
          firstError = globalThis.GXT.i18n.t("background_service_worker_handlers_5", {v0:(String(error.message || error)), v1:(error.http ? ` [HTTP ${error.http}${error.apiStatus ? ` ${error.apiStatus}` : ''}]` : ''), v2:(key)});
        }
      }
    }
    return { ok: valid > 0, valid, total: list.length, count: modelCount, error: firstError };
  },

  /**
   * Discover what each engine can run right now.
   *
   * v2.5.1: the reply carries `groups`, so ONE pass feeds every model list in
   * the interface — translation, speech and live dubbing — instead of only the
   * translation dropdown. The stored list is the RAW discovery result: what
   * counts as a speech model is a classification decision, and keeping it out
   * of storage means it can improve without invalidating what is cached.
   */
  async LIST_MODELS({ provider }) {
    const settings = await GXTBG.getSettings();
    try {
      if (provider === 'openai' || (!provider && settings.provider === 'openai')) {
        const key = await GXTBG.getOpenaiKey();
        if (!settings.openaiBaseUrl) return { ok: false, code: 'NO_KEY' };
        const models = await GXTBG.openai.listModels({ baseUrl: settings.openaiBaseUrl, key });
        await chrome.storage.local.set({ [GXTBG.OPENAI_MODEL_LIST_KEY]: models });
        return { ok: true, models, groups: GXTBG.classifyOpenaiModels(models) };
      }
      const keys = await GXTBG.getApiKeys();
      if (!keys.length) return { ok: false, code: 'NO_KEY' };
      let lastError = null;
      for (const key of keys) {
        try {
          const models = await GXTBG.gemini.listModels(key);
          await chrome.storage.local.set({ [GXTBG.MODEL_LIST_KEY]: models });
          return { ok: true, models, groups: GXTBG.classifyModels(models) };
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    } catch (error) {
      return { ok: false, error: String(error.message || error), code: error.code || 'ERR' };
    }
  },

  /**
   * The voices and transcription models the LOCAL machine can offer.
   *
   * The Microsoft neural voices behind the keyless engine are a live catalogue
   * too — they are added to and renamed like any other — and the bridge is the
   * only thing here that can enumerate them. Whisper sizes come back the same
   * way, including any model already pulled into the local cache, so «⟳» means
   * the same thing for local engines as it does for cloud ones.
   */
  async LIST_LOCAL_MODELS() {
    const settings = await GXTBG.getSettings();
    if (!settings.bridgeEnabled) return { ok: false, code: 'OFF', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_4"); } };
    const result = await GXTBG.bridge.voices(settings);
    if (result?.ok && Array.isArray(result.voices)) {
      await chrome.storage.local.set({ [GXTBG.LOCAL_VOICE_LIST_KEY]: result });
    }
    return result;
  },

  async CLEAR_CACHE() {
    await GXTBG.cache.clearAll();
    return { ok: true };
  },

  /** Zero the usage counters (all-time + today). The learned daily quota is
   *  quota calibration, not usage, so it's preserved. Serialized through the
   *  same queue as bumpStats so an in-flight increment can't resurrect a
   *  counter after the reset. */
  async RESET_STATS() {
    const result = statsQueue
      .then(async () => {
        // Read INSIDE the queue: a bump that lands between the read and the
        // write would otherwise be carried into the "fresh" object.
        const current = await getStats();
        const { dayKey } = GXTBG.pacificDayAndReset();
        await chrome.storage.local.set({
          [GXTBG.STATS_KEY]: {
            translated: 0,
            apiCalls: 0,
            cacheHits: 0,
            day: dayKey,
            dayApiCalls: 0,
            dayTranslated: 0,
            learnedDailyLimit: current.learnedDailyLimit || 0,
            learnedDailyLimitModel: current.learnedDailyLimitModel || '',
            items_tweet: 0,
            items_subtitle: 0,
            items_page: 0,
            items_selection: 0,
            items_image: 0,
            items_summary: 0,
          },
        });
        // Per-key counters are usage too, and leaving them behind would let a
        // "reset" still show yesterday's keys as spent.
        await chrome.storage.local.set({
          [GXTBG.KEY_USAGE_KEY]: { day: dayKey, keys: {} },
        });
      });
    statsQueue = result.catch(() => {});
    await result;
    return { ok: true };
  },

  /**
   * Everything the آمار tab draws.
   *
   * v2.5.5 — the quota half of this was rebuilt. It used to return a single
   * `dailyLimit` (one project's cap) beside a fleet-wide `dayApiCalls`, and
   * the popup divided one by the other; with a dozen keys that reads "over
   * quota" while every translation is succeeding. It now returns a per-key
   * summary computed by the shared, pure `quotaSummary`.
   */
  async GET_STATS() {
    const [stats, settings] = await Promise.all([getStats(), GXTBG.getSettings()]);
    const { resetTs } = GXTBG.pacificDayAndReset();
    // Keys and the daily-quota bar are Gemini-only concepts; OpenAI and the
    // keyless machine-translation engines have neither.
    const isGemini = settings.provider === 'gemini';
    let keysInfo = null;
    let quota = null;
    if (isGemini) {
      const keys = await GXTBG.getApiKeys();
      if (keys.length) keysInfo = await GXTBG.gemini.keySnapshot(keys, settings.model);
      const usage = await getKeyUsage(settings.model);
      // A cap learned for THIS model, before any key has taught us its own,
      // is still better than the published table — so it seeds every key that
      // has no measurement of its own yet.
      const learnedForModel =
        stats.learnedDailyLimitModel === settings.model ? stats.learnedDailyLimit || 0 : 0;
      const seeded = {};
      for (const key of keys) {
        const record = usage.keys[key] || GXTBG.emptyKeyUsage();
        seeded[key] = record.limit ? record : { ...record, limit: learnedForModel };
      }
      quota = GXTBG.quotaSummary({
        keys,
        usage: seeded,
        model: settings.model,
        override: settings.dailyQuota || 0,
      });
    }
    return {
      ok: true,
      stats,
      diagnostics: {
        tweet: {...tweetMetrics, averageMs:tweetMetrics.completed?Math.round(tweetMetrics.totalMs/tweetMetrics.completed):0,pending:stableTweetFlights.size},
        sharedRequests:GXTBG.cache._internal.flightStats(),
        gemini:GXTBG.gemini.diagnostics?.(),
      },
      resetTs,
      keys: keysInfo,
      provider: settings.provider,
      model: settings.model,
      quota,
      // Kept for compatibility with anything still reading the old shape.
      dailyLimit: quota?.limit || 0,
      limitSource: quota?.limitSource || 'none',
    };
  },

  /**
   * Run one of the page-level actions on a tab, on behalf of the popup (v2.9.0).
   *
   * WHY THIS EXISTS
   * ───────────────
   * Until v2.9 the three things this extension mainly does to a page —
   * translate it, summarise it, read it aloud — were reachable only from the
   * right-click menu and from Alt+Shift+P/S/R. The popup, which is the one
   * affordance every user finds, offered settings and no way to act. That is
   * the single biggest usability defect the v2.9 audit turned up.
   *
   * The work itself is NOT duplicated: this is the same `ensureInjected` +
   * `chrome.tabs.sendMessage` pair the command and context-menu handlers use,
   * so a page action behaves identically however it was asked for. Injection
   * has to happen here rather than in the popup because `chrome.scripting`
   * needs the worker's context and the module list lives here.
   */
  async RUN_TAB_ACTION({ action, tabId }) {
    const TYPE = {
      page: { type: 'GXT_PAGE' },
      summary: { type: 'GXT_SUMMARY', fallbackText: '' },
      read: { type: 'GXT_READ_PAGE' },
      // v3.0.0 - leaves the browser entirely: the user picks a screen and
      // drags a box over text no content script could ever reach.
      screen: { type: 'GXT_SCREEN' },
    };
    const payload = TYPE[action];
    if (!payload) return { ok: false, code: 'UNKNOWN_ACTION', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_3"); } };
    let id = tabId;
    if (id == null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      id = tab?.id;
    }
    if (id == null) return { ok: false, code: 'NO_TAB', get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_2"); } };
    try {
      await ensureInjected(id);
      await chrome.tabs.sendMessage(id, payload);
      return { ok: true };
    } catch (error) {
      // chrome://, the Web Store, the PDF viewer and a few enterprise-blocked
      // pages cannot host a content script. Saying so is far better than a
      // button that appears to do nothing.
      return {
        ok: false,
        code: 'NOT_INJECTABLE',
        get error() { return globalThis.GXT.i18n.t("background_service_worker_handlers_1"); },
        raw: String(error?.message || error),
      };
    }
  },
};

/**
 * Live dubbing transport (v2.4.5).
 *
 * A long-lived Port rather than one-shot messages, because this carries ~10
 * audio chunks a second in each direction for the length of a video. A port
 * also gives us the one signal that matters most: `onDisconnect` fires when
 * the tab navigates away or closes, which is the only reliable way to know the
 * socket should go — and leaving a Live session open costs the user quota for
 * a video nobody is watching.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gxt-live' && port.name !== 'gxt-live-web') return;
  if (port.sender?.id !== chrome.runtime.id) { port.disconnect(); return; }
  const webVideo = port.name === 'gxt-live-web';
  if (webVideo && (!Number.isInteger(port.sender?.tab?.id) || !/^https?:\/\//.test(port.sender?.url || ''))) {
    port.disconnect(); return;
  }
  let session = null;
  // `session` is only assigned two awaits into the start handler, so it cannot
  // be the guard against a second start: two 'start' messages in the same tick
  // both passed `if (session)` and opened two Live sockets, the second
  // overwriting the first — which then stayed open, unreferenced and
  // unstoppable, billing Live API quota for a video nobody was watching. This
  // flag is set synchronously, before any await, so it can actually guard.
  let starting = false;
  // A 'stop' that arrives while start is still handshaking must not be lost:
  // the handler is async, so it can run to completion BEFORE the start it was
  // meant to cancel finishes. Recorded here and honored when start lands.
  let stopped = false;
  let generation = 0;

  const earlyAudio = [];
  let inputEnded = false;

  const send = (message) => {
    try { port.postMessage(message); } catch { /* port already gone */ }
  };

  const endSession = () => {
    generation += 1;
    stopped = true;
    starting = false;
    earlyAudio.length = 0; inputEnded = false;
    session?.stop();
    session = null;
  };

  port.onMessage.addListener(async (message) => {
    if (message?.t === 'start') {
      if (session || starting) return;
      starting = true;
      stopped = false;
      inputEnded = false;
      const current = ++generation;
      try {
        const settings = await GXTBG.getSettings();
        if (current !== generation) return;
        let model = settings.ytLiveModel || '', sourceLang = settings.ytLiveSourceLang || '';
        if (webVideo) {
          const host = new URL(port.sender.url).hostname.toLowerCase();
          const matches = list => Array.isArray(list) && list.some(value => {
            const domain = String(value).trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
            return domain && (host === domain || host.endsWith('.' + domain));
          });
          if (!settings.enabled || !settings.webVideoEnabled || !settings.webVideoDub ||
              matches(settings.webVideoBlockedSites) || (settings.webVideoSiteMode === 'allowlist' && !matches(settings.webVideoAllowedSites))) {
            throw Object.assign(new Error(globalThis.GXT.i18n.t("background_service_worker_message_4")), {code:'DISABLED'});
          }
          if (Object.hasOwn(message, 'model')) model = message.model;
          if (Object.hasOwn(message, 'sourceLang')) sourceLang = message.sourceLang;
          if (sourceLang === 'auto') sourceLang = '';
          if (typeof model !== 'string' || model.length > 160 || (model && !/^[a-zA-Z0-9._-]+$/.test(model)) ||
              typeof sourceLang !== 'string' || sourceLang.length > 24 || (sourceLang && !/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(sourceLang))) {
            throw Object.assign(new Error(globalThis.GXT.i18n.t("background_service_worker_message_3")), {code:'INVALID_SETTINGS'});
          }
        }
        const keys = await GXTBG.getApiKeys();
        if (current !== generation) return;
        if (!keys.length) {
          starting = false;
          send({ t: 'state', state: 'error', error: { code: 'NO_KEY', get error() { return globalThis.GXT.i18n.t("background_live_connect_5"); } } });
          return;
        }
        const catalog = await chrome.storage.local.get(GXTBG.MODEL_LIST_KEY);
        if (current !== generation) return;
        const discovered = catalog[GXTBG.MODEL_LIST_KEY];
        const liveModels = GXTBG.classifyModels(discovered || []).live.map(m=>m.id);
        if (Array.isArray(discovered) && model && !liveModels.includes(model)) {
          throw Object.assign(new Error(globalThis.GXT.i18n.t("background_service_worker_message_2")), {code:'MODEL_UNAVAILABLE'});
        }
        const created = GXTBG.live.createSession({
          apiKeys: keys,
          model: model || undefined,
          availableModels: liveModels,
          targetLang: webVideo ? GXTBG.forScope(settings,'web').targetLang : settings.ytTargetLang || 'fa',
          sourceLang,
          onAudio: (data, meta) => { if (current === generation) send({ t: 'audio', data, ...meta }); },
          onText: (payload) => { if (current === generation) send({ t: 'text', ...payload }); },
          onState: (payload) => { if (current === generation) send({ t: 'state', ...payload }); },
        });
        starting = false;
        // The tab asked to stop while we were still setting up. Honor that
        // instead of starting a session with no owner.
        if (stopped || current !== generation) { created.stop(); return; }
        session = created;
        session.start();
        for (const data of earlyAudio.splice(0)) session.push(data);
        if (inputEnded) session.endInput();
      } catch (error) {
        if (current === generation) {
          session?.stop();
          session = null;
          send({ t: 'state', state: 'error', error: {
            code: error?.code || 'ERR', error: scrub(error?.message || error),
          } });
        }
      } finally {
        if (current === generation) starting = false;
      }
      return;
    }
    if (message?.t === 'audio' && !inputEnded) {
      if (typeof message.data !== 'string' || message.data.length > 65536) return;
      if (session) session.push(message.data);
      else if (starting && earlyAudio.length < 80) earlyAudio.push(message.data);
      else if (starting) {
        endSession();
        send({t:'state',state:'error',error:{code:'BUFFER_FULL',get error() { return globalThis.GXT.i18n.t("background_service_worker_message_1"); }}});
      }
      return;
    }
    if (message?.t === 'end') { inputEnded = true; session?.endInput(); return; }
    if (message?.t === 'stop') endSession();
  });

  port.onDisconnect.addListener(endSession);
});

const EXTENSION_ONLY_MESSAGES = new Set([
  'EXPORT_BACKUP', 'IMPORT_BACKUP', 'GET_STATS', 'TEST_KEY', 'RESET_STATS',
  'CLEAR_CACHE', 'TTS_CLEAR_CACHE', 'GET_MEMORY', 'CLEAR_MEMORY', 'FORGET_TERM',
  'PIN_TERM', 'RUN_TAB_ACTION', 'DIAGNOSE', 'TRANSLATE_WORKSHOP', 'CANCEL_WORKSHOP',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  const ownSender = sender?.id === chrome.runtime.id;
  const extensionPage = ownSender && typeof sender.url === 'string'
    && sender.url.startsWith(chrome.runtime.getURL(''));
  if (!ownSender || (EXTENSION_ONLY_MESSAGES.has(type) && !extensionPage)) {
    sendResponse({ ok: false, code: 'FORBIDDEN' });
    return false;
  }
  const handler = Object.hasOwn(handlers, type) ? handlers[type] : null;
  if (!handler) {
    sendResponse({ ok: false, code: 'UNKNOWN_TYPE' });
    return false;
  }
  // Promise.resolve() wraps whatever the handler returns (or throws
  // synchronously), so no handler shape can ever leave the sender hanging on a
  // closed message port.
  Promise.resolve()
    .then(() => handler(message, sender))
    .then(sendResponse, (error) =>
      sendResponse({ ok: false, error: scrub(error?.message || error), code: error?.code || 'ERR' })
    );
  return true; // keep the message channel open for the async response
});

// ------------------------------------------------------------------- badge

async function updateBadge() {
  const settings = await GXTBG.getSettings();
  const ctx = await getProviderCtx(settings);
  if (!ctx.configured) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#f4212e' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// ------------------------------------------------------------------- setup

chrome.runtime.onInstalled.addListener(async (details) => {
  await GXTBG.migrateLocaleInstall(details?.reason);
  setupMenus();
  void registerAutoSites();
  void registerVsrScripts();
  void registerWebVideo();
  void updateBadge();
});
chrome.runtime.onStartup.addListener(() => {
  setupMenus();
  void registerAutoSites();
  void registerVsrScripts();
  void registerWebVideo();
  void updateBadge();
});

let lastVsrCfg = null;
let lastAutoSites = null;
let lastMenuCfg = null;
/** v3.0.0 — the optional traffic switch, applied to the client that issues it. */
function applyEngineSwitches(settings) {
  GXTBG.gemini?._internal?.setContextCache?.(settings.contextCache !== false);
}
void GXTBG.getSettings().then(applyEngineSwitches);

GXTBG.onStorageChanged(({ settings, apiKeyChanged }) => {
  if (settings || apiKeyChanged) void updateBadge();
  if (settings) {
    applyEngineSwitches(settings);
    void registerWebVideo();
    void applyAudioCacheLimit(settings);
    const sites = JSON.stringify([settings.autoSites || [], !!settings.pageFrames]);
    // `null` is the unknown baseline right after a worker restart. We can't
    // tell whether autoSites changed, so sync once to be safe — otherwise the
    // first change after a restart (e.g. removing a site in the popup) would
    // leave a stale dynamic registration alive. registerAutoSites is idempotent.
    if (lastAutoSites !== sites) {
      lastAutoSites = sites;
      void registerAutoSites();
    }
    // The image/summary menu items are toggleable (v1.8): rebuild on change.
    // `null` is the unknown baseline after a worker restart — exactly like
    // autoSites above, we cannot tell whether the menu config changed, so we
    // rebuild once (setupMenus is idempotent: removeAll + create). Skipping it
    // used to swallow the FIRST toggle after every restart, so unchecking
    // «ترجمهٔ این تصویر» left the menu item in place (v1.9.6 fix).
    const menuCfg =
      `${settings.imageTranslate !== false}|${settings.summarizer !== false}` +
      `|${!!settings.bridgeEnabled}|${settings.ttsAnywhere !== false}|${settings.uiLanguage}|${settings.targetLang}`;
    if (lastMenuCfg !== menuCfg) setupMenus();
    lastMenuCfg = menuCfg;
    // Same "unknown baseline after a restart" rule as autoSites above.
    const vsrCfg = `${!!settings.vsrHelper}|${!!settings.vsrForceH264}`;
    if (lastVsrCfg !== vsrCfg) {
      lastVsrCfg = vsrCfg;
      void registerVsrScripts();
  void registerWebVideo();
    }
  }
});
void updateBadge();
