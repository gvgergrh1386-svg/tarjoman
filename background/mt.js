/**
 * Traditional machine-translation providers: Google Translate and Bing /
 * Microsoft Translator, via their keyless consumer endpoints.
 *
 * Why: LLM providers give the best quality but are rate/quota limited. These
 * classic engines are much lower quality (no tone, no slang, weaker on
 * entities) but effectively unlimited and need no API key — ideal for
 * high-volume translation. The user opted in with eyes open.
 *
 * These are UNOFFICIAL endpoints (the same ones the free web UIs call). They
 * aren't documented or guaranteed by Google/Microsoft and can change or be
 * throttled without notice; every failure is classified and surfaced.
 *
 * Both engines translate one plain string per request, so a batch becomes N
 * concurrency-limited requests. The tweet pipeline's ⟦n⟧ placeholder tokens
 * and inline @/#/emoji are passed through as-is (MT usually preserves them);
 * `repairTokens` heals the most common mangling (spaces inside a token) and
 * the render layer already re-appends any placeholder the engine dropped.
 */
'use strict';
(() => {
  globalThis.GXT = globalThis.GXT || {};

  const TARGET = 'fa';
  const MAX_RETRIES = 2;
  const MAX_BACKOFF_MS = 15000;
  // Per-request ceiling so a stalled connection can never hold a limiter slot
  // forever (see gemini.js). These consumer endpoints are fast, so a short cap.
  let requestTimeoutMs = 20000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class MTError extends Error {
    constructor(message, code, { retriable = false, retryAfterMs = 0 } = {}) {
      super(message);
      this.name = 'MTError';
      this.code = code;
      this.retriable = retriable;
      this.retryAfterMs = retryAfterMs;
    }
  }

  /**
   * Shared concurrency gate: keyless endpoints throttle bursts, so keep a
   * bounded number of requests in flight even for large page/subtitle jobs.
   *
   * v2.1.0 — raised 5 → 8. These engines translate ONE line per request, so
   * this number is exactly the divisor on how long a subtitle batch takes: a
   * 10-line urgent batch was 2 round trips at 5, and is 2 at 8 only because
   * the look-ahead batch is no longer hogging the gate at the same time. On a
   * page job the difference is a straight ~1.6× on wall-clock. Both endpoints
   * are the ones the free web UIs hammer far harder than this; 8 stays well
   * inside what they answer without throttling.
   */
  const limiter = {
    max: 8,
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

  function classifyStatus(status, raw) {
    if (status === 429) {
      return new MTError(globalThis.GXT.i18n.t("background_mt_classifyStatus_2"), 'RATE_LIMIT', {
        retriable: true,
        retryAfterMs: 8000,
      });
    }
    if (status >= 500) {
      return new MTError(globalThis.GXT.i18n.t("background_mt_classifyStatus_1"), 'SERVER', {
        retriable: true,
        retryAfterMs: 2000,
      });
    }
    const error = new MTError(raw || `HTTP ${status}`, `HTTP_${status}`);
    error.http = status;
    error.raw = raw || '';
    return error;
  }

  /** fetch bounded by an abort timeout; throws a classified MTError on
   *  network failure or timeout so a stall can't wedge the limiter. */
  async function fetchWithTimeout(url, opts = {}, consume) {
    const controller = new AbortController();
    const unlinkAbort = globalThis.GXT.abort?.link(opts.signal, controller);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, { ...opts, signal: controller.signal });
      // Headers can arrive immediately while the response body stalls. Keep
      // the abort timer alive until parsing/reading has also completed.
      return consume ? await consume(response) : response;
    } catch (error) {
      globalThis.GXT.abort?.check(opts.signal);
      const timedOut = controller.signal.aborted;
      if (!timedOut && error instanceof MTError) throw error;
      throw new MTError(
        timedOut ? globalThis.GXT.i18n.t("background_mt_fetchWithTimeout_1") : globalThis.GXT.i18n.t("background_gemini_error_1"),
        timedOut ? 'TIMEOUT' : 'NETWORK',
        { retriable: !timedOut, retryAfterMs: timedOut ? 0 : 3000 }
      );
    } finally {
      clearTimeout(timer);
      unlinkAbort?.();
    }
  }

  /** Undo the spacing MT engines sometimes add inside a ⟦n⟧ placeholder. */
  function repairTokens(str) {
    return str.replace(/⟦\s*(\d+)\s*⟧/g, '⟦$1⟧');
  }

  const normSl = (sl) => String(sl || '').toLowerCase().slice(0, 8);

  // -------------------------------------------------------------- Google

  async function googleTranslate(text, targetLang = TARGET, signal) {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' +
      `&sl=auto&tl=${encodeURIComponent(targetLang)}&q=${encodeURIComponent(text)}`;
    return fetchWithTimeout(url, { signal }, async (response) => {
      if (!response.ok) throw classifyStatus(response.status, '');
      let data;
      try {
        data = await response.json();
      } catch {
        throw new MTError(globalThis.GXT.i18n.t("background_mt_googleTranslate_1"), 'BAD_RESPONSE', {
          retriable: true,
          retryAfterMs: 1000,
        });
      }
      const segments = Array.isArray(data?.[0]) ? data[0] : [];
      const translated = segments.map((seg) => (seg && seg[0]) || '').join('');
      const sl = typeof data?.[2] === 'string' ? data[2] : '';
      return { t: repairTokens(translated), sl: normSl(sl) };
    });
  }

  // ---------------------------------------------------------------- Bing

  /** Cached Bing session (key/token expire; refreshed on demand). */
  let bingAuth = null;
  /**
   * The scrape in flight, if any.
   *
   * Without this, the very first Bing translation of a page fans out to eight
   * concurrent requests (the limiter's width), every one of them finds
   * `bingAuth` still null, and all eight scrape bing.com/translator at once —
   * eight full page loads to obtain one token that eight callers will then
   * overwrite each other with. The same thing happens again, in a burst, every
   * time the token expires mid-page or a stale-token retry resets it, which is
   * exactly the traffic pattern that gets an unofficial endpoint throttled.
   * One scrape, shared by everyone waiting for it.
   */
  let bingAuthInFlight = null;

  function getBingAuth(force) {
    if (!force && bingAuth && Date.now() < bingAuth.expiresAt) return Promise.resolve(bingAuth);
    if (bingAuthInFlight) return bingAuthInFlight;
    bingAuthInFlight = scrapeBingAuth().finally(() => {
      bingAuthInFlight = null;
    });
    return bingAuthInFlight;
  }

  async function scrapeBingAuth() {
    let html;
    try {
      html = await fetchWithTimeout('https://www.bing.com/translator', {
        credentials: 'omit',
      }, async (response) => {
        if (!response.ok) throw classifyStatus(response.status, '');
        return response.text();
      });
    } catch (error) {
      if (error instanceof MTError) throw error;
      throw new MTError(globalThis.GXT.i18n.t("background_mt_scrapeBingAuth_2"), 'NETWORK', {
        retriable: true,
        retryAfterMs: 3000,
      });
    }
    const ig = /IG:"([^"]+)"/.exec(html)?.[1] || '';
    const iid = /data-iid="([^"]+)"/.exec(html)?.[1] || '';
    const abuse = /params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)",(\d+)\]/.exec(html);
    if (!abuse) {
      throw new MTError(globalThis.GXT.i18n.t("background_mt_scrapeBingAuth_1"), 'BING_AUTH', {
        retriable: true,
        retryAfterMs: 2000,
      });
    }
    const ttl = parseInt(abuse[3], 10) || 3600000;
    bingAuth = {
      key: abuse[1],
      token: abuse[2],
      ig,
      iid,
      // Refresh a minute early; the token is only valid within its TTL window.
      expiresAt: Date.now() + Math.min(ttl, 3600000) - 60000,
    };
    return bingAuth;
  }

  async function bingTranslateOnce(text, auth, targetLang = TARGET, signal) {
    const url = `https://www.bing.com/ttranslatev3?isVertical=1&IG=${encodeURIComponent(
      auth.ig
    )}&IID=${encodeURIComponent(auth.iid)}`;
    const body = new URLSearchParams({
      fromLang: 'auto-detect',
      to: targetLang,
      text,
      token: auth.token,
      key: String(auth.key),
    });
    return fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      credentials: 'omit',
      signal,
    }, async (response) => {
      if (!response.ok) throw classifyStatus(response.status, '');
      let data;
      try {
        data = await response.json();
      } catch {
        throw new MTError(globalThis.GXT.i18n.t("background_mt_bingTranslateOnce_1"), 'BAD_RESPONSE', {
          retriable: true,
          retryAfterMs: 1000,
        });
      }
      // Bing signals a stale/invalid token with a statusCode object, not an entry.
      if (data && !Array.isArray(data) && data.statusCode) {
        const error = new MTError(globalThis.GXT.i18n.t("background_mt_error_1"), 'BING_AUTH', {
          retriable: true,
          retryAfterMs: 500,
        });
        error.http = data.statusCode;
        throw error;
      }
      const entry = Array.isArray(data) ? data[0] : null;
      const t = entry?.translations?.[0]?.text || '';
      const sl = entry?.detectedLanguage?.language || '';
      return { t: repairTokens(t), sl: normSl(sl) };
    });
  }

  async function bingTranslate(text, targetLang = TARGET, signal) {
    try {
      return await bingTranslateOnce(text, await (signal ? globalThis.GXT.abort.wait(getBingAuth(false), signal) : getBingAuth(false)), targetLang, signal);
    } catch (error) {
      // One forced re-auth on a token problem before giving up.
      if (error.code === 'BING_AUTH') {
        bingAuth = null;
        return bingTranslateOnce(text, await (signal ? globalThis.GXT.abort.wait(getBingAuth(true), signal) : getBingAuth(true)), targetLang, signal);
      }
      throw error;
    }
  }

  // ------------------------------------------------------------- dispatch

  function engineFn(engine) {
    if (engine === 'bing') return bingTranslate;
    return googleTranslate;
  }

  /** Translate one string with bounded retries on retriable errors. */
  async function translateOne(engine, text, targetLang = TARGET, signal) {
    globalThis.GXT.abort?.check(signal);
    if (!text || !text.trim()) return { t: text, sl: '' };
    const fn = engineFn(engine);
    let retries = 0;
    for (;;) {
      try {
        globalThis.GXT.abort?.check(signal);
        return await fn(text, targetLang, signal);
      } catch (error) {
        if (error.retriable && retries < MAX_RETRIES) {
          retries += 1;
          const delay = Math.min(MAX_BACKOFF_MS, (error.retryAfterMs || 1000 * retries) + Math.random() * 300);
          if (signal) await globalThis.GXT.abort.sleep(delay, signal);
          else await sleep(delay);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Rich tweet pipeline shape: Map<index, {t, sl}>. A failure propagates so
   * the group is marked failed and the user gets a retry (matches gemini/openai).
   * @returns {Promise<{map: Map<number,{t:string,sl:string}>, model: string}>}
   */
  async function translateBatch(items, { engine, targetLang = TARGET }) {
    const map = new Map();
    // allSettled, not all: `all` rejects on the FIRST failure while its
    // siblings keep running, and their later rejections surface as unhandled
    // promise rejections in the worker. Settle everything, then throw.
    const settled = await Promise.allSettled(
      items.map((item, i) =>
        limiter.run(async () => {
          map.set(i, await translateOne(engine, item.text, targetLang));
        })
      )
    );
    const failure = settled.find((r) => r.status === 'rejected');
    if (failure && !map.size) throw failure.reason;
    return { map, model: engine };
  }

  /**
   * Generic low-token pipeline shape: same-length string array out.
   * @returns {Promise<{list: string[], model: string}>}
   */
  async function translateTexts(texts, { engine, targetLang = TARGET, signal }) {
    // Same reasoning as translateBatch: settle every request, then decide.
    // A partial result is useful here — the caller keeps the original text for
    // any null, and the holes-retry pass picks them up.
    const settled = await Promise.allSettled(
      texts.map((text) =>
        limiter.run(async () => {
          const { t } = await translateOne(engine, text, targetLang, signal);
          return t;
        })
      )
    );
    const list = settled.map((r) => (r.status === 'fulfilled' ? r.value : null));
    if (list.every((t) => t == null)) {
      const failure = settled.find((r) => r.status === 'rejected');
      if (failure) throw failure.reason;
    }
    return { list, model: engine };
  }

  globalThis.GXT.mt = {
    MTError,
    translateBatch,
    translateTexts,
    /**
     * The Bing session (v2.2.0), shared with the TTS engine.
     *
     * Bing's read-aloud endpoint authenticates with exactly the same scraped
     * `{key, token, ig, iid}` blob as its translate endpoint, so both features
     * ride ONE session: one scrape, one TTL, and a refresh triggered by either
     * one immediately benefits the other. `reset()` drops it so the next call
     * re-scrapes (used on the stale-token retry).
     */
    bingSession: {
      get: getBingAuth,
      reset: () => { bingAuth = null; },
    },
    MTErrorFor: classifyStatus,
    fetchWithTimeout,
    _internal: {
      googleTranslate,
      bingTranslate,
      repairTokens,
      classifyStatus,
      limiter,
      setRequestTimeoutMs: (ms) => { requestTimeoutMs = ms; },
    },
  };
})();
