/**
 * Gemini API client.
 *
 * Resilience strategy, in layers:
 *  - Concurrency limiter (2 in-flight requests).
 *  - API-key rotation: multiple keys are tried in round-robin order; a key
 *    that hits its rate limit is put on cooldown (until the Pacific-midnight
 *    quota reset when the failure was a daily quota) and the next key takes
 *    over. Invalid keys are parked. Key state persists in
 *    chrome.storage.session so it survives service-worker restarts.
 *  - Short-blip absorption: when every key is cooling for only a few
 *    seconds (per-minute limits), the batch waits for the soonest key once
 *    instead of failing.
 *  - Thinking-config ladder: the tweet task asks for thinkingLevel "low"
 *    (v1.8.8 — enough budget for its many simultaneous rules on a lite model);
 *    a model that rejects it falls through to the model's own default thinking.
 *    The client walks GXT.prompt.THINKING_LADDER on INVALID_ARGUMENT and
 *    remembers the step that worked per model.
 *  - Model fallback: MODEL_NOT_FOUND walks GXT.FALLBACK_MODELS.
 *  - Bounded retries with jittered backoff for 5xx/network/parse errors.
 *
 * Transparency: every thrown error carries {http, apiStatus, raw, quotaId,
 * retryAfterMs, attempts[]} where attempts logs each key tried — with the
 * key UNMASKED (explicitly requested by the user so failures can be
 * researched), the HTTP status, Google's status string and raw message.
 */
'use strict';
(() => {
  globalThis.GXT = globalThis.GXT || {};

  const BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const MAX_RETRIES = 2;
  const MAX_BACKOFF_MS = 20000;
  const MIN_KEY_COOLDOWN_MS = 10000;
  const SHORT_WAIT_MAX_MS = 25000;
  const SESSION_STATE_KEY = 'gxtGeminiKeyState';
  // Hard ceiling on a single request. Without it a stalled connection never
  // settles, so the concurrency limiter's slot is never released — two such
  // stalls permanently deadlock the whole pipeline (the "stuck on Translating
  // forever" bug). A translation call here is small and normally finishes in a
  // few seconds; 45s is a generous cap that only ever fires on a real stall.
  let requestTimeoutMs = 45000;
  // Process-local numbers only: no prompts, source text, URLs or credentials.
  const metrics = { generationRequests:0, retries:0, cancelled:0, completed:0, totalMs:0 };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class GeminiError extends Error {
    constructor(message, code, { retriable = false, retryAfterMs = 0 } = {}) {
      super(message);
      this.name = 'GeminiError';
      this.code = code;
      this.retriable = retriable;
      this.retryAfterMs = retryAfterMs;
    }
  }

  const limiter = {
    max: 2,
    active: 0,
    waiters: [],
    async run(fn) {
      while (this.active >= this.max) {
        await new Promise((resolve) => this.waiters.push(resolve));
      }
      this.active += 1;
      try {
        return await fn();
      } finally {
        this.active -= 1;
        const next = this.waiters.shift();
        if (next) next();
      }
    },
  };

  function classifyHttpError(status, body) {
    const rawMessage = body?.error?.message || '';
    const apiStatus = body?.error?.status || '';
    const message = rawMessage || `HTTP ${status}`;
    let error;
    let quotaId = '';
    if (status === 429) {
      let delayMs = 15000;
      let dailyLimit = 0;
      const details = body?.error?.details || [];
      const retryInfo = details.find((d) => String(d['@type'] || '').includes('RetryInfo'));
      const match = /(\d+(?:\.\d+)?)s/.exec(retryInfo?.retryDelay || '');
      if (match) delayMs = Math.min(120000, Math.ceil(parseFloat(match[1]) * 1000));
      for (const detail of details) {
        if (!String(detail['@type'] || '').includes('QuotaFailure')) continue;
        for (const violation of detail.violations || []) {
          const id = `${violation.quotaId || ''} ${violation.quotaMetric || ''}`;
          if (!quotaId) quotaId = (violation.quotaId || violation.quotaMetric || '').trim();
          if (/day|daily/i.test(id)) {
            const n = parseInt(violation.quotaValue, 10);
            if (n > 0) dailyLimit = n;
            quotaId = (violation.quotaId || violation.quotaMetric || quotaId).trim();
          }
        }
      }
      error = new GeminiError(globalThis.GXT.i18n.t("background_gemini_callWithKeys_1"), 'RATE_LIMIT', {
        retriable: true,
        retryAfterMs: delayMs,
      });
      if (dailyLimit) error.dailyLimit = dailyLimit;
    } else if (status === 400 && /api.?key/i.test(message)) {
      error = new GeminiError(globalThis.GXT.i18n.t("content_youtube_friendly_1"), 'BAD_KEY');
    } else if (status === 401 || status === 403) {
      error = new GeminiError(globalThis.GXT.i18n.t("background_gemini_classifyHttpError_3"), 'BAD_KEY');
    } else if (status === 404) {
      error = new GeminiError(globalThis.GXT.i18n.t("background_gemini_classifyHttpError_2"), 'MODEL_NOT_FOUND');
    } else if (status === 400) {
      error = new GeminiError(message, 'INVALID_ARGUMENT');
    } else if (status >= 500) {
      error = new GeminiError(globalThis.GXT.i18n.t("background_gemini_classifyHttpError_1"), 'SERVER', {
        retriable: true,
        retryAfterMs: 2000,
      });
    } else {
      error = new GeminiError(message, `HTTP_${status}`);
    }
    error.http = status;
    error.apiStatus = apiStatus;
    error.raw = rawMessage;
    if (quotaId) error.quotaId = quotaId;
    return error;
  }

  /** A network/timeout error. A timeout is NOT retried internally (each retry
   *  would cost another full timeout); it surfaces at once so the user sees a
   *  retry control in seconds instead of the pipeline hanging. */
  function networkError(timedOut, cause) {
    const error = new GeminiError(
      timedOut
        ? globalThis.GXT.i18n.t("background_gemini_error_2")
        : globalThis.GXT.i18n.t("background_gemini_error_1"),
      timedOut ? 'TIMEOUT' : 'NETWORK',
      { retriable: !timedOut, retryAfterMs: timedOut ? 0 : 3000 }
    );
    // Keep the underlying reason visible in «جزئیات فنی» — a bare "network
    // error" hides DNS/TLS/blocked-host failures the user could act on.
    if (cause) error.raw = String(cause.message || cause);
    return error;
  }

  async function apiFetch(path, key, { method = 'GET', body, signal } = {}) {
    const measured = /:(?:generateContent|streamGenerateContent)/.test(path);
    const startedAt = Date.now();if(measured)metrics.generationRequests++;
    const controller = new AbortController();
    const unlinkAbort = globalThis.GXT.abort?.link(signal, controller);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      let response;
      try {
        response = await fetch(BASE + path, {
          method,
          headers: {
            'x-goog-api-key': key,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (error) {
        globalThis.GXT.abort?.check(signal);
        throw networkError(controller.signal.aborted, error);
      }
      let json = null;
      try {
        json = await response.json();
      } catch (error) {
        // A body the timeout aborted mid-read must surface as a timeout, not a
        // silent null (a 200 with null would look like an empty-but-OK reply).
        globalThis.GXT.abort?.check(signal);
        if (controller.signal.aborted) throw networkError(true, error);
        /* non-JSON body; classified below by status */
      }
      if (!response.ok) throw classifyHttpError(response.status, json);
      globalThis.GXT.abort?.check(signal);
      return json;
    } finally {
      if(measured){metrics.completed++;metrics.totalMs+=Date.now()-startedAt;if(signal?.aborted)metrics.cancelled++;}
      clearTimeout(timer);
      unlinkAbort?.();
    }
  }

  // ══════════════════════════════════ streaming / caching / batch (v3.0.0)
  //
  // Three accelerations that share one design rule: THEY MUST NEVER BE ABLE TO
  // BREAK A TRANSLATION. Each is attempted, and any failure — an unsupported
  // endpoint, a model too small to cache, a malformed stream — falls straight
  // back to the ordinary `generateContent` path that has always worked. A
  // capability that is not available is remembered so it is not re-attempted
  // on every request.

  /** Models that have refused one of the optional endpoints: `model -> Set`. */
  const unsupported = new Map();
  const markUnsupported = (model, feature) => {
    if (!unsupported.has(model)) unsupported.set(model, new Set());
    unsupported.get(model).add(feature);
  };
  const supports = (model, feature) => !unsupported.get(model)?.has(feature);

  /**
   * Server-sent-events variant of a generate call.
   *
   * `onDelta` receives text as it arrives. The full text is still returned, so
   * every caller's parsing is unchanged — streaming here buys PERCEIVED speed
   * on the two surfaces where the wait is long enough to feel broken (a page
   * summary, a long page unit), not a different data path.
   */
  async function apiStream(path, key, body, onDelta) {
    const startedAt=Date.now();metrics.generationRequests++;
    const controller = new AbortController();
    let reader;
    // The idle guard, not a total-time guard: a long answer legitimately takes
    // longer than one request timeout, but a stream that goes silent is dead.
    let timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    };
    try {
      let response;
      try {
        response = await fetch(`${BASE}${path}&alt=sse`, {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        throw networkError(controller.signal.aborted, error);
      }
      if (!response.ok) {
        let json = null;
        try {
          json = await response.json();
        } catch {
          /* non-JSON error body */
        }
        throw classifyHttpError(response.status, json);
      }
      if (!response.body) throw new GeminiError(globalThis.GXT.i18n.t("background_gemini_apiStream_1"), 'NO_STREAM');

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';
      let finishReason = '';
      let blockReason = '';
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw networkError(controller.signal.aborted, error);
        }
        if (chunk.done) break;
        bump();
        buffer += decoder.decode(chunk.value, { stream: true });
        // SSE frames are separated by a blank line; a partial frame stays in
        // the buffer until the rest of it arrives.
        let boundary;
        while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          for (const line of frame.split(/\r\n|\n|\r/)) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let data;
            try {
              data = JSON.parse(payload);
            } catch {
              continue; // a frame we cannot read is skipped, never fatal
            }
            const part = extractText(data);
            if (part.blockReason) blockReason = part.blockReason;
            if (part.finishReason) finishReason = part.finishReason;
            if (part.text) {
              text += part.text;
              try {
                onDelta?.(part.text, text);
              } catch {
                /* a consumer's paint must never kill the stream */
              }
            }
          }
        }
      }
      return { text, finishReason, blockReason };
    } finally {
      metrics.completed++;metrics.totalMs+=Date.now()-startedAt;
      clearTimeout(timer);
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      controller.abort();
    }
  }

  /**
   * Explicit context caching.
   *
   * The tweet system prompt is ~6.6k characters and was re-sent with EVERY
   * batch — the single largest repeated cost in the product. A cached handle
   * is billed at a fraction of ordinary input.
   *
   * HONEST LIMIT, and the reason this is written to fail open: Google enforces
   * a MINIMUM token count for cached content (it has been 1024–4096 depending
   * on the model). A short system prompt, or a model that does not offer
   * caching at all, is refused — so the first refusal marks the model and the
   * ordinary path is used from then on, silently and correctly.
   *
   * The cache is keyed by the CONTENT, so changing a prompt override, the
   * register or the glossary naturally produces a different handle instead of
   * serving the previous instruction.
   */
  // Explicit cache storage is billed by duration. A short renewable lifetime
  // limits idle storage after the viewer leaves the timeline.
  const CACHE_TTL_SECONDS = 300;
  /**
   * How many times the same system prompt must be sent before it is worth
   * caching.
   *
   * Creating a cache is itself an HTTP round-trip, so doing it eagerly makes
   * the FIRST translation slower in order to make a second one cheaper — and
   * for someone who translates one page and closes the tab, that second one
   * never comes. The extension's own regression suite caught this immediately
   * (a two-call test started making four), which is the clearest possible
   * evidence that the cost is real and paid up front.
   *
   * Three demonstrates repeat use; it is not a guaranteed financial break-even
   * point. Actual savings depend on model pricing, token count and later reuse.
   */
  const CACHE_AFTER_USES = 3;
  /**
   * Master switch for context caching, set from `settings.contextCache`.
   *
   * It exists as a real setting because caching is the one optional behaviour
   * here that issues traffic the user did not directly ask for — and because
   * the regression suite needs to be able to say "I am counting HTTP requests;
   * add nothing of your own", which is exactly what a user on a metered
   * connection would want too.
   */
  let contextCacheEnabled = true;
  /** `contentHash -> { name, model, expiresAt, key }` */
  const cacheHandles = new Map();
  /** `contentHash -> times seen`, so setup only happens for repeat work. */
  const cacheSeen = new Map();
  const cachePending = new Map();
  const cacheBackoff = new Map();
  const CACHE_METADATA_MAX = 64;
  let cacheEpoch = 0;
  // Full equality, including credentials, prevents hash collisions and one
  // project's handle replacing another project's reusable cache. Never logged.
  const cacheIdentity = (key, model, text) => JSON.stringify([key, model, text]);
  function boundedPut(map, key, value) {
    map.delete(key); map.set(key, value);
    while (map.size > CACHE_METADATA_MAX) map.delete(map.keys().next().value);
  }
  function cacheEligible(model, text) {
    return contextCacheEnabled && !!text && text.length <= 100000 && supports(model, 'cache');
  }

  function hashText(text) {
    let h = 5381;
    const s = String(text || '');
    for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /**
   * The handle for this prompt if one is ready — a pure Map lookup, NEVER a
   * request.
   *
   * Creating a cache is itself a round-trip, so doing it inline would make the
   * translation that triggered it slower in order to make a later one cheaper.
   * The suite caught exactly that (a two-call test became four calls, and a
   * ladder step-down test lost its step because the cache request had consumed
   * the mock's first reply). So the read path is synchronous and free, and
   * creation happens afterwards, off the critical path, in `primeCache`.
   */
  function cachedHandleFor(key, model, systemText) {
    if (!cacheEligible(model, systemText)) return null;
    const id = cacheIdentity(key, model, systemText);
    const hit = cacheHandles.get(id);
    // A handle is only valid for the key that created it: cached content is
    // scoped to the API project, and this fleet spans several.
    if (hit && hit.expiresAt > Date.now() + 30000) {
      boundedPut(cacheHandles, id, hit); return hit.name;
    }
    if (hit) { cacheHandles.delete(id); cacheSeen.delete(id); }
    return null;
  }

  /** Note one use of a system prompt; returns true once it is worth caching. */
  function noteCacheUse(key, model, systemText) {
    if (!cacheEligible(model, systemText) || cachedHandleFor(key, model, systemText)) return false;
    const id = cacheIdentity(key, model, systemText), now = Date.now();
    if (cachePending.has(id) || (cacheBackoff.get(id) || 0) > now) return false;
    const previous = cacheSeen.get(id);
    const seen = previous && now - previous.at < 600000 ? previous.count + 1 : 1;
    boundedPut(cacheSeen, id, { count: seen, at: now });
    return seen >= CACHE_AFTER_USES;
  }

  async function ensureCachedContent(key, model, systemText) {
    if (!cacheEligible(model, systemText)) return null;
    const id = cacheIdentity(key, model, systemText);
    const hit = cachedHandleFor(key, model, systemText);
    if (hit) return hit;
    if (cachePending.has(id)) return cachePending.get(id);
    if (cachePending.size >= CACHE_METADATA_MAX || (cacheBackoff.get(id) || 0) > Date.now()) return null;
    const epoch = cacheEpoch;
    // Register the operation before fetch can settle, including test transports.
    const pending = Promise.resolve().then(async () => { try {
      if (epoch !== cacheEpoch || !contextCacheEnabled) return null;
      const created = await apiFetch('/cachedContents', key, {
        method: 'POST',
        body: {
          model: `models/${model}`,
          systemInstruction: { parts: [{ text: systemText }] },
          ttl: `${CACHE_TTL_SECONDS}s`,
        },
      });
      const name = created?.name;
      if (!name) {
        if (epoch === cacheEpoch) boundedPut(cacheBackoff, id, Date.now() + 300000);
        return null;
      }
      if (epoch !== cacheEpoch || !contextCacheEnabled) return null;
      boundedPut(cacheHandles, id, {
        name,
        model,
        key,
        expiresAt: Number.isFinite(Date.parse(created.expireTime)) ? Date.parse(created.expireTime) : Date.now() + CACHE_TTL_SECONDS * 1000,
      });
      cacheSeen.delete(id); cacheBackoff.delete(id);
      return name;
    } catch (error) {
      // A short prompt or a denied project does not condemn every prompt/key
      // on this model. Back off only this exact optional creation attempt.
      if (epoch === cacheEpoch) boundedPut(cacheBackoff, id, Date.now() +
        ([400,403,404].includes(error.http) ? 300000 : 60000));
      return null;
    } finally { if (cachePending.get(id) === pending) cachePending.delete(id); } });
    cachePending.set(id, pending);
    return pending;
  }

  /**
   * Batch mode: half price, minutes-to-hours turnaround.
   *
   * Deliberately NOT wired into interactive translation. It exists for the
   * work that is already non-interactive and large — a whole video's
   * subtitles, a subtitle file, a manga chapter — where "half the cost by
   * tomorrow morning" is a genuinely better trade than "now".
   *
   * Returns a job handle the worker polls. Any refusal marks the model and the
   * caller falls back to ordinary calls, so a build against a lineup that
   * does not offer batching still works.
   */
  async function submitBatch(key, model, requests) {
    if (!supports(model, 'batch')) return null;
    try {
      const created = await apiFetch(`/models/${encodeURIComponent(model)}:batchGenerateContent`, key, {
        method: 'POST',
        body: { batch: { inputConfig: { requests } } },
      });
      const name = created?.name;
      if (!name) {
        markUnsupported(model, 'batch');
        return null;
      }
      return { name, key, model, submittedAt: Date.now() };
    } catch (error) {
      if (error.http === 400 || error.http === 404) markUnsupported(model, 'batch');
      return null;
    }
  }

  /** @returns {{done:boolean, responses?:object[], error?:string}} */
  async function pollBatch(job) {
    if (!job?.name) return { done: true, error: 'NO_JOB' };
    try {
      const state = await apiFetch(`/${job.name}`, job.key, { method: 'GET' });
      if (!state?.done) return { done: false };
      if (state.error) return { done: true, error: String(state.error.message || 'BATCH_FAILED') };
      const responses =
        state.response?.inlinedResponses?.inlinedResponses ||
        state.response?.responses ||
        [];
      return { done: true, responses };
    } catch (error) {
      return { done: true, error: String(error.message || error) };
    }
  }

  /**
   * Every Gemini model this key can reach, with the metadata needed to tell
   * them apart.
   *
   * v2.5.1: this used to keep only `generateContent` models and drop the rest
   * on the floor — which is exactly why the speech and live-dubbing engines
   * had hand-written model lists that went stale. The same one call already
   * returns those models; `supportedGenerationMethods` is carried out so
   * GXTS.classifyModels can sort them into the three lists the popup offers.
   */
  async function listModels(key) {
    const models = [];
    const pages = new Set();
    let pageToken = '';
    do {
      const query = `?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const data = await apiFetch(`/models${query}`, key);
      if(!Array.isArray(data.models))throw new Error(globalThis.GXT.i18n.t("background_gemini_listModels_2"));
      for (const m of data.models || []) {
        const id = String(m.name || '').replace(/^models\//, '');
        if (!id.startsWith('gemini')) continue;
        models.push({
          id,
          displayName: m.displayName || id,
          methods: m.supportedGenerationMethods || [],
        });
      }
      pageToken = data.nextPageToken || '';
      if(pageToken&&pages.has(pageToken))throw new Error(globalThis.GXT.i18n.t("background_gemini_listModels_1"));
      if(pageToken)pages.add(pageToken);
    } while (pageToken);
    return models;
  }

  async function testKey(key) {
    const models = await listModels(key);
    // The key test reports what the key can TRANSLATE with, which is what the
    // line under it is about — speech and live models are counted elsewhere.
    const usable = globalThis.GXT?.classifyModels
      ? globalThis.GXT.classifyModels(models).text
      : models;
    return { count: usable.length, models };
  }

  // ------------------------------------------------------------ key rotation

  /** @type {Map<string, {coolUntil?: number, invalid?: boolean}>} */
  const keyState = new Map();
  let keyCursor = 0;
  let stateLoad = null;

  /** Key state must outlive the 30s service-worker lifetime, otherwise every
   *  worker restart forgets which key is exhausted and starts over at #1. */
  function loadKeyState() {
    if (stateLoad) return stateLoad;
    stateLoad = (async () => {
    try {
      const raw = await chrome.storage.session?.get?.(SESSION_STATE_KEY);
      const saved = raw?.[SESSION_STATE_KEY];
      if (saved) {
        keyCursor = saved.cursor || 0;
        for (const [key, value] of Object.entries(saved.keys || {})) {
          keyState.set(key, value);
        }
      }
    } catch {
      /* storage.session unavailable (dev harness): stay in-memory */
    }
    })();
    return stateLoad;
  }

  function saveKeyState() {
    try {
      void chrome.storage.session?.set?.({
        [SESSION_STATE_KEY]: { cursor: keyCursor, keys: Object.fromEntries(keyState) },
      })?.catch?.(() => {});
    } catch {
      /* best effort */
    }
  }

  function cooldownFor(state, model) {
    if (!state) return 0;
    // Legacy records have no model information; honor them until their old
    // cooldown expires. New records keep each model's quota independently.
    if (state.coolUntil) return state.coolUntil;
    return model ? state.cooldowns?.[model] || 0
      : Math.max(0, ...Object.values(state.cooldowns || {}));
  }

  function isUsable(key, now = Date.now(), model) {
    const state = keyState.get(key);
    return !(state && (state.invalid || cooldownFor(state, model) > now));
  }

  /** Popup/stats insight: total, usable, and per-key status (key unmasked). */
  async function keySnapshot(keys, model) {
    await loadKeyState();
    const now = Date.now();
    const list = keys.map((key) => {
      const state = keyState.get(key);
      const coolUntil = cooldownFor(state, model);
      return {
        key,
        status: state?.invalid ? 'invalid' : coolUntil > now ? 'cooling' : 'ok',
        coolUntil,
      };
    });
    return {
      total: keys.length,
      usable: list.filter((entry) => entry.status === 'ok').length,
      list,
    };
  }

  function coolKey(key, error, model = '') {
    let coolMs;
    if (error.dailyLimit || error.retryAfterMs > 10 * 60 * 1000) {
      // Daily quota exhausted: park the key until the Pacific-midnight reset.
      coolMs = Math.max(MIN_KEY_COOLDOWN_MS, GXT.pacificDayAndReset().resetTs - Date.now());
      // GROUND TRUTH, and the only kind the quota display can fully trust:
      // Google has refused THIS key for the rest of the day, and `dailyLimit`
      // (parsed out of the QuotaFailure details) is that key's real ceiling —
      // worth more than any table of published caps shipped in this extension.
      reportUsage({ key, model, kind: 'exhausted', limit: error.dailyLimit || 0 });
    } else {
      coolMs = Math.max(MIN_KEY_COOLDOWN_MS, error.retryAfterMs || 15000);
    }
    const state = keyState.get(key) || {};
    const { coolUntil: legacy, ...rest } = state;
    keyState.set(key, {
      ...rest,
      cooldowns: { ...(state.cooldowns || {}), [model]: Date.now() + coolMs },
    });
    saveKeyState();
  }

  const attemptOf = (key, error) => ({
    key,
    code: error.code,
    http: error.http || 0,
    apiStatus: error.apiStatus || '',
    quotaId: error.quotaId || '',
    retryAfterMs: error.retryAfterMs || 0,
    raw: error.raw || String(error.message || ''),
  });

  // -------------------------------------------------------------- translate

  /** Remembered working step of the thinking ladder, keyed by model id AND the
   *  ladder's shape — a per-model tuning change (v1.9.0) yields a different
   *  ladder, so its learned step must not leak onto the previous one. */
  const thinkingStep = new Map();
  const ladderKey = (model, ladder) =>
    `${model}\u0000${JSON.stringify(ladder)}`;

  /** The thinking ladder for a request: a per-model override (carried on
   *  extra.thinkingLevel) builds a custom ladder, else the default floor. */
  const ladderFor = (extra) =>
    globalThis.GXT.prompt.buildThinkingLadder(extra && extra.thinkingLevel);

  function extractText(data) {
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    return {
      // Thinking models can attach thought-summary parts (`thought: true`).
      // They are reasoning, never the answer — including them would inject the
      // model's scratchpad into the translation (and break JSON parsing).
      text: parts
        .filter((p) => !p.thought)
        .map((p) => p.text || '')
        .join(''),
      finishReason: candidate?.finishReason || '',
      blockReason: data?.promptFeedback?.blockReason || '',
    };
  }

  /**
   * Audio extractor for the speech models (v2.2.0). Same contract as
   * `extractText` so the whole retry / ladder / key-rotation machinery is
   * reused untouched: the base64 audio takes the place of the answer text,
   * with its mime type prefixed (`mimeType|base64`). Base64 never contains a
   * pipe, so the split in the parser is unambiguous — and keeping it in the
   * string means no hidden state survives a retry.
   */
  function extractAudio(data) {
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const audio = parts.find((p) => p?.inlineData?.data);
    return {
      text: audio ? `${audio.inlineData.mimeType || 'audio/L16;rate=24000'}|${audio.inlineData.data}` : '',
      finishReason: candidate?.finishReason || '',
      blockReason: data?.promptFeedback?.blockReason || '',
    };
  }

  /** Models that rejected our maxOutputTokens as too large (older models cap
   *  at 8192). Remembered per model so the reduction happens once, not on
   *  every request. */
  const outputCap = new Map();
  const SAFE_OUTPUT_TOKENS = 8192;

  // ------------------------------------------------------ usage (v2.5.5)
  //
  // Which KEY served a request is the one fact the quota display cannot be
  // honest without, and this module was throwing it away. It is reported out
  // rather than written here, so this file keeps knowing nothing about
  // storage — the worker owns persistence, as it does for every other counter.

  /** @type {null | ((event: {key: string, model: string, kind: 'call'|'exhausted', limit?: number}) => void)} */
  let usageReporter = null;
  const setUsageReporter = (fn) => {
    usageReporter = typeof fn === 'function' ? fn : null;
  };
  function reportUsage(event) {
    try {
      usageReporter?.(event);
    } catch {
      /* accounting must never be able to fail a translation */
    }
  }

  async function callModel(items, key, model, buildBody, parse, ladder, extract, opts = {}) {
    const useLadder = ladder || globalThis.GXT.prompt.THINKING_LADDER;
    const stepKey = ladderKey(model, useLadder);
    let step = thinkingStep.get(stepKey) ?? 0;
    let retries = 0;
    let bypassCachedContent = false;
    for (;;) {
      globalThis.GXT.abort?.check(opts.signal);
      const body = buildBody(useLadder[step]);
      const cap = outputCap.get(model);
      if (cap && body.generationConfig?.maxOutputTokens > cap) {
        body.generationConfig.maxOutputTokens = cap;
      }
      /**
       * v3.0.0 — hand the system instruction to the context cache and send a
       * handle instead of the text. Both are attempted per request and both
       * fail open: `ensureCachedContent` returns null for a model that will
       * not cache, and the body is sent exactly as it always was.
       */
      let systemText = '';
      if (opts.cache && body.systemInstruction) {
        systemText = (body.systemInstruction.parts || []).map((part) => part.text || '').join('');
        const handle = bypassCachedContent ? null : cachedHandleFor(key, model, systemText);
        if (handle) {
          body.cachedContent = handle;
          delete body.systemInstruction;
        }
      }
      try {
        const streaming = opts.onDelta && supports(model, 'stream');
        const data = await limiter.run(() =>
          streaming
            ? apiStream(`/models/${encodeURIComponent(model)}:streamGenerateContent?`, key, body, opts.onDelta)
            : apiFetch(`/models/${encodeURIComponent(model)}:generateContent`, key, {
                method: 'POST',
                body,
                signal: opts.signal,
              })
        );
        // Counted HERE, per HTTP request, not once per logical translation:
        // a ladder step-down and a retry are each a separate billed request
        // against this key's daily allowance, and counting them as one was
        // quietly under-reporting usage.
        reportUsage({ key, model, kind: 'call' });
        thinkingStep.set(stepKey, step);
        // apiStream already returns the extracted shape (it has to, to emit
        // deltas as they arrive); apiFetch returns the raw envelope.
        const { text, finishReason, blockReason } = opts.onDelta && supports(model, 'stream')
          ? data
          : (extract || extractText)(data);
        if (blockReason) {
          throw new GeminiError(globalThis.GXT.i18n.t("background_gemini_callModel_3"), 'BLOCKED');
        }
        if (!text) {
          // MAX_TOKENS with no text = the reply hit the output ceiling before
          // producing anything. On a thinking model the thinking tokens share
          // that budget, so the cure is LESS thinking (step down the ladder),
          // not a retry at the same level.
          if (finishReason === 'MAX_TOKENS') {
            throw new GeminiError(
              globalThis.GXT.i18n.t("background_gemini_callModel_2"),
              'MAX_TOKENS'
            );
          }
          throw new GeminiError(
            globalThis.GXT.i18n.t("background_gemini_callModel_1", {v0:(finishReason ? ` (${finishReason})` : '')}),
            'EMPTY',
            { retriable: true, retryAfterMs: 1000 }
          );
        }
        try {
          const parsed = parse(text);
          // The request succeeded, so this prompt is real repeat work. Create
          // the cache for the NEXT one, without blocking this one and without
          // letting a failure here touch the result we already have.
          if (systemText && noteCacheUse(key, model, systemText)) {
            void ensureCachedContent(key, model, systemText).catch(() => {});
          }
          return parsed;
        } catch (parseError) {
          // A truncated reply (hit the ceiling mid-JSON) is unparseable for the
          // same reason: not enough room. Route it down the ladder too instead
          // of burning retries on an identically-truncated answer.
          if (finishReason === 'MAX_TOKENS') {
            const err = new GeminiError(
              globalThis.GXT.i18n.t("background_gemini_err_1"),
              'MAX_TOKENS'
            );
            err.raw = String(parseError.message || parseError);
            throw err;
          }
          throw parseError;
        }
      } catch (error) {
        // A request Google ANSWERED spent a slot, even when the answer was an
        // error. The exception is 429: that is the quota system declining to
        // serve the request, so counting it would inflate usage precisely when
        // the number matters most. A network failure never reached Google.
        if (error.http && error.http !== 429) reportUsage({ key, model, kind: 'call' });
        // Remote eviction can happen before the advertised expiry. Retry this
        // same model once with the identical full instruction, without changing
        // translation quality or treating a stale handle as a missing model.
        if (body.cachedContent && !bypassCachedContent && [400, 403, 404].includes(error.http) &&
            /cached[ _-]?content|cache.{0,32}(?:expired|not found|invalid)/i.test(`${error.raw || ''} ${error.message || ''}`)) {
          bypassCachedContent = true;
          const identity = cacheIdentity(key, model, systemText);
          cacheHandles.delete(identity);
          boundedPut(cacheBackoff, identity, Date.now() + 60000);
          continue;
        }
        // Older models cap generation below our ceiling and reject the request
        // outright. Remember their limit and retry at the safe value instead of
        // failing the batch (v1.9.6).
        if (
          error.code === 'INVALID_ARGUMENT' &&
          /max.?output.?tokens/i.test(`${error.raw || ''} ${error.message || ''}`) &&
          (body.generationConfig?.maxOutputTokens || 0) > SAFE_OUTPUT_TOKENS
        ) {
          outputCap.set(model, SAFE_OUTPUT_TOKENS);
          continue;
        }
        // An unaccepted thinking config surfaces as 400; a budget blown on
        // thinking surfaces as MAX_TOKENS. Both are cured by the next ladder
        // step (less thinking, more room for the answer).
        if (
          (error.code === 'INVALID_ARGUMENT' || error.code === 'MAX_TOKENS') &&
          useLadder[step] !== null &&
          step < useLadder.length - 1
        ) {
          step += 1;
          continue;
        }
        // Rate limits are handled one level up by rotating to the next key.
        if (error.code === 'RATE_LIMIT') throw error;
        if (error.retriable && retries < MAX_RETRIES) {
          retries += 1;
          metrics.retries += 1;
          const backoff = Math.min(
            MAX_BACKOFF_MS,
            (error.retryAfterMs || 1500 * retries) + Math.random() * 400
          );
          if (opts.signal) await globalThis.GXT.abort.sleep(backoff, opts.signal);
          else await sleep(backoff);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Try the batch across all usable keys, rotating on quota/key errors.
   * Round 2 runs after a short wait when every key is merely on a brief
   * per-minute cooldown. Every failure path attaches the attempts log.
   */
  async function callWithKeys(items, keys, model, buildBody, parse, ladder, extract, opts = {}) {
    globalThis.GXT.abort?.check(opts.signal);
    await loadKeyState();
    if (!keys.length) throw new GeminiError(globalThis.GXT.i18n.t("background_gemini_callWithKeys_3"), 'NO_KEY');
    const attempts = [];
    for (let round = 0; round < 2; round += 1) {
      let lastError = null;
      const start = keyCursor % keys.length;
      for (let offset = 0; offset < keys.length; offset += 1) {
        const index = (start + offset) % keys.length;
        const key = keys[index];
        if (!isUsable(key, Date.now(), model)) {
          const state = keyState.get(key);
          attempts.push({
            key,
            code: state?.invalid ? 'INVALID' : 'COOLING',
            coolUntil: cooldownFor(state, model),
          });
          continue;
        }
        try {
          const map = await callModel(items, key, model, buildBody, parse, ladder, extract, opts);
          keyCursor = index; // stick with the key that worked
          saveKeyState();
          return map;
        } catch (error) {
          if (error.code === 'RATE_LIMIT') {
            coolKey(key, error, model);
            attempts.push(attemptOf(key, error));
            lastError = error;
            continue;
          }
          if (error.code === 'BAD_KEY') {
            keyState.set(key, { invalid: true });
            saveKeyState();
            attempts.push(attemptOf(key, error));
            lastError = error;
            continue;
          }
          error.attempts = [...attempts, attemptOf(key, error)];
          throw error;
        }
      }
      // Nothing succeeded this round. If the only obstacle is a short
      // cooldown, absorb it once by waiting for the soonest key.
      const now = Date.now();
      const soonest = Math.min(
        ...keys.map((k) => {
          const state = keyState.get(k);
          return state?.invalid ? Infinity : cooldownFor(state, model) || now;
        })
      );
      const waitMs = soonest - now;
      if (round === 0 && Number.isFinite(waitMs) && waitMs > 0 && waitMs <= SHORT_WAIT_MAX_MS) {
        if (opts.signal) await globalThis.GXT.abort.sleep(waitMs + 250, opts.signal);
        else await sleep(waitMs + 250);
        continue;
      }
      if (keys.every((k) => keyState.get(k)?.invalid)) {
        const bad = new GeminiError(globalThis.GXT.i18n.t("background_gemini_bad_1"), 'BAD_KEY');
        bad.attempts = attempts;
        throw bad;
      }
      const error =
        lastError ||
        new GeminiError(globalThis.GXT.i18n.t("background_gemini_callWithKeys_1"), 'RATE_LIMIT', {
          retriable: true,
          retryAfterMs: Math.max(1000, Number.isFinite(waitMs) ? waitMs : 15000),
        });
      if (error.code === 'RATE_LIMIT' && keys.length > 1) {
        error.message = globalThis.GXT.i18n.t("background_gemini_callWithKeys_2");
      }
      error.attempts = attempts;
      throw error;
    }
    throw new GeminiError(globalThis.GXT.i18n.t("background_gemini_callWithKeys_1"), 'RATE_LIMIT', { retriable: true });
  }

  // Models that recently accepted a request but never answered (TIMEOUT).
  // Benched for a short window so we don't re-spend the full timeout on every
  // request. Unlike a 404 (the model doesn't exist → permanent, saved-model
  // switch), this is transient: the user's chosen model is NEVER changed, just
  // routed around until the window passes, then retried automatically.
  const modelCooldown = new Map(); // model id -> coolUntil ts
  const MODEL_COOLDOWN_MS = 5 * 60 * 1000;
  // A timeout costs a full request timeout, so cap how many models one request
  // will spend timeouts on (a 404 is instant, so those are uncapped).
  const MAX_TIMEOUT_FALLBACKS = 1;
  const modelUsable = (m, now = Date.now()) => (modelCooldown.get(m) || 0) <= now;

  /**
   * Try the chosen model, then the fallback chain. Falls through on:
   *  - MODEL_NOT_FOUND (404): the model doesn't exist — a HARD switch the
   *    caller persists as the new saved model.
   *  - TIMEOUT: the model accepted the request but never answered — a SOFT,
   *    transient switch (benched briefly, saved model kept) so the user still
   *    gets a translation instead of an error.
   * @returns {{result, model, softFallback}} softFallback=true ⇒ do NOT persist.
   */
  async function withModelFallback(keys, model, run, chain) {
    const list = chain || globalThis.GXT.FALLBACK_MODELS;
    const all = [model, ...list.filter((m) => m !== model)];
    // Prefer models not benched for unresponsiveness; if every one is benched,
    // try them all rather than give up.
    const fresh = all.filter((m) => modelUsable(m));
    const candidates = fresh.length ? fresh : all;
    let lastError = null;
    let userModelHardFailed = false; // the user's own model returned 404
    let timeoutFallbacks = 0;
    for (const candidate of candidates) {
      try {
        const result = await run(candidate);
        return { result, model: candidate, softFallback: candidate !== model && !userModelHardFailed };
      } catch (error) {
        if (error.code === 'MODEL_NOT_FOUND') {
          if (candidate === model) userModelHardFailed = true;
          lastError = error;
          continue;
        }
        if (error.code === 'TIMEOUT') {
          modelCooldown.set(candidate, Date.now() + MODEL_COOLDOWN_MS);
          lastError = error;
          timeoutFallbacks += 1;
          if (timeoutFallbacks > MAX_TIMEOUT_FALLBACKS) break; // bound total wait
          continue;
        }
        throw error;
      }
    }
    throw lastError || new GeminiError(globalThis.GXT.i18n.t("background_gemini_withModelFallback_1"), 'MODEL_NOT_FOUND');
  }

  /**
   * Rich tweet pipeline: per-item {i, t, sl} responses.
   * @param {Array<{text:string, lang?:string, author?:string, ctx?:string}>} items
   * @param {{keys: string[], model: string}} cfg
   * @returns {Promise<{map: Map<number,{t:string,sl:string}>, model: string}>}
   */
  async function translateBatch(items, { keys, model, extra }) {
    const prompt = globalThis.GXT.prompt;
    const ladder = ladderFor(extra);
    const { result, model: usedModel, softFallback } = await withModelFallback(keys, model, (candidate) =>
      callWithKeys(
        items,
        keys,
        candidate,
        (thinking) => prompt.buildTranslateRequest(items, thinking, extra),
        (text) => prompt.parseTranslations(text, items.map((item) => item.text)),
        ladder,
        null,
        // The tweet prompt is ~6.6k characters and every batch re-sent it.
        // This is the single largest repeated cost in the product, so it is
        // the one path that asks for the context cache by default.
        { cache: extra?.contextCache !== false }
      )
    );
    return { map: result, model: usedModel, softFallback };
  }

  /**
   * Generic low-token pipeline (selection / page / subtitles): plain string
   * array in, same-length Persian string array out.
   * @param {string[]} texts
   * @param {{keys: string[], model: string, kind?: string}} cfg
   * @returns {Promise<{list: string[], model: string}>}
   */
  async function translateTexts(texts, { keys, model, kind, context, extra }) {
    const prompt = globalThis.GXT.prompt;
    const ladder = ladderFor(extra);
    const { result, model: usedModel, softFallback } = await withModelFallback(keys, model, (candidate) =>
      callWithKeys(
        texts,
        keys,
        candidate,
        (thinking) => prompt.buildGenericRequest(texts, kind, thinking, context, extra),
        (text) => prompt.parseGenericTranslations(text, texts.length, texts, kind),
        ladder
      )
    );
    return { list: result, model: usedModel, softFallback };
  }

  async function translateWorkshop(payload, { keys, model, extra, signal, exactModel = false }) {
    const prompt = globalThis.GXT.subtitlePrompts;
    const run = candidate => {
      const thinking = prompt.workshopThinking(candidate, extra);
      const scoped = {...extra, temperature:typeof extra?.temperature === 'number' ? extra.temperature : /^gemini-[3-9]/.test(candidate) ? 1 : 0.25};
      return callWithKeys(payload.cues, keys, candidate, () => prompt.workshopRequest(payload, thinking, scoped),
        raw => prompt.parseWorkshop(raw, payload.cues), [thinking], null, {signal});
    };
    const { result, model: usedModel, softFallback } = exactModel
      ? {result:await run(model), model, softFallback:false} : await withModelFallback(keys, model, run);
    return { ...result, model: usedModel, softFallback };
  }

  /** Optional quality-mode pass: edit a whole translated batch in one call. */
  async function reviewTexts(texts, sources, { keys, model, kind, extra }) {
    const prompt = globalThis.GXT.prompt;
    const ladder = ladderFor(extra);
    const { result, model: usedModel, softFallback } = await withModelFallback(keys, model, (candidate) =>
      callWithKeys(
        texts,
        keys,
        candidate,
        (thinking) => prompt.buildReviewTextsRequest(texts, sources, kind, thinking, extra),
        (text) => prompt.parseGenericTranslations(text, texts.length, sources, kind),
        ladder
      )
    );
    return { list: result, model: usedModel, softFallback };
  }

  /**
   * Shared plain-text runner (image / summary / compose): one text out.
   *
   * v3.0.0 — `opts.onDelta` streams the answer as it arrives. These are the
   * long single-shot answers, which is exactly where a spinner that sits still
   * for fifteen seconds reads as a hang rather than as work.
   */
  async function runPlain(keys, model, buildBody, ladder, opts = {}) {
    const prompt = globalThis.GXT.prompt;
    const { result, model: usedModel, softFallback } = await withModelFallback(keys, model, (candidate) =>
      callWithKeys(null, keys, candidate, buildBody, (text) => prompt.parsePlainText(text), ladder, null, opts)
    );
    return { text: result, model: usedModel, softFallback };
  }

  /** Translate every non-Persian text found in an image (v1.8). */
  function translateImage({ keys, model, mime, data, extra }) {
    const prompt = globalThis.GXT.prompt;
    return runPlain(keys, model, (thinking) =>
      prompt.buildImageRequest(mime, data, thinking, extra), ladderFor(extra)
    );
  }

  /** Persian bullet summary of arbitrary text (v1.8). Streams when the caller
   *  can paint partial text (v3.0.0) — the longest wait in the product. */
  function summarize({ keys, model, text, extra, onDelta }) {
    const prompt = globalThis.GXT.prompt;
    return runPlain(
      keys, model,
      (thinking) => prompt.buildSummaryRequest(text, thinking, extra),
      ladderFor(extra),
      { onDelta }
    );
  }

  /**
   * The editing pass (v3.0.0): finished Persian in, better Persian out.
   *
   * Streams, because this runs on text the user is already looking at — and
   * watching a paragraph improve is a far better experience than watching a
   * spinner and then having the text swap underneath you.
   */
  function reviewText({ keys, model, text, source, extra, onDelta }) {
    const prompt = globalThis.GXT.prompt;
    return runPlain(
      keys, model,
      (thinking) => prompt.buildReviewRequest(text, source, thinking, extra),
      ladderFor(extra),
      { onDelta }
    );
  }

  /** Persian draft → natural English X post (v1.8). */
  function composeEnglish({ keys, model, text, extra }) {
    const prompt = globalThis.GXT.prompt;
    return runPlain(keys, model, (thinking) => prompt.buildComposeRequest(text, thinking, extra), ladderFor(extra));
  }

  /**
   * Shorten one dubbing line to fit its time slot (v2.4.5).
   *
   * A separate call rather than a flag on the translation, because it runs on
   * only the minority of lines that actually overrun — re-translating every
   * line "concisely" would cost the whole video's tokens and would make the
   * SUBTITLE worse to read in order to help the audio.
   */
  function compressForDub({ keys, model, text, budget, extra }) {
    const prompt = globalThis.GXT.prompt;
    return runPlain(
      keys, model,
      (thinking) => prompt.buildDubCompressRequest(text, budget, thinking, extra),
      ladderFor(extra)
    );
  }

  /**
   * Speech synthesis (v2.2.0) — the premium TTS engine.
   *
   * Reuses every resilience layer above: key rotation, cooldowns, bounded
   * retries and model fallback all work unchanged, because the only thing
   * that differs is which part of the response is the answer (`extractAudio`).
   *
   * Two deliberate differences from the text calls:
   *  - the ladder is `[null]`: speech models take no thinkingConfig at all, so
   *    there is nothing to step down and a rejected step would waste a request;
   *  - the fallback chain is TTS-only (`TTS_FALLBACK_MODELS`). Falling through
   *    to a text model would 400 on `responseModalities: ["AUDIO"]`, turning a
   *    recoverable 404 into a confusing hard failure.
   *
   * @returns {Promise<{mime: string, data: string, model: string, softFallback: boolean}>}
   */
  async function synthesize({ keys, model, text, voice, style }) {
    const prompt = globalThis.GXT.prompt;
    const { result, model: usedModel, softFallback } = await withModelFallback(
      keys,
      model,
      (candidate) =>
        callWithKeys(
          null,
          keys,
          candidate,
          () => prompt.buildSpeechRequest(text, voice, style),
          (payload) => {
            const cut = payload.indexOf('|');
            return { mime: payload.slice(0, cut), data: payload.slice(cut + 1) };
          },
          [null],
          extractAudio
        ),
      globalThis.GXT.TTS_FALLBACK_MODELS
    );
    return { ...result, model: usedModel, softFallback };
  }

  globalThis.GXT.gemini = {
    diagnostics:()=>({...metrics,averageMs:metrics.completed?Math.round(metrics.totalMs/metrics.completed):0}),
    GeminiError,
    listModels,
    testKey,
    translateBatch,
    translateTexts,
    translateWorkshop,
    reviewTexts,
    translateImage,
    summarize,
    composeEnglish,
    compressForDub,
    reviewText,
    synthesize,
    keySnapshot,
    setUsageReporter,
    // v3.0.0 — half-price asynchronous work, for jobs that are already not
    // interactive (a whole video, a subtitle file, a manga chapter).
    submitBatch,
    pollBatch,
    _internal: {
      apiStream,
      ensureCachedContent,
      cacheHandles,
      cacheSeen,
      CACHE_AFTER_USES,
      unsupported,
      supports,
      markUnsupported,
      hashText,
      classifyHttpError,
      limiter,
      extractText,
      extractAudio,
      keyState,
      modelCooldown,
      outputCap,
      clearModelCooldown: () => modelCooldown.clear(),
      setContextCache: (on) => {
        if (contextCacheEnabled !== !!on) { cacheEpoch++; cachePending.clear(); }
        contextCacheEnabled = !!on;
      },
      resetCaches: () => {
        cacheEpoch++;
        cachePending.clear(); cacheBackoff.clear();
        cacheHandles.clear();
        cacheSeen.clear();
        unsupported.clear();
      },
      setRequestTimeoutMs: (ms) => { requestTimeoutMs = ms; },
    },
  };
})();
