/**
 * Persian text-to-speech (v2.2.0).
 *
 * WHY THIS FILE EXISTS, and why it does not look like the obvious design:
 *
 * There is no free Persian voice inside the browser. `chrome.tts` and
 * `speechSynthesis` expose the OS voices, and Windows ships none for fa-IR.
 * Google's keyless consumer TTS — the twin of the translate endpoint mt.js
 * already uses — answers for Arabic, Turkish and Urdu but returns an EMPTY
 * body for `fa`: Google Translate has no Persian voice at all. And the
 * well-known `edge-tts` WebSocket trick died in December 2025, when Microsoft
 * started requiring custom handshake headers that a browser cannot set (the
 * WebSocket API takes none, and declarativeNetRequest is not allowed to write
 * `Origin` or `Sec-*`).
 *
 * What DOES work — verified against the live services before this was written —
 * is Bing Translator's read-aloud endpoint. It serves the very same Azure
 * neural voices as edge-tts (fa-IR-DilaraNeural, fa-IR-FaridNeural) over an
 * ordinary HTTPS POST, with no key, and it authenticates with exactly the
 * session blob mt.js already scrapes for translation. So the free engine here
 * is not a new integration: it is a second consumer of an existing session.
 *
 * Three engines behind one interface, so no single service can take the
 * feature down and quality is always a setting away:
 *
 *   bing    free, keyless, effectively unlimited, two Persian neural voices,
 *           honors an SSML speaking rate. The default and the workhorse.
 *   gemini  the premium tier: prompt-steerable delivery, 30 voices. Costs a
 *           request from a very small free-tier budget (~3/min), so it is for
 *           short, quality-critical text — never for bulk.
 *   openai  any OpenAI-compatible /audio/speech endpoint, including a local
 *           server. Model and voice are free-text, so this stays useful no
 *           matter what the vendors rename next.
 *
 * Everything returns the same shape: base64 audio in a container the Web Audio
 * API can decode, so the player in the content script never branches on engine.
 */
'use strict';
(() => {
  globalThis.GXT = globalThis.GXT || {};

  // A speech request is far longer than a translation: ~7s of audio takes
  // ~1s to synthesize, and a full paragraph can take 25s. Two in flight keeps
  // a read-aloud responsive (chunk N+1 renders while chunk N plays) without
  // hammering an endpoint that is doing real work per request.
  const limiter = { max: 2, active: 0, waiters: [], async run(fn) {
    while (this.active >= this.max) await new Promise((r) => this.waiters.push(r));
    this.active += 1;
    try { return await fn(); } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  } };

  // Generous: 4000 characters of Persian took ~25s against Bing in testing,
  // and the chunker keeps real requests far below that. Still bounded, so a
  // stalled connection can never hold a limiter slot forever (the v1.6.6
  // deadlock lesson applies to every fetch in this codebase).
  let requestTimeoutMs = 60000;

  class TtsError extends Error {
    constructor(message, code, { retriable = false, retryAfterMs = 0 } = {}) {
      super(message);
      this.name = 'TtsError';
      this.code = code;
      this.retriable = retriable;
      this.retryAfterMs = retryAfterMs;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchWithTimeout(url, opts = {}, consume) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, { ...opts, signal: controller.signal });
      return consume ? await consume(response) : response;
    } catch (error) {
      const timedOut = controller.signal.aborted;
      if (!timedOut && error instanceof TtsError) throw error;
      throw new TtsError(
        timedOut ? globalThis.GXT.i18n.t("background_tts_fetchWithTimeout_2") : globalThis.GXT.i18n.t("background_tts_fetchWithTimeout_1"),
        timedOut ? 'TIMEOUT' : 'NETWORK',
        { retriable: !timedOut, retryAfterMs: 2000 }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  function bufToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    // Chunked: String.fromCharCode(...bytes) blows the argument limit on
    // anything longer than a second or two of audio.
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  // ------------------------------------------------------------- chunking

  // Sentence enders, Persian and Latin. The Arabic full stop (۔), the Persian
  // question mark (؟) and the Arabic semicolon (؛) all matter here — a Persian
  // paragraph split on `.` alone barely splits at all.
  const SENT_END = /([.!?؟…؛۔:]|\n)+/;
  // The first chunk is deliberately small: time-to-first-word is what makes
  // read-aloud feel instant. Later chunks are large because they are being
  // synthesized while an earlier one plays, so their latency is hidden.
  const FIRST_CHUNK = 220;
  const CHUNK = 700;
  const HARD_MAX = 1400;

  /**
   * Split text into speakable pieces, preferring sentence boundaries.
   *
   * Never splits mid-word. A single sentence longer than the limit is broken
   * at the last space before it; a single WORD longer than the limit (a URL,
   * a hash) is passed through whole rather than mangled — the engine will
   * handle it or not, but the text stays intact.
   *
   * @returns {string[]} non-empty pieces, in order
   */
  function split(text, { first = FIRST_CHUNK, size = CHUNK } = {}) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    // Keep the delimiter attached to the sentence it ends.
    const sentences = [];
    let rest = clean;
    for (;;) {
      const m = SENT_END.exec(rest);
      if (!m) { if (rest.trim()) sentences.push(rest.trim()); break; }
      const cut = m.index + m[0].length;
      sentences.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
    const out = [];
    let buf = '';
    const limitNow = () => (out.length === 0 ? first : size);
    const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
    for (const sentence of sentences) {
      if (!sentence) continue;
      if (sentence.length > HARD_MAX) {
        flush();
        let tail = sentence;
        while (tail.length > HARD_MAX) {
          const window = tail.slice(0, HARD_MAX);
          const space = window.lastIndexOf(' ');
          const cut = space > HARD_MAX * 0.5 ? space : window.length;
          out.push(tail.slice(0, cut).trim());
          tail = tail.slice(cut).trim();
        }
        if (tail) buf = tail;
        continue;
      }
      if (buf && (buf.length + 1 + sentence.length) > limitNow()) flush();
      buf = buf ? `${buf} ${sentence}` : sentence;
    }
    flush();
    return out.filter(Boolean);
  }

  // ----------------------------------------------------------------- bing

  const BING_TTS_URL = 'https://www.bing.com/tfettts';

  const xmlEscape = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  /** Clamp a speaking-rate multiplier to the SSML percentage Bing accepts. */
  function ratePercent(rate) {
    const r = typeof rate === 'number' && Number.isFinite(rate) ? rate : 1;
    const clamped = Math.max(0.5, Math.min(2, r));
    const pct = Math.round((clamped - 1) * 100);
    return pct === 0 ? '' : `${pct > 0 ? '+' : ''}${pct}%`;
  }

  function bingSsml(text, voice, rate) {
    const pct = ratePercent(rate);
    const body = xmlEscape(text);
    const inner = pct ? `<prosody rate="${pct}">${body}</prosody>` : body;
    return (
      '<speak version="1.0" xml:lang="fa-IR">' +
      `<voice xml:lang="fa-IR" name="${xmlEscape(voice)}">${inner}</voice>` +
      '</speak>'
    );
  }

  async function bingOnce(text, { voice, rate }, auth) {
    const url =
      `${BING_TTS_URL}?isVertical=1&&IG=${encodeURIComponent(auth.ig)}` +
      `&IID=${encodeURIComponent(auth.iid)}`;
    return fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ssml: bingSsml(text, voice, rate),
        token: auth.token,
        key: String(auth.key),
      }).toString(),
      credentials: 'omit',
    }, async (response) => {
      // A stale abuse-prevention token comes back as 401/403 — recoverable by
      // re-scraping, exactly like the translate path's BING_AUTH case.
      if (response.status === 401 || response.status === 403) {
        throw new TtsError(globalThis.GXT.i18n.t("background_mt_error_1"), 'BING_AUTH', { retriable: true, retryAfterMs: 300 });
      }
      if (!response.ok) {
        throw new TtsError(
          globalThis.GXT.i18n.t("background_tts_bingOnce_2", {v0:(response.status)}),
          response.status >= 500 ? 'SERVER' : `HTTP_${response.status}`,
          { retriable: response.status >= 500, retryAfterMs: 2000 }
        );
      }
      const buffer = await response.arrayBuffer();
      // A 200 with an empty/tiny body means the request was accepted but no
      // audio was produced. Surfacing it here keeps it from reaching the player
      // as an opaque decode failure (the same empty-200 trap as YouTube's
      // caption endpoint in v1.6.3).
      if (buffer.byteLength < 512) {
        throw new TtsError(globalThis.GXT.i18n.t("background_tts_bingOnce_1"), 'EMPTY_AUDIO', { retriable: true, retryAfterMs: 1000 });
      }
      return { mime: 'audio/mpeg', data: bufToBase64(buffer), voice };
    });
  }

  async function bingSpeak(text, opts) {
    const session = globalThis.GXT.mt.bingSession;
    try {
      return await bingOnce(text, opts, await session.get(false));
    } catch (error) {
      if (error.code === 'BING_AUTH') {
        session.reset();
        return bingOnce(text, opts, await session.get(true));
      }
      throw error;
    }
  }

  // --------------------------------------------------------------- gemini

  /**
   * Gemini speech models answer with RAW PCM (`audio/L16`, 24 kHz, mono,
   * signed 16-bit) — headerless samples, which `decodeAudioData` cannot read.
   * Wrapping them in a 44-byte RIFF/WAVE header here (rather than special-
   * casing the player) is what keeps every engine's output interchangeable.
   */
  function pcmToWav(base64, mime) {
    const rate = parseInt(/rate=(\d+)/.exec(mime || '')?.[1] || '24000', 10);
    const binary = atob(base64);
    const pcmLen = binary.length;
    const buffer = new ArrayBuffer(44 + pcmLen);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const ascii = (offset, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i)); };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + pcmLen, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);      // PCM chunk size
    view.setUint16(20, 1, true);       // format = PCM
    view.setUint16(22, 1, true);       // channels = mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true); // byte rate = rate * channels * 2
    view.setUint16(32, 2, true);       // block align
    view.setUint16(34, 16, true);      // bits per sample
    ascii(36, 'data');
    view.setUint32(40, pcmLen, true);
    for (let i = 0; i < pcmLen; i += 1) bytes[44 + i] = binary.charCodeAt(i);
    return bufToBase64(buffer);
  }

  async function geminiSpeak(text, { voice, style, model, keys }) {
    if (!keys || !keys.length) {
      throw new TtsError(globalThis.GXT.i18n.t("background_tts_geminiSpeak_1"), 'NO_KEY');
    }
    const result = await globalThis.GXT.gemini.synthesize({
      keys,
      model: model || 'gemini-3.1-flash-tts-preview',
      text,
      voice,
      style,
    });
    // Already a container format? Pass it through. Otherwise it is raw PCM.
    const isContainer = /audio\/(mpeg|mp3|wav|ogg|webm)/i.test(result.mime || '');
    return {
      mime: isContainer ? result.mime : 'audio/wav',
      data: isContainer ? result.data : pcmToWav(result.data, result.mime),
      voice,
      model: result.model,
    };
  }

  // --------------------------------------------------------------- openai

  async function openaiSpeak(text, { voice, rate, model, baseUrl, key }) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new TtsError(globalThis.GXT.i18n.t("background_tts_openaiSpeak_3"), 'NO_BASE_URL');
    if (!model) throw new TtsError(globalThis.GXT.i18n.t("background_tts_openaiSpeak_2"), 'NO_MODEL');
    const headers = { 'Content-Type': 'application/json' };
    // A local server (Ollama, LM Studio, openedai-speech) usually needs no key.
    if (key) headers.Authorization = `Bearer ${key}`;
    return fetchWithTimeout(`${base}/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: text,
        voice: voice || 'alloy',
        response_format: 'mp3',
        speed: Math.max(0.25, Math.min(4, typeof rate === 'number' ? rate : 1)),
      }),
    }, async (response) => {
      if (!response.ok) {
        let raw = '';
        try { raw = (await response.text()).slice(0, 400); } catch { /* body already consumed */ }
        const error = new TtsError(
          globalThis.GXT.i18n.t("background_tts_error_1", {v0:(response.status)}),
          response.status === 401 || response.status === 403 ? 'BAD_KEY'
            : response.status === 404 ? 'MODEL_NOT_FOUND'
            : response.status >= 500 ? 'SERVER' : `HTTP_${response.status}`,
          { retriable: response.status >= 500, retryAfterMs: 2000 }
        );
        error.raw = raw;
        throw error;
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength < 256) {
        throw new TtsError(globalThis.GXT.i18n.t("background_tts_openaiSpeak_1"), 'EMPTY_AUDIO', { retriable: true });
      }
      return { mime: response.headers.get('Content-Type') || 'audio/mpeg', data: bufToBase64(buffer), voice, model };
    });
  }

  // ------------------------------------------------------------- dispatch

  /**
   * The local bridge as a speech engine (v2.5.0).
   *
   * It drives the SAME Microsoft neural voices, from Python, where Microsoft
   * never closed the door — so this is the answer to the browser path being
   * shut off again, and it works with no network at all once Piper is
   * installed. Deliberately thin: the bridge already returns the exact audio
   * shape every other engine here returns.
   */
  async function bridgeSpeak(text, opts) {
    const bridge = globalThis.GXT.bridge;
    if (!bridge) throw new TtsError(globalThis.GXT.i18n.t("background_tts_bridgeSpeak_1"), 'NO_BRIDGE');
    const result = await bridge.speak(opts.settings || {}, {
      text,
      voice: opts.voice,
      rate: opts.rate,
    });
    if (!result.ok) {
      // OFFLINE is the ordinary state of a program the user has not started,
      // so it is retriable in the sense that starting it fixes it — but not
      // worth retrying automatically, which would only delay the message.
      throw new TtsError(result.error || globalThis.GXT.i18n.t("background_service_worker_handlers_39"), result.code || 'BRIDGE_FAILED');
    }
    return { mime: result.mime, data: result.data, voice: opts.voice };
  }

  const MAX_RETRIES = 2;

  /**
   * Synthesize ONE piece of text. Callers chunk with `split` first; this is
   * deliberately single-piece so each piece caches, retries and cancels on
   * its own.
   *
   * @param {string} text
   * @param {{engine:string, voice:string, rate?:number, style?:string,
   *          model?:string, keys?:string[], baseUrl?:string, key?:string}} opts
   * @returns {Promise<{mime:string, data:string, engine:string, voice:string}>}
   */
  async function speak(text, opts) {
    const clean = String(text || '').trim();
    if (!clean) throw new TtsError(globalThis.GXT.i18n.t("background_service_worker_handlers_6"), 'EMPTY_INPUT');
    const engine = ['gemini', 'openai', 'bridge'].includes(opts.engine) ? opts.engine : 'bing';
    const run =
      engine === 'gemini' ? geminiSpeak
      : engine === 'openai' ? openaiSpeak
      : engine === 'bridge' ? bridgeSpeak
      : bingSpeak;
    let retries = 0;
    for (;;) {
      try {
        const result = await limiter.run(() => run(clean, opts));
        return { ...result, engine };
      } catch (error) {
        if (error.retriable && retries < MAX_RETRIES) {
          retries += 1;
          await sleep((error.retryAfterMs || 1000 * retries) + Math.random() * 250);
          continue;
        }
        throw error;
      }
    }
  }

  globalThis.GXT.tts = {
    TtsError,
    speak,
    split,
    _internal: {
      bingSsml,
      ratePercent,
      pcmToWav,
      xmlEscape,
      limiter,
      FIRST_CHUNK,
      CHUNK,
      HARD_MAX,
      setRequestTimeoutMs: (ms) => { requestTimeoutMs = ms; },
    },
  };
})();
