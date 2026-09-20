/**
 * Gemini Live translation client (v2.4.5) — the audio-native dubbing path.
 *
 * The caption path (tts.js + content/dub.js) reads the video's SUBTITLES and
 * speaks them. This one never touches text: it streams the video's actual
 * AUDIO to Gemini and gets Persian speech back, continuously. That difference
 * is the whole point of having both.
 *
 *   caption path            live path
 *   ─────────────           ─────────
 *   needs subtitles         needs nothing but sound
 *   free / keyless          burns Live API quota
 *   sentence-accurate       a few seconds behind, always
 *   fixed voice             carries tone and emphasis across
 *
 * So the live path is the answer to "this video has no captions at all",
 * which the caption path can never solve, and the caption path stays the
 * default because it is free and exactly synchronized.
 *
 * ── Why this lives in the service worker ────────────────────────────────────
 *
 * The WebSocket must outlive whatever the page is doing, and since Chrome 116
 * an open WebSocket keeps the worker alive on its own — no keepalive hacks. It
 * also keeps the API key out of the page, which matters on a site whose own
 * scripts share the tab.
 *
 * ── The two things that WILL happen mid-video ───────────────────────────────
 *
 * 1. Google closes the socket after ~10 minutes. It warns first with `goAway`.
 * 2. The connection drops for ordinary network reasons.
 *
 * Both are handled the same way: keep the newest session-resumption handle,
 * reconnect, and hand the handle back so the model keeps its context. A
 * dubbing session for a 40-minute video is therefore several sockets, and the
 * viewer should never be able to tell.
 */
'use strict';
(() => {
  const GXTBG = globalThis.GXT;

  const WS_URL =
    'wss://generativelanguage.googleapis.com/ws/' +
    'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

  // A model built for speech-to-speech translation. The generic live models
  // can be told to translate, but this one is trained for it and does not
  // editorialize, greet, or answer the video.
  const TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';
  // If that is not available on the key, a general live model can still do the
  // job when instructed firmly enough. Ordered newest first.
  const FALLBACK_MODELS = ['gemini-3.1-flash-live-preview', 'gemini-2.5-flash-live-preview'];

  /** Spoken-language names for the system instruction; the client-side filter
   *  works off the codes. */
  const LANG_NAMES = {
    en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian',
    ar: 'Arabic', tr: 'Turkish', hi: 'Hindi', es: 'Spanish', fr: 'French',
    de: 'German', it: 'Italian', pt: 'Portuguese', th: 'Thai', he: 'Hebrew',
  };

  // Reconnect backoff. Deliberately short at the start: a `goAway` close is
  // expected and routine, and waiting seconds there would be an audible hole.
  const BACKOFF_MS = [250, 1000, 3000, 8000];
  const MAX_RECONNECTS = 40; // ~40 × 10 min ≫ any video

  /**
   * A dubbing session: one video, one tab, many sockets.
   *
   * @param {{apiKeys: string[], model?: string, targetLang?: string,
   *          onAudio: Function, onText: Function, onState: Function}} config
   */
  function createSession(config) {
    const {
      apiKeys = [],
      targetLang = 'fa',
      sourceLang = '',
      onAudio = () => {},
      onText = () => {},
      onState = () => {},
    } = config;

    let ws = null;
    let model = config.model || TRANSLATE_MODEL;
    let modelIndex = -1;          // -1 = the preferred model, then FALLBACK_MODELS
    let keyIndex = 0;
    let resumeHandle = null;      // survives reconnects; the whole point
    let reconnects = 0;
    let closed = false;           // the CALLER asked to stop — never reconnect
    let ready = false;
    let sawSetupComplete = false;
    /** Audio that arrived while the socket was down or still handshaking. */
    const pending = [];
    let lastError = null;
    let openedAt = 0;
    let started = false;
    let reconnectTimer = null;
    let inputEnded = false;
    let endSent = false;
    let inputSinceTurn = false;
    let drainTimer = null;
    let incoming = Promise.resolve();
    const fallbacks = config.model ? [] : (config.availableModels?.length ? config.availableModels : FALLBACK_MODELS).filter(id => id !== model);

    function sendEnd() {
      if (!inputEnded || endSent || pending.length || !ready || ws?.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({realtimeInput:{audioStreamEnd:true}})); endSent = true;
        if (!inputSinceTurn) { clearTimeout(drainTimer); report('drained'); }
      } catch (e) { lastError={code:'DRAIN_FAILED',get error() { return globalThis.GXT.i18n.t("background_live_sendEnd_1"); }}; report('error'); }
    }

    const report = (state, extra) => onState({ state, model, error: lastError, ...extra });

    function nextKey() {
      keyIndex = (keyIndex + 1) % Math.max(1, apiKeys.length);
      return apiKeys[keyIndex] || '';
    }

    /**
     * The handshake. `translationConfig` is what makes this a translator
     * rather than a chatbot: the model is told to render whatever it hears in
     * the target language and nothing else.
     *
     * `inputAudioTranscription`/`outputAudioTranscription` cost nothing extra
     * and give us live subtitles for free — including on videos that have no
     * caption track at all, which is the one thing the caption path cannot do.
     */
    function setupMessage() {
      const usingTranslateModel = /live-translate/.test(model);
      const setup = {
        model: `models/${model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Reconnecting with the previous handle keeps the model's context, so
        // a sentence split across a socket boundary still lands intact.
        sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
      };
      if (usingTranslateModel) {
        setup.generationConfig.translationConfig = {
          targetLanguageCode: targetLang,
          // Speak only the translation. Without this some configurations echo
          // the source language first, which would double every line.
          echoTargetLanguage: false,
        };
      } else {
        // A general live model needs telling, firmly, that it is not in a
        // conversation — and, when the viewer has picked a source language,
        // that it must ignore every other one. (The dedicated translate model
        // has no such setting, which is why the client filters its output
        // instead; see `matchesSource` in content/dub.js.)
        const only = sourceLang
          ? `ONLY translate speech spoken in ${LANG_NAMES[sourceLang] || sourceLang}. ` +
            'If you hear ANY other language, stay completely silent — this video has more than ' +
            'one soundtrack and the viewer asked for one of them. '
          : '';
        setup.systemInstruction = {
          parts: [{
            text:
              'You are a live dubbing engine. Translate speech you hear into natural, spoken ' +
              `${globalThis.GXT.targetName(targetLang || 'fa')} and say it aloud immediately. ${only}` +
              'NEVER answer, comment, greet, summarise, or add anything of your own. ' +
              'NEVER repeat the source language. If you hear silence, music, or noise, stay silent. ' +
              "Match the speaker's tone and register. Keep the translation as short as the " +
              'original so it fits the same time.',
          }],
        };
      }
      return { setup };
    }

    function connect() {
      if (closed) return;
      const key = apiKeys[keyIndex] || '';
      if (!key) { lastError = { code: 'NO_KEY', get error() { return globalThis.GXT.i18n.t("background_live_connect_5"); } }; report('error'); return; }
      ready = false;
      sawSetupComplete = false;
      openedAt = Date.now();
      report('connecting');
      if (closed) return;
      let socket;
      try {
        socket = new WebSocket(`${WS_URL}?key=${encodeURIComponent(key)}`);
        ws = socket;
      } catch (error) {
        lastError = { code: 'WS_OPEN', error: String(error?.message || error) };
        report('error');
        scheduleReconnect();
        return;
      }
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        if (closed || ws !== socket) return;
        try { socket.send(JSON.stringify(setupMessage())); } catch { /* closing */ }
      };

      socket.onmessage = (event) => {
        // Blob decoding is asynchronous; preserve wire order through final
        // turn completion instead of allowing a later text frame to overtake it.
        const task = incoming.then(async () => {
        if (closed || ws !== socket) return;
        let text = event.data;
        // The server may frame JSON as a Blob or an ArrayBuffer depending on
        // size; all three shapes carry the same JSON.
        if (text instanceof ArrayBuffer) text = new TextDecoder().decode(text);
        else if (typeof Blob !== 'undefined' && text instanceof Blob) {
          try { text = await text.text(); } catch { return; }
        }
        // Decoding a Blob can finish after stop/restart or socket rotation.
        if (closed || ws !== socket) return;
        let message;
        try { message = JSON.parse(text); } catch { return; }
        handle(message);
        });
        incoming = task.catch(() => {});
        return task;
      };

      socket.onerror = () => {
        if (closed || ws !== socket) return;
        lastError = { code: 'WS_ERROR', get error() { return globalThis.GXT.i18n.t("background_live_connect_4"); } };
      };

      socket.onclose = (event) => {
        if (closed || ws !== socket) return;
        ready = false;
        ws = null;
        endSent = false;
        if (inputEnded) { lastError={code:'DRAIN_DISCONNECTED',get error() { return globalThis.GXT.i18n.t("background_live_connect_3"); }}; report('error'); return; }
        // A 1007/1008/4xx right after opening is a configuration problem —
        // wrong model, key without access — and retrying it forever is just
        // noise. Try the next model, then the next key, then give up loudly.
        const instant = Date.now() - openedAt < 2500 && !sawSetupComplete;
        if (instant) {
          if (modelIndex + 1 < fallbacks.length) {
            modelIndex += 1;
            model = fallbacks[modelIndex];
            lastError = null;
            report('connecting', {get notice() { return globalThis.GXT.i18n.t("background_live_connect_2", {v0:(model)}); }});
            connect();
            return;
          }
          if (apiKeys.length > 1 && keyIndex + 1 < apiKeys.length) {
            nextKey();
            connect();
            return;
          }
          lastError = lastError || {
            code: 'WS_REFUSED',
            get error() { return globalThis.GXT.i18n.t("background_live_connect_1", {v0:(event.code)}); },
          };
          report('error');
          return;
        }
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (closed || reconnectTimer !== null) return;
      if (reconnects >= MAX_RECONNECTS) {
        lastError = { code: 'GAVE_UP', get error() { return globalThis.GXT.i18n.t("background_live_scheduleReconnect_1"); } };
        report('error');
        return;
      }
      const delay = BACKOFF_MS[Math.min(reconnects, BACKOFF_MS.length - 1)];
      reconnects += 1;
      report('reconnecting', { in: delay });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function handle(message) {
      // Field names differ slightly between transports and versions, so every
      // read here tolerates both camelCase and snake_case rather than trusting
      // one shape.
      const pick = (...names) => {
        for (const name of names) {
          if (message[name] !== undefined) return message[name];
        }
        return undefined;
      };

      if (pick('setupComplete', 'setup_complete') !== undefined) {
        ready = true;
        sawSetupComplete = true;
        reconnects = 0;
        report('live');
        // Anything captured during the handshake goes out now, in order.
        while (pending.length) sendAudio(pending.shift());
        sendEnd();
        return;
      }

      const resumption = pick('sessionResumptionUpdate', 'session_resumption_update');
      if (resumption) {
        // Only a handle marked resumable is worth keeping; storing a
        // provisional one would make the NEXT reconnect fail.
        if (resumption.resumable !== false && resumption.newHandle) resumeHandle = resumption.newHandle;
        else if (resumption.resumable !== false && resumption.new_handle) resumeHandle = resumption.new_handle;
        return;
      }

      const goAway = pick('goAway', 'go_away');
      if (goAway) {
        // The server is about to hang up. Reconnect NOW, while the current
        // socket still works, so the gap is a handshake rather than a dropout.
        report('rotating');
        try { ws?.close(1000, 'rotate'); } catch { /* already gone */ }
        return;
      }

      const server = pick('serverContent', 'server_content');
      if (!server) return;

      if (server.interrupted) {
        // The model abandoned what it was saying. Anything already buffered on
        // our side is now wrong and must be dropped, not played.
        onAudio(null, { interrupted: true });
        return;
      }

      const inputText = server.inputTranscription || server.input_transcription;
      if (inputText?.text) {
        // The detected language of what was HEARD. There is no way to tell the
        // API which language to translate, so this is what the client filters
        // on when a video carries two conversations at once.
        onText({
          kind: 'source',
          text: inputText.text,
          lang: inputText.languageCode || inputText.language_code || '',
        });
      }
      const outputText = server.outputTranscription || server.output_transcription;
      if (outputText?.text) onText({ kind: 'target', text: outputText.text });

      const turn = server.modelTurn || server.model_turn;
      for (const part of turn?.parts || []) {
        const inline = part.inlineData || part.inline_data;
        if (!inline?.data) continue;
        const mime = inline.mimeType || inline.mime_type || 'audio/pcm;rate=24000';
        const rate = Number(/rate=(\d+)/.exec(mime)?.[1]) || 24000;
        onAudio(inline.data, { rate });
      }
      if (server.turnComplete || server.turn_complete) {
        inputSinceTurn = false;
        onText({ kind: 'turnEnd', text: '' });
        if (inputEnded && endSent && !pending.length) { clearTimeout(drainTimer); report('drained'); }
      }
    }

    function sendAudio(base64) {
      if (!ws || ws.readyState !== 1 || !ready) return false;
      try {
        ws.send(JSON.stringify({
          realtimeInput: { audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } },
        }));
        inputSinceTurn = true;
        return true;
      } catch {
        return false;
      }
    }

    return {
      start() {
        if (started) return;
        started = true;
        closed = false;
        reconnects = 0;
        resumeHandle = null;
        lastError = null;
        inputEnded = false; endSent = false; inputSinceTurn = false;
        model = config.model || config.availableModels?.[0] || TRANSLATE_MODEL;
        modelIndex = -1;
        keyIndex = 0;
        connect();
      },

      /**
       * Push one chunk of 16 kHz mono PCM16, base64-encoded.
       *
       * While the socket is down, a bounded amount is held back rather than
       * dropped — a reconnect takes a few hundred milliseconds and losing that
       * speech would cut a word in half. Exhausting the bound is a visible
       * failure; silently dropping accepted audio would hide missing speech.
       */
      push(base64) {
        if (closed || inputEnded) return;
        if (!sendAudio(base64)) {
          if (pending.length >= 40) {
            this.stop();
            lastError={code:'BUFFER_FULL',get error() { return globalThis.GXT.i18n.t("background_live_createSession_2"); }};report('error');return;
          }
          pending.push(base64);
        }
      },

      endInput() {
        if (closed || inputEnded) return;
        inputEnded = true;
        // This is a failure watchdog, never evidence of successful draining.
        drainTimer = setTimeout(() => { if (!closed) {lastError={code:'DRAIN_TIMEOUT',get error() { return globalThis.GXT.i18n.t("background_live_createSession_1"); }};report('error');} }, 60000);
        report('draining'); sendEnd();
      },

      stop() {
        if (!started && closed) return;
        started = false;
        closed = true;
        ready = false;
        pending.length = 0;
        clearTimeout(reconnectTimer);
        clearTimeout(drainTimer);
        reconnectTimer = null;
        const socket = ws;
        ws = null;
        try { socket?.close(1000, 'done'); } catch { /* already gone */ }
        report('stopped');
      },

      state: () => ({
        ready,
        model,
        reconnects,
        buffered: pending.length,
        resumable: !!resumeHandle,
        error: lastError,
      }),
    };
  }

  GXTBG.live = {
    createSession,
    TRANSLATE_MODEL,
    FALLBACK_MODELS,
    WS_URL,
    LANG_NAMES,
  };
})();
