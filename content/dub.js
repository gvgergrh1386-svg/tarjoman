/**
 * Persian dubbing engine (v2.4.5).
 *
 * Knows nothing about YouTube. It is handed a <video> plus either speech
 * segments or permission to listen, and it makes Persian come out of the
 * speakers at the right moment. YouTube and generic web-video players feed it.
 *
 * ── Two engines, deliberately kept side by side ─────────────────────────────
 *
 *   CAPTION  reads the translated subtitles aloud. Free, keyless, exactly
 *            synchronized to the cue timings, and cached so a rewatch costs
 *            nothing. Needs the video to have captions.
 *
 *   LIVE     streams the video's own AUDIO to Gemini Live and plays back the
 *            Persian it speaks. Needs no captions at all — which is the one
 *            thing the caption engine can never solve — and carries tone and
 *            emphasis across. Costs Live API quota and runs a few seconds
 *            behind, because it cannot translate what has not been said yet.
 *
 * Neither replaces the other. Caption is the default because it is free and
 * in sync; live is what you reach for when there is nothing to read.
 *
 * ── Why audio is scheduled and not just played ──────────────────────────────
 *
 * `new Audio().play()` returns whenever the browser gets round to it — tens of
 * milliseconds, unpredictably. Over a video that is a drifting, lip-flapping
 * mess. `AudioBufferSourceNode.start(t)` is scheduled on the audio hardware
 * clock and lands sample-accurately. Clips arrive as base64 over the message
 * channel and go through `decodeAudioData` / a raw PCM wrap, so no page CSP
 * can interfere — there is no URL for it to block.
 *
 * ── The hard problem: Persian is longer ─────────────────────────────────────
 *
 * A Persian translation runs 15–30% longer than its English source. v2.4.0
 * answered that by reading faster, and past about 1.3× that is audibly
 * gabbled — the single complaint this version exists to fix. The cascade is
 * now four steps, cheapest and most natural first:
 *
 *   1. SPILL into the silence after the line. Free, and the most natural
 *      thing a real dub does. The share of the gap used now scales with how
 *      much silence there actually is.
 *   2. SHORTEN the line — ask the model to say the same thing in fewer words.
 *      This is what a human dubbing writer does, it costs one small cached
 *      text call, and it only ever runs on the minority of lines that overrun.
 *   3. READ FASTER, and only up to a comfort ceiling (default 1.3).
 *   4. DROP the line rather than let the whole track slide.
 *
 * Choosing between 2 and 3 requires knowing how long the speech WILL be before
 * requesting it, so the engine keeps a running estimate of milliseconds per
 * character, calibrated from every clip it receives — per voice and engine by
 * construction.
 *
 * ── What is deliberately NOT done in caption mode ───────────────────────────
 *
 * The original audio is ducked with `video.volume`, NOT by routing the video
 * through a MediaElementSource. Routing it is one broken node graph away from
 * a permanently silent video that only a reload fixes — the same class of bug
 * as the v2.0.1 backdrop-filter incident. YouTube LIVE keeps its established
 * permanent full-gain passthrough. Generic web-video LIVE instead uses an
 * explicitly selected disposable captureStream/srcObject audio tap, and never
 * reroutes a potentially cross-origin media element.
 */
'use strict';
(() => {
  globalThis.GXT = globalThis.GXT || {};

  // Starting guess for Persian neural speech, refined from the first clip on.
  // ~16 characters per second is what fa-IR-DilaraNeural does at rate 1.
  const DEFAULT_MS_PER_CHAR = 62;
  // Rates are quantized to this step so the same line in the same slot asks
  // for the same rate on a rewatch — which means it hits the audio cache
  // instead of paying for synthesis again.
  const RATE_STEP = 0.05;
  // A line whose audio is not ready by this far past its start is abandoned.
  // Playing it late is worse than not playing it: it collides with the next.
  const LATE_MS = 600;
  // A ready line is handed to the audio clock this far ahead of its cue. Long
  // enough to be sample-accurate, short enough that a seek rarely has to
  // cancel anything.
  const SCHEDULE_LEAD_MS = 1500;
  // Starting a clip up to this far after its cue is still better than dropping
  // it — the loss is imperceptible.
  const GRACE_MS = 400;
  // However much silence follows a line, never begin the next one closer than
  // this to it. Spilling right up to the next speaker sounds like a collision.
  const SPILL_MARGIN_MS = 250;
  // Fade length for the original audio. Settable so the tests can make it
  // instant: timer throttling in a hidden tab makes a real fade unobservable.
  let rampMs = 180;

  // Live-mode audio plumbing.
  const LIVE_IN_RATE = 16000;   // what the Live API accepts
  const LIVE_OUT_RATE = 24000;  // what it returns
  const LIVE_CHUNK = 4096;      // ScriptProcessor frame; ~85 ms at 48 kHz
  // Jitter cushion before live speech starts. Network delivery is bursty; too
  // small and every burst gap becomes an audible click.
  const LIVE_JITTER_S = 0.18;

  // ------------------------------------------------- pure decision functions
  //
  // Everything genuinely tricky lives here: no DOM, no audio, no async. These
  // are unit-tested directly (the same approach as youtube.js's planBatch).

  /**
   * The speaking rate to request for one segment.
   *
   * @returns {number} 1 when it already fits, else a quantized rate ≥ 1
   */
  function pickRate({ chars, availableMs, msPerChar = DEFAULT_MS_PER_CHAR, maxRate = 2 }) {
    if (!chars || !Number.isFinite(availableMs) || availableMs <= 0) return 1;
    const estimated = chars * msPerChar;
    if (estimated <= availableMs) return 1;
    const raw = estimated / availableMs;
    // Round UP to the step: rounding down would leave it still too long, and
    // the whole point is to make it fit.
    const stepped = Math.ceil(raw / RATE_STEP) * RATE_STEP;
    return Math.min(maxRate, Math.max(1, Number(stepped.toFixed(2))));
  }

  /**
   * How much room a segment really has: its own window plus the silence that
   * follows it.
   *
   * The share of that silence scales with how much there is. A two-second
   * pause can absorb a long line with nobody noticing; a 300 ms breath cannot,
   * and eating it makes two speakers sound like they are interrupting each
   * other. Whatever the share works out to, `SPILL_MARGIN_MS` is always left
   * untouched in front of the next line.
   */
  function availableFor(segments, index, { tailMs = 6000 } = {}) {
    const segment = segments[index];
    if (!segment) return 0;
    const next = segments[index + 1];
    const own = Math.max(0, segment.end - segment.start);
    const gap = next ? Math.max(0, next.start - segment.end) : tailMs;
    const share = gap > 2000 ? 0.85 : gap > 800 ? 0.7 : 0.5;
    const usable = Math.min(gap * share, Math.max(0, gap - SPILL_MARGIN_MS));
    return own + usable;
  }

  /**
   * Decide how to make one line fit — the heart of v2.4.5.
   *
   * Returns the CHEAPEST acceptable action, in the order a human dubbing
   * writer would try them:
   *
   *   'speak'    it already fits; say it normally.
   *   'rush'     it overruns by so little that speeding up is inaudible.
   *   'compress' it overruns enough that speeding up would be heard — so
   *              rewrite it shorter instead, to `budgetChars`.
   *
   * `comfortRate` is where speeding up stops being free to the ear. Below it,
   * rushing is strictly better than compressing: it costs no call and loses no
   * words. Above it, the opposite is true, which is exactly the judgement
   * v2.4.0 got wrong by only ever having one tool.
   */
  function planFit({
    chars,
    availableMs,
    msPerChar = DEFAULT_MS_PER_CHAR,
    comfortRate = 1.12,
    maxRate = 1.3,
    canCompress = false,
  }) {
    if (!chars || !Number.isFinite(availableMs) || availableMs <= 0) {
      return { action: 'speak', rate: 1 };
    }
    const estimated = chars * msPerChar;
    if (estimated <= availableMs) return { action: 'speak', rate: 1 };

    const needed = estimated / availableMs;
    if (needed <= comfortRate) {
      return { action: 'rush', rate: pickRate({ chars, availableMs, msPerChar, maxRate }) };
    }
    if (canCompress) {
      // Aim for a length that fits at the COMFORT rate, not at rate 1: asking
      // for an impossibly short line makes the model drop meaning, and a
      // little speeding up is free anyway.
      const budgetChars = Math.max(8, Math.floor((availableMs * comfortRate) / msPerChar));
      return { action: 'compress', budgetChars, rate: pickRate({ chars, availableMs, msPerChar, maxRate }) };
    }
    return { action: 'rush', rate: pickRate({ chars, availableMs, msPerChar, maxRate }) };
  }

  /**
   * Which segments to synthesize right now.
   *
   * Ordered by start time — the next thing the viewer will hear is always the
   * most urgent thing to render, regardless of what else is pending.
   */
  function planSynthesis({
    segments, timeMs, aheadMs, ready, inFlight, missed, maxInFlight = 3, mode = 'live',
  }) {
    const budget = maxInFlight - inFlight.size;
    if (budget <= 0) return [];
    const horizon = mode === 'full' ? Infinity : timeMs + aheadMs;
    const out = [];
    for (let i = 0; i < segments.length && out.length < budget; i += 1) {
      const segment = segments[i];
      if (!segment.text) continue;
      if (ready.has(segment.id) || inFlight.has(segment.id)) continue;
      // A failed synthesis must not be retried on every animation frame.
      // Seeking back (or a fresh session) explicitly makes it eligible again.
      if (missed?.has(segment.id)) continue;
      // In live mode, anything already well behind the playhead will never be
      // heard — spending a request on it is pure waste.
      if (mode !== 'full' && segment.start < timeMs - LATE_MS) continue;
      if (segment.start > horizon) break; // segments are sorted; so are we done
      out.push(i);
    }
    return out;
  }

  /**
   * Which ready segments to hand to the audio clock, and which to abandon.
   *
   * `toDrop` is the honest half: a segment whose audio did not arrive in time
   * is marked as spent so it can never fire later, on top of the line after it.
   */
  function planSchedule({ segments, timeMs, ready, scheduled, spent, leadMs = SCHEDULE_LEAD_MS }) {
    const toSchedule = [];
    const toDrop = [];
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (spent.has(segment.id) || scheduled.has(segment.id)) continue;
      if (segment.start > timeMs + leadMs) break; // sorted
      if (segment.start < timeMs - GRACE_MS) {
        // Too late to start. Only report it as a real miss if we never had the
        // audio; if it is ready we simply seeked past it, which is not a fault.
        toDrop.push(i);
        continue;
      }
      if (ready.has(segment.id)) toSchedule.push(i);
      // Not ready and not yet late: leave it alone, its audio may still land.
    }
    return { toSchedule, toDrop };
  }

  /**
   * Fold one observed clip into the running characters-per-millisecond model.
   *
   * `durationMs` is the clip as rendered, so multiplying by the rate it was
   * rendered at recovers what it would have been at natural pace — which is
   * the only thing worth averaging.
   */
  function calibrate(current, { chars, durationMs, rate, samples }) {
    if (!chars || !durationMs) return current;
    const natural = (durationMs * (rate || 1)) / chars;
    // Ignore absurd values (a one-word line, a failed render) rather than let
    // them poison the estimate.
    if (natural < 20 || natural > 200) return current;
    // Weighted mean that settles quickly and then stops moving much.
    const weight = Math.min(samples, 12);
    return (current * weight + natural) / (weight + 1);
  }

  /**
   * Guess the language of a transcript line from its script (v2.4.6).
   *
   * The Live API has no source-language setting — it translates everything it
   * hears — so when a video carries two conversations at once (an anime
   * reaction: Japanese playing under an English commentator) both come back as
   * Persian, on top of each other. The only way to pick one is to work out
   * what was actually being spoken, and the API tells us that twice over: it
   * reports a `languageCode` on the input transcription, and failing that, the
   * transcript's own writing system is decisive.
   *
   * Script detection is not a general-purpose language identifier and does not
   * pretend to be. It only has to separate the handful of cases that actually
   * share a video, and for those it is exact rather than probabilistic.
   *
   * @param {string} text      the input transcript
   * @param {string} [reported] `languageCode` from the API, when present
   * @returns {string} a base language code, or '' when genuinely unknown
   */
  function detectSourceLang(text, reported) {
    if (reported) return String(reported).split(/[-_]/)[0].toLowerCase();
    const s = String(text || '');
    if (!s.trim()) return '';
    // Kana is unique to Japanese and settles the anime case outright. It has
    // to be tested before the CJK ideograph range, which Japanese also uses.
    if (/[぀-ゟ゠-ヿ]/.test(s)) return 'ja';
    if (/[가-힯ᄀ-ᇿ]/.test(s)) return 'ko';
    if (/[฀-๿]/.test(s)) return 'th';
    if (/[ऀ-ॿ]/.test(s)) return 'hi';
    if (/[֐-׿]/.test(s)) return 'he';
    // Persian-only letters distinguish Persian from the Arabic that shares its
    // script; without one of them, Arabic is the safer read.
    if (/[پچژگی]/.test(s)) return 'fa';
    if (/[؀-ۿ]/.test(s)) return 'ar';
    if (/[Ѐ-ӿ]/.test(s)) return 'ru';
    if (/[一-鿿]/.test(s)) return 'zh'; // ideographs with no kana
    if (/[a-z]/i.test(s)) return 'en';
    return '';
  }

  /** How many recent readings vote on what is being spoken. */
  const LANG_VOTES = 5;

  /**
   * The language a stream is in, decided by majority over recent readings.
   *
   * A single transcript fragment is not reliable enough to switch on. Japanese
   * written entirely in kanji — «日本語» itself is three of them — carries no
   * kana and therefore reads as Chinese; a filter that flipped on that one
   * fragment would start discarding the very soundtrack the viewer asked for.
   * Real speech produces a steady stream of fragments, so the majority over
   * the last few is both stable and quick to follow a genuine speaker change.
   *
   * @param {string[]} history most recent first
   * @returns {string} the winner, or '' when there is nothing to go on
   */
  function dominantLang(history) {
    const tally = new Map();
    for (const lang of history) {
      if (!lang) continue;
      tally.set(lang, (tally.get(lang) || 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [lang, count] of tally) {
      if (count > bestCount) { best = lang; bestCount = count; }
    }
    return best;
  }

  /** Push a reading onto the bounded history (most recent first). */
  function rememberLang(history, detected) {
    if (!detected) return history;
    return [detected, ...history].slice(0, LANG_VOTES);
  }

  /**
   * Should audio whose source was `detected` be spoken, given the filter?
   *
   * FAILS OPEN by design. A filter that goes silent because a field was
   * missing is worse than no filter at all: the viewer hears nothing, has no
   * idea why, and nothing in the interface explains it. When the source is
   * genuinely unknown, speak.
   *
   * @returns {boolean}
   */
  function matchesSource(detected, want) {
    if (!want) return true;      // no filter set
    if (!detected) return true;  // unknown ⇒ fail open
    return detected === want;
  }

  /**
   * Resample mono Float32 audio to `outRate`, linearly.
   *
   * Speech at 16 kHz through a linear interpolator is indistinguishable from
   * anything fancier, and this runs on the audio thread's budget.
   */
  function resample(input, inRate, outRate) {
    if (inRate === outRate) return input;
    const ratio = inRate / outRate;
    const length = Math.floor(input.length / ratio);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const at = i * ratio;
      const low = Math.floor(at);
      const high = Math.min(low + 1, input.length - 1);
      const frac = at - low;
      out[i] = input[low] * (1 - frac) + input[high] * frac;
    }
    return out;
  }

  /** Float32 [-1,1] → little-endian PCM16, base64. What the Live API wants. */
  function floatToPcm16Base64(samples) {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i += 1) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  /** base64 PCM16 → Float32, for playback. */
  function pcm16Base64ToFloat(base64) {
    const binary = atob(base64);
    const count = binary.length >> 1;
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const lo = binary.charCodeAt(i * 2);
      const hi = binary.charCodeAt(i * 2 + 1);
      let value = (hi << 8) | lo;
      if (value >= 0x8000) value -= 0x10000;
      out[i] = value / 0x8000;
    }
    return out;
  }

  // ---------------------------------------------------------------- engine

  /** Swappable for tests, which have no audio hardware. */
  let contextFactory = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)();

  /**
   * @param {{video: HTMLVideoElement, send: Function, settings: object,
   *          connectLive?: Function, onState?: Function, onLiveText?: Function,
   *          captureMode?: 'stream'}} config
   */
  function create(config) {
    const { video, send } = config;
    // Arbitrary websites must never permanently reroute a media element: a
    // cross-origin MediaElementSource can succeed while producing only silence.
    const streamCapture = config.captureMode === 'stream';
    let settings = config.settings || {};
    const speechKey = (s) => JSON.stringify([
      globalThis.GXT.resolveTts?.(s) || [s.ttsEngine, s.ttsVoiceBing, s.ttsVoiceGemini,
        s.ttsVoiceOpenai, s.ttsModelGemini, s.ttsModelOpenai, s.ttsRate, s.ttsStyle],
      s.openaiBaseUrl, s.bridgePort, s.ytTargetLang, s.targetLang, s.ytDubCompress, s.ytDubMaxRate, s.ytDubComfortRate,
      config.canCompress ? globalThis.GXT.cacheNamespace?.(s) : null,
    ]);
    let synthesisKey = speechKey(settings);
    const liveKey = (s) => JSON.stringify([s.ytLiveModel, s.ytLiveSourceLang,streamCapture?s.targetLang:s.ytTargetLang]);
    let liveSettingsKey = liveKey(settings);
    const onState = config.onState || (() => {});
    const onLiveText = config.onLiveText || (() => {});
    const connectLive = config.connectLive || null;

    let ctx = null;
    let gain = null;
    let segments = [];
    const ready = new Map();      // id -> { buffer, rate, compressed }
    const inFlight = new Set();
    const scheduled = new Map();  // id -> { source, at }
    const spent = new Set();
    const missed = new Set();
    let msPerChar = DEFAULT_MS_PER_CHAR;
    let calibrations = 0;
    let compressions = 0;
    let rushes = 0;
    let gen = 0;                  // bumped on stop / new video: retires callbacks
    let running = false;
    let disposed = false;
    let lastError = null;
    let mode = 'caption';
    let draining = false;
    let upstreamPending = false;
    let liveDrained = false;
    let drainFrom = 0;
    let playbackFrom = 0;
    let drainCursor = 0;
    const drainIds = new Set();
    let lastPlayhead = video.currentTime * 1000;

    // -- ducking ------------------------------------------------------------
    let baseVolume = 1;
    let ducked = false;
    let expectedVolume = -1;
    let rampTimer = 0;
    let rampEpoch = 0;
    let duckWatch = 0;
    let watchEpoch = 0;
    let userVolumeOverride = false;
    let speaking = 0;
    /** Have we written video.volume at all? Drives the unconditional restore. */
    let touchedVolume = false;

    const duckLevel = () => {
      const raw = Number(mode === 'live' ? settings.ytLiveDuck : settings.ytDubDuck);
      const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 12;
      return pct / 100;
    };

    function setVolume(value) {
      const v = Math.max(0, Math.min(1, value));
      expectedVolume = v;
      touchedVolume = true;
      try { video.volume = v; } catch { /* detached element */ }
    }

    /**
     * Fade the original audio towards `target`.
     *
     * Driven by ELAPSED TIME, not by a step count. Timers are throttled to
     * roughly once a second in a background tab — and a YouTube tab keeps
     * playing audio in the background — so a step-counted ramp would take
     * twelve seconds to arrive there, or stall part-way. Interpolating on the
     * clock means even a single late tick lands exactly on the target.
     */
    function rampTo(target) {
      clearInterval(rampTimer);
      rampTimer = 0;
      const epoch = ++rampEpoch;
      if (rampMs <= 0 || target === 0) { setVolume(target); return; }
      const from = video.volume;
      const startedAt = Date.now();
      rampTimer = setInterval(() => {
        // A timer already queued before cancellation can still run. It must
        // not write into another session, even after an A → B → A switch.
        if (epoch !== rampEpoch || !running || !ducked) return;
        if (!hasAudibleSpeech()) { refreshDucking(); return; }
        const progress = Math.min(1, (Date.now() - startedAt) / rampMs);
        setVolume(from + (target - from) * progress);
        if (progress >= 1) { clearInterval(rampTimer); rampTimer = 0; }
      }, 15);
    }

    function releaseVolume() {
      ++rampEpoch;
      clearInterval(rampTimer);
      rampTimer = 0;
      ducked = false;
      if (touchedVolume) {
        // volumechange is queued by a real media element. A user can move the
        // slider and stop before that event is delivered; their value still wins.
        if (Math.abs(video.volume - expectedVolume) >= 0.005) {
          baseVolume = video.volume;
          expectedVolume = video.volume;
          syncOutputVolume();
        } else setVolume(baseVolume);
      }
      touchedVolume = false;
    }

    function hasAudibleSpeech() {
      if (!running || (!draining && (video.paused || video.seeking || video.ended)) || !ctx || ctx.state !== 'running') return false;
      const now = ctx.currentTime;
      const entries = mode === 'live' ? liveTimes.values() : scheduled.values();
      for (const entry of entries) if (entry.at <= now && now < entry.end) return true;
      return false;
    }

    function refreshDucking(force = false) {
      const audible = hasAudibleSpeech();
      const silentOriginal = running && duckLevel() === 0;
      if (!audible) userVolumeOverride = false;
      if (liveOriginalGain) liveOriginalGain.gain.value = mode === 'live' && (audible || silentOriginal) ? duckLevel() : 1;
      if ((silentOriginal || audible) && (mode !== 'live' || streamCapture) && (!userVolumeOverride || silentOriginal)) {
        if (!ducked || force) { ducked = true; rampTo(baseVolume * duckLevel()); }
      } else releaseVolume();
      if (!scheduled.size && !liveSources.size) {
        ++watchEpoch;
        clearInterval(duckWatch);
        duckWatch = 0;
      }
    }

    function watchDucking() {
      if (!duckWatch) {
        const epoch = ++watchEpoch;
        duckWatch = setInterval(() => {
          if (epoch !== watchEpoch) return;
          refreshDucking();
        }, 30);
      }
      refreshDucking();
    }

    /** A manual slider change wins over a pending fade. Keep the actual value
     *  selected, including at zero duck, rather than guessing by division. */
    function onVolumeChange() {
      syncOutputVolume();
      if (Math.abs(video.volume - expectedVolume) < 0.005) return; // our own write
      ++rampEpoch;
      clearInterval(rampTimer);
      rampTimer = 0;
      baseVolume = video.volume;
      expectedVolume = video.volume;
      userVolumeOverride = hasAudibleSpeech();
      touchedVolume = false;
      ducked = false;
      syncOutputVolume();
      if (running && duckLevel() === 0) refreshDucking(true);
    }

    function syncOutputVolume() {
      const level = video.muted ? 0 : baseVolume;
      if (gain) gain.gain.value = level;
      if (liveOutGain) liveOutGain.gain.value = level;
    }

    // -- audio --------------------------------------------------------------

    let resumeHooked = false;
    let resumeWake = null;

    function audio() {
      if (!ctx) {
        ctx = contextFactory();
        gain = ctx.createGain();
        gain.gain.value = video.muted ? 0 : baseVolume;
        gain.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') {
        void ctx.resume?.()?.catch?.(() => {});
        // Autoplay policy: a context created outside a user gesture stays
        // suspended and every scheduled clip is silently dropped. This is the
        // real path when dubbing rides YouTube auto-start, where nothing was
        // clicked. Arm a one-shot resume on the next interaction anywhere, and
        // tell the host so it can say so instead of appearing broken.
        if (!resumeHooked) {
          resumeHooked = true;
          const wake = () => {
            resumeHooked = false;
            resumeWake = null;
            document.removeEventListener('pointerdown', wake, true);
            document.removeEventListener('keydown', wake, true);
            // A live MediaElementSource remains the video's only audio path
            // even after stop. Its passthrough must still be allowed to wake.
            if (running || liveSource) void ctx.resume?.()?.then?.(report, () => {});
          };
          resumeWake = wake;
          document.addEventListener('pointerdown', wake, true);
          document.addEventListener('keydown', wake, true);
        }
      }
      return ctx;
    }

    const suspended = () => !!ctx && ctx.state === 'suspended';

    function base64ToBuffer(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }

    // -- caption engine -----------------------------------------------------

    async function synthesize(index) {
      const segment = segments[index];
      if (!segment) return;
      const myGen = gen;
      inFlight.add(segment.id);
      try {
        const available = availableFor(segments, index);
        const maxRate = Math.max(1, Number(settings.ytDubMaxRate) || 1.3);
        const comfortRate = Math.max(1, Number(settings.ytDubComfortRate) || 1.12);
        // Compression needs a model that can rewrite; the keyless machine
        // translators cannot, and the host says so via canCompress.
        const canCompress = settings.ytDubCompress !== false && !!config.canCompress;

        let text = segment.text;
        let plan = planFit({
          chars: text.length, availableMs: available, msPerChar, comfortRate, maxRate, canCompress,
        });

        if (plan.action === 'compress') {
          const shorter = await send({ type: 'DUB_COMPRESS', text, budget: plan.budgetChars, targetLang:streamCapture?settings.targetLang:settings.ytTargetLang });
          if (myGen !== gen) return;
          if (shorter?.ok && typeof shorter.t === 'string' && shorter.t.trim()) {
            const candidate = shorter.t.trim();
            // Only accept a rewrite that actually helped. A model that returns
            // something LONGER has not compressed anything, and using it would
            // make the very problem worse.
            if (candidate.length < text.length) {
              text = candidate;
              compressions += 1;
            }
          }
          // Re-plan on the real new length, with compression off so this can
          // never loop.
          plan = planFit({
            chars: text.length, availableMs: available, msPerChar, comfortRate, maxRate,
            canCompress: false,
          });
        }
        if (plan.rate > 1) rushes += 1;

        const response = await send({
          type: 'TTS_SPEAK',
          text,
          // Rate 1 is the default; omitting it keeps the cache key identical to
          // a plain read-aloud of the same line, so the two share cached audio.
          ...(plan.rate > 1 ? { rate: plan.rate } : {}),
        });
        if (myGen !== gen) return;
        if (!response?.ok) {
          lastError = response;
          missed.add(segment.id);
          return;
        }
        const buffer = await audio().decodeAudioData(base64ToBuffer(response.data));
        if (myGen !== gen) return;
        msPerChar = calibrate(msPerChar, {
          chars: text.length,
          durationMs: buffer.duration * 1000,
          rate: plan.rate,
          samples: calibrations,
        });
        calibrations += 1;
        ready.set(segment.id, { buffer, rate: plan.rate });
      } catch (error) {
        if (myGen === gen) { lastError = { error: String(error?.message || error) }; missed.add(segment.id); }
      } finally {
        if (myGen === gen) inFlight.delete(segment.id);
        if (myGen === gen && draining) pumpDrain();
        report();
      }
    }

    function scheduleSegment(index, timeMs) {
      const segment = segments[index];
      const entry = ready.get(segment.id);
      if (!entry) return;
      const context = audio();
      const playbackRate = video.playbackRate || 1;
      const source = context.createBufferSource();
      source.buffer = entry.buffer;
      // Match the video's speed, or a viewer watching at 1.5× hears the dub
      // fall a sentence behind within a minute.
      source.playbackRate.value = playbackRate;
      source.connect(gain);
      const delay = Math.max(0, (segment.start - timeMs) / 1000 / playbackRate);
      const at = draining ? Math.max(context.currentTime, drainCursor) : context.currentTime + delay;
      const scheduledEntry = { source, at, end: at + entry.buffer.duration / playbackRate };
      if (draining) drainCursor = scheduledEntry.end;
      source.onended = () => {
        if (scheduled.get(segment.id) !== scheduledEntry) return;
        speaking = Math.max(0, speaking - 1);
        scheduled.delete(segment.id);
        source.disconnect?.();
        refreshDucking();
        if (draining) pumpDrain();
        report();
      };
      try {
        source.start(at);
      } catch {
        source.disconnect?.();
        return;
      }
      speaking += 1;
      scheduled.set(segment.id, scheduledEntry);
      spent.add(segment.id);
      watchDucking();
    }

    /** Cancel everything queued but not yet audible. Used on seek, pause and
     *  stop — anything that invalidates the mapping from media time to now. */
    function cancelScheduled({ keepPlaying = false } = {}) {
      const now = ctx ? ctx.currentTime : 0;
      for (const [id, entry] of [...scheduled]) {
        if (keepPlaying && entry.at <= now) continue;
        try { entry.source.onended = null; entry.source.stop(); } catch { /* already done */ }
        try { entry.source.disconnect?.(); } catch { /* detached */ }
        scheduled.delete(id);
        // A cancelled-before-it-played segment becomes eligible again: after a
        // seek backwards the viewer expects to hear that line once more.
        if (entry.at > now) spent.delete(id);
        speaking = Math.max(0, speaking - 1);
      }
      if (!keepPlaying) speaking = 0;
      refreshDucking();
    }

    // -- live engine --------------------------------------------------------

    let livePort = null;
    let liveSource = null;      // MediaElementAudioSourceNode (created once, ever)
    let liveTap = null;         // ScriptProcessorNode
    let liveTapMute = null;
    let captureSource = null;   // Disposable MediaStreamAudioSource (web video)
    let captureTracks = [];
    let captureListeners = [];
    let captureEpoch = 0;
    let pendingCapture = null;
    let captureWaitTimer = null;
    let captureReadyListener = null;

    function clearCaptureWait(stop = true) {
      clearTimeout(captureWaitTimer); captureWaitTimer = null;
      if (pendingCapture && captureReadyListener) pendingCapture.removeEventListener?.('addtrack', captureReadyListener);
      if (stop) for (const track of pendingCapture?.getTracks?.() || []) { try { track.stop(); } catch {} }
      pendingCapture = null; captureReadyListener = null;
    }
    let liveOriginalGain = null;
    let liveOutGain = null;
    let liveNextTime = 0;
    let liveState = 'idle';
    let liveHeard = 0;          // chunks sent
    let liveSpoken = 0;         // chunks played
    let liveFiltered = 0;       // chunks dropped for being the wrong language
    let liveSourceLang = '';    // the language currently being spoken (voted)
    let liveSourceAt = 0;
    let liveLangHistory = [];   // recent readings, most recent first

    /**
     * Is the speech currently arriving in the language the viewer picked?
     *
     * The detected language is only trusted while it is FRESH. A stale reading
     * would keep filtering long after the speaker changed, which in a video
     * that alternates between two languages is exactly the wrong behaviour.
     */
    function sourceWanted() {
      const want = String(settings.ytLiveSourceLang || '');
      if (!want) return true;
      if (!liveSourceLang || Date.now() - liveSourceAt > 6000) return true; // fail open
      return matchesSource(liveSourceLang, want);
    }
    const liveSources = new Set();
    const liveTimes = new Map();

    function releaseLiveTap() {
      ++captureEpoch;
      clearCaptureWait();
      if (liveTap) {
        liveTap.onaudioprocess = null;
        try { (captureSource || liveSource)?.disconnect(liveTap); } catch { /* no connection */ }
        try { liveTap.disconnect(); } catch { /* detached */ }
      }
      try { liveTapMute?.disconnect(); } catch { /* detached */ }
      try { captureSource?.disconnect(); } catch { /* detached */ }
      for (const [track, listener] of captureListeners) {
        track.removeEventListener?.('mute', listener);
        track.removeEventListener?.('ended', listener);
      }
      for (const track of captureTracks) { try { track.stop(); } catch { /* ended */ } }
      captureTracks = [];
      captureListeners = [];
      captureSource = null;
      liveTap = null;
      liveTapMute = null;
    }

    function captureReadableAudio(context) {
      let captured = null;
      let freshCapture = false;
      try {
        if (video.srcObject?.getAudioTracks) captured = video.srcObject;
        else {
          const capture = video.captureStream || video.mozCaptureStream;
          if (typeof capture !== 'function') throw new Error(globalThis.GXT.i18n.t("content_dub_captureReadableAudio_3"));
          captured = pendingCapture || capture.call(video);
          freshCapture = true;
        }
        const tracks = captured?.getAudioTracks?.() || [];
        // captureStream may return before Chrome creates its audio track.
        // Bind to the stream lifecycle; do not pause the video or recapture in
        // a loop. Only a real track starts a provider session.
        if (!tracks.length && freshCapture && captured?.addEventListener) {
          if (!pendingCapture) {
            pendingCapture = captured;
            captureReadyListener = () => { if (running && !livePort && !draining) startLive(); };
            captured.addEventListener('addtrack', captureReadyListener);
            const epoch = captureEpoch;
            captureWaitTimer = setTimeout(() => {
              if (epoch === captureEpoch && running && pendingCapture) failLive({code:'CAPTURE_UNAVAILABLE',get error() { return globalThis.GXT.i18n.t("content_dub_captureReadableAudio_2"); }});
            }, 8000);
          }
          liveState = 'capturing'; report();
          freshCapture = false; // retained until addtrack or teardown
          return false;
        }
        if (!tracks.length || tracks.some(track => track.readyState !== 'live' || track.muted || track.enabled === false)) {
          throw new Error(globalThis.GXT.i18n.t("content_dub_captureReadableAudio_1"));
        }
        // Never stop the page's own srcObject tracks. A captureStream result
        // is ours, but cloning also gives both paths the same cleanup rules.
        for (const track of tracks) captureTracks.push(track.clone());
        clearCaptureWait(false);
        captureSource = context.createMediaStreamSource(new MediaStream(captureTracks));
        const epoch = captureEpoch;
        for (const track of captureTracks) {
          const unavailable = event => {
            if (epoch !== captureEpoch || !running || mode !== 'live') return;
            if (video.ended) { beginDrain(); return; }
            if (event?.type === 'mute' && (video.paused || video.seeking || video.ended)) return;
            failLive({ code: 'CAPTURE_UNAVAILABLE', get error() { return globalThis.GXT.i18n.t("content_dub_unavailable_1"); } });
          };
          track.addEventListener?.('mute', unavailable);
          track.addEventListener?.('ended', unavailable);
          captureListeners.push([track, unavailable]);
        }
        return true;
      } finally {
        // captureStream also returns video tracks we do not consume.
        if (freshCapture) for (const track of captured?.getTracks?.() || []) {
          try { track.stop(); } catch { /* already ended */ }
        }
      }
    }

    /**
     * Build the live audio graph.
     *
     * The default YouTube path retains its permanent Web Audio routing. The
     * explicit stream path reads a clone and leaves native playback alone.
     * Two safeguards protect the permanent path —
     *
     *   • the tap is taken BEFORE the level control, so the model always hears
     *     the video at full volume no matter how far down the viewer's copy is;
     *   • `liveOriginalGain` is never disconnected, only turned back up, so the
     *     video keeps playing through the graph forever after. A
     *     MediaElementSource cannot be undone, and a disconnected one is a
     *     silent video that only a reload fixes.
     */
    function buildLiveGraph() {
      const context = audio();
      if (streamCapture) {
        if (!captureSource && !captureReadableAudio(context)) return false;
      } else if (!liveSource) {
        liveOriginalGain = context.createGain();
        liveSource = context.createMediaElementSource(video);
        liveSource.connect(liveOriginalGain);
        liveOriginalGain.connect(context.destination);
      }
      if (!liveOutGain) {
        liveOutGain = context.createGain();
        liveOutGain.gain.value = video.muted ? 0 : baseVolume;
        liveOutGain.connect(context.destination);
      }
      if (!liveTap) {
        // ScriptProcessorNode is deprecated in favour of AudioWorklet, but a
        // worklet must be loaded as a module from an extension URL into the
        // PAGE's context, which YouTube's CSP is entitled to refuse. A dropped
        // frame here is a click; a blocked worklet is no dubbing at all.
        liveTap = context.createScriptProcessor(LIVE_CHUNK, 1, 1);
        const tap = liveTap;
        const epoch = captureEpoch;
        liveTap.onaudioprocess = (event) => {
          if (epoch !== captureEpoch || liveTap !== tap || !running || mode !== 'live' || !livePort || video.paused || video.seeking || video.ended) return;
          if (streamCapture && captureTracks.some(track => track.muted || track.readyState !== 'live' || track.enabled === false)) return;
          const input = event.inputBuffer.getChannelData(0);
          const down = resample(input, context.sampleRate, LIVE_IN_RATE);
          try {
            livePort.postMessage({ t: 'audio', data: floatToPcm16Base64(down) });
            liveHeard += 1;
          } catch { /* a disconnected port is cleaned up by its listener */ }
        };
        (captureSource || liveSource).connect(liveTap);
        // A ScriptProcessor only runs while connected to the destination, but
        // its own output must be silent — this is a tap, not a passthrough.
        liveTapMute = context.createGain();
        liveTapMute.gain.value = 0;
        liveTap.connect(liveTapMute);
        liveTapMute.connect(context.destination);
      }
      // The viewer's own volume slider stays meaningful; the level we control
      // is the gain node, which sits after the tap.
      refreshDucking();
      return true;
    }

    function playLiveChunk(base64, rate) {
      const context = audio();
      const samples = pcm16Base64ToFloat(base64);
      if (!samples.length) return;
      const buffer = context.createBuffer(1, samples.length, rate || LIVE_OUT_RATE);
      buffer.getChannelData(0).set(samples);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(liveOutGain || gain);
      // Chunks are played back to back on a cursor rather than "now": network
      // delivery is bursty, and starting each one on arrival would put a gap
      // between every pair.
      const earliest = context.currentTime + LIVE_JITTER_S;
      const at = Math.max(earliest, liveNextTime);
      try { source.start(at); } catch { source.disconnect?.(); return; }
      liveNextTime = at + buffer.duration;
      liveSources.add(source);
      liveTimes.set(source, { at, end: liveNextTime });
      source.onended = () => {
        if (!liveSources.delete(source)) return;
        liveTimes.delete(source);
        source.disconnect?.();
        refreshDucking();
        finishLiveDrain();
      };
      liveSpoken += 1;
      watchDucking();
    }

    function flushLive() {
      for (const source of [...liveSources]) {
        try { source.onended = null; source.stop(); } catch { /* done */ }
        try { source.disconnect?.(); } catch { /* detached */ }
      }
      liveSources.clear();
      liveTimes.clear();
      liveNextTime = 0;
      refreshDucking();
    }

    function failLive(error, state = 'error') {
      api.stop();
      lastError = error;
      liveState = state;
      report();
    }

    function startLive() {
      if (livePort || draining) return;
      if (video.paused || video.seeking || video.ended) {
        liveState = 'paused';
        refreshDucking();
        report();
        return;
      }
      if (!connectLive) {
        failLive({ code: 'NO_PORT', get error() { return globalThis.GXT.i18n.t("content_dub_startLive_2"); } });
        return;
      }
      try {
        if (!buildLiveGraph()) return;
      } catch (error) {
        failLive({ code: streamCapture ? 'CAPTURE_UNAVAILABLE' : 'TAP_FAILED', get error() { return globalThis.GXT.i18n.t("content_dub_startLive_1", {v0:(error?.message || error)}); } });
        return;
      }
      try {
        livePort = connectLive();
      } catch (error) {
        failLive({ code: 'NO_PORT', error: String(error?.message || error) });
        return;
      }
      const port = livePort;
      liveState = 'connecting';
      port.onMessage.addListener((message) => {
        if (!running || mode !== 'live' || livePort !== port) return;
        if (message?.t === 'audio') {
          if (message.interrupted || !message.data) { flushLive(); return; }
          if (!draining && (video.paused || video.seeking || video.ended)) return;
          // Speech in a language the viewer did not ask for is dropped here
          // rather than played over the language they did. The decision uses
          // the most recent input transcription, which in continuous
          // translation arrives just ahead of the audio it describes.
          if (!sourceWanted()) { liveFiltered += 1; report(); return; }
          try { playLiveChunk(message.data, message.rate); }
          catch (error) { failLive({ code: 'AUDIO_INVALID', error: String(error?.message || error) }); }
          return;
        }
        if (message?.t === 'text') {
          if (!draining && (video.paused || video.seeking || video.ended)) return;
          if (message.kind === 'source') {
            const detected = detectSourceLang(message.text, message.lang);
            if (detected) {
              // Majority over the last few readings, not the latest one: a
              // kanji-only Japanese fragment reads as Chinese, and switching
              // on it would discard the soundtrack the viewer picked.
              liveLangHistory = rememberLang(liveLangHistory, detected);
              liveSourceLang = dominantLang(liveLangHistory);
              liveSourceAt = Date.now();
            }
          }
          onLiveText(message);
          return;
        }
        if (message?.t === 'state') {
          if (message.state === 'drained') { liveDrained = true; finishLiveDrain(); return; }
          liveState = message.state;
          if (message.error) lastError = message.error;
          // A reconnect means the old stream is finished; anything still
          // queued belongs to a session that no longer exists.
          if (message.state === 'reconnecting' || message.state === 'rotating') flushLive();
          if (message.state === 'error' || message.state === 'stopped') {
            failLive(message.error || null, message.state);
            return;
          }
          refreshDucking();
          report();
        }
      });
      port.onDisconnect?.addListener?.(() => {
        if (livePort !== port) return;
        livePort = null;
        failLive(null, 'stopped');
      });
      try { port.postMessage(streamCapture ? {
        t: 'start', model: settings.ytLiveModel || '', sourceLang: settings.ytLiveSourceLang || 'auto',
      } : { t: 'start' }); }
      catch (error) {
        failLive({ code: 'NO_PORT', error: String(error?.message || error) });
      }
      report();
    }

    function stopLive() {
      flushLive();
      releaseLiveTap();
      const port = livePort;
      livePort = null;
      try { port?.postMessage({ t: 'stop' }); } catch { /* gone */ }
      try { port?.disconnect?.(); } catch { /* gone */ }
      liveState = 'idle';
      liveSourceLang = '';
      liveSourceAt = 0;
      liveLangHistory = [];
      // Hand the video's audio back. The graph itself stays — it cannot be
      // taken apart — but at gain 1 it is indistinguishable from no graph.
      if (liveOriginalGain) liveOriginalGain.gain.value = running && duckLevel() === 0 ? 0 : 1;
    }

    function finishLiveDrain() {
      if (!draining || mode !== 'live' || !liveDrained || liveSources.size) return;
      api.stop(); liveState = 'completed'; report();
    }

    function pumpDrain() {
      if (!running || !draining || mode !== 'caption') return;
      // Drain in source order, including synthesis/translation that was
      // accepted before EOF. A later ready clip cannot overtake an earlier one.
      const remaining = segments.map((s,i)=>({s,i})).filter(({s})=>s.end >= playbackFrom && (s.end >= drainFrom || drainIds.has(s.id)) && !spent.has(s.id) && !missed.has(s.id));
      for (const {s,i} of remaining) {
        if (!ready.has(s.id)) { if (!inFlight.has(s.id)) void synthesize(i); return; }
        scheduleSegment(i, video.currentTime * 1000);
      }
      if (!upstreamPending && !inFlight.size && !scheduled.size) { api.stop(); liveState='completed'; report(); }
    }

    function beginDrain() {
      if (!running || draining) return;
      draining = true; liveDrained = false; drainFrom = Math.max(0,lastPlayhead-GRACE_MS);
      drainIds.clear();for(const id of inFlight) {drainIds.add(id);spent.delete(id);missed.delete(id);}
      drainCursor = Math.max(ctx?.currentTime || 0, ...[...scheduled.values()].map(x=>x.end));
      if (mode === 'live') {
        // Freeze input only. All accepted server and playback work keeps its
        // owner until the protocol completion AND the audio queue are empty.
        releaseLiveTap(); liveState = 'draining';
        if (livePort) { try { livePort.postMessage({t:'end'}); } catch (e) { failLive({code:'DRAIN_FAILED',error:String(e)}); } }
        else { liveDrained=true; finishLiveDrain(); }
      } else pumpDrain();
      report();
    }

    // Playback belongs to the audio engine too: a captionless live session
    // has no caption loop to cancel its queued speech on a pause or seek.
    function mediaChanged(event) {
      if (!running) return;
      if ((event?.type === 'pause' && video.ended) || event?.type === 'ended') { beginDrain(); return; }
      if (draining && ['seeking','playing','pause'].includes(event?.type)) {
        draining = false; liveDrained = false;
        if (mode === 'live') stopLive(); else cancelScheduled();
      }
      if (event?.type === 'playing') {
        if (mode === 'live' && liveState === 'paused') { startLive(); return; }
        // A capture may naturally mute during a pause. Give the track time to
        // unmute on resume, then fail visibly instead of charging for silence.
        if (streamCapture && mode === 'live') {
          const epoch = captureEpoch;
          setTimeout(() => {
            if (epoch !== captureEpoch || !running || video.paused || video.seeking || video.ended) return;
            if (captureTracks.some(track => track.muted || track.readyState !== 'live' || track.enabled === false)) {
              failLive({ code: 'CAPTURE_UNAVAILABLE', get error() { return globalThis.GXT.i18n.t("content_dub_mediaChanged_1"); } });
            }
          }, 500);
        }
        refreshDucking();
        return;
      }
      if (mode === 'live') {
        if (event?.type === 'pause') {
          // Retire the server session as well as queued local buffers. Output
          // generated before this pause must not play after a later resume.
          stopLive();
          liveState = 'paused';
          report();
          return;
        }
        flushLive();
        // A new position requires a new server session, otherwise late output
        // from the old position can arrive after the local queue was cleared.
        if (event?.type === 'seeking') { stopLive(); liveState='seeking'; }
        if (event?.type === 'seeked') { stopLive(); startLive(); }
      } else {
        cancelScheduled();
        if (event?.type === 'seeking') {
          // Synthesis and delayed translations from before this position no
          // longer own playback, including if EOF follows immediately.
          gen += 1; inFlight.clear(); drainIds.clear();
          playbackFrom = Math.max(0,video.currentTime*1000-GRACE_MS);
        }
        if (event?.type === 'seeking' || event?.type === 'seeked') rearmFromPlayhead();
      }
    }

    function rearmFromPlayhead() {
      const from = video.currentTime * 1000 - GRACE_MS;
      for (const segment of segments) {
        if (segment.start < from) continue;
        spent.delete(segment.id);
        missed.delete(segment.id);
      }
    }

    const mediaEvents = ['pause', 'seeking', 'seeked', 'ratechange', 'ended', 'playing'];

    function report() {
      onState(stats());
    }

    function stats() {
      return {
        running,
        draining,
        mode,
        ready: ready.size,
        pending: inFlight.size,
        total: segments.length,
        missed: missed.size,
        speaking,
        compressions,
        rushes,
        msPerChar: Math.round(msPerChar),
        suspended: suspended(),
        live: {
          state: liveState,
          heard: liveHeard,
          spoken: liveSpoken,
          filtered: liveFiltered,
          sourceLang: liveSourceLang,
        },
        error: lastError,
      };
    }

    // -- the tick -----------------------------------------------------------

    /**
     * Called from the host's own animation/timeupdate loop. Cheap enough to
     * run every frame: the two planners are linear scans over a sorted list
     * that break as soon as they pass the horizon.
     */
    function update() {
      if (!running) return;
      if (video.ended) beginDrain();
      if (draining) { if (mode === 'caption') pumpDrain(); else finishLiveDrain(); return; }
      lastPlayhead = video.currentTime * 1000;
      refreshDucking();
      if (mode === 'live') {
        // Live playback follows the socket, not the playhead. The only thing
        // the tick owes it is silence while the picture is still — the tap
        // already stops sending, so anything still queued is stale.
        if ((video.paused || video.seeking || video.ended) && liveSources.size) flushLive();
        return;
      }
      if (!segments.length) return;
      const timeMs = video.currentTime * 1000;
      const paused = video.paused;

      if (paused) {
        // Nothing may be audible while the picture is still. Synthesis keeps
        // going, though — a paused viewer is a chance to get ahead.
        cancelScheduled();
      } else {
        const { toSchedule, toDrop } = planSchedule({ segments, timeMs, ready, scheduled, spent });
        for (const index of toDrop) {
          const segment = segments[index];
          spent.add(segment.id);
          if (!ready.has(segment.id)) missed.add(segment.id);
        }
        for (const index of toSchedule) scheduleSegment(index, timeMs);
      }

      const aheadMs = (Number(settings.ytDubAheadSec) || 45) * 1000;
      const planMode = settings.ytDubMode === 'full' ? 'full' : 'live';
      const next = planSynthesis({
        segments, timeMs, aheadMs, ready, inFlight, missed,
        maxInFlight: paused ? 4 : 3, mode: planMode,
      });
      for (const index of next) void synthesize(index);
    }

    // -- lifecycle ----------------------------------------------------------

    const api = {
      /** Replace the segment list. Ids are stable, so already-rendered audio
       *  survives a re-feed — which happens on every translation batch. */
      setSegments(list) {
        if(draining) { const existing=new Set(segments.map(s=>s.id));for(const s of list||[])if(!existing.has(s.id))drainIds.add(s.id); }
        segments = (list || []).filter((s) => s && s.text).sort((a, b) => a.start - b.start);
        report();
        if (draining) pumpDrain();
      },

      setUpstreamPending(value) { upstreamPending=!!value; },

      configure(next) {
        if (next) {
          const nextKey = speechKey(next);
          const nextLiveKey = liveKey(next);
          const restartLive = nextLiveKey !== liveSettingsKey;
          liveSettingsKey = nextLiveKey;
          settings = next;
          if (nextKey !== synthesisKey) {
            synthesisKey = nextKey;
            // Audio cached by cue id belongs to one voice/model generation.
            // Retire callbacks BEFORE freeing ids for new synthesis, so a
            // late response cannot fill or delete the new generation's slot.
            gen += 1;
            cancelScheduled();
            ready.clear();
            inFlight.clear();
            spent.clear();
            missed.clear();
            lastError = null;
            msPerChar = DEFAULT_MS_PER_CHAR;
            calibrations = 0;
          }
          if (restartLive && running && mode === 'live') {
            stopLive();
            startLive();
          }
        }
        refreshDucking(true);
      },

      /** Switch engines. Safe at any time: the old one is fully torn down. */
      setMode(next) {
        const wanted = next === 'live' ? 'live' : 'caption';
        if (wanted === mode) return;
        gen += 1;
        if (running) {
          if (mode === 'live') stopLive();
          else cancelScheduled();
          releaseVolume();
        }
        mode = wanted;
        ready.clear();
        inFlight.clear();
        spent.clear();
        missed.clear();
        if (running) {
          if (mode === 'live') startLive();
          else if (liveOriginalGain) liveOriginalGain.gain.value = 1;
        }
        report();
      },

      start(startMode) {
        if (running || disposed) return;
        if (startMode) mode = startMode === 'live' ? 'live' : 'caption';
        running = true;
        draining = false; liveDrained = false; lastPlayhead = video.currentTime * 1000;
        playbackFrom = Math.max(0,lastPlayhead-GRACE_MS);
        gen += 1;
        baseVolume = video.volume;
        expectedVolume = video.volume;
        userVolumeOverride = false;
        lastError = null;
        video.addEventListener('volumechange', onVolumeChange);
        for (const event of mediaEvents) video.addEventListener(event, mediaChanged);
        try { audio(); } // create in the initiating user gesture when possible
        catch (error) { failLive({ code: 'AUDIO_UNAVAILABLE', error: String(error?.message || error) }); return; }
        if (mode === 'live') startLive();
        refreshDucking();
        report();
      },

      /** Anything that breaks the media-time ↔ audio-time mapping. */
      resync() {
        if (!running) return;
        if (draining && video.ended) return;
        if (mode === 'live') flushLive();
        else { cancelScheduled(); rearmFromPlayhead(); }
      },

      update,

      stop() {
        running = false;
        draining = false; liveDrained = false; upstreamPending = false;
        gen += 1;
        if (mode === 'live') stopLive();
        cancelScheduled();
        releaseVolume();
        ++watchEpoch;
        clearInterval(duckWatch);
        duckWatch = 0;
        video.removeEventListener('volumechange', onVolumeChange);
        for (const event of mediaEvents) video.removeEventListener(event, mediaChanged);
        if (resumeWake && !liveSource) {
          document.removeEventListener('pointerdown', resumeWake, true);
          document.removeEventListener('keydown', resumeWake, true);
          resumeWake = null;
          resumeHooked = false;
        }
        userVolumeOverride = false;
        ready.clear();
        inFlight.clear();
        spent.clear();
        missed.clear();
        segments = [];
        lastError = null;
        report();
      },

      /** Everything the panel needs to describe what is happening. */
      stats,

      /** Final teardown for disposable caption or stream-capture players.
       * The default Live path owns a permanent MediaElementAudioSource: stop
       * restores it, but closing it would silence media until page reload. */
      dispose() {
        api.stop();
        if (liveSource) return false;
        disposed = true;
        try { gain?.disconnect(); } catch { /* already disconnected */ }
        if (ctx) { try { void ctx.close?.()?.catch?.(() => {}); } catch { /* closed context */ } }
        ctx = null;
        gain = null;
        return true;
      },

      _test: { ready, inFlight, scheduled, spent, missed, liveSources, segmentsRef: () => segments },
    };
    return api;
  }

  globalThis.GXT.dub = {
    create,
    // Exposed so the whole decision layer can be tested without audio hardware.
    _internal: {
      pickRate,
      planFit,
      planSynthesis,
      planSchedule,
      availableFor,
      calibrate,
      detectSourceLang,
      matchesSource,
      dominantLang,
      rememberLang,
      LANG_VOTES,
      resample,
      floatToPcm16Base64,
      pcm16Base64ToFloat,
      DEFAULT_MS_PER_CHAR,
      RATE_STEP,
      LATE_MS,
      SCHEDULE_LEAD_MS,
      GRACE_MS,
      SPILL_MARGIN_MS,
      setContextFactory: (fn) => { contextFactory = fn; },
      /** 0 makes ducking instant, which is the only way to observe it under a
       *  hidden tab's timer throttling. */
      setRampMs: (ms) => { rampMs = ms; },
    },
  };
})();
