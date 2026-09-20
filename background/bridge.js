/**
 * Local bridge client (v2.5.0) — the extension's half of `bridge/bridge.py`.
 *
 * The extension is very good at everything a page can do, and helpless at
 * everything it cannot: software installed on this machine, the GPU, and the
 * user's own two applications. This is the door to those.
 *
 * ── Capabilities are asked for, never assumed ───────────────────────────────
 *
 * `/health` reports what the machine can actually do at this moment. Nothing
 * here hard-codes the belief that Whisper is installed or that MangaTranslator
 * exists; a feature that is missing is reported as installable, with the exact
 * command, rather than failing later as an unexplained error. The health
 * result is cached briefly so a context-menu build or a settings repaint does
 * not fire a request every time.
 *
 * ── Why this can be trusted with a token ────────────────────────────────────
 *
 * The bridge can run local programs, so it authenticates. A web page cannot
 * forge an `Origin`, but it CAN fire a no-cors POST at loopback and never see
 * the reply — enough to cause an action if actions were unauthenticated. The
 * token closes that. It lives in settings, is sent as a header, and is never
 * placed in a URL where it could end up in a log.
 *
 * ── Failure is a first-class result ─────────────────────────────────────────
 *
 * The overwhelmingly likely state is "the bridge is not running", which is not
 * an error worth a stack trace — it is the default. Every call returns a
 * structured `{ok:false, code}` and the codes are specific enough for the UI
 * to say something true: OFFLINE, BAD_TOKEN, NOT_INSTALLED, BLOCKED.
 */
'use strict';
(() => {
  const GXTBG = globalThis.GXT;

  // Long enough for Whisper on a cold model, short enough that a hung bridge
  // does not wedge a caller forever.
  // `manga` sits deliberately ABOVE the bridge's own 600s cap on that job, so
  // a slow page ends in the server's precise explanation rather than in this
  // side's generic "پل پاسخ نداد".
  const TIMEOUT_MS = {
    health: 2500, tts: 30000, asr: 180000, manga: 660000, upscale: 8000,
    // The voice catalogue is one network round trip inside the bridge.
    voices: 15000,
    // v2.5.8 — a chapter upload can be tens of megabytes over loopback, so it
    // gets room; the polls that follow must be short, because a status call
    // that hangs would stall a run that is otherwise progressing fine.
    mangaStart: 180000, mangaPoll: 10000, mangaPage: 60000,
  };
  const HEALTH_TTL_MS = 5000;

  let healthCache = null;
  let healthAt = 0;
  let healthIdentity = '';

  const baseUrl = (settings) => {
    const port = Number(settings?.bridgePort) || 8765;
    return `http://127.0.0.1:${port}`;
  };

  /**
   * One request. Every failure mode this can hit is turned into a code the
   * interface can explain, because "TypeError: Failed to fetch" tells the user
   * nothing about a program they simply have not started.
   */
  async function call(settings, path, payload, { timeout = 15000, raw = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(baseUrl(settings) + path, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tarjoman-Language': globalThis.GXT.i18n.language(settings),
          ...(settings?.bridgeToken ? { 'X-Bridge-Token': settings.bridgeToken } : {}),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
        // The bridge is a local tool, not a site; nothing about this request
        // should carry or accept ambient credentials.
        credentials: 'omit',
        cache: 'no-store',
      });
      if (response.status === 401) {
        return { ok: false, code: 'BAD_TOKEN', get error() { return globalThis.GXT.i18n.t("background_bridge_call_6"); } };
      }
      if (response.status === 403) {
        return { ok: false, code: 'BLOCKED', get error() { return globalThis.GXT.i18n.t("background_bridge_call_5"); } };
      }
      const readErrorBody = async () => {
        try { return (await response.json()) || {}; }
        catch (error) {
          if (controller.signal.aborted) throw error;
          return {};
        }
      };
      if (response.status === 503) {
        const body = await readErrorBody();
        return { ok: false, code: 'NOT_INSTALLED', error: body.error || globalThis.GXT.i18n.t("background_bridge_call_4"), hint: body.hint || '' };
      }
      if (!response.ok) {
        const body = await readErrorBody();
        return { ok: false, code: body.code || 'FAILED', error: body.error || globalThis.GXT.i18n.t("background_bridge_call_3", {v0:(response.status)}) };
      }
      if (raw) {
        const buffer = await response.arrayBuffer();
        return { ok: true, buffer, mime: response.headers.get('Content-Type') || 'audio/mpeg' };
      }
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        return { ok: false, code: 'TIMEOUT', get error() { return globalThis.GXT.i18n.t("background_bridge_call_2"); } };
      }
      // A refused connection is the NORMAL state — the companion app is simply
      // not running — so it must never read like a crash.
      return {
        ok: false,
        code: 'OFFLINE',
        get error() { return globalThis.GXT.i18n.t("background_bridge_call_1"); },
        raw: String(error?.message || error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** What the machine can do. Cached briefly; `force` skips the cache. */
  async function health(settings, { force = false } = {}) {
    const identity = JSON.stringify([baseUrl(settings), settings?.bridgeToken || '', globalThis.GXT.i18n.language(settings)]);
    if (!force && identity === healthIdentity && healthCache && Date.now() - healthAt < HEALTH_TTL_MS) return healthCache;
    const result = await call(settings, '/health', undefined, { timeout: TIMEOUT_MS.health });
    healthCache = result;
    healthAt = Date.now();
    healthIdentity = identity;
    return result;
  }

  /** Is a named capability usable right now? Never throws — a bridge that is
   *  not running simply cannot do anything, which is a valid answer. */
  async function can(settings, feature) {
    if (!settings?.bridgeEnabled) return false;
    const result = await health(settings);
    return !!result?.ok && !!result.capabilities?.[feature]?.available;
  }

  /** Speech from the local engine. Returns the extension's usual audio shape,
   *  so this is a drop-in fourth TTS engine rather than a special case. */
  async function speak(settings, { text, voice, rate }) {
    const result = await call(settings, '/tts', { text, voice, rate },
      { timeout: TIMEOUT_MS.tts, raw: true });
    if (!result.ok) return result;
    const bytes = new Uint8Array(result.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { ok: true, mime: result.mime, data: btoa(binary) };
  }

  /**
   * Transcribe audio into timed cues.
   *
   * `offsetMs` is where this chunk sits in the video, because the caller
   * transcribes a window at a time and the returned timings have to land on
   * the real timeline, not on the chunk's own zero.
   */
  function transcribe(settings, { audio, language, model, offsetMs }) {
    return call(settings, '/asr', { audio, language, model, offsetMs },
      { timeout: TIMEOUT_MS.asr });
  }

  /**
   * What the local half of the product is running, and what it could be
   * running (v3.0.0).
   *
   * The «به‌روزرسانی» control in the popup asks every engine what exists right
   * now; for the cloud engines that is a model list, and for this one it is
   * the versions of the Python packages the machine actually has. A bridge too
   * old to answer simply reports nothing, which the UI shows as "unknown"
   * rather than as an error — an older bridge is not a broken one.
   */
  /**
   * Read the text out of an image, locally (v3.0.0).
   *
   * Generous timeout: the first call loads the OCR models, which on a cold
   * cache is seconds, and a user who has just dragged a box over a game is
   * willing to wait for that once.
   */
  function ocr(settings, { image }) {
    return call(settings, '/ocr', { image }, { timeout: TIMEOUT_MS.asr });
  }

  function updates(settings) {
    return call(settings, '/updates', {}, { timeout: TIMEOUT_MS.voices }).catch(() => null);
  }

  /** The voices and transcription models this machine can offer. The «⟳»
   *  button means the same thing here as it does for a cloud provider. */
  function voices(settings) {
    return call(settings, '/voices', {}, { timeout: TIMEOUT_MS.voices });
  }

  /** Hand an image to MangaTranslator's local pipeline. */
  function mangaTarget(settings){const targetLang=globalThis.GXT.forScope(settings,'manga').targetLang;return {targetLang,targetName:globalThis.GXT.targetName(targetLang),direction:globalThis.GXT.targetDirection(targetLang)};}
  function manga(settings, { image, name }) {
    return call(settings, '/manga', { image, name, ...mangaTarget(settings) }, { timeout: TIMEOUT_MS.manga });
  }

  // ------------------------------------------------------ chapters (v2.5.8)
  //
  // A chapter is a JOB, not a request. Uploading it is one long call (dozens
  // of megabytes over loopback); everything after that is short and frequent,
  // so those get short timeouts and can fail without costing the run.

  /** Queue a whole chapter. Returns a job id immediately. */
  function mangaStart(settings, { pages, concurrency }) {
    return call(settings, '/manga/start', { pages, concurrency, ...mangaTarget(settings) },
      { timeout: TIMEOUT_MS.mangaStart });
  }

  /** Poll progress. Cheap on purpose — the tab calls this every second. */
  function mangaStatus(settings, { job }) {
    return call(settings, '/manga/status', { job }, { timeout: TIMEOUT_MS.mangaPoll });
  }

  /** Collect one finished page. */
  function mangaPage(settings, { job, index }) {
    return call(settings, '/manga/page', { job, index }, { timeout: TIMEOUT_MS.mangaPage });
  }

  function mangaCancel(settings, { job }) {
    return call(settings, '/manga/cancel', { job }, { timeout: TIMEOUT_MS.mangaPoll });
  }

  /** The finished chapter as a CBZ. */
  function mangaArchive(settings, { job }) {
    return call(settings, '/manga/archive', { job }, { timeout: TIMEOUT_MS.manga });
  }

  /** Queue a video for Anime Studio. */
  function upscale(settings, { url, title, page, launch }) {
    return call(settings, '/upscale', { url, title, page, launch },
      { timeout: TIMEOUT_MS.upscale });
  }

  GXTBG.bridge = {
    health,
    can,
    voices,
    updates,
    ocr,
    mangaStart,
    mangaStatus,
    mangaPage,
    mangaCancel,
    mangaArchive,
    speak,
    transcribe,
    manga,
    upscale,
    _internal: {
      call,
      baseUrl,
      resetHealth: () => { healthCache = null; healthAt = 0; },
    },
  };
})();
