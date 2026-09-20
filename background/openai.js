/**
 * OpenAI-compatible provider: works with any endpoint that implements
 * POST {base}/chat/completions and GET {base}/models — OpenAI, OpenRouter,
 * DeepSeek, Groq, xAI, local Ollama / LM Studio, and the like.
 *
 * Shares the system prompts, payload builders and response parsers with the
 * Gemini provider (GXT.prompt), so translation-quality rules live in one
 * place. `response_format: json_object` is attempted first and dropped
 * automatically for servers that reject it.
 *
 * Transparency: like the Gemini client, every thrown error carries
 * {http, apiStatus, raw, retryAfterMs} so failures can be researched.
 */
'use strict';
(() => {
  globalThis.GXT = globalThis.GXT || {};

  const MAX_RETRIES = 2;
  const MAX_BACKOFF_MS = 20000;
  // Per-request ceiling so a stalled connection can never hold a limiter slot
  // forever (see gemini.js). Local endpoints (Ollama/LM Studio) can be slow, so
  // this is more generous than the Gemini cap.
  let requestTimeoutMs = 60000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class ProviderError extends Error {
    constructor(message, code, { retriable = false, retryAfterMs = 0 } = {}) {
      super(message);
      this.name = 'ProviderError';
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

  function normalizeBaseUrl(url) {
    return String(url || '')
      .trim()
      .replace(/\/+$/, '');
  }

  function classifyHttpError(status, body, headers) {
    const rawMessage =
      body?.error?.message ||
      body?.message ||
      (typeof body?.error === 'string' ? body.error : '') ||
      '';
    const message = rawMessage || `HTTP ${status}`;
    let error;
    if (status === 401 || status === 403) {
      error = new ProviderError(globalThis.GXT.i18n.t("background_openai_classifyHttpError_4"), 'BAD_KEY');
    } else if (status === 429) {
      let delayMs = 15000;
      const retryAfter = parseFloat(headers?.get?.('retry-after') || '');
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        delayMs = Math.min(120000, Math.ceil(retryAfter * 1000));
      }
      error = new ProviderError(globalThis.GXT.i18n.t("background_openai_classifyHttpError_3"), 'RATE_LIMIT', {
        retriable: true,
        retryAfterMs: delayMs,
      });
    } else if (status === 404) {
      error = new ProviderError(
        /model/i.test(message) ? globalThis.GXT.i18n.t("background_gemini_classifyHttpError_2") : globalThis.GXT.i18n.t("background_openai_classifyHttpError_2"),
        /model/i.test(message) ? 'MODEL_NOT_FOUND' : 'BAD_BASE_URL'
      );
    } else if (status === 400 || status === 422) {
      error = new ProviderError(message, 'INVALID_ARGUMENT');
    } else if (status >= 500) {
      error = new ProviderError(globalThis.GXT.i18n.t("background_openai_classifyHttpError_1"), 'SERVER', {
        retriable: true,
        retryAfterMs: 2000,
      });
    } else {
      error = new ProviderError(message, `HTTP_${status}`);
    }
    error.http = status;
    error.apiStatus = String(body?.error?.code || body?.error?.type || '');
    error.raw = rawMessage;
    return error;
  }

  function networkError(timedOut) {
    return new ProviderError(
      timedOut
        ? globalThis.GXT.i18n.t("background_openai_networkError_2")
        : globalThis.GXT.i18n.t("background_openai_networkError_1"),
      timedOut ? 'TIMEOUT' : 'NETWORK',
      { retriable: !timedOut, retryAfterMs: timedOut ? 0 : 3000 }
    );
  }

  async function apiFetch(baseUrl, path, key, { method = 'GET', body, signal } = {}) {
    const controller = new AbortController();
    const unlinkAbort = globalThis.GXT.abort?.link(signal, controller);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      let response;
      try {
        response = await fetch(normalizeBaseUrl(baseUrl) + path, {
          method,
          headers: {
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch {
        globalThis.GXT.abort?.check(signal);
        throw networkError(controller.signal.aborted);
      }
      let json = null;
      try {
        json = await response.json();
      } catch {
        globalThis.GXT.abort?.check(signal);
        if (controller.signal.aborted) throw networkError(true);
        /* non-JSON body; classified below by status */
      }
      if (!response.ok) throw classifyHttpError(response.status, json, response.headers);
      globalThis.GXT.abort?.check(signal);
      return json;
    } finally {
      clearTimeout(timer);
      unlinkAbort?.();
    }
  }

  async function listModels({ baseUrl, key }) {
    const data = await apiFetch(baseUrl, '/models', key);
    const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    return raw
      .map((m) => ({ id: String(m.id || m.name || ''), displayName: String(m.id || m.name || '') }))
      .filter((m) => m.id);
  }

  /** Remembers which endpoints reject response_format, per baseUrl|model. */
  const jsonModeSupported = new Map();

  /**
   * Core chat call shared by both pipelines.
   * @param {{baseUrl,key,model}} cfg
   * @param {string} systemText
   * @param {string|Array} userContent plain text or a content-parts array
   * @param {(raw: string) => any} parse
   * @param {{json?: boolean}} [opts] json:false = plain-text task (image/
   *   summary/compose): no response_format and no JSON suffix on the system.
   */
  async function call(cfg, systemText, userContent, parse, opts = {}) {
    const wantJson = opts.json !== false;
    const cfgKey = `${normalizeBaseUrl(cfg.baseUrl)}|${cfg.model}`;
    let useJsonMode = wantJson && jsonModeSupported.get(cfgKey) !== false;
    let retries = 0;
    // A per-model temperature override (v1.9.0) rides on cfg.extra.temperature;
    // otherwise the provider-neutral default. (thinkingLevel is Gemini-only and
    // does not apply to OpenAI-compatible chat endpoints.)
    const temperature =
      cfg.extra && typeof cfg.extra.temperature === 'number' ? cfg.extra.temperature : 0.35;
    for (;;) {
      globalThis.GXT.abort?.check(cfg.signal);
      const body = {
        model: cfg.model,
        temperature,
        messages: [
          {
            role: 'system',
            content: wantJson
              ? systemText +
                '\nReturn ONLY the JSON object described above — no prose, no markdown fences.'
              : systemText,
          },
          { role: 'user', content: userContent },
        ],
      };
      if (opts.workshop) {
        const options = cfg.extra?.workshopOptions || {};
        if (options.thinking && options.thinking !== 'auto') body.reasoning_effort = options.thinking === 'off' ? 'none' : options.thinking;
        // Reasoning families generally reject sampling parameters. Inherited
        // defaults must not make them unusable; explicit choices remain visible
        // server-validated settings rather than silently discarded controls.
        if (/^(?:o\d|gpt-[5-9])/.test(cfg.model) && typeof cfg.extra?.temperature !== 'number') delete body.temperature;
      }
      if (useJsonMode) body.response_format = { type: 'json_object' };
      try {
        const data = await limiter.run(() =>
          apiFetch(cfg.baseUrl, '/chat/completions', cfg.key, { method: 'POST', body, signal: cfg.signal })
        );
        jsonModeSupported.set(cfgKey, useJsonMode);
        const choice = data?.choices?.[0];
        const text = choice?.message?.content || '';
        if (!text) {
          const reason = choice?.finish_reason || '';
          // `length` = the server cut the answer off at its own token ceiling;
          // say so instead of an opaque "empty response", and don't retry it
          // (an identical request would be truncated identically).
          if (reason === 'length') {
            throw new ProviderError(
              globalThis.GXT.i18n.t("background_openai_call_1"),
              'MAX_TOKENS'
            );
          }
          throw new ProviderError(globalThis.GXT.i18n.t("background_gemini_callModel_1", {v0:(reason ? ` (${reason})` : '')}), 'EMPTY', {
            retriable: true,
            retryAfterMs: 1000,
          });
        }
        return parse(text);
      } catch (error) {
        // Some servers reject response_format; drop it once and remember.
        if (
          error.code === 'INVALID_ARGUMENT' &&
          useJsonMode &&
          /response_format|json/i.test(error.message || '')
        ) {
          useJsonMode = false;
          jsonModeSupported.set(cfgKey, false);
          continue;
        }
        if (error.retriable && retries < MAX_RETRIES) {
          retries += 1;
          const backoff = Math.min(
            MAX_BACKOFF_MS,
            (error.retryAfterMs || 1500 * retries) + Math.random() * 400
          );
          if (cfg.signal) await globalThis.GXT.abort.sleep(backoff, cfg.signal);
          else await sleep(backoff);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Optional backup model (v1.8): when the configured model 404s or times
   * out, retry once with cfg.fallbackModel. Marked as a soft fallback so the
   * caller never persists it over the user's choice.
   */
  async function withFallback(cfg, run) {
    try {
      return await run(cfg.model);
    } catch (error) {
      const backup = String(cfg.fallbackModel || '').trim();
      if (
        backup &&
        backup !== cfg.model &&
        (error.code === 'MODEL_NOT_FOUND' || error.code === 'TIMEOUT')
      ) {
        const result = await run(backup);
        result.softFallback = true;
        return result;
      }
      throw error;
    }
  }

  /**
   * Rich tweet pipeline: per-item {i, t, sl} responses.
   * @returns {Promise<{map: Map<number,{t:string,sl:string}>, model: string}>}
   */
  function translateBatch(items, cfg) {
    const prompt = globalThis.GXT.prompt;
    return withFallback(cfg, async (model) => {
      const map = await call(
        { ...cfg, model },
        prompt.resolveSystem('tweet', cfg.extra, items.map((item) => item.text)),
        JSON.stringify(prompt.buildItemsPayload(items, cfg.extra)),
        (text) => prompt.parseTranslations(text, items.map((item) => item.text))
      );
      return { map, model };
    });
  }

  /**
   * Generic low-token pipeline (selection / page / subtitles).
   * @param {string[]} texts
   * @returns {Promise<{list: string[], model: string}>}
   */
  function translateTexts(texts, cfg) {
    const prompt = globalThis.GXT.prompt;
    // Same index-prefixed protocol + context element as the Gemini path — the
    // shared system prompt promises them, and alignment lands by index.
    return withFallback(cfg, async (model) => {
      const list = await call(
        { ...cfg, model },
        prompt.buildGenericSystemPrompt(cfg.kind, prompt.nowContext(), cfg.extra, texts),
        JSON.stringify(prompt.buildGenericPayload(texts, cfg.context)),
        (text) => prompt.parseGenericTranslations(text, texts.length, texts, cfg.kind)
      );
      return { list, model };
    });
  }

  function translateWorkshop(payload, cfg) {
    const prompt = globalThis.GXT.subtitlePrompts;
    return withFallback(cfg, async model => {
      const result = await call({ ...cfg, model }, prompt.workshopSystem(cfg.extra, payload.cues.map(c => c.text)), JSON.stringify(payload), raw => prompt.parseWorkshop(raw, payload.cues), {workshop:true});
      return { ...result, model };
    });
  }

  /** Optional quality-mode pass, shared with Gemini's conservative editor. */
  function reviewTexts(texts, sources, cfg) {
    const prompt = globalThis.GXT.prompt;
    return withFallback(cfg, async (model) => {
      const body = prompt.buildReviewTextsRequest(texts, sources, cfg.kind, null, cfg.extra);
      const list = await call(
        { ...cfg, model },
        body.systemInstruction.parts[0].text,
        body.contents[0].parts[0].text,
        (text) => prompt.parseGenericTranslations(text, texts.length, sources, cfg.kind)
      );
      return { list, model };
    });
  }

  /** Shared plain-text runner (image / summary / compose). */
  function runPlain(cfg, systemText, userContent) {
    const prompt = globalThis.GXT.prompt;
    return withFallback(cfg, async (model) => {
      const text = await call(
        { ...cfg, model },
        systemText,
        userContent,
        (raw) => prompt.parsePlainText(raw),
        { json: false }
      );
      return { text, model };
    });
  }

  /** Translate every non-Persian text found in an image (v1.8). */
  function translateImage(cfg) {
    const prompt = globalThis.GXT.prompt;
    return runPlain(cfg, prompt.resolveSystem('image', cfg.extra), [
      { type: 'text', text: 'Translate the text in this image to '+globalThis.GXT.targetName(cfg.extra?.targetLang || 'fa')+'.' },
      { type: 'image_url', image_url: { url: `data:${cfg.mime};base64,${cfg.data}` } },
    ]);
  }

  /** Persian bullet summary of arbitrary text (v1.8). */
  function summarize(cfg) {
    const prompt = globalThis.GXT.prompt;
    return runPlain(cfg, prompt.resolveSystem('summary', cfg.extra), String(cfg.text || '').slice(0, 60000));
  }

  /** Manual single-text quality edit for OpenAI-compatible providers. */
  function reviewText(cfg) {
    const prompt = globalThis.GXT.prompt;
    return runPlain(
      cfg,
      prompt.reviewSystem(cfg.extra) + prompt.extrasBlock(cfg.extra, [cfg.source, cfg.text]),
      `ORIGINAL:\n${String(cfg.source || '').slice(0, 12000)}\n\nTRANSLATION TO EDIT:\n${String(cfg.text || '').slice(0, 12000)}`
    );
  }

  /** Persian draft → natural English X post (v1.8). */
  function composeEnglish(cfg) {
    const prompt = globalThis.GXT.prompt;
    return runPlain(cfg, prompt.resolveSystem('compose', cfg.extra), String(cfg.text || '').slice(0, 8000));
  }

  /** Shorten one dubbing line to fit its slot (v2.4.5). */
  function compressForDub(cfg) {
    const prompt = globalThis.GXT.prompt;
    return runPlain(
      cfg,
      prompt.resolveSystem('dubCompress', cfg.extra),
      `بودجه: حداکثر ${Math.max(10, Math.round(cfg.budget || 0))} کاراکتر\n\n${String(cfg.text || '').slice(0, 2000)}`
    );
  }

  globalThis.GXT.openai = {
    ProviderError,
    listModels,
    translateBatch,
    translateTexts,
    translateWorkshop,
    reviewTexts,
    translateImage,
    summarize,
    reviewText,
    composeEnglish,
    compressForDub,
    _internal: {
      classifyHttpError,
      normalizeBaseUrl,
      setRequestTimeoutMs: (ms) => { requestTimeoutMs = ms; },
    },
  };
})();
