/**
 * YouTube subtitle translation (isolated world).
 *
 * Two translation modes, both cached per line (re-watching costs zero):
 *  - ROLLING (default): the overlay activates instantly and only cues within
 *    a ~90s look-ahead window are translated, in 40-cue batches. Watch 3
 *    minutes of a 2-hour video → only those minutes are billed; skipped
 *    parts cost nothing.
 *  - FULL VIDEO (button in the ⚙ panel): translates the entire remaining
 *    track up front in large batches — the cheapest option per line when
 *    you intend to watch to the end.
 *
 * Appearance (⚙ panel, persisted): subtitle font (bundled Persian fonts or
 * the extension-wide font), size slider, and drag-to-reposition — grab the
 * subtitle capsule and drop it anywhere on the video; reset button included.
 *
 * Alignment is self-healing (index-prefixed protocol + a holes-retry pass in
 * the service worker); an untranslated cue shows its original text dimmed
 * until its batch lands. Native captions are unloaded while ours are active.
 *
 * v2.1.0:
 *  - AUTO-START (`ytAuto`, opt-in): every video that has captions starts
 *    translating on its own with the saved settings. One attempt per video id,
 *    and an explicit stop always wins for that video.
 *  - LATENCY. The rolling window is split into an urgent near-window and a
 *    background look-ahead that run concurrently, so the line about to be
 *    spoken never waits behind a 40-cue prefetch. See the block below.
 */
'use strict';
(() => {
  if (globalThis.__gxtYtLoaded) return;
  globalThis.__gxtYtLoaded = true;
  if (!globalThis.chrome?.runtime?.id) return;

  // ---------------------------------------------------------- scheduling
  //
  // v2.1.0 — the rolling pipeline used to be ONE request at a time covering the
  // whole 90-second look-ahead. Nothing appeared until that entire batch came
  // back, so on a seek (or right after switching on) the player showed the
  // English source for as long as ~40 lines took to translate. With the
  // keyless Google/Bing engines that is 40 individual HTTP requests behind a
  // concurrency gate — several seconds of visible original text, exactly the
  // lag being reported.
  //
  // The window is now split in two, and they run CONCURRENTLY:
  //   URGENT   the next ~25s of speech, in small batches, always allowed —
  //            even while paused, because a paused frame still shows a cue.
  //   LOOKAHEAD the rest of the buffer, in big batches, only while playing so
  //            a paused video never burns quota on lines nobody reached.
  // The urgent batch is deliberately small: it is a latency budget, not a
  // throughput one.

  const BATCH_CUES = 40; // look-ahead batch size
  const NEAR_MS = 25000; // "about to be spoken" horizon
  const NEAR_BATCH = 10; // urgent batch: small, so it lands fast
  const MAX_INFLIGHT = 2; // urgent + look-ahead in parallel
  const MAX_INFLIGHT_MT = 3; // keyless engines are per-line: more parallelism pays
  const BULK_SLICE = 120; // full-video mode: cues per message (worker re-chunks)
  const BULK_WORD_WARN = 15000; // full-video mode: warn above this many words
  const FAIL_COOLDOWN_MS = 5000;
  /** How often playback may trigger a scheduling pass. `timeupdate` fires ~4×
   *  a second; this only bounds the (cheap) scan, and at 1.5s it used to add
   *  up to a second and a half of pure waiting on every seek. */
  const WINDOW_CHECK_MS = 350;
  /** Scheduling must never depend solely on `timeupdate`, which does not fire
   *  while paused and is throttled in background tabs. */
  const SAFETY_TICK_MS = 1000;

  const AHEAD_CHOICES = [
    [30, globalThis.GXT.i18n.t("content_youtube_AHEAD_CHOICES_6")],
    [60, globalThis.GXT.i18n.t("content_youtube_AHEAD_CHOICES_5")],
    [90, globalThis.GXT.i18n.t("content_youtube_AHEAD_CHOICES_4")],
    [120, globalThis.GXT.i18n.t("content_youtube_AHEAD_CHOICES_3")],
    [180, globalThis.GXT.i18n.t("content_youtube_AHEAD_CHOICES_2")],
    [300, globalThis.GXT.i18n.t("content_youtube_AHEAD_CHOICES_1")],
  ];

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const faNum = (n) => globalThis.GXT.i18n ? globalThis.GXT.i18n.number(n) : Number(n || 0).toLocaleString('fa-IR');
  const send = async (message) => {
    let timer;
    try {
      return await Promise.race([
        chrome.runtime.sendMessage(message),
        new Promise(resolve => { timer = setTimeout(() => resolve({ok:false,code:'TIMEOUT',get error() { return globalThis.GXT.i18n.t("content_youtube_send_3"); }}), 90000); }),
      ]);
    } catch (error) {
      const invalidated = /context invalidated|receiving end does not exist/i.test(String(error?.message || error));
      return {ok:false,code:invalidated?'EXTENSION_RELOADED':'NETWORK',error:invalidated?globalThis.GXT.i18n.t("content_youtube_send_2"):globalThis.GXT.i18n.t("content_youtube_send_1")};
    } finally { clearTimeout(timer); }
  };

  function routeVideoId() {
    if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v') || '';
    return location.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/)?.[1] || '';
  }

  let settings = null;
  // Knowing the route before metadata arrives lets an early click belong to
  // this video; the first metadata response must not look like a navigation.
  let info = { videoId: routeVideoId(), tracks: [] };
  /**
   * Has the page script reported this video yet? (v3.1.0)
   *
   * «no captions» and «we do not know yet» are different states, and the
   * controls now mount before the answer arrives — so without this the
   * subtitle button would flash disabled for a moment on every video, which
   * reads as a bug even though it corrects itself.
   */
  let infoSeen = false;
  /**
   * Has the page script SETTLED the caption question for this video? (v3.3.0)
   *
   * `infoSeen` only means «a message arrived». That was being read as «the
   * answer is final», and it is not: a player response with no `captions` key at
   * all is a response that has not answered yet, and there are plenty of those
   * in the first second of a video. Treating one as «this video has no
   * subtitles» is what disabled the button on videos that have them, which is
   * the whole reported bug.
   *
   * The page script now labels every message (see yt-main.js `settled`), and
   * only a settled one may produce a negative conclusion.
   */
  let infoSettled = false;
  /** User-chosen source caption track id (see trackId), reset per video. */
  let selectedTrackId = null;
  /**
   * TWO PIPELINES, TWO STATE MACHINES (v3.1.0).
   *
   * `state` is the CAPTION pipeline: fetch a track, parse it, translate cues,
   * paint them. `dubState` is the AUDIO pipeline: send sound to the Live API
   * (or speak translated cues) and play Persian over the video.
   *
   * Until v3.1.0 there was only `state`, and everything asked it — including
   * "is dubbing on?". That single variable was the bug the user hit:
   *
   *   · a video with NO captions produced no controls at all, so live dubbing
   *     — which reads nothing and listens instead — could not be switched on,
   *     because the only control that switches it on had been removed;
   *   · a caption FETCH FAILURE set `state = 'idle'`, which silently reported
   *     dubbing as off and disabled it, even though the live engine had never
   *     touched a caption.
   *
   * They are allowed to COOPERATE — the caption engine feeds the caption-driven
   * dub its segments, and both paint into one overlay — but neither may gate
   * the other. Anything that reads one to decide something about the other is
   * the defect coming back.
   */
  let state = 'idle'; // captions: 'idle' | 'loading' | 'active'
  let dubState = 'idle'; // audio: 'idle' | 'active'
  let dubStarting = false;
  let dubIntentGen = 0;
  // Session intent, deliberately separate from both pipelines and from the
  // persisted default. The caption pipeline may be running only to feed the
  // dub; that must never imply that text should be painted over the video.
  let visualWanted = false;
  let cancelRequested = false;
  let currentVideoIdAtStart = '';
  /** Bumped on every start()/track switch so a stale in-flight load bails. */
  let startGen = 0;
  /** @type {{s:number, e:number, orig:string, fa:string|null}[]|null} */
  let cues = null;
  let sourceCues = null; // original acquired timing; translation changes reuse it
  const requested = new Set();
  /** Number of translation requests currently outstanding (was a boolean:
   *  one in-flight batch at a time, which is what serialized the urgent
   *  window behind the look-ahead). */
  let inFlight = 0;
  let bulkRunning = false;
  let bulkCancel = false;
  let bulkConfirmed = false;
  const aheadMs = () => clamp(Number(settings?.ytAheadSec) || 90, 30, 600) * 1000;
  let lastFailAt = 0;
  let lastWindowCheck = 0;
  let ptr = 0;
  let lastShown = null;
  let safetyTimer = 0;

  // ------------------------------------------------------- dubbing (v2.4.0)
  //
  // The dub engine lives in content/dub.js and knows nothing about YouTube.
  // This module owns the decision of WHAT to speak (translated cues) and WHEN
  // to tell it the time; the engine owns everything about the audio itself.

  /** @type {ReturnType<typeof globalThis.GXT.dub.create>|null} */
  let dubber = null;
  let dubVideo = null;
  const dubbers = new WeakMap();
  let dubStats = null;
  let dubStatusEl = null;

  /**
   * The dub speaks whole SENTENCES, so a cue only becomes a segment once it
   * carries a translation. Ids are the cue's start time, which is stable
   * across re-feeds — that is what lets already-rendered audio survive the
   * next translation batch landing.
   */
  function dubSegments() {
    if (!cues) return [];
    const out = [];
    for (const cue of cues) {
      if (!cue.fa) continue;
      out.push({ id: `${cue.s}`, start: cue.s, end: cue.e, text: cue.fa });
    }
    return out;
  }

  /**
   * Is the CAPTION-DRIVEN dub running and able to take new segments?
   *
   * This one legitimately reads both machines, because that engine speaks
   * translated cues — it genuinely needs the caption pipeline. The live engine
   * does not, and must never be gated on it.
   */
  function dubEnabled() {
    return !!(dubState === 'active' && dubEngineName() === 'caption' && state === 'active' && video);
  }

  /** Does the chosen dub engine need the caption pipeline at all? */
  const dubNeedsCaptions = () => dubEngineName() === 'caption';

  /** Are there captions to work with on this video? */
  const hasTracks = () => !!info.tracks?.length;
  /**
   * We have been told DEFINITIVELY, and the answer was none — v3.3.0.
   *
   * This was `infoSeen && !hasTracks()`, i.e. «a message arrived and it had no
   * tracks in it». That is the single line that disabled the subtitle button on
   * videos which do have subtitles: an early player response carries no
   * `captions` key, the page script posted it anyway, and the button went dead
   * with «this video has no subtitles» before YouTube had finished answering.
   * The user's workaround — reload, toggle, repeat — was them re-rolling the
   * race until a populated response happened to arrive first.
   *
   * Now it takes a SETTLED answer to conclude anything negative.
   */
  const knownCaptionless = () => infoSettled && !hasTracks();

  const dubEngineName = () => (settings?.ytDubEngine === 'live' ? 'live' : 'caption');

  /** Can the active provider REWRITE a line shorter? The keyless machine
   *  translators cannot; for them the engine falls back to speeding up. */
  const canCompress = () => settings?.provider === 'gemini' || settings?.provider === 'openai';

  /**
   * The <video> element, resolved on demand (v3.1.0).
   *
   * It used to be assigned only inside the overlay builder, which made the
   * player's own media element a side effect of drawing a subtitle box. On a
   * caption-less video nothing drew that box, so `video` stayed null and
   * `ensureDubber` below silently returned null — the live engine could not
   * start even once every other gate had been opened. Finding the video is a
   * player concern, not an overlay one.
   */
  function ensureVideo() {
    const next = player?.querySelector('video') || null;
    if (video === next) return video;
    // A Shorts transition can leave the previous video connected elsewhere
    // in the DOM. Membership in the current player, not isConnected alone,
    // determines which media element receives sound and playback listeners.
    video?.removeEventListener('timeupdate', tick);
    for (const event of ['seeked', 'seeking', 'play', 'pause', 'ratechange']) {
      video?.removeEventListener(event, nudge);
    }
    if (dubber && dubVideo === video) dubber.stop();
    video = next;
    return video;
  }

  function ensureDubber() {
    if (!globalThis.GXT.dub) return null;
    ensureVideo();
    if (dubber && dubVideo !== video) {
      dubber.stop();
      dubber = null;
    }
    if (!dubber && video) {
      dubber = dubbers.get(video) || globalThis.GXT.dub.create({
        video,
        send,
        settings,
        canCompress: canCompress(),
        // A long-lived port, not one-shot messages: this carries ~10 audio
        // chunks a second each way, and its disconnect is what tells the worker
        // to close a Live session when the tab goes away.
        connectLive: () => chrome.runtime.connect({ name: 'gxt-live' }),
        onLiveText: handleLiveText,
        onState: (stats) => { dubStats = stats; if(stats.live?.state==='completed'){dubState='idle';restylePill();}paintDubStatus(); },
      });
      dubVideo = video;
      dubbers.set(video, dubber);
    }
    return dubber;
  }

  /**
   * Start the voice. Needs no captions unless the CAPTION engine was chosen.
   *
   * The overlay is brought up here too: the live engine paints its own
   * transcript into it, and on a caption-less video nothing else would ever
   * create it. `ensureOverlay` is idempotent and shared with the caption
   * pipeline, so whichever path starts first wins and the other reuses it.
   */
  function startDub() {
    // The engine needs the media element, but it does NOT need a subtitle box.
    // A voice-only click stays voice-only; the transcript is painted only when
    // the viewer separately asks for subtitles.
    ensureVideo();
    const engine = ensureDubber();
    if (!engine) return false;
    engine.configure(settings);
    engine.setMode(dubEngineName());
    engine.start(dubEngineName());
    if (dubEngineName() === 'caption') engine.setSegments(dubSegments());
    dubState = 'active';
    dubStarting = false;
    paintDubStatus();
    restylePill();
    return true;
  }

  /**
   * Live-engine transcripts.
   *
   * The Live API returns what it HEARD and what it SAID, at no extra cost. The
   * Persian side is a usable subtitle — and, uniquely, one that exists for
   * videos with no caption track at all, which the caption engine can never
   * produce. Shown in the same box, so the viewer sees one caption whichever
   * engine is running.
   */
  let liveLine = '';
  let liveLineAt = 0;

  function handleLiveText({ kind, text }) {
    if (dubState !== 'active' || dubEngineName() !== 'live') return;
    if (kind === 'turnEnd') {
      liveLine = '';
      liveLineAt = 0;
      if (overlayInner) overlayInner.style.display = 'none';
      lastShown = null;
      return;
    }
    if (kind !== 'target' || !text) return;
    const now = Date.now();
    // The API streams a phrase in fragments. Append while they keep coming,
    // start a new line after a pause, and keep it to a readable length.
    liveLine = now - liveLineAt > 2500 ? text : `${liveLine}${text}`;
    liveLineAt = now;
    if (liveLine.length > 220) liveLine = liveLine.slice(-220);
    if (visualWanted) {
      ensureOverlay();
    }
    if (overlayInner && visualWanted) {
      overlayFa.textContent = liveLine;
      overlayOrig.style.display = 'none';
      overlayInner.style.display = 'inline-block';
      overlayInner.style.opacity = '1';
      // The cue-driven painter must not immediately overwrite this.
      lastShown = `live\u0000${liveLine}`;
    }
  }

  function stopDub() {
    dubIntentGen += 1;
    dubStarting = false;
    dubber?.stop();
    dubStats = null;
    dubState = 'idle';
    liveLine = '';
    paintDubStatus();
    // The overlay belongs to whichever pipeline still needs it. If captions
    // are running it stays; if nothing is running it goes.
    if (state !== 'active') teardownOverlay();
    restylePill();
  }

  /** Push newly translated lines into the engine. Called whenever a batch
   *  lands, so the dub picks up work the moment the words exist. */
  function refreshDubSegments() {
    if (dubEnabled() && dubber) {dubber.setUpstreamPending?.(inFlight>0);dubber.setSegments(dubSegments());}
  }

  function paintDubStatus() {
    if (!dubStatusEl) return;
    if (!settings?.ytDub) {
      globalThis.GXT.i18n.bind(dubStatusEl, "textContent", () => (globalThis.GXT.i18n.t("content_youtube_paintDubStatus_10")));
      return;
    }
    const s = dubStats || dubber?.stats();
    if (s?.suspended) {
      // Autoplay policy: the audio context was created without a user gesture
      // (auto-start), so nothing can be heard until something is clicked.
      globalThis.GXT.i18n.bind(dubStatusEl, "textContent", () => (globalThis.GXT.i18n.t("content_youtube_paintDubStatus_9")));
      return;
    }
    // The live engine has no segment counts — it has a socket, and the honest
    // thing to report is what that socket is doing.
    if (s?.mode === 'live') {
      const label = {
        get idle() { return globalThis.GXT.i18n.t("content_youtube_label_9"); }, get connecting() { return globalThis.GXT.i18n.t("content_youtube_label_8"); }, get live() { return globalThis.GXT.i18n.t("content_youtube_label_7"); }, get paused() { return globalThis.GXT.i18n.t("content_youtube_label_6"); },
        get reconnecting() { return globalThis.GXT.i18n.t("content_youtube_label_5"); }, get rotating() { return globalThis.GXT.i18n.t("content_youtube_label_4"); }, get stopped() { return globalThis.GXT.i18n.t("content_youtube_label_3"); }, get error() { return globalThis.GXT.i18n.t("content_youtube_label_2"); },
      }[s.live?.state] || s.live?.state || '…';
      const bits = [label];
      if (s.live?.spoken) bits.push(globalThis.GXT.i18n.t("content_youtube_paintDubStatus_8", {v0:(faNum(s.live.spoken))}));
      if (s.live?.filtered) bits.push(globalThis.GXT.i18n.t("content_youtube_paintDubStatus_7", {v0:(faNum(s.live.filtered))}));
      if (s.live?.sourceLang && !settings?.ytLiveSourceLang) {
        bits.push(globalThis.GXT.i18n.t("content_youtube_paintDubStatus_6", {v0:(s.live.sourceLang)}));
      }
      dubStatusEl.textContent = bits.join(' · ');
      if (s.error?.error) dubStatusEl.textContent += ` — ${s.error.error}`;
      return;
    }
    if (!s || !s.total) {
      globalThis.GXT.i18n.bind(dubStatusEl, "textContent", () => (globalThis.GXT.i18n.t("content_youtube_paintDubStatus_5")));
      return;
    }
    const parts = [globalThis.GXT.i18n.t("content_youtube_parts_1", {v0:(faNum(s.ready)), v1:(faNum(s.total))})];
    if (s.pending) parts.push(globalThis.GXT.i18n.t("content_youtube_paintDubStatus_4", {v0:(faNum(s.pending))}));
    if (s.compressions) parts.push(globalThis.GXT.i18n.t("content_youtube_paintDubStatus_3", {v0:(faNum(s.compressions))}));
    if (s.rushes) parts.push(globalThis.GXT.i18n.t("content_youtube_paintDubStatus_2", {v0:(faNum(s.rushes))}));
    if (s.missed) parts.push(globalThis.GXT.i18n.t("content_youtube_paintDubStatus_1", {v0:(faNum(s.missed))}));
    dubStatusEl.textContent = parts.join(' · ');
    if (s.error?.error) dubStatusEl.textContent += ` — ${s.error.error}`;
  }

  /** Is the engine that will actually translate subtitles a keyless machine
   *  translator? Those issue one request per line, so more of them can be in
   *  flight profitably; the AI providers are batched and rate-limited. */
  function subtitleEngineIsMT() {
    const chosen =
      settings?.ytProvider && settings.ytProvider !== 'inherit'
        ? settings.ytProvider
        : settings?.provider;
    return chosen === 'google' || chosen === 'bing';
  }

  const maxInFlight = () => (subtitleEngineIsMT() ? MAX_INFLIGHT_MT : MAX_INFLIGHT);

  let controls = null; // container for the subtitle, dub and settings buttons
  let pill = null;     // subtitles
  let dubBtn = null;   // the voice — independent of the subtitles since v2.4.6
  let gear = null;
  let panel = null;
  let panelTab = 'caption';
  let bulkButton = null;
  let pillTimer = 0;
  let overlay = null;
  let overlayInner = null;
  let overlayFa = null; // Persian line (v1.8 bilingual layout)
  let overlayOrig = null; // original line, shown when ytBilingual is on
  let player = null;
  let video = null;
  let mountRetry = 0;
  let liveTimer = 0; // live streams: periodic caption refetch (v1.8)

  // ------------------------------------------------------------------ fonts

  function extensionFontStack() {
    const name =
      settings?.font === 'x-default'
        ? ''
        : settings?.font === '_custom'
          ? (settings.customFont || '').trim()
          : settings?.font || 'Vazirmatn';
    const head = name ? `"${name.replace(/"/g, '')}", ` : '';
    return `${head}"Vazirmatn", "Segoe UI", Tahoma, sans-serif`;
  }

  function subtitleFontStack() {
    const f = settings?.ytFont && settings.ytFont !== 'inherit' ? settings.ytFont : '';
    if (f) return `"${f.replace(/"/g, '')}", "Vazirmatn", "Segoe UI", Tahoma, sans-serif`;
    return extensionFontStack();
  }

  function friendly(result) {
    switch (result?.code) {
      case 'NO_KEY':
        return globalThis.GXT.i18n.t("content_youtube_friendly_3");
      case 'RATE_LIMIT':
        return result?.error || globalThis.GXT.i18n.t("content_youtube_friendly_2");
      case 'BAD_KEY':
        return globalThis.GXT.i18n.t("content_youtube_friendly_1");
      default:
        return result?.error || globalThis.GXT.i18n.t("content_composer_ensureComposerChip_5");
    }
  }

  // -------------------------------------------------------------- controls

  /**
   * The in-player controls (rebuilt in v2.4.6).
   *
   * There used to be ONE button labelled «زیرنویس فارسی» that started the whole
   * pipeline, which meant switching the voice on required first switching the
   * SUBTITLES on — a control whose label had nothing to do with what the
   * viewer wanted. Now the two outputs each have their own button:
   *
   *     [ زیرنویس ] [ 🔊 دوبله ] [ ⚙ ]
   *
   * Either one starts the pipeline if it is not running; turning both off
   * stops it. The label always names the thing the button actually does.
   */
  function subsOn() {
    return state === 'active' && visualWanted;
  }

  /** Acquire/release the visual output without touching cue preparation or
   * dubbing. This is the architectural boundary that makes voice-only real. */
  function setCaptionVisibility(on) {
    visualWanted = !!on;
    lastShown = undefined;
    if (visualWanted) {
      if (state === 'active') {
        window.postMessage({ source: 'gxt-yt-cmd', cmd: 'captionsOff' }, '*');
        ensureOverlay();
      } else if (dubState === 'active' && dubEngineName() === 'live') {
        ensureOverlay();
      }
    } else {
      if (overlayInner) overlayInner.style.display = 'none';
      // Release only our lease; yt-main restores the viewer's exact previous
      // native-caption state instead of blindly turning captions on.
      window.postMessage({ source: 'gxt-yt-cmd', cmd: 'captionsOn' }, '*');
    }
    restylePill();
    tick();
  }

  /**
   * Is the voice actually running? Answered by the AUDIO machine alone.
   *
   * It used to be `state === 'active' && settings.ytDub` — i.e. the caption
   * pipeline decided whether the button looked on. On a caption-less video, or
   * after a caption fetch failed, that read "off" while the live engine was
   * perfectly able to run, which is exactly what made dubbing look broken.
   */
  function dubOn() {
    return dubState === 'active';
  }

  /**
   * Labels no longer carry state (v3.2.0).
   *
   * They used to read «زیرنویس ✓» / «🔊 دوبله ✓», so the on-state was encoded in
   * TEXT — which had to be rewritten on every repaint, could not be announced
   * to a screen reader, and meant the label and the fill could disagree. State
   * is `aria-pressed` and the dot now; the label just says what the button is.
   */
  function pillDefaultLabel() {
    if (state === 'loading') return globalThis.GXT.i18n.t("content_youtube_pillDefaultLabel_1");
    return globalThis.GXT.i18n.t("content_youtube_mountPill_4");
  }

  const dubButtonLabel = () => globalThis.GXT.i18n.t("content_youtube_mountPill_1");

  function updatePill(text) {
    if (!pill) return;
    setLabel(pill, text);
    if (dubBtn) setLabel(dubBtn, dubButtonLabel());
    restylePill();
  }

  function flashPill(text, ms = 5000) {
    updatePill(text);
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => updatePill(pillDefaultLabel()), ms);
  }

  // ══════════════════════════════════════ the design system (v3.2.0)
  //
  // Everything this module draws now lives in ONE themed shadow root inside
  // `#movie_player`, styled by content/player.css.js against the same tokens
  // as the popup. Before v3.2.0 each element carried a hand-written
  // `style.cssText` string, which is why the in-player UI was the one surface
  // that never adopted the design system: a style attribute cannot express a
  // type scale, a focus ring, `prefers-reduced-motion` or `forced-colors`.

  /** The shadow root that holds the controls, the panel and the caption. */
  let surfaceRoot = null;
  let ownHost = null;

  /**
   * A last-resort stylesheet (v3.2.1).
   *
   * `content/player.css.js` is a template literal, and a stray backtick inside
   * it ends the string and makes the whole module a syntax error — a failure
   * that is SILENT in the worst possible way, because the shadow root then gets
   * no stylesheet and every control renders invisible. That happened twice
   * while writing it. dev/selftest.html now guards against it, but a guard in
   * the test suite does not help a user who already has the broken build, so
   * there is also a floor here: enough CSS to make the controls visible and
   * clickable, so the feature degrades instead of disappearing.
   */
  const EMERGENCY_CSS = `
    :host { position: absolute !important; inset: 0 !important;
            pointer-events: none !important; z-index: 58; direction: var(--gxt-ui-dir, rtl); }
    .yt-controls { position: absolute; right: 12px; bottom: 64px; display: flex;
                   gap: 8px; align-items: center; pointer-events: auto; }
    .yt-btn { min-height: 34px; padding: 0 14px; border: 1px solid #3a4356;
              border-radius: 9999px; background: #171a21; color: #e2e5e8;
              font: 700 13px/1.5 sans-serif; cursor: pointer; }
    .yt-btn[aria-pressed="true"] { background: #177bbf; color: #fff; }
    .yt-panel { position: absolute; right: 12px; bottom: 112px; width: 330px;
                max-height: calc(100% - 160px); overflow: auto; pointer-events: auto;
                background: #171a21; color: #e2e5e8; border: 1px solid #3a4356;
                border-radius: 18px; padding: 14px; }
    .yt-cap-wrap { position: absolute; transform: translateX(-50%); max-width: 90%;
                   pointer-events: none; z-index: 59; text-align: center; }
    .yt-cap { display: none; background: rgba(8,8,8,.78); color: #fff;
              padding: .2em .7em; border-radius: .5em; direction: var(--gxt-ui-dir, rtl);
              pointer-events: auto; cursor: grab; }
  `;

  const playerCss = () => globalThis.GXT.playerCss || EMERGENCY_CSS;

  /** The bundled Persian webfont as @font-face rules for a shadow root. A
   *  shadow tree does not inherit the document's @font-face declarations, so
   *  every root that wants Vazirmatn has to declare it. */
  function fontFaceCss() {
    try {
      const url = (file) => chrome.runtime.getURL(`fonts/${file}`);
      return [400, 700]
        .map(
          (w) =>
            `@font-face{font-family:"Vazirmatn";src:url("${url(
              `Vazirmatn-${w === 700 ? 'Bold' : 'Regular'}.woff2`
            )}") format("woff2");font-weight:${w};font-display:swap;}`
        )
        .join(String.fromCharCode(10));
    } catch {
      return ''; // no extension context (dev harness): system fonts apply
    }
  }

  /**
   * The host's own layout, carried INLINE — v3.2.2, and this was a real bug.
   *
   * The host is reset with `all: initial` so the page's styles cannot reach into
   * it. But `all: initial` is an INLINE declaration, and it sets EVERY property
   * — including `position: static`, `pointer-events: auto` and, decisively,
   * `z-index: auto`. A `:host` rule cannot override an inline declaration unless
   * it is `!important`, and while v3.2.0 marked position/inset/pointer-events
   * that way, it did NOT mark z-index.
   *
   * So the host computed to `z-index: auto`. Inside a simple mock player that is
   * harmless: with no z-indexed siblings, DOM order puts the last child on top,
   * which is why all 530 checks passed. Inside the REAL player it is fatal —
   * `#movie_player` contains `.ytp-chrome-bottom`, `.ytp-gradient-bottom` and
   * friends at z-index ~59-62, and an `auto` element paints beneath all of them.
   * The entire UI was rendered UNDERNEATH YouTube's controls: present in the
   * DOM, invisible on screen, unclickable, and reported (correctly) as
   * «completely vanished». Measured with elementFromPoint: our own button's
   * centre resolved to YouTube's chrome, not to us.
   *
   * The fix is not another `!important`. It is to stop having the inline style
   * and the stylesheet disagree: the host's layout is declared HERE, after
   * `all: initial` in the same `cssText`, where later-wins settles it with no
   * specificity argument at all. One constant, used by both the shared-surface
   * path and the local fallback, so the two can never drift.
   */
  const HOST_STYLE =
    'all: initial;'
    + 'position: absolute;'
    + 'inset: 0;'
    // Clicks pass through the host; only real controls opt back in.
    + 'pointer-events: none;'
    // Above YouTube's own player chrome, so the controls and the settings sheet
    // are reachable. Below content/ui.js's page-level card layer
    // (2147483647), so a translation card still floats over the player.
    + 'z-index: 2147483000;'
    /**
     * TYPOGRAPHY, for exactly the same reason — and this was the second half of
     * the same bug.
     *
     * `all: initial` does not only reset layout. It sets `font-family`,
     * `font-size`, `line-height` and `color` inline too, and every descendant
     * of the shadow root inherits from the host. Measured on the shipped
     * v3.2.2 build:
     *
     *     font-family: "Times New Roman"   font-size: 16px
     *     line-height: normal              color: rgb(0, 0, 0)
     *
     * — while `--gxt-font` sat right there on the same element, correct and
     * unused. So every Persian glyph in the player UI was drawn by a serif
     * fallback at the wrong size with the wrong leading. The structure of the
     * redesign was all present; it simply could not look like it, which is why
     * it read as "unstyled, same as the old version".
     *
     * Custom properties resolve at computed-value time, not in source order, so
     * these `var()`s pick up the token block that `themeHost` appends AFTER
     * this string. The literal fallbacks cover the no-theme-module path.
     */
    + 'font-family: var(--gxt-font, "Vazirmatn", "Segoe UI", Tahoma, sans-serif);'
    + 'font-size: var(--gxt-fs-md, 13.5px);'
    + 'line-height: var(--gxt-lh, 1.75);'
    + 'color: var(--gxt-fg, #e2e5e8);'
    + 'direction: var(--gxt-ui-dir, rtl);'
    + 'text-align: start;'
    + '-webkit-font-smoothing: antialiased;';

  /**
   * The themed shadow root that holds the controls, the panel and the caption.
   *
   * THREE LEVELS, and the reason matters (v3.2.1). v3.2.0 shipped only the
   * first one, guarded by `if (!surface) return;` — so on a browser where
   * `content/ui.js` had not been injected, `mountPill` returned before creating
   * anything and the ENTIRE YouTube UI silently disappeared. No error, no
   * console warning, nothing in the DOM: exactly what a user reported, and
   * exactly what happens for as long as a browser is still running the
   * PREVIOUS content-script registration (Chrome re-reads that list only when
   * the extension itself is reloaded, not when the page is).
   *
   * A shared helper being unavailable must never be able to erase the product.
   * So this module can now build its own host, and can style it without the
   * theme module too.
   */
  function ensureSurface() {
    if (!player) return null;
    // 1. The shared surface: one implementation, re-themed with every other
    //    in-page surface by GXT.ui.configure().
    const UI = globalThis.GXT.ui;
    if (UI?.surface) {
      surfaceRoot = UI.surface(player, {
        id: 'yt',
        // The host fills the player and passes clicks through; only the real
        // controls opt back in. See :host in content/player.css.js.
        keep: HOST_STYLE,
        css: playerCss(),
      }).root;
      ownHost = null;
      return surfaceRoot;
    }
    // 2. No shared layer — build the same thing locally. Costs a dozen lines
    //    and makes this module self-sufficient.
    if (!ownHost || !ownHost.isConnected || ownHost.parentElement !== player) {
      ownHost = document.createElement('div');
      ownHost.setAttribute('data-gxt-ui', 'yt');
      ownHost.setAttribute('lang', 'fa');
      surfaceRoot = ownHost.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      // The @font-face rules too: without them this path asks for "Vazirmatn"
      // and silently gets whatever the system has. ui.js owns the canonical
      // copy; this is the standalone equivalent for when ui.js is absent.
      style.textContent = `${fontFaceCss()}
${playerCss()}`;
      surfaceRoot.appendChild(style);
      player.appendChild(ownHost);
    }
    // 3. Tokens if the theme module is there, a readable default if it is not.
    const theme = globalThis.GXT.theme;
    ownHost.style.cssText = theme
      ? `${HOST_STYLE} ${theme.tokens(settings || {}, { inPage: true })}`
      : HOST_STYLE;
    return surfaceRoot;
  }

  /** `document.createElement` with a class, because that is now the whole job. */
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) globalThis.GXT.i18n.bindLabel(node,'textContent',text);
    return node;
  }

  /**
   * One button primitive for the whole player UI.
   *
   * `variant` may include `icon` (square) and `dot` (a state dot instead of a
   * tick glued into the label — the old labels were «زیرنویس ✓» / «🔊 دوبله ✓»,
   * which meant the on-state was carried by TEXT that also had to be
   * translated, measured and re-written on every repaint).
   */
  function ytButton(label, title, variant = '') {
    const b = el('button', `yt-btn${variant.includes('icon') ? ' icon' : ''}`);
    b.type = 'button';
    globalThis.GXT.i18n.bindLabel(b,'title',title);
    b.setAttribute('aria-label', title);
    if (variant.includes('dot')) b.append(el('span', 'dot'));
    b.append(el('span', 'txt', label));
    return b;
  }

  /** Set a button's label without disturbing its dot. */
  function setLabel(button, text) {
    const slot = button?.querySelector('.txt');
    if (slot) globalThis.GXT.i18n.bindLabel(slot,'textContent',text);
    else if (button) globalThis.GXT.i18n.bindLabel(button,'textContent',text);
  }

  /**
   * THE INLINE PAINT PATH IS GONE — v3.2.5.
   *
   * Three functions used to live here: `look()`, which read the theme table and
   * the derived palette and returned about a dozen literal colours;
   * `surfaceFill()`, which composited a panel background by hand at a
   * `PANEL_ALPHA` of 92; and `buttonStyle()`, which concatenated a full style
   * string for a chip. They existed because of a fact that stopped being true in
   * v3.2.0: that this UI lives in YouTube's own DOM and therefore cannot inherit
   * CSS custom properties. It lives in a shadow root now, `themeHost` writes the
   * whole token block onto that host, and content/player.css.js reads it — so
   * every colour these three computed is a `var()` at the point of use.
   *
   * Leaving them was not free. `buttonStyle()` called `blurCss()`, which no
   * longer exists anywhere in this file: the only thing that function could do
   * if anything ever called it was throw a ReferenceError. Dead code that
   * cannot run is merely clutter; dead code that throws is a trap set for
   * whoever reaches for it next.
   *
   * The palette contract they used to be tested through is still tested — but
   * against the surface that SHIPS. dev/mock-yt.html now measures
   * getComputedStyle on the real nodes in the real shadow root for every theme,
   * which is strictly better than asserting on a helper the product never calls.
   */

  /** Repaint the pill/gear when the caption state or the theme changes. */
  /**
   * Paint each control according to ITS OWN availability (v3.1.0).
   *
   * The subtitle pill is the only one captions can disable. The voice button
   * is disabled only when the engine it would use is the caption one AND
   * there are no captions — with the live engine it is always available,
   * because the live engine listens to audio and every video has audio.
   */
  /**
   * Paint each control according to ITS OWN availability (v3.1.0), through the
   * stylesheet rather than through inline styles (v3.2.0).
   *
   * `aria-pressed` now carries the on-state — it is what the CSS selects on AND
   * what a screen reader reads, so the two can no longer disagree. Before this
   * the state lived in a «✓» inside the label and nothing announced it at all.
   */
  function restylePill() {
    if (pill) {
      const noSubs = knownCaptionless();
      pill.setAttribute('aria-pressed', subsOn() ? 'true' : 'false');
      pill.disabled = false; // absent metadata must never make an explicit retry inert
      pill.classList.toggle('warned', noSubs);
      pill.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
      const title = noSubs
        ? globalThis.GXT.i18n.t("content_youtube_title_2")
        : globalThis.GXT.i18n.t("content_youtube_mountPill_3");
      const label = lastCaptionError && state === 'idle' ? lastCaptionError + globalThis.GXT.i18n.t("content_youtube_label_1") : state === 'loading' ? (pill.querySelector('.txt')?.textContent || title) : title;
      globalThis.GXT.i18n.bindLabel(pill,'title',label);
      globalThis.GXT.i18n.bindLabel(pill,'ariaLabel',label);
    }
    if (dubBtn) {
      const blocked = dubNeedsCaptions() && knownCaptionless();
      dubBtn.setAttribute('aria-pressed', dubOn() ? 'true' : 'false');
      // Not `disabled`: the click is what SWITCHES the engine to the one that
      // works here, so it has to stay pressable — it is discouraged, not
      // forbidden. (v3.1.0 made that click do the useful thing.)
      dubBtn.classList.toggle('warned', blocked);
      const title = blocked
        ? globalThis.GXT.i18n.t("content_youtube_title_1")
        : globalThis.GXT.i18n.t("content_youtube_togglePanel_60");
      globalThis.GXT.i18n.bindLabel(dubBtn,'title',title);
      dubBtn.setAttribute('aria-label', title);
    }
  }

  function removeControls() {
    controls?.remove();
    controls = null;
    pill = null;
    gear = null;
    dubBtn = null;
    closePanel();
    // v3.3.2 — the popup watchers exist to keep our chrome out of YouTube's way,
    // and there is no chrome to keep out of the way now. Left running they would
    // hold a reference to a player that may be torn down (an SPA route change
    // rebuilds `#movie_player`) and re-arm on the next mount anyway.
    popupObserver.disconnect();
    popupRootObserver.disconnect();
    autohideObserver.disconnect();
    autohidePlayer = null;
    if (chromeSyncFrame) {
      cancelAnimationFrame(chromeSyncFrame);
      chromeSyncFrame = 0;
    }
    clearTimeout(chromeSyncTail);
    chromeSyncTail = 0;
  }

  function mountPill() {
    if (!settings?.enabled || settings?.youtube === false) {
      if (state !== 'idle' || dubState !== 'idle') { stop(); stopDub(); }
      return removeControls();
    }
    const isShorts = /^\/shorts\//.test(location.pathname);
    /**
     * Every URL that is really a watch page — v3.3.0.
     *
     * `/live/<id>` and `/embed/<id>` were missing. YouTube usually redirects
     * `/live/` to `/watch`, but for a stream that is live RIGHT NOW the
     * `/live/<id>` URL stays — which is how a premiere or a broadcast is
     * normally shared, and exactly the kind of video whose captions a Persian
     * viewer most wants. The page script was already publishing tracks for those
     * URLs (see `wantedVideoId` in yt-main.js), so the two halves disagreed:
     * metadata arrived, the controls refused to mount, and the feature was
     * simply absent with nothing to explain why.
     */
    const allowed =
      /^\/(?:watch|live|embed)\b/.test(location.pathname) ||
      (isShorts && settings?.ytShorts !== false) ||
      globalThis.__gxtYtTestMode;
    if (!allowed) {
      if (state !== 'idle' || dubState !== 'idle') { stop(); stopDub(); }
      return removeControls();
    }
    const previousPlayer = player;
    const previousVideo = video;
    player =
      document.getElementById('movie_player') ||
      (isShorts ? document.getElementById('shorts-player') : null);
    if (previousPlayer && previousPlayer !== player) {
      removeControls();
      teardownOverlay();
    }
    ensureVideo();
    if (!player) {
      if (mountRetry < 8) {
        mountRetry += 1;
        setTimeout(mountPill, 1000);
      }
      return;
    }
    mountRetry = 0;
    if (previousVideo !== video && video) {
      if (state === 'active') {
        if (visualWanted) ensureOverlay();
        attachPlayback();
      } else if (dubState === 'active') startDub();
    }
    /**
     * THE CONTROLS ALWAYS MOUNT (v3.1.0) — this line used to be the bug.
     *
     * It read:
     *     const liveArmed = settings?.ytDub && settings?.ytDubEngine === 'live';
     *     if (!info.tracks?.length && !liveArmed) return removeControls();
     *
     * so on a video with no captions the ENTIRE control cluster was removed
     * unless live dubbing had ALREADY been turned on and its engine ALREADY
     * chosen. But the dub button is the only in-player way to turn dubbing on,
     * and the gear is the only in-player way to pick the engine — both of
     * which had just been removed. A chicken-and-egg: to reach the control
     * that enables live translation you first had to have enabled it.
     *
     * Captions are one FEATURE of this player UI, not its precondition. A
     * video with no captions still has audio, and audio is the whole input of
     * the live engine. So the cluster mounts whenever the player exists, and
     * each control reports its own availability — see `restylePill`.
     */
    if (!controls || !controls.isConnected) {
      const surface = ensureSurface();
      if (!surface) return;
      controls = el('div', 'yt-controls');
      controls.id = 'gxt-yt-controls';
      controls.setAttribute('role', 'group');
      globalThis.GXT.i18n.bind(controls,'ariaLabel',()=>(globalThis.GXT.i18n.t("content_youtube_mountPill_5")));

      gear = ytButton('⚙', globalThis.GXT.i18n.t("content_youtube_togglePanel_82"), 'icon');
      gear.id = 'gxt-yt-gear';
      gear.dataset.glyph = '⚙';
      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanel();
      });
      pill = ytButton(globalThis.GXT.i18n.t("content_youtube_mountPill_4"), globalThis.GXT.i18n.t("content_youtube_mountPill_3"), 'dot icon');
      pill.id = 'gxt-yt-pill';
      pill.dataset.glyph = globalThis.GXT.i18n.t("content_youtube_mountPill_2");
      // v2.4.6: the voice gets its own control. Before this, turning dubbing on
      // meant pressing a button labelled «زیرنویس فارسی», which is not what the
      // viewer was asking for and read like a bug even though it worked.
      dubBtn = ytButton(globalThis.GXT.i18n.t("content_youtube_mountPill_1"), globalThis.GXT.i18n.t("content_youtube_togglePanel_60"), 'dot icon');
      dubBtn.id = 'gxt-yt-dub';
      dubBtn.dataset.glyph = '🔊';
      dubBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void onDubClick();
      });
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        void onPillClick();
      });
      controls.append(gear, dubBtn, pill);
      surface.appendChild(controls);
    }
    // The gear is available before activation now — source track, engine and
    // appearance can all be chosen up front.
    if (gear) gear.style.display = '';
    restylePill();
    updatePill(pillDefaultLabel());
    watchAutohide();
    maybeAutoStart();
  }

  // ------------------------------------------------- auto-start (v2.1.0)
  //
  // Opt-in (`ytAuto`): every video that HAS captions starts translating on its
  // own, with the settings already saved — no click on the pill. Two rules keep
  // it from becoming annoying:
  //   1. one attempt per video id, so a re-mount (theme change, resize, the
  //      player rebuilding its DOM) never restarts anything;
  //   2. an explicit «stop» wins for that video — auto-start is a default, not
  //      a policy, and the user overruling it must stick until the next video.

  /** videoId we already auto-started, and the one the user manually stopped. */
  let autoStartedFor = '';
  let userStoppedFor = '';

  /**
   * Auto-start, per pipeline (v3.1.0).
   *
   * The caption pipeline needs a track; the live engine needs only audio. One
   * `!info.tracks?.length` guard used to cover both, so `ytAuto` never started
   * anything on a caption-less video — the exact case the live engine exists
   * for.
   */
  function maybeAutoStart() {
    if (!settings?.ytAuto || !settings.enabled || settings.youtube === false) return;
    const vid = info.videoId || '';
    if (!vid || autoStartedFor === vid || userStoppedFor === vid) return;

    const wantsLive = settings.ytDub && !dubNeedsCaptions();
    if (settings.ytSubtitles === false && !settings.ytDub) return;
    if (!hasTracks() && !wantsLive) return; // genuinely nothing to start
    autoStartedFor = vid;

    if (hasTracks() && state === 'idle') {
      setCaptionVisibility(settings?.ytSubtitles !== false);
      void start(); // captions (which starts the caption-driven dub too)
      return;
    }
    // No captions, but a live dub was asked for: start the voice on its own.
    if (wantsLive && dubState !== 'active') startDub();
  }

  // ═══════════════════════════════ yielding to YouTube's own UI (v3.3.2) ══
  //
  // THE BUG. Our surface sits at z-index 2147483000 — deliberately, because
  // v3.2.2 shipped a host that computed to `z-index: auto` and the whole UI
  // painted UNDERNEATH YouTube's player chrome, invisible and unclickable. But
  // "above everything YouTube draws" is too strong a claim: it is right for the
  // control BAR, which is permanent furniture, and wrong for YouTube's own
  // MENUS, which are transient things the viewer just deliberately opened.
  //
  // Reported with two screenshots: the native settings menu open, its lower rows
  // («سرعت بازپخش», «360°») covered by our pill and gear; and the speed submenu
  // with its «عادی» row hidden behind «دوبله». Worse than the cosmetics —
  // `.yt-cap` carries `pointer-events: auto` so it can be dragged, so wherever
  // the caption overlapped a menu it also SWALLOWED THE CLICKS meant for it.
  //
  // THE APPROACH. Not a list of YouTube's menu class names — those get renamed
  // and this would rot silently. Instead: find whatever popup YouTube is showing
  // right now and ask a geometric question — does it overlap the thing we drew?
  // A rectangle intersection cannot go out of date.
  //
  // AND THE TWO KINDS OF SURFACE YIELD DIFFERENTLY, which is the point:
  //
  //   · the CONTROLS are transient UI. While the viewer is in YouTube's menu
  //     they are not looking for ours, so they fade out completely.
  //   · the CAPTION is the product's entire output. Hiding subtitles because
  //     someone opened the volume menu would be absurd. So it keeps painting —
  //     and merely stops intercepting pointer events, which is the only part of
  //     it that was ever in YouTube's way.
  //
  // Keep the content, yield the interaction.

  /** YouTube's own transient overlays. `.ytp-popup` is the base class its
   *  settings menu, context menu, playlist menu and share panel all share. */
  const YT_POPUP_SELECTOR = '.ytp-popup, .ytp-contextmenu';

  let autohidePlayer = null;
  const autohideObserver = new MutationObserver(() => syncAutohide());
  /** Watches the popups themselves — see `watchPopups` for why not a subtree. */
  const popupObserver = new MutationObserver(() => scheduleChromeSync());
  /** Watches for popups being ADDED (YouTube builds them lazily, on first use). */
  const popupRootObserver = new MutationObserver(() => {
    watchPopups();
    scheduleChromeSync();
  });

  function watchAutohide() {
    if (!player || autohidePlayer === player) return;
    autohideObserver.disconnect();
    autohideObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
    popupRootObserver.disconnect();
    // childList WITHOUT subtree: YouTube's popups are direct children of
    // `#movie_player`, and this fires a handful of times per session. Observing
    // the subtree would instead fire on every progress-bar update — dozens of
    // times a second, for the whole video.
    popupRootObserver.observe(player, { childList: true });
    autohidePlayer = player;
    watchPopups();
    syncAutohide();
  }

  /** Observe each popup's own `style`/`class`, which is what YouTube toggles to
   *  open and close it. Precise and cheap, unlike watching the whole player. */
  function watchPopups() {
    popupObserver.disconnect();
    if (!player) return;
    for (const el of player.querySelectorAll(YT_POPUP_SELECTOR)) {
      popupObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    }
  }

  /** The on-screen rectangles of every YouTube popup currently visible. */
  function ytPopupRects() {
    if (!player) return [];
    const out = [];
    for (const el of player.querySelectorAll(YT_POPUP_SELECTOR)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      // Menus fade rather than vanish, so a mid-animation popup still counts.
      if (parseFloat(cs.opacity || '1') < 0.05) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 8 && rect.height > 8) out.push(rect);
    }
    return out;
  }

  const rectsOverlap = (a, b) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  /** Does `el` collide with anything YouTube is showing? */
  function collidesWithYouTube(el, rects) {
    if (!el || !rects.length) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    return rects.some((other) => rectsOverlap(rect, other));
  }

  /**
   * Coalesced to one evaluation per frame. Popup animations produce a burst of
   * mutations, and the follow-ups catch the end of the transition — a menu that
   * is still fading in has not reached its final size yet, so a single check at
   * mutation time can measure the wrong rectangle.
   */
  let chromeSyncFrame = 0;
  let chromeSyncTail = 0;

  function scheduleChromeSync() {
    if (!chromeSyncFrame) {
      chromeSyncFrame = requestAnimationFrame(() => {
        chromeSyncFrame = 0;
        syncAutohide();
      });
    }
    // ONE trailing check, restarted on each burst rather than two more timers
    // per call — this runs off a capture-phase click listener, so a fast clicker
    // would otherwise stack dozens of pending timeouts.
    clearTimeout(chromeSyncTail);
    chromeSyncTail = setTimeout(syncAutohide, 320);
  }

  /**
   * YouTube marks the player `ytp-autohide` when its own controls hide — our
   * pill/gear/panel follow it so nothing floats over a clean video — and since
   * v3.3.2 they also get out of the way of YouTube's own menus.
   */
  function syncAutohide() {
    dockBesideNativeControls();
    const autohidden = !!autohidePlayer?.classList.contains('ytp-autohide');
    const rects = ytPopupRects();

    // Our own settings sheet and YouTube's are both "the settings", and two of
    // them open at once is nonsense. Ours closes — it is the guest here.
    if (panel && rects.length && collidesWithYouTube(panel, rects)) {
      closePanel();
    }

    for (const el of [controls, panel]) {
      if (!el) continue;
      const hidden = autohidden || collidesWithYouTube(el, rects);
      el.style.opacity = hidden ? '0' : '';
      el.style.pointerEvents = hidden ? 'none' : '';
      // `opacity:0` still leaves the element in the paint tree. `visibility`
      // takes it out entirely, so while the player's controls are hidden the
      // video is the only thing on screen — the state in which the GPU can
      // keep it on its own overlay plane (v2.0.1). The delayed transition
      // keeps the fade-out visible.
      el.style.visibility = hidden ? 'hidden' : '';
      el.style.transition = hidden
        ? 'opacity .25s, visibility 0s .25s'
        : 'opacity .25s, visibility 0s';
    }

    /**
     * The caption keeps painting and stops intercepting.
     *
     * It is draggable, which is why it takes pointer events at all; over a
     * YouTube menu that made the menu items underneath unclickable. Dropping
     * only the interaction costs the viewer nothing they can notice — the
     * caption is not something you drag while a menu is open — and it is the
     * whole of the harm.
     */
    if (overlayInner) {
      const blocked = collidesWithYouTube(overlayInner, rects);
      overlayInner.style.pointerEvents = blocked ? 'none' : '';
      overlayInner.classList.toggle('yielding', blocked);
    }
  }

  /**
   * Dock our three compact controls inside YouTube's own bottom control row.
   * The old floating pills sat above the scrubber, exactly where hover cards,
   * the heatmap and chapter detail appear. Measuring the native right-control
   * group gives us a stable free slot immediately beside it without depending
   * on YouTube's current button count, theatre mode or fullscreen size.
   */
  function dockBesideNativeControls() {
    if (!controls || !player) return;
    const native = player.querySelector('.ytp-right-controls');
    const playerRect = player.getBoundingClientRect();
    const nativeRect = native?.getBoundingClientRect();
    if (
      nativeRect && nativeRect.width > 8 && nativeRect.height > 8
      && playerRect.width > 0 && playerRect.height > 0
    ) {
      const right = Math.max(8, Math.round(playerRect.right - nativeRect.left + 6));
      const ownHeight = controls.getBoundingClientRect().height || 40;
      const bottom = Math.max(
        4,
        Math.round(playerRect.bottom - nativeRect.bottom + (nativeRect.height - ownHeight) / 2)
      );
      controls.style.right = `${right}px`;
      controls.style.bottom = `${bottom}px`;
      controls.classList.add('native-dock');
    } else {
      controls.style.right = '';
      controls.style.bottom = '';
      controls.classList.remove('native-dock');
    }
  }

  /**
   * Menus open and close by pointer and by keyboard, and both can happen without
   * mutating anything we observe (YouTube sometimes reuses a popup element and
   * only changes a descendant). Re-checking after any interaction with the
   * player is cheap insurance, and it is bounded: `scheduleChromeSync` collapses
   * a burst into one evaluation per frame.
   */
  for (const type of ['click', 'keydown']) {
    document.addEventListener(type, () => {
      if (controls) scheduleChromeSync();
    }, true);
  }
  window.addEventListener('resize', scheduleChromeSync, { passive: true });

  /**
   * The subtitle button.
   *
   * Idle → start the pipeline with the text on. Running → toggle the text. And
   * if turning the text off would leave nothing running at all, stop entirely,
   * because a pipeline producing neither output is just cost.
   */
  async function onPillClick() {
    if (state === 'loading') {
      userStoppedFor = info.videoId || '';
      stop();
      return;
    }
    if (state === 'idle') {
      // An explicit start clears a previous manual stop for this video, so
      // auto-start is free to take over again on the next one.
      userStoppedFor = '';
      lastCaptionError = '';
      globalThis.GXT.ui?.toast?.(globalThis.GXT.i18n.t("content_youtube_onPillClick_1"), 3500);
      if (!infoSeen || !hasTracks()) void send({type:'ENSURE_YOUTUBE_HELPER'}).then(() => requestInfo());
      requestInfo();
      setCaptionVisibility(true);
      void start();
      return;
    }
    const next = !visualWanted;
    if (!next && !dubOn()) {
      userStoppedFor = info.videoId || '';
      stop();
      return;
    }
    setCaptionVisibility(next);
    updatePill(pillDefaultLabel());
  }

  /**
   * The dub button — the whole point of v2.4.6's control rebuild.
   *
   * It starts the pipeline on its own when nothing is running, so wanting the
   * voice no longer means switching the subtitles on first.
   */
  /**
   * The voice button — routed by ENGINE, not by the caption pipeline (v3.1.0).
   *
   * The old version began `if (state === 'idle') … void start()`, i.e. every
   * request for a voice went through "fetch and translate the captions first".
   * For the live engine that is not merely unnecessary, it is wrong: it reads
   * nothing, so on a video with no captions the start it was waiting for could
   * never happen, and a caption fetch failure took the voice down with it.
   */
  async function onDubClick() {
    const next = !(dubOn() || dubStarting);
    const intent = ++dubIntentGen;
    dubStarting = next;
    if (settings) settings.ytDub = next;
    await globalThis.GXT.setSettings({ ytDub: next });
    if (intent !== dubIntentGen || !settings?.enabled || settings.youtube === false) return;

    if (!next) {
      stopDub();
      // If subtitles were never wanted either, there is nothing left to
      // produce — let the caption pipeline go rather than keep it warm.
      if (state !== 'idle' && !visualWanted) {
        userStoppedFor = info.videoId || '';
        stop();
        return;
      }
      updatePill(pillDefaultLabel());
      return;
    }

    // ── turning the voice ON ────────────────────────────────────────────
    if (!dubNeedsCaptions()) {
      // LIVE: needs sound and nothing else. Never waits for, and never fails
      // because of, a caption track.
      startDub();
      updatePill(pillDefaultLabel());
      return;
    }

    if (!hasTracks() && !knownCaptionless()) {
      flashPill(globalThis.GXT.i18n.t("content_youtube_onDubClick_3"));
      await awaitTracks();
      if (intent !== dubIntentGen || !settings?.ytDub) return;
      if (!hasTracks() && !knownCaptionless()) {
        dubStarting = false;
        flashPill(globalThis.GXT.i18n.t("content_youtube_onDubClick_2"));
        return;
      }
    }

    /**
     * CAPTION-DRIVEN, on a video with no captions — switch engines, do not
     * refuse (v3.1.0).
     *
     * Refusing with «go and choose the live engine in ⚙» was the first version
     * of this branch, and it is a worse answer than it looks: the user asked
     * for a Persian voice, exactly one engine on this machine can produce one
     * for this video, and they are being sent on an errand to enable it. So it
     * is enabled for them and reported plainly. The choice is persisted, since
     * the next caption-less video would otherwise ask the same question again.
     */
    if (knownCaptionless()) {
      if (settings) settings.ytDubEngine = 'live';
      await globalThis.GXT.setSettings({ ytDubEngine: 'live' });
      if (intent !== dubIntentGen || !settings?.ytDub) return;
      dubber?.configure(settings);
      startDub();
      flashPill(globalThis.GXT.i18n.t("content_youtube_onDubClick_1"));
      if (panel) { closePanel(); togglePanel(); }
      return;
    }
    if (state === 'loading') return; // the fetch it needs is already running
    if (state === 'idle') {
      userStoppedFor = '';
      setCaptionVisibility(false);
      void start(); // start() starts the dub once cues exist
      return;
    }
    // Already active. Speech needs SENTENCES, and the cue list was built as
    // reading-sized cues before dubbing was asked for.
    if (!settings?.ytSentenceMerge && !info.isLive) restartPipeline();
    else startDub();
    updatePill(pillDefaultLabel());
  }

  // ---------------------------------------------------------------- panel

  function closePanel() {
    panel?.remove();
    panel = null;
    bulkButton = null;
    bulkWarnBox = null;
    document.removeEventListener('pointerdown', onOutsidePanel, true);
    document.removeEventListener('keydown', onPanelKey, true);
  }

  /**
   * A click outside closes the sheet.
   *
   * v3.2.0 — the panel now lives in a shadow root, so `event.target` is the
   * shadow HOST for anything inside it, not the clicked node. `composedPath`
   * crosses the boundary, which is the only way to tell "inside the panel"
   * from "somewhere else in the player" now.
   */
  function onOutsidePanel(event) {
    if (!panel) return;
    const path = event.composedPath?.() || [event.target];
    if (path.includes(panel) || path.includes(gear)) return;
    closePanel();
  }

  // --- panel building blocks (shared styling) ----------------------------


  // ── panel primitives, on the design system (v3.2.0) ────────────────────
  //
  // Each of these used to write a `style.cssText` string with magic numbers.
  // `panelHeading` in particular set `font-size:10.5px` — below the 11px floor
  // dev/uicheck.html enforces on every other surface in the product.

  let rowSeq = 0;

  function panelRow(labelText, control) {
    const row = el('div', 'yt-row');
    const label = el('span', 'yt-lbl', labelText);
    // A real label association, so the control is named for a screen reader
    // rather than being an anonymous <select> next to some text.
    const id = `gxt-yt-c${(rowSeq += 1)}`;
    if (control && !control.id) control.id = id;
    if (control?.id) label.setAttribute('for', control.id);
    const tag = control?.tagName;
    if (tag === 'SELECT' || tag === 'INPUT') {
      control.setAttribute('aria-label', labelText);
    }
    row.append(label, control);
    return row;
  }

  const panelHeading = (text) => el('div', 'yt-group', text);

  function panelSelect(options, value, onChange) {
    const sel = document.createElement('select');
    for (const [val, label] of options) {
      const option = document.createElement('option');
      option.value = val;
      option.textContent = label;
      sel.appendChild(option);
    }
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  /**
   * A switch row — the SAME control as the popup (v3.2.0).
   *
   * This was a bare `<input type="checkbox">` with `accent-color`, which is the
   * single most visible reason the panel read as a different product: every
   * other toggle in the extension is a designed track-and-knob switch.
   */
  function panelToggle(labelText, checked, onChange) {
    const wrap = el('label', 'yt-switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', labelText);
    input.addEventListener('change', () => onChange(input.checked));
    wrap.append(input, el('span', 'track'));
    const row = panelRow(labelText, wrap);
    // The label points at the input, not at the wrapper.
    row.querySelector('.yt-lbl')?.setAttribute('for', input.id || '');
    return row;
  }

  /** Escape closes the sheet — it had no keyboard exit at all before v3.2.0. */
  function onPanelKey(event) {
    if (event.key !== 'Escape' || !panel) return;
    event.stopPropagation();
    closePanel();
    gear?.focus();
  }

  function togglePanel() {
    if (panel) return closePanel();
    if (!player) return;
    const active = state === 'active';
    panel = document.createElement('div');
    panel.id = 'gxt-yt-panel';
    panel.className = 'yt-panel';
    panel.setAttribute('role', 'dialog');
    globalThis.GXT.i18n.bind(panel,'ariaLabel',()=>(globalThis.GXT.i18n.t("content_youtube_togglePanel_82")));
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    /**
     * A real card: a fixed head and a scrolling body (v3.2.0).
     *
     * The old panel was one scrolling block, so the title scrolled away and
     * there was no close affordance at all — the only way out was to find the
     * gear again behind the panel. It is also the popup's card structure now,
     * which is the point.
     */
    const head = el('div', 'yt-panel-head');
    head.append(el('h2', '', globalThis.GXT.i18n.t("content_youtube_togglePanel_81")));
    const closeBtn = ytButton('✕', globalThis.GXT.i18n.t("content_manga_finish_1"), 'icon');
    closeBtn.classList.add('quiet');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closePanel();
      gear?.focus();
    });
    head.append(closeBtn);
    panel.append(head);

    const body = el('div', 'yt-panel-body');
    panel.append(body);
    const tabs = el('div', 'yt-tabs');
    tabs.setAttribute('role', 'tablist');
    const paneWrap = el('div', 'yt-panes');
    const panes = {};
    const tabButtons = {};
    for (const [id, label] of [
      ['caption', globalThis.GXT.i18n.t("shared_video_sources_label_1")], ['dub', globalThis.GXT.i18n.t("content_web_video_createManager_28")], ['look', globalThis.GXT.i18n.t("content_youtube_togglePanel_80")],
    ]) {
      const tab = el('button', 'yt-tab', label);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => showPane(id));
      tabs.append(tab);
      tabButtons[id] = tab;
      const pane = el('section', 'yt-pane');
      pane.setAttribute('role', 'tabpanel');
      paneWrap.append(pane);
      panes[id] = pane;
    }
    body.append(tabs, paneWrap);
    let appendTarget = panes.caption;
    // Keep the many setting builders below simple while routing each section
    // into a dedicated pane instead of one exhausting scroll.
    panel.append = (...nodes) => appendTarget.append(...nodes);
    function showPane(id) {
      panelTab = panes[id] ? id : 'caption';
      for (const name of Object.keys(panes)) {
        const activePane = name === panelTab;
        panes[name].hidden = !activePane;
        tabButtons[name].classList.toggle('active', activePane);
        tabButtons[name].setAttribute('aria-selected', activePane ? 'true' : 'false');
      }
    }
    const usePane = (id) => { appendTarget = panes[id]; };
    showPane(panelTab);

    const dashboard = el('div', 'yt-dashboard');
    const captionCard = el('div', 'yt-state-card');
    captionCard.append(
      el('strong', '', globalThis.GXT.i18n.t("shared_video_sources_label_1")),
      el('span', '', knownCaptionless() ? globalThis.GXT.i18n.t("content_youtube_togglePanel_79") : state === 'active' ? globalThis.GXT.i18n.t("content_youtube_togglePanel_78") : state === 'loading' ? globalThis.GXT.i18n.t("content_youtube_togglePanel_77") : globalThis.GXT.i18n.t("content_youtube_togglePanel_76"))
    );
    const dubCard = el('div', 'yt-state-card');
    dubCard.append(
      el('strong', '', globalThis.GXT.i18n.t("content_web_video_createManager_28")),
      el('span', '', dubOn() ? globalThis.GXT.i18n.t("content_youtube_togglePanel_75") : globalThis.GXT.i18n.t("content_youtube_togglePanel_74"))
    );
    dashboard.append(captionCard, dubCard);
    panel.append(dashboard);

    // --- section: source & engine ---
    panel.append(panelHeading(globalThis.GXT.i18n.t("content_youtube_togglePanel_72")));

    // Source caption track (only meaningful when >1 track exists).
    const tracks = info.tracks || [];
    if (tracks.length > 1) {
      const def = defaultTrack();
      const current = pickTrack();
      const trackSelect = panelSelect(
        tracks.map((t) => [
          trackId(t),
          trackLabel(t) + (def && trackId(t) === trackId(def) ? globalThis.GXT.i18n.t("content_youtube_trackSelect_1") : ''),
        ]),
        current ? trackId(current) : '',
        (id) => switchTrack(id)
      );
      panel.append(panelRow(globalThis.GXT.i18n.t("content_youtube_togglePanel_73"), trackSelect));
    }

    // Engine override, just for YouTube.
    const engineSelect = panelSelect(
      [
        ['inherit', globalThis.GXT.i18n.t("content_youtube_engineSelect_3")],
        ['gemini', 'Google Gemini'],
        ['openai', globalThis.GXT.i18n.t("shared_settings_TTS_ENGINES_4")],
        ['google', globalThis.GXT.i18n.t("content_youtube_engineSelect_2")],
        ['bing', globalThis.GXT.i18n.t("content_youtube_engineSelect_1")],
      ],
      settings?.ytProvider || 'inherit',
      (val) => void globalThis.GXT.setSettings({ ytProvider: val })
    );
    panel.append(panelRow(globalThis.GXT.i18n.t("content_youtube_togglePanel_72"), engineSelect));

    const targetInput=document.createElement('input');targetInput.type='text';
    targetInput.value=settings?.ytTargetLang || 'fa';
    globalThis.GXT.i18n.bind(targetInput,'ariaLabel',()=>globalThis.GXT.i18n.t('content_youtube_togglePanel_71'));
    panel.append(panelRow(globalThis.GXT.i18n.t('content_youtube_togglePanel_71'),targetInput));
    // The panel may still be detached; use its own datalist until mounted.
    globalThis.GXT.targetInput(targetInput);
    targetInput.addEventListener('change',()=>{if(globalThis.GXT.validTarget(targetInput.value))void globalThis.GXT.setSettings({ytTargetLang:targetInput.value});else targetInput.reportValidity();});
    const modelRow = el('label', 'yt-field');
    modelRow.append(el('span', '', globalThis.GXT.i18n.t("content_youtube_togglePanel_69")));
    const modelInput = document.createElement('input'); modelInput.type='text'; modelInput.dir='ltr';
    modelInput.value=settings?.ytModel || ''; modelInput.maxLength=160;
    globalThis.GXT.i18n.bind(modelInput,'ariaLabel',()=>(globalThis.GXT.i18n.t("content_youtube_togglePanel_68")));
    modelInput.addEventListener('change',()=>void globalThis.GXT.setSettings({ytModel:modelInput.value.trim()}));
    modelRow.append(modelInput); panel.append(modelRow);

    // v2.1.0: start on every video by itself, with these same settings.
    panel.append(
      panelToggle(globalThis.GXT.i18n.t("content_youtube_togglePanel_67"), settings?.ytAuto === true, (on) => {
        void globalThis.GXT.setSettings({ ytAuto: on });
        if (settings) settings.ytAuto = on;
        // Turning it on should apply to the video already open, not only the
        // next one — otherwise the switch looks broken.
        if (on) {
          userStoppedFor = '';
          maybeAutoStart();
        }
      })
    );

    // v1.8: sentence merging (quality) + bilingual display, both persisted.
    panel.append(
      panelToggle(globalThis.GXT.i18n.t("content_youtube_togglePanel_66"), settings?.ytSentenceMerge === true, (on) => {
        void globalThis.GXT.setSettings({ ytSentenceMerge: on });
        if (settings) settings.ytSentenceMerge = on;
        if (state === 'active') restartPipeline();
      })
    );
    panel.append(
      panelToggle(globalThis.GXT.i18n.t("content_youtube_togglePanel_65"), settings?.ytBilingual === true, (on) => {
        void globalThis.GXT.setSettings({ ytBilingual: on });
        if (settings) settings.ytBilingual = on;
        lastShown = undefined;
        tick();
      })
    );

    // --- active-only: full-video + buffer window ---
    if (active) {
      bulkButton = ytButton('', globalThis.GXT.i18n.t("content_youtube_togglePanel_64"), '');
      bulkButton.classList.add('yt-bulk');
      // Progress paints INSIDE the button, so the percentage appears where the
      // action is instead of in a separate widget beside it.
      bulkButton.prepend(el('span', 'fill'));
      bulkButton.addEventListener('click', () => void bulkTranslate());
      updateBulkButton();
      const bulkHint = document.createElement('div');
      globalThis.GXT.i18n.bind(bulkHint, "textContent", () => (globalThis.GXT.i18n.t("content_youtube_togglePanel_63")));
      bulkHint.className = 'yt-note';
      bulkWarnBox = null;

      const aheadSelect = panelSelect(
        AHEAD_CHOICES.map(([seconds, label]) => [String(seconds), label]),
        String(clamp(Number(settings?.ytAheadSec) || 90, 30, 600)),
        (val) => void globalThis.GXT.setSettings({ ytAheadSec: parseInt(val, 10) })
      );
      // v1.8: export what's translated so far (untranslated lines keep the
      // original text) as a standard SRT file.
      const srtBtn = ytButton(globalThis.GXT.i18n.t("content_youtube_srtBtn_2"), globalThis.GXT.i18n.t("content_youtube_srtBtn_1"));
      srtBtn.classList.add('wide');
      srtBtn.addEventListener('click', downloadSrt);
      panel.append(bulkButton, bulkHint, panelRow(globalThis.GXT.i18n.t("content_youtube_togglePanel_62"), aheadSelect), srtBtn);
    } else {
      bulkButton = null;
      const hint = document.createElement('div');
      globalThis.GXT.i18n.bind(hint, "textContent", () => (globalThis.GXT.i18n.t("content_youtube_togglePanel_61")));
      hint.className = 'yt-note';
      panel.append(hint);
    }

    /**
     * --- section: dubbing (v2.4.0) ---
     *
     * v3.1.0 — no longer gated on the CAPTION pipeline being active.
     *
     * The old condition was `state === 'active'`, reasoned as "there is
     * nothing to speak before the first line has been translated". That is
     * true of the caption-driven engine and false of the live one, which
     * translates the audio and needs no line at all. The consequence was the
     * second half of the reported bug: on a caption-less video the only place
     * to choose «صدای زنده» was inside a panel section that required captions
     * to be running — so the engine that works without captions could not be
     * selected without them.
     *
     * The section now appears whenever the dub module is loaded. Individual
     * rows that genuinely need cues say so themselves.
     */
    usePane('dub');
    if (globalThis.GXT.dub) {
      panel.append(panelHeading(globalThis.GXT.i18n.t("content_youtube_togglePanel_60")));
      const homeNote = document.createElement('div');
      globalThis.GXT.i18n.bind(homeNote, "textContent", () => (globalThis.GXT.i18n.t("content_youtube_togglePanel_59")));
      homeNote.className = 'yt-hint';
      panel.append(homeNote);
      panel.append(
        panelToggle(globalThis.GXT.i18n.t("content_youtube_togglePanel_58"), settings?.ytDub === true, (on) => {
          void globalThis.GXT.setSettings({ ytDub: on });
          if (settings) settings.ytDub = on;
          if (on) {
            if (!dubNeedsCaptions()) {
              startDub();
            } else if (knownCaptionless()) {
              if (settings) settings.ytDubEngine = 'live';
              void globalThis.GXT.setSettings({ ytDubEngine: 'live' });
              startDub();
            } else if (state === 'idle') {
              setCaptionVisibility(false);
              void start();
            } else if (!settings?.ytSentenceMerge && !info.isLive) {
              restartPipeline();
            } else {
              startDub();
            }
          } else {
            stopDub();
            if (state === 'active' && !visualWanted) stop();
          }
          // Redraw so the dependent rows appear/disappear.
          if (panel) { closePanel(); togglePanel(); }
        })
      );

      dubStatusEl = document.createElement('div');
      dubStatusEl.className = 'yt-status';
      panel.append(dubStatusEl);
      paintDubStatus();

      /**
       * The ENGINE choice is always visible (v3.1.0).
       *
       * It used to sit behind `if (settings?.ytDub)`, which completed the
       * chicken-and-egg: to select «صدای زنده» you had to turn dubbing on
       * first, but turning it on with the caption engine is impossible on a
       * video with no captions — which is the only situation where you needed
       * «صدای زنده» in the first place.
       *
       * Choosing an engine while the voice is off is a perfectly meaningful
       * preference, so it is offered like any other preference.
       */
      {
        panel.append(
          panelRow(
            globalThis.GXT.i18n.t("content_youtube_togglePanel_57"),
            panelSelect(
              [['caption', globalThis.GXT.i18n.t("content_youtube_togglePanel_56")], ['live', globalThis.GXT.i18n.t("content_youtube_togglePanel_55")]],
              dubEngineName(),
              (val) => {
                void globalThis.GXT.setSettings({ ytDubEngine: val });
                if (settings) settings.ytDubEngine = val;
                dubber?.configure(settings);
                dubber?.setMode(val);
                if (panel) { closePanel(); togglePanel(); }
              }
            )
          )
        );
        const engineHint = document.createElement('div');
        globalThis.GXT.i18n.bind(engineHint, "textContent", () => (dubEngineName() === 'live'
            ? globalThis.GXT.i18n.t("content_youtube_togglePanel_54") +
              globalThis.GXT.i18n.t("content_youtube_togglePanel_53")
            : globalThis.GXT.i18n.t("content_youtube_togglePanel_52") +
              globalThis.GXT.i18n.t("content_youtube_togglePanel_51")));
        engineHint.className = 'yt-hint';
        panel.append(engineHint);
      }

      if (settings?.ytDub && dubEngineName() === 'live') {
        panel.append(
          panelRow(
            globalThis.GXT.i18n.t("content_youtube_togglePanel_50"),
            panelSelect(
              [
                ['', globalThis.GXT.i18n.t("content_youtube_togglePanel_49")],
                ['en', globalThis.GXT.i18n.t("content_youtube_togglePanel_48")],
                ['ja', globalThis.GXT.i18n.t("content_youtube_togglePanel_47")],
                ['ko', globalThis.GXT.i18n.t("content_youtube_togglePanel_46")],
                ['zh', globalThis.GXT.i18n.t("content_youtube_togglePanel_45")],
                ['ru', globalThis.GXT.i18n.t("content_youtube_togglePanel_44")],
                ['ar', globalThis.GXT.i18n.t("content_youtube_togglePanel_43")],
                ['tr', globalThis.GXT.i18n.t("content_youtube_togglePanel_42")],
                ['es', globalThis.GXT.i18n.t("content_youtube_togglePanel_41")],
                ['fr', globalThis.GXT.i18n.t("content_youtube_togglePanel_40")],
                ['de', globalThis.GXT.i18n.t("content_youtube_togglePanel_39")],
                ['hi', globalThis.GXT.i18n.t("content_youtube_togglePanel_38")],
                ['th', globalThis.GXT.i18n.t("content_youtube_togglePanel_37")],
              ],
              settings?.ytLiveSourceLang || '',
              (val) => {
                void globalThis.GXT.setSettings({ ytLiveSourceLang: val });
                if (settings) settings.ytLiveSourceLang = val;
                dubber?.configure(settings);
              }
            )
          )
        );
        const langHint = document.createElement('div');
        globalThis.GXT.i18n.bind(langHint, "textContent", () => (globalThis.GXT.i18n.t("content_youtube_togglePanel_36") +
          globalThis.GXT.i18n.t("content_youtube_togglePanel_35") +
          globalThis.GXT.i18n.t("content_youtube_togglePanel_34")));
        langHint.className = 'yt-hint';
        panel.append(langHint);
      }

      if (settings?.ytDub && dubEngineName() === 'caption') {
        panel.append(
          panelToggle(globalThis.GXT.i18n.t("content_youtube_togglePanel_33"), settings?.ytDubCompress !== false, (on) => {
            void globalThis.GXT.setSettings({ ytDubCompress: on });
            if (settings) settings.ytDubCompress = on;
            dubber?.configure(settings);
          })
        );
        const compressHint = document.createElement('div');
        globalThis.GXT.i18n.bind(compressHint, "textContent", () => (canCompress()
          ? globalThis.GXT.i18n.t("content_youtube_togglePanel_32") +
            globalThis.GXT.i18n.t("content_youtube_togglePanel_31")
          : globalThis.GXT.i18n.t("content_youtube_togglePanel_30")));
        compressHint.className = 'yt-hint';
        panel.append(compressHint);
      }

      if (settings?.ytDub) {
        panel.append(
          panelRow(
            globalThis.GXT.i18n.t("content_youtube_togglePanel_29"),
            panelSelect(
              [['0', globalThis.GXT.i18n.t("content_youtube_togglePanel_28")], ['8', globalThis.GXT.i18n.t("content_youtube_togglePanel_27")], ['12', globalThis.GXT.i18n.t("content_youtube_togglePanel_26")], ['20', globalThis.GXT.i18n.t("content_youtube_togglePanel_25")], ['35', globalThis.GXT.i18n.t("content_youtube_togglePanel_24")]],
              String(clamp(Number(
                dubEngineName() === 'live' ? (settings?.ytLiveDuck ?? 10) : (settings?.ytDubDuck ?? 12)
              ), 0, 100)),
              (val) => {
                const key = dubEngineName() === 'live' ? 'ytLiveDuck' : 'ytDubDuck';
                void globalThis.GXT.setSettings({ [key]: parseInt(val, 10) });
                if (settings) settings[key] = parseInt(val, 10);
                dubber?.configure(settings);
              }
            )
          )
        );
        if (dubEngineName() === 'caption') panel.append(
          panelRow(
            globalThis.GXT.i18n.t("content_youtube_togglePanel_23"),
            panelSelect(
              [
                ['1', globalThis.GXT.i18n.t("content_youtube_togglePanel_22")],
                ['1.2', globalThis.GXT.i18n.t("content_youtube_togglePanel_21")],
                ['1.3', globalThis.GXT.i18n.t("content_youtube_togglePanel_20")],
                ['1.5', globalThis.GXT.i18n.t("content_youtube_togglePanel_19")],
                ['1.75', globalThis.GXT.i18n.t("content_youtube_togglePanel_18")],
              ],
              String(Number(settings?.ytDubMaxRate) || 1.3),
              (val) => {
                void globalThis.GXT.setSettings({ ytDubMaxRate: Number(val) });
                if (settings) settings.ytDubMaxRate = Number(val);
                dubber?.configure(settings);
              }
            )
          )
        );
        if (dubEngineName() === 'caption') panel.append(
          panelRow(
            globalThis.GXT.i18n.t("content_youtube_togglePanel_17"),
            panelSelect(
              [['live', globalThis.GXT.i18n.t("content_youtube_togglePanel_16")], ['full', globalThis.GXT.i18n.t("content_youtube_togglePanel_15")]],
              settings?.ytDubMode === 'full' ? 'full' : 'live',
              (val) => {
                void globalThis.GXT.setSettings({ ytDubMode: val });
                if (settings) settings.ytDubMode = val;
                dubber?.configure(settings);
              }
            )
          )
        );
        const modeHint = document.createElement('div');
        globalThis.GXT.i18n.bind(modeHint, "textContent", () => (globalThis.GXT.i18n.t("content_youtube_togglePanel_14") +
          globalThis.GXT.i18n.t("content_youtube_togglePanel_13")));
        modeHint.className = 'yt-hint';
        panel.append(modeHint);

        const dubHint = document.createElement('div');
        globalThis.GXT.i18n.bind(dubHint, "textContent", () => (globalThis.GXT.i18n.t("content_youtube_togglePanel_12") +
          globalThis.GXT.i18n.t("content_youtube_togglePanel_11") +
          globalThis.GXT.i18n.t("content_youtube_togglePanel_10")));
        dubHint.className = 'yt-hint';
        panel.append(dubHint);
      }
    } else {
      dubStatusEl = null;
    }

    // --- section: appearance ---
    usePane('look');
    panel.append(panelHeading(globalThis.GXT.i18n.t("content_youtube_togglePanel_9")));

    const fontSelect = panelSelect(
      [
        ['inherit', globalThis.GXT.i18n.t("content_youtube_fontSelect_2")],
        ['Vazirmatn', globalThis.GXT.i18n.t("content_youtube_fontSelect_1")],
        ['Shabnam', globalThis.GXT.i18n.t("shared_settings_BUNDLED_FONTS_3")],
        ['Sahel', globalThis.GXT.i18n.t("shared_settings_BUNDLED_FONTS_2")],
        ['Samim', globalThis.GXT.i18n.t("shared_settings_BUNDLED_FONTS_1")],
      ],
      settings?.ytFont || 'inherit',
      (val) => void globalThis.GXT.setSettings({ ytFont: val })
    );
    panel.append(panelRow(globalThis.GXT.i18n.t("content_youtube_togglePanel_8"), fontSelect));

    const sizeInput = document.createElement('input');
    sizeInput.type = 'range';
    sizeInput.min = '60';
    sizeInput.max = '220';
    sizeInput.step = '10';
    sizeInput.value = String(Math.round((settings?.ytScale || 1) * 100));
    sizeInput.className = 'yt-range';
    sizeInput.addEventListener('input', () => {
      // Live preview while sliding; persisted on release.
      if (settings) settings.ytScale = parseInt(sizeInput.value, 10) / 100;
      applyAppearance();
    });
    sizeInput.addEventListener('change', () => {
      void globalThis.GXT.setSettings({ ytScale: parseInt(sizeInput.value, 10) / 100 });
    });
    panel.append(panelRow(globalThis.GXT.i18n.t("content_youtube_togglePanel_7"), sizeInput));

    // v3.2.5 — the subtitle box joined the design system, so the choice it used
    // to make silently (always the near-black bar) is now the user's.
    const capSelect = panelSelect(
      [
        ['theme', globalThis.GXT.i18n.t("content_youtube_capSelect_2")],
        ['plain', globalThis.GXT.i18n.t("content_youtube_capSelect_1")],
      ],
      settings?.ytCapTheme === 'plain' ? 'plain' : 'theme',
      (val) => {
        void globalThis.GXT.setSettings({ ytCapTheme: val });
        if (settings) settings.ytCapTheme = val;
        applyAppearance();
      }
    );
    panel.append(panelRow(globalThis.GXT.i18n.t("content_youtube_togglePanel_6"), capSelect));
    const capHint = document.createElement('div');
    globalThis.GXT.i18n.bind(capHint, "textContent", () => (globalThis.GXT.i18n.t("content_youtube_togglePanel_5") +
      globalThis.GXT.i18n.t("content_youtube_togglePanel_4") +
      globalThis.GXT.i18n.t("content_youtube_togglePanel_3")));
    capHint.className = 'yt-hint';
    panel.append(capHint);

    // --- section: position ---
    panel.append(panelHeading(globalThis.GXT.i18n.t("content_youtube_togglePanel_2")));
    const posHint = document.createElement('div');
    globalThis.GXT.i18n.bind(posHint, "textContent", () => (globalThis.GXT.i18n.t("content_youtube_togglePanel_1")));
    posHint.className = 'yt-note';
    const resetBtn = ytButton(globalThis.GXT.i18n.t("content_youtube_resetBtn_2"), globalThis.GXT.i18n.t("content_youtube_resetBtn_1"));
    resetBtn.classList.add('wide');
    resetBtn.addEventListener('click', () => {
      sizeInput.value = '100';
      if (settings) settings.ytScale = 1;
      applyAppearance();
      void globalThis.GXT.setSettings({ ytPosX: 50, ytPosY: 11, ytScale: 1 });
    });
    panel.append(posHint, resetBtn);

    const surface = ensureSurface();
    if (surface) surface.appendChild(panel);
    // Focus enters the sheet so Escape and Tab work — the panel had no keyboard
    // entry point at all before v3.2.0.
    closeBtn.focus?.({ preventScroll: true });
    document.addEventListener('pointerdown', onOutsidePanel, true);
    document.addEventListener('keydown', onPanelKey, true);
    syncAutohide();
  }

  /** Inline warning shown before an unusually long full-video translation. */
  let bulkWarnBox = null;

  /**
   * v3.2.5 — on the design system, like the panel it appears inside.
   *
   * This was the last hand-styled surface in the in-player UI, and it was the
   * most conspicuous one: a warning drawn in hand-picked amber and grey
   * literals, at a type size below the 11px floor the rest of the product
   * enforces, with two buttons that were plain `<button>`s — no focus ring, no
   * hover, no reduced-motion, no forced-colours treatment — appearing INSIDE the
   * settings sheet, directly under a themed progress button. It is `.yt-callout`
   * now: the same component as content/ui.js's `.callout`, on the status ramp, so
   * it is a legible amber on «کاغذی» and on «نیمه‌شب» in the way each needs.
   *
   * `role="status"` (set on the callout) matters here beyond tidiness: this box
   * appears in response to pressing the full-video button and it is the ONLY
   * feedback that the press did not start anything. Silent before.
   */
  function showBulkWarning(words) {
    if (!panel || bulkWarnBox) return;
    bulkWarnBox = el('div', 'yt-callout');
    bulkWarnBox.setAttribute('role', 'status');
    bulkWarnBox.append(
      el(
        'div',
        '',
        globalThis.GXT.i18n.t("content_youtube_showBulkWarning_1", {v0:(faNum(words))})
      )
    );

    const proceed = ytButton(globalThis.GXT.i18n.t("content_youtube_proceed_2"), globalThis.GXT.i18n.t("content_youtube_proceed_1"));
    proceed.classList.add('primary');
    proceed.addEventListener('click', () => {
      bulkConfirmed = true;
      bulkWarnBox?.remove();
      bulkWarnBox = null;
      void bulkTranslate();
    });
    const keepRolling = ytButton(globalThis.GXT.i18n.t("content_youtube_keepRolling_2"), globalThis.GXT.i18n.t("content_youtube_keepRolling_1"));
    keepRolling.addEventListener('click', () => {
      bulkWarnBox?.remove();
      bulkWarnBox = null;
      // Focus would otherwise land on <body> — i.e. outside the sheet — which
      // for a keyboard user means being dropped out of the panel by dismissing
      // a warning inside it.
      bulkButton?.focus?.({ preventScroll: true });
    });

    const row = el('div', 'yt-actions');
    row.append(proceed, keepRolling);
    bulkWarnBox.append(row);
    bulkButton.insertAdjacentElement('afterend', bulkWarnBox);
  }

  function translatedCount() {
    if (!cues) return 0;
    let n = 0;
    for (const cue of cues) if (cue.fa) n += 1;
    return n;
  }

  function updateBulkButton(pct) {
    if (!bulkButton || !cues) return;
    // `setLabel`, not `textContent`: the button also contains the progress
    // fill, and writing textContent would delete it (v3.2.0).
    if (bulkRunning) {
      setLabel(bulkButton, globalThis.GXT.i18n.t("content_youtube_updateBulkButton_3", {v0:(faNum(pct ?? 0))}));
    } else if (translatedCount() >= cues.length) {
      setLabel(bulkButton, globalThis.GXT.i18n.t("content_youtube_updateBulkButton_2"));
    } else {
      setLabel(bulkButton, globalThis.GXT.i18n.t("content_youtube_updateBulkButton_1", {v0:(faNum(cues.length - translatedCount()))}));
    }
    const fill = bulkButton.querySelector('.fill');
    if (fill) fill.style.width = bulkRunning ? `${pct ?? 0}%` : '0';
    bulkButton.setAttribute('aria-pressed', bulkRunning ? 'true' : 'false');
  }

  // ----------------------------------------------------------------- track

  /** Stable identity of a caption track within a video (lang+kind+name). */
  function trackId(t) {
    return `${t?.lang || ''}|${t?.kind || ''}|${t?.name || ''}`;
  }

  /** Human-readable label for the source-track dropdown. */
  function trackLabel(t) {
    const name = (t.name || '').trim();
    const base = name || (t.lang ? t.lang.toUpperCase() : globalThis.GXT.i18n.t("shared_video_sources_label_1"));
    return t.kind === 'asr' ? globalThis.GXT.i18n.t("content_youtube_trackLabel_1", {v0:(base)}) : base;
  }

  /** Default source track: a real (non-ASR) track first, else the first one. */
  function defaultTrack() {
    const tracks = info.tracks || [];
    return tracks.find((t) => t.kind !== 'asr') || tracks[0] || null;
  }

  function pickTrack() {
    const tracks = info.tracks || [];
    if (selectedTrackId) {
      const chosen = tracks.find((t) => trackId(t) === selectedTrackId);
      if (chosen) return chosen;
    }
    return defaultTrack();
  }

  /** Up to 4 preceding source lines, so a batch is never translated cold. */
  function contextFor(firstIdx, lastIdx = firstIdx) {
    if (!cues) return null;
    const out = [];
    for (let i = Math.max(0, firstIdx - 4); i < firstIdx; i++) out.push(cues[i].orig);
    for (let i = lastIdx + 1; i < Math.min(cues.length, lastIdx + 3); i++) out.push(cues[i].orig);
    return out.length ? out : null;
  }

  // ------------------------------------------------- caption URL building
  //
  // YouTube stamps caption baseUrls with `exp=xpe`: fetched programmatically
  // they return an EMPTY 200 body unless a runtime proof-of-origin token
  // (`pot`) is attached. The player mints that token itself, so yt-main.js
  // captures the URL the player actually requests and we prefer it.

  /** @type {{url:string, v:string, lang:string}[]} recent player caption URLs */
  const capturedUrls = [];
  const capturedBodies = [];
  let lastCaptionError = '';
  let captionCaptureRevision = 0;
  let captionProbeId = 0;
  const captionFetches = new Set();

  function noteCapturedCaptionUrl(raw) {
    try {
      if (typeof raw !== 'string' || !raw.trim()) return;
      const u = new URL(raw, location.href);
      if (u.protocol !== 'https:' || !/(^|\.)youtube\.com$/.test(u.hostname) || u.pathname !== '/api/timedtext') return;
      const entry = {
        url: u.toString(),
        v: u.searchParams.get('v') || '',
        // Native auto-translation adds tlang but lang remains the ORIGINAL
        // track. Losing lang here made that viewer setting break acquisition.
        lang: u.searchParams.get('lang') || '',
        targetLang: u.searchParams.get('tlang') || '',
        kind: u.searchParams.get('kind') || '',
      };
      if (capturedUrls.some((c) => c.url === entry.url)) return;
      capturedUrls.push(entry);
      captionCaptureRevision += 1;
      if (capturedUrls.length > 16) capturedUrls.shift();
    } catch {
      /* unparseable URL: ignore */
    }
  }

  const setParam = (raw, key, value) => {
    try {
      if (typeof raw !== 'string' || !raw.trim()) return null;
      const u = new URL(raw, location.href);
      u.searchParams.set(key, value);
      return u.toString();
    } catch {
      return null;
    }
  };

  /** Force fmt=json3 (a baseUrl may already carry fmt=srv3, which would
   *  otherwise hand us XML that JSON.parse chokes on). */
  const asJson3 = (raw) => {
    const result = setParam(raw, 'fmt', 'json3');
    if (!result) return null;
    const url = new URL(result);
    // Translate the original once in our selected engine. Native YouTube's
    // target language is a viewer preference, not the source-track identity.
    url.searchParams.delete('tlang');
    return url.toString();
  };

  /** Drop only the `xpe` experiment, preserving any other exp values. */
  function stripXpe(raw) {
    try {
      const u = new URL(raw, location.href);
      const exps = u.searchParams.getAll('exp');
      if (!exps.some((value) => value.split(',').includes('xpe'))) return null;
      u.searchParams.delete('exp');
      for (const value of exps) {
        const keep = value.split(',').filter((part) => part !== 'xpe').join(',');
        if (keep) u.searchParams.append('exp', keep);
      }
      return u.toString();
    } catch {
      return null;
    }
  }

  /**
   * A pot token harvested from any caption URL the player issued.
   *
   * Unlike a whole URL, a token is not video-specific — it is a proof that this
   * browser session is a real player — so this deliberately does NOT filter by
   * video id. Borrowing a token across videos is the intended behaviour and is
   * what makes the second video of a session fast.
   */
  function capturedPot() {
    for (let i = capturedUrls.length - 1; i >= 0; i -= 1) {
      try {
        const pot = new URL(capturedUrls[i].url).searchParams.get('pot');
        if (pot) return pot;
      } catch {
        /* ignore */
      }
    }
    return '';
  }

  /**
   * Drop captured URLs belonging to other videos — v3.3.0.
   *
   * `resetForNewVideo` cleared eleven pieces of state and not this one, so the
   * cache accumulated across every video in the session. Combined with the
   * `!c.v` hole in `pickCapturedUrl` that meant a video could be served another
   * video's captions.
   *
   * URLs for the video we are ON are kept (a navigation back to it should not
   * throw away a good token), and so is anything still useful as a TOKEN
   * source — see `capturedPot`. Only the misleading ones go.
   */
  function forgetCapturedUrls(keepVideoId) {
    for (let i = capturedUrls.length - 1; i >= 0; i -= 1) {
      const entry = capturedUrls[i];
      const sameVideo = keepVideoId && entry.v === keepVideoId;
      const hasToken = entry.url.includes('pot=');
      if (!sameVideo && !hasToken) capturedUrls.splice(i, 1);
    }
  }

  /**
   * Player-issued URL for this video, preferring the requested language.
   *
   * v3.3.0 — the video match is no longer optional. This filter was
   * `(c) => !c.v || !vid || c.v === vid`, which accepts any entry whose URL
   * happened to carry no `v` parameter, from any video, for ever — and the cache
   * was never cleared on navigation (see `forgetCapturedUrls`). So after
   * watching two videos, the second could be handed the first one's caption URL
   * and would cheerfully display the wrong subtitles. Wrong text is a worse
   * outcome than no text, and it is silent.
   *
   * An entry with no `v` is now only usable while we do not know our own id
   * either, which is the genuinely ambiguous case rather than a licence.
   */
  function pickCapturedUrl(track) {
    const vid = info.videoId;
    const mine = capturedUrls.filter((c) =>
      (vid ? c.v === vid : !c.v) && c.kind === (track?.kind || '')
    );
    const exact = mine.filter((c) => c.lang && track?.lang && c.lang === track.lang);
    if (exact.length) {
      const originals = exact.filter((c) => !c.targetLang);
      const chosen = originals.length ? originals[originals.length - 1] : exact[exact.length - 1];
      const url = new URL(chosen.url);
      url.searchParams.delete('tlang');
      return url.toString();
    }
    /**
     * NEVER SUBSTITUTE ANOTHER LANGUAGE — v3.3.0.
     *
     * This fell back to `mine[mine.length - 1]`: the most recent captured URL,
     * whatever language it was for. And a captured URL is the FIRST candidate
     * `candidateUrls` tries, precisely because it carries a working token — so
     * when the user had chosen the Japanese source track and the player happened
     * to have fetched English, the English captions were downloaded, translated,
     * and displayed as the Japanese ones. Wrong text presented confidently is a
     * worse failure than no text, and nothing about it looks like a bug.
     *
     * A captured URL is only a substitute when there is no language to disagree
     * about — either the track does not name one, or the captured URL does not.
     * Otherwise the `pot` token is still borrowed (see `capturedPot`, which is
     * language-independent by nature) and applied to this track's own baseUrl,
     * which is the correct way to get here.
     */
    const languageless = mine.filter((c) => !c.lang || !track?.lang);
    const chosen = languageless[languageless.length - 1];
    return chosen ? chosen.url : '';
  }

  function captionBodyEvents(body) {
    if (typeof body !== 'string' || body.length > 2 * 1024 * 1024) return null;
    try {
      const events=JSON.parse(body)?.events;
      if (Array.isArray(events) && events.length && events.length <= 50000) return events;
    } catch {}
    if (!body.trim().startsWith('<') || /<!DOCTYPE|<!ENTITY/i.test(body)) return null;
    try {
      const doc=new DOMParser().parseFromString(body,'text/xml');
      if(doc.querySelector('parsererror')) return null;
      const nodes=[...doc.querySelectorAll('timedtext body p, transcript text')];
      if(nodes.length>50000) return null;
      const events=nodes.map(node=>{
        const seconds=node.tagName==='text';
        const start=Number(node.getAttribute(seconds?'start':'t'))*(seconds?1000:1);
        const duration=Number(node.getAttribute(seconds?'dur':'d'))*(seconds?1000:1);
        const text=[...node.childNodes].map(n=>n.nodeName==='br'?'\n':n.textContent).join('');
        return {tStartMs:start,dDurationMs:duration,segs:[{utf8:text}]};
      }).filter(e=>Number.isFinite(e.tStartMs)&&Number.isFinite(e.dDurationMs)&&e.tStartMs>=0&&e.dDurationMs>0&&e.segs[0].utf8.trim());
      return events.length?events:null;
    } catch {return null;}
  }
  function rememberCaptionBody(data) {
    try {
      const u=new URL(data.url);
      const route=routeVideoId();
      if(u.pathname!=='/api/timedtext'||!/^(?:www\.)?youtube\.com$/.test(u.hostname)||
          u.searchParams.has('tlang')||!route||data.videoId!==route||u.searchParams.get('v')!==route) return;
      const events=captionBodyEvents(data.body);
      if(!events || !parseEvents(events).length) return;
      const record={v:route,lang:u.searchParams.get('lang')||'',kind:u.searchParams.get('kind')||'',events};
      const old=capturedBodies.findIndex(r=>r.v===record.v&&r.lang===record.lang&&r.kind===record.kind);
      if(old>=0)capturedBodies.splice(old,1);
      capturedBodies.push(record);if(capturedBodies.length>3)capturedBodies.shift();
      captionCaptureRevision++;
      if (!hasTracks() && info.videoId === route && record.lang) {
        info.tracks = [{lang:record.lang,kind:record.kind,baseUrl:u.href,name:record.lang.toUpperCase()}];
        infoSeen = true; infoSettled = true;
        restylePill();
      }
      trackWaiters.resolve();
    } catch {}
  }
  function availableCaptionEvents(track) {
    // Browser text tracks are a separate, already-available source. Reading
    // cues never toggles mode, native CC, currentTime or playback state.
    try {
      for(const textTrack of Array.from(video?.textTracks||[])) {
        if(!['subtitles','captions'].includes(textTrack.kind)||!textTrack.cues?.length||
            (track?.lang && textTrack.language!==track.lang))continue;
        const events=Array.from(textTrack.cues).slice(0,50000).map(c=>({tStartMs:c.startTime*1000,dDurationMs:(c.endTime-c.startTime)*1000,segs:[{utf8:c.text}]}));
        if(parseEvents(events).length)return events;
      }
    } catch {}
    const match=[...capturedBodies].reverse().find(r=>r.v===info.videoId&&r.lang===track?.lang&&r.kind===(track?.kind||''));
    return match?.events || null;
  }

  /** Candidate URLs, best first. */
  function candidateUrls(track) {
    const out = [];
    const add = (u) => {
      if (u && !out.includes(u)) out.push(u);
    };
    add(asJson3(pickCapturedUrl(track)));
    const pot = capturedPot();
    if (pot) add(setParam(asJson3(track.baseUrl), 'pot', pot));
    add(asJson3(stripXpe(track.baseUrl)));
    add(asJson3(track.baseUrl));
    return out.filter(Boolean);
  }

  /**
   * Fetch a caption track, trying each candidate. Reads the body as TEXT
   * first: the PoToken failure mode is a 200 with an EMPTY body, which
   * response.json() would surface as an opaque syntax error.
   * @returns {Promise<{events: any[], attempts: string[]}>}
   */
  async function fetchCaptionEvents(track, { deadline = Date.now() + ACQUIRE_BUDGET_MS, stale = () => false } = {}) {
    const ready = availableCaptionEvents(track);
    if (ready) return {events:ready,attempts:[]};
    const attempts = [];
    for (const url of candidateUrls(track)) {
      if (stale() || Date.now() >= deadline) break;
      const tag = url.length > 90 ? `${url.slice(0, 90)}…` : url;
      const controller = new AbortController();
      captionFetches.add(controller);
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(2500, deadline - Date.now())));
      try {
        const aborted = new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('caption request timed out or cancelled')), { once: true });
        });
        const { response, body } = await Promise.race([
          (async () => {
            const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
            return { response, body: response.ok ? await response.text() : '' };
          })(),
          aborted,
        ]);
        if (!response.ok) {
          attempts.push(`HTTP ${response.status} ← ${tag}`);
          continue;
        }
        const text = body.trim();
        if (!text) {
          attempts.push(`empty body (PoToken required) ← ${tag}`);
          continue;
        }
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          attempts.push(`non-JSON body ← ${tag}`);
          continue;
        }
        const events = data?.events;
        if (Array.isArray(events) && events.length) return { events, attempts };
        attempts.push(`no events ← ${tag}`);
      } catch (error) {
        attempts.push(`${String(error?.message || error)} ← ${tag}`);
      } finally {
        clearTimeout(timer);
        captionFetches.delete(controller);
      }
    }
    const captured = availableCaptionEvents(track);
    if (captured) return {events:captured,attempts};
    const error = new Error('no caption URL returned usable data');
    error.attempts = attempts;
    throw error;
  }

  /** Ask the player to load captions so it issues its own token-carrying
   *  request, then wait briefly for our MAIN-world hook to capture it.
   *  @param {number} [budgetMs] how long to wait for the player to respond. */
  async function probeForCaptionUrl(track, budgetMs = 2000, stale = () => false) {
    const before = captionCaptureRevision;
    const requestId = ++captionProbeId;
    window.postMessage(
      { source: 'gxt-yt-cmd', cmd: 'captionsProbe', lang: track?.lang || '', kind: track?.kind || '', requestId },
      '*'
    );
    try {
      const until = Date.now() + budgetMs;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 125));
        if (stale() || cancelRequested || info.videoId !== currentVideoIdAtStart) return false;
        if (captionCaptureRevision > before && (pickCapturedUrl(track) || capturedPot())) return true;
      }
      return false;
    } finally {
      window.postMessage({ source: 'gxt-yt-cmd', cmd: 'captionsProbeDone', requestId }, '*');
    }
  }

  /**
   * Get a caption track's events, with retries — v3.3.0.
   *
   * WHAT THIS REPLACES. `start()` used to do exactly three things: one fetch
   * pass over the candidate URLs, one probe, one more fetch pass — and then a
   * hard, user-visible failure. That gives the `pot` token race precisely one
   * chance. And the race is real: the probe returns as soon as our hook sees the
   * player ISSUE a request, which is strictly earlier than the token being
   * usable by us, so the second pass can still read an empty body and the whole
   * attempt is spent.
   *
   * Now the acquisition is a loop with backoff. Each round re-probes (the player
   * may need another nudge, and each nudge is another chance for a fresh token
   * to be captured) and re-reads the candidate list, which is rebuilt from
   * `capturedUrls` every time and therefore improves as URLs arrive.
   *
   * BOUNDED BY A DEADLINE, NOT A ROUND COUNT. My first cut counted rounds and
   * probed on each one, which multiplied out to ~11 seconds of a user staring at
   * a button that had already failed — the harness caught it. A user-facing
   * operation should be bounded by the time the user will actually wait, so that
   * is what bounds it. Probing is the expensive part (seconds, because it waits
   * on the player) and it is capped separately: if two nudges have not made the
   * player issue a caption request, a third will not either.
   *
   * Every round checks `stale()` so a navigation or a cancel ends this
   * immediately rather than reporting an error about a video nobody is on.
   *
   * @param {object} track
   * @param {() => boolean} stale
   */
  const ACQUIRE_BUDGET_MS = 7000;
  const ACQUIRE_BACKOFF_MS = [0, 300, 700, 1200, 1900];
  const MAX_PROBES = 3;

  async function acquireCaptions(track, stale) {
    const ready = availableCaptionEvents(track);
    if (ready) return {events:ready,attempts:[]};
    const deadline = Date.now() + ACQUIRE_BUDGET_MS;
    let last = null;
    let probes = 0;
    // Signed YouTube caption URLs with exp=xpe often work only after the
    // player's own CC action has minted a PoToken. Do that action up front
    // instead of first spending a request we already expect to be empty.
    if (stripXpe(track?.baseUrl) && !capturedPot()) {
      probes += 1;
      updatePill(globalThis.GXT.i18n.t("content_youtube_acquireCaptions_1", {v0:(faNum(probes)), v1:(faNum(MAX_PROBES))}));
      await probeForCaptionUrl(track, Math.min(2200, deadline - Date.now()), stale);
      if (stale()) throw new Error('stale');
    }
    for (let round = 0; round < ACQUIRE_BACKOFF_MS.length; round += 1) {
      if (stale()) throw last || new Error('stale');
      const pause = ACQUIRE_BACKOFF_MS[round];
      if (pause) {
        if (Date.now() + pause > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, pause));
        if (stale()) throw last || new Error('stale');
      }
      try {
        return await fetchCaptionEvents(track, { deadline, stale });
      } catch (error) {
        last = error;
        if (stale()) throw error;
        if (Date.now() >= deadline) break;
        // Only the empty-body failure is worth probing for: it is the one that
        // means «the URL was fine, the token was not». An HTTP error or a parse
        // failure will not be cured by a nudge, so those rounds just retry the
        // fetch — a 5xx or a dropped connection can be transient — and the
        // candidate list is rebuilt from `capturedUrls` each time, so it also
        // improves on its own as the player works.
        const potBlocked = (error.attempts || []).some((a) => a.includes('PoToken'));
        const noUsableCapture = !pickCapturedUrl(track);
        // One native CC action is worthwhile for every failure class; empty
        // PoToken responses and missing language-matched captures keep using
        // the remaining attempts. This automates the user's manual workaround.
        if ((potBlocked || noUsableCapture || probes === 0) && probes < MAX_PROBES) {
          probes += 1;
          updatePill(globalThis.GXT.i18n.t("content_youtube_acquireCaptions_1", {v0:(faNum(probes)), v1:(faNum(MAX_PROBES))}));
          const left = deadline - Date.now();
          if (left < 300) break;
          const captured = await probeForCaptionUrl(track, Math.min(2000, left), stale);
          if (stale()) throw error;
          if (!captured) {
            error.attempts = [
              ...(error.attempts || []),
              `player issued no caption request (probe ${probes})`,
            ];
          }
        }
      }
    }
    throw last || new Error('no caption URL returned usable data');
  }

  /** Strip non-verbal caption furniture: [Music], (laughter), ">>" speaker
   *  markers. Only short, Latin-only bracketed tags are removed, so real
   *  content in brackets — "(2023)", "[در ایران]" — survives. */
  function cleanCueText(text) {
    return text
      .replace(/\[[^\]]{1,30}\]|\([^)]{1,30}\)/g, (match) => {
        const inner = match.slice(1, -1).trim();
        // Brackets also carry real speech such as "(in English)" or
        // "[New York]". Remove only known sound annotations.
        return /^(?:[♪♫\s]+|music|laughter|laughing|laughs|applause|cheering|crowd cheering|inaudible|silence|sighs|sighing|coughing|screaming)$/i.test(inner)
          ? ' '
          : match;
      })
      .replace(/^>{1,2}\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseEvents(events) {
    const out = [];
    for (const ev of events) {
      if (!Array.isArray(ev.segs) || ev.aAppend) continue;
      const text = cleanCueText(
        ev.segs
          .map((seg) => seg.utf8 || '')
          .join('')
          .replace(/\n+/g, ' ')
      );
      if (!text || /^[♪♫\s[\]()]+$/.test(text)) continue;
      const s = ev.tStartMs | 0;
      // json3 calls this dDurationMs; accept the short form too, defensively.
      const dur = ev.dDurationMs != null ? ev.dDurationMs : ev.dDurMs;
      const e = s + (dur != null ? dur : 3000);
      const last = out[out.length - 1];
      if (last && last.orig === text && s - last.e < 500) {
        last.e = e;
        continue;
      }
      out.push({ s, e, orig: text, fa: null });
    }
    return out;
  }

  // ------------------------------------------ sentence merging (v1.8, opt-in)

  const SENT_END_RE = /[.!?…。！？؟]["')\]»۔]?\s*$/;
  const MERGE_MAX_CHARS = 220;
  const MERGE_MAX_GAP_MS = 2500;

  /**
   * Merge caption fragments into sentence units before translation. ASR cues
   * cut mid-sentence, and Persian puts the verb last — fragment-by-fragment
   * translation is structurally doomed. A merged cue spans its fragments'
   * full time range, so the complete sentence shows for the whole duration.
   */
  function mergeSentences(list) {
    const out = [];
    let acc = null;
    for (let i = 0; i < list.length; i += 1) {
      const cue = list[i];
      if (!acc) acc = { s: cue.s, e: cue.e, orig: cue.orig, fa: null };
      else {
        acc.orig += ` ${cue.orig}`;
        acc.e = cue.e;
      }
      const next = list[i + 1];
      const sentenceDone = SENT_END_RE.test(cue.orig);
      const tooLong = acc.orig.length >= MERGE_MAX_CHARS;
      const bigGap = next && next.s - cue.e > MERGE_MAX_GAP_MS;
      if (sentenceDone || tooLong || bigGap || !next) {
        out.push(acc);
        acc = null;
      }
    }
    if (acc) out.push(acc);
    return out;
  }

  // ------------------------------------------------------ SRT export (v1.8)

  function srtTime(ms) {
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return (
      `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:` +
      `${pad(Math.floor(ms / 1000) % 60)},${pad(Math.floor(ms % 1000), 3)}`
    );
  }

  function downloadSrt() {
    if (!cues || !cues.length) return;
    const lines = [];
    cues.forEach((cue, i) => {
      lines.push(String(i + 1), `${srtTime(cue.s)} --> ${srtTime(cue.e)}`, cue.fa || cue.orig, '');
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${info.videoId || 'subtitles'}-fa.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // -------------------------------------------------- live streams (v1.8)

  /** Live captions grow over time; refetch the track and append new cues.
   *  Indices only ever grow, so `requested` bookkeeping stays valid. */
  async function refreshLiveTrack() {
    if (state !== 'active' || !cues || bulkRunning) return;
    const vid = currentVideoIdAtStart;
    /**
     * The generation guard, here too — v3.3.0.
     *
     * Same defect as the one v3.2.5 fixed in `sendBatch`, in the one place that
     * was missed: this awaits a network fetch and then MUTATES `cues`. If the
     * pipeline restarted meanwhile — a source-track switch, or «جمله‌بندی
     * هوشمند» re-segmenting the stream into sentences — the list it appends to is
     * a different list from the one it measured `lastStart` against, so unmerged
     * cues get pushed onto a merged list. The result is a caption track that
     * repeats itself from the point of the switch onward, which is very hard to
     * recognise as a bug in a LIVE stream where the text is supposed to be new.
     */
    const gen = startGen;
    try {
      const { events } = await fetchCaptionEvents(pickTrack());
      if (state !== 'active' || info.videoId !== vid || startGen !== gen || !cues) return;
      const parsed = parseEvents(events);
      const lastStart = cues.length ? cues[cues.length - 1].s : -1;
      for (const cue of parsed) if (cue.s > lastStart) cues.push(cue);
    } catch {
      /* transient live hiccup — next interval retries */
    }
  }

  /**
   * The CAPTION pipeline, and only that (v3.1.0).
   *
   * It used to open with a `liveOnly()` branch that faked its way through this
   * function — setting `cues = []` and calling `activate()` — so that live
   * dubbing could borrow the caption machinery it does not use. That is what
   * tied the voice to `state`, and through `state` to every caption failure.
   * Live dubbing now starts in `startDub()` and never enters this function.
   */
  async function start() {
    /**
     * WAIT FOR THE METADATA BEFORE JUDGING IT — v3.3.0.
     *
     * This function used to open with a bare `pickTrack()` and, on an empty
     * list, announce «این ویدیو زیرنویس ندارد». But the controls mount before
     * the page script has reported anything (v3.1.0, deliberately — the live
     * dubbing engine needs no captions), so a user who presses the button
     * promptly was told a video with subtitles had none. Reloading made it
     * WORSE, not better, which is why the reported workaround was so fiddly.
     *
     * The pill says what it is doing while it waits, and the wait is short.
     */
    state = 'loading';
    lastFailAt = 0; // a new explicit operation must not inherit another attempt's cooldown
    lastWindowCheck = 0;
    clearTimeout(pillTimer);
    cancelRequested = false;
    const myGen = ++startGen; // invalidates any earlier in-flight load
    currentVideoIdAtStart = info.videoId; // guards against SPA navigation mid-run
    // Stale if the video navigated away, a cancel was requested, or a newer
    // start() (e.g. the user picked a different source track) superseded us.
    const stale = () =>
      cancelRequested || info.videoId !== currentVideoIdAtStart || myGen !== startGen;

    let track = pickTrack();
    if (!track) {
      updatePill(globalThis.GXT.i18n.t("content_youtube_start_9"));
      await awaitTracks();
      if (stale()) {
        if (myGen === startGen) {
          state = 'idle';
          updatePill(pillDefaultLabel());
        }
        return;
      }
      track = pickTrack();
      restylePill(); // the answer may have enabled or disabled the button
    }
    if (!track) {
      // Now it is a real answer: no captions on this video. Not an error for
      // this pipeline — just nothing to do. `fail` decides whether the live
      // engine should step in.
      return fail(globalThis.GXT.i18n.t("content_youtube_start_8"));
    }
    updatePill(globalThis.GXT.i18n.t("content_youtube_start_7"));
    let events;
    try {
      events = (await acquireCaptions(track, stale)).events;
    } catch (error) {
      if (stale()) return; // a newer load owns the UI now; stay silent
      // Full transparency: every URL tried and exactly how it failed.
      console.warn(
        globalThis.GXT.i18n.t("content_youtube_start_6"),
        error?.attempts || error,
        globalThis.GXT.i18n.t("content_youtube_start_5") +
          globalThis.GXT.i18n.t("content_youtube_start_4")
      );
      const potBlocked = (error?.attempts || []).some((a) => a.includes('PoToken'));
      return fail(
        potBlocked
          ? globalThis.GXT.i18n.t("content_youtube_start_3")
          : globalThis.GXT.i18n.t("content_youtube_start_2")
      );
    }
    if (stale()) {
      if (myGen === startGen) {
        state = 'idle';
        updatePill(pillDefaultLabel());
      }
      return;
    }
    sourceCues = parseEvents(events);
    cues = sourceCues.map(cue => ({ ...cue }));
    // Sentence merge (opt-in) — skipped on live streams, where the track is
    // appended incrementally and merged units would shift under our feet.
    // Dubbing forces sentence merging. A caption cue is a READING unit — it
    // breaks every two seconds, mid-clause. Speaking those one by one produces
    // a voice that gasps for breath continuously; there is no version of
    // dubbing that works without merging first, so this is not a preference.
    const merge = settings?.ytSentenceMerge || settings?.ytDub;
    if (merge && !info.isLive) cues = mergeSentences(cues);
    requested.clear();
    if (!cues.length) return fail(globalThis.GXT.i18n.t("content_youtube_start_1"));
    // Activate immediately; translation streams in behind the playhead.
    activate();
    requestWindow();
  }

  /**
   * A CAPTION failure. It ends the caption pipeline and nothing else.
   *
   * This is the second half of the reported bug: «یوتیوب زیرنویس را نداد» used
   * to leave `state = 'idle'`, and because `dubOn()` read `state`, the voice
   * reported itself off and the button went dead — for a live session that had
   * never asked YouTube for a caption in the first place.
   *
   * When the live engine is the chosen one, a missing caption track is not
   * even a problem worth reporting as a failure: it is the situation that
   * engine was built for. So we offer it instead.
   */
  function fail(message) {
    lastCaptionError = message;
    globalThis.GXT.ui?.toast?.(message + globalThis.GXT.i18n.t("content_youtube_fail_2"), 9000);
    state = 'idle';
    dubStarting = false;
    window.postMessage({ source: 'gxt-yt-cmd', cmd: 'captionsOn' }, '*');
    if (settings?.ytDub && !dubNeedsCaptions() && dubState !== 'active') {
      // The user wants a voice and the engine that provides it reads nothing.
      // Give them the voice rather than an error about something else.
      if (startDub()) {
        flashPill(globalThis.GXT.i18n.t("content_youtube_fail_1"));
        return;
      }
    }
    flashPill(`⚠ ${message}`);
    restylePill();
  }

  // -------------------------------------------------- rolling translation

  /** Index of the first cue that ends at or after `ms` (binary search). */
  function cueIndexAt(list, ms) {
    let lo = 0;
    let hi = list.length - 1;
    let ans = list.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].e >= ms) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return ans;
  }

  /** Untranslated, unrequested cue indices between two timestamps, capped. */
  function pendingBetween(list, done, fromMs, toMs, limit) {
    const out = [];
    for (let i = cueIndexAt(list, fromMs); i < list.length && out.length < limit; i += 1) {
      if (list[i].s > toMs) break;
      if (!list[i].fa && !done.has(i)) out.push(i);
    }
    return out;
  }

  /**
   * THE scheduling decision, kept pure so it can be reasoned about (and
   * tested) on its own: given the track, what has already been asked for, and
   * where the playhead is, which cues should the next request cover?
   *
   *   1. anything inside the urgent horizon — always, playing or paused;
   *   2. otherwise the look-ahead buffer, but only while playing;
   *   3. otherwise nothing.
   *
   * @returns {number[]|null} cue indices to request, or null for "nothing to do"
   */
  function planBatch(opts) {
    const urgent = pendingBetween(opts.list, opts.done, opts.nowMs, opts.nowMs + opts.nearMs, opts.nearBatch);
    if (urgent.length) return urgent;
    if (opts.paused) return null;
    const far = pendingBetween(opts.list, opts.done, opts.nowMs, opts.nowMs + opts.ahead, opts.farBatch);
    return far.length ? far : null;
  }

  /**
   * Fill the buffer up to the engine's concurrency budget. Called on every
   * scheduling tick — a cheap scan that does nothing once the window is
   * covered.
   */
  function requestWindow() {
    if (state !== 'active' || !cues || !video || bulkRunning) return;
    if (Date.now() - lastFailAt < FAIL_COOLDOWN_MS) return;
    const budget = maxInFlight();
    while (inFlight < budget) {
      const batch = planBatch({
        list: cues,
        done: requested,
        nowMs: video.currentTime * 1000,
        paused: !!video.paused,
        nearMs: NEAR_MS,
        nearBatch: NEAR_BATCH,
        ahead: aheadMs(),
        farBatch: BATCH_CUES,
      });
      if (!batch) return;
      // sendBatch marks the cues and bumps inFlight synchronously, before its
      // first await, so the next turn of this loop sees the updated state.
      void sendBatch(batch);
    }
  }

  async function sendBatch(batch) {
    for (const ci of batch) requested.add(ci);
    inFlight += 1;
    if(dubEnabled())dubber?.setUpstreamPending?.(true);
    const vid = currentVideoIdAtStart;
    /**
     * The generation this batch belongs to — v3.2.5, and this was a live bug.
     *
     * `startGen` exists (see its declaration) so that "a stale in-flight load
     * bails", and every other consumer of it checks it. This one did not: it
     * captured only the video id. But the cue LIST is replaced, not just
     * appended to, whenever the pipeline restarts within the same video —
     * switching the source track, or turning «جمله‌بندی هوشمند» on, which merges
     * fragments and therefore produces a SHORTER list. A batch planned against
     * the old indices then landed against the new list and ran
     * `cues[batch[k]].fa = t` on an index past its end:
     *
     *     TypeError: Cannot set properties of undefined (setting 'fa')
     *
     * Thrown from an async function nobody awaits, so it surfaced as an
     * unhandled rejection — invisible to the suites, which only read console
     * lines, and invisible in the product too. Its cost was real: the throw
     * escaped before `tick()` and `requestWindow()` on the lines below, so that
     * batch's translations were discarded AND scheduling stalled until the
     * one-second safety tick picked it back up. dev/mock-yt.html reproduced it
     * twice on every single run, and reported 55/55 OK.
     *
     * The runner reports uncaught exceptions as failures now (dev/run_harness.py),
     * which is how this was found at all.
     */
    const gen = startGen;
    let res = null;
    try {
      res = await send({
        type: 'TRANSLATE_TEXTS',
        texts: batch.map((ci) => cues[ci].orig),
        kind: 'subtitle',
        source: 'youtube',
        captionKind: pickTrack()?.kind === 'asr' ? 'auto' : 'manual',
        context: contextFor(batch[0], batch[batch.length - 1]),
      });
    } finally {
      // A throw here would otherwise leak a slot and stall the pipeline for
      // the rest of the video. Clamped: a batch left over from a previous
      // video/track may land after the counter was reset.
      if (gen === startGen) {inFlight = Math.max(0, inFlight - 1);if(dubEnabled())dubber?.setUpstreamPending?.(inFlight>0);}
    }
    if (state !== 'active' || info.videoId !== vid || startGen !== gen || !cues) return;
    if (!applyBatch(batch, res)) {if(dubEnabled())dubber?.update();return;}
    lastShown = undefined; // repaint in case the current cue just arrived
    tick();
    requestWindow(); // a slot just freed and the playhead has moved on
  }

  /** Apply a TRANSLATE_TEXTS response; returns false on total failure. */
  function applyBatch(batch, res) {
    if (!res?.ok || !Array.isArray(res.list) || !res.list.some((t) => typeof t === 'string' && t.trim())) {
      for (const ci of batch) requested.delete(ci);
      lastFailAt = Date.now();
      const failure = res?.ok ? res.failed : res;
      // Full transparency: unmasked keys, codes and raw messages in console.
      console.warn(globalThis.GXT.i18n.t("content_youtube_applyBatch_2"), failure?.detail || failure);
      lastCaptionError = friendly(failure);
      globalThis.GXT.ui?.toast?.(lastCaptionError, 7000);
      flashPill(`⚠ ${lastCaptionError}`);
      return false;
    }
    for (let k = 0; k < batch.length; k += 1) {
      const t = res.list[k];
      // The index is re-checked against the CURRENT list even though the
      // caller already verified the generation. Writing to `undefined.fa` is
      // the one line in this pipeline that can throw out of an unawaited async
      // function, and it costs one comparison to make that impossible rather
      // than merely unlikely — see the note on `gen` in `sendBatch`.
      const cue = cues[batch[k]];
      if (!cue) continue;
      if (typeof t === 'string' && t) cue.fa = t;
      else requested.delete(batch[k]); // hole: eligible for a later retry
    }
    // New words exist: hand them to the dub engine so synthesis can start on
    // them immediately instead of waiting for the next frame.
    refreshDubSegments();
    if (res.failed) {
      console.warn(globalThis.GXT.i18n.t("content_youtube_applyBatch_1"), res.failed.detail || res.failed);
    }
    return true;
  }

  // ---------------------------------------------- full-video translation

  async function bulkTranslate() {
    if (bulkRunning) {
      bulkCancel = true;
      return;
    }
    if (!cues || state !== 'active') return;
    const todo = [];
    for (let i = 0; i < cues.length; i += 1) {
      if (!cues[i].fa && !requested.has(i)) todo.push(i);
    }
    // Token safeguard: an exceptionally long track deserves a heads-up
    // before it is billed all at once.
    if (!bulkConfirmed) {
      let words = 0;
      for (const i of todo) words += cues[i].orig.split(/\s+/).length;
      if (words > BULK_WORD_WARN) {
        showBulkWarning(words);
        return;
      }
    }
    bulkRunning = true;
    bulkCancel = false;
    const vid = currentVideoIdAtStart;
    // Same staleness guard as `sendBatch`, and needed more here: this loop runs
    // for as long as a whole video takes, and `todo` was computed against the
    // cue list as it stood at the first slice. If the list is replaced meanwhile
    // — a source-track switch, or «جمله‌بندی هوشمند» merging fragments into a
    // shorter list — then `cues[ci].orig` on a later slice reads an index past
    // the end and throws before `bulkRunning` is ever cleared, which would leave
    // the button stuck reporting a translation that is no longer running.
    const gen = startGen;
    const stale = () => state !== 'active' || info.videoId !== vid || startGen !== gen || !cues;
    let done = cues.length - todo.length;
    updateBulkButton(Math.round((done / cues.length) * 100));
    for (let offset = 0; offset < todo.length; offset += BULK_SLICE) {
      if (bulkCancel || stale()) break;
      const slice = todo.slice(offset, offset + BULK_SLICE);
      for (const ci of slice) requested.add(ci);
      const res = await send({
        type: 'TRANSLATE_TEXTS',
        texts: slice.map((ci) => cues[ci]?.orig || ''),
        kind: 'subtitle',
        source: 'youtube',
        captionKind: pickTrack()?.kind === 'asr' ? 'auto' : 'manual',
        context: contextFor(slice[0], slice[slice.length - 1]),
      });
      if (stale()) break;
      if (!applyBatch(slice, res)) break;
      done += slice.length;
      updateBulkButton(Math.round((done / cues.length) * 100));
      lastShown = undefined;
      tick();
    }
    if (gen === startGen) {
      bulkRunning = false;
      updateBulkButton();
    }
  }

  // --------------------------------------------------------------- overlay

  function applyAppearance() {
    if (!overlay || !overlayInner || !player) return;
    const base = Math.max(15, Math.min(34, player.clientWidth / 34));
    overlayInner.style.fontSize = `${Math.round(base * clamp(settings?.ytScale || 1, 0.6, 2.2))}px`;
    overlayInner.style.fontFamily = subtitleFontStack();
    // v3.2.5 — themed by default, with the classic high-contrast bar one click
    // away. The COLOURS are the stylesheet's job either way (.yt-cap /
    // .yt-cap.plain); all this does is choose which of the two applies.
    overlayInner.classList.toggle('plain', settings?.ytCapTheme === 'plain');
    overlay.style.left = `${clamp(settings?.ytPosX ?? 50, 5, 95)}%`;
    overlay.style.bottom = `${clamp(settings?.ytPosY ?? 11, 2, 90)}%`;
  }

  // --- drag to reposition -------------------------------------------------
  let dragging = null;

  function onDragStart(event) {
    if (event.button !== 0 || !player) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = { rect: player.getBoundingClientRect(), x: null, y: null };
    overlayInner.setPointerCapture(event.pointerId);
    overlayInner.style.cursor = 'grabbing';
    overlayInner.addEventListener('pointermove', onDragMove);
    overlayInner.addEventListener('pointerup', onDragEnd);
    // Without this, a cancelled gesture (touch cancel, context menu, element
    // teardown) skips onDragEnd — the caption then follows the pointer with no
    // button held down until the next real pointerup.
    overlayInner.addEventListener('pointercancel', onDragEnd);
  }

  function onDragMove(event) {
    if (!dragging) return;
    const { rect } = dragging;
    if (!rect.width || !rect.height) return;
    dragging.x = clamp(((event.clientX - rect.left) / rect.width) * 100, 5, 95);
    dragging.y = clamp(((rect.bottom - event.clientY) / rect.height) * 100, 2, 90);
    overlay.style.left = `${dragging.x}%`;
    overlay.style.bottom = `${dragging.y}%`;
  }

  function onDragEnd() {
    if (!overlayInner) {
      dragging = null;
      return;
    }
    overlayInner.removeEventListener('pointermove', onDragMove);
    overlayInner.removeEventListener('pointerup', onDragEnd);
    overlayInner.removeEventListener('pointercancel', onDragEnd);
    overlayInner.style.cursor = 'grab';
    if (dragging && dragging.x != null) {
      void globalThis.GXT.setSettings({
        ytPosX: Math.round(dragging.x),
        ytPosY: Math.round(dragging.y),
      });
    }
    dragging = null;
  }

  /**
   * Bring up the caption pipeline. Splits into "the overlay" (shared) and
   * "captions are now running" (this machine only) — v3.1.0.
   */
  function activate() {
    state = 'active';
    updatePill(pillDefaultLabel());
    restylePill();
    // The panel gains its active-only rows (full-video, buffer) — rebuild it.
    if (panel) {
      closePanel();
      togglePanel();
    }
    // Only the CAPTION pipeline replaces YouTube's own captions. The live
    // engine adds a voice and a transcript; silencing the viewer's native
    // subtitles because they turned on dubbing would be taking something away
    // they never offered to give up.
    if (visualWanted) {
      window.postMessage({ source: 'gxt-yt-cmd', cmd: 'captionsOff' }, '*');
      ensureOverlay();
    }
    attachPlayback();
  }

  /**
   * The subtitle box, created on demand by EITHER pipeline (v3.1.0).
   *
   * Both paint here: the caption engine writes translated cues, the live
   * engine writes the transcript the Live API returns. It used to be built
   * inside `activate()`, which meant a caption-less video running live dubbing
   * had nowhere to show its transcript.
   */
  function ensureOverlay() {
    if (overlay && overlay.isConnected) return;
    if (!player) return;
    overlay = el('div', 'yt-cap-wrap');
    overlay.id = 'gxt-yt-overlay';
    // The caption stays dark-on-video whatever the theme is: legibility over
    // arbitrary footage beats matching the panel, and NO backdrop blur here
    // ever — this box sits on the video for the whole video, and a blurred
    // backdrop would keep GPU video enhancement (RTX VSR) switched off the
    // entire time. Measured: white on rgba(8,8,8,.78) is 10.7:1 even over a
    // white frame. Now expressed in the stylesheet (.yt-cap) rather than in a
    // style string, so it also picks up the reduced-motion rule.
    overlayInner = el('span', 'yt-cap');
    // v1.8: two stacked lines — Persian, plus the original when bilingual.
    overlayFa = document.createElement('div');
    // v2.9.5 — WCAG 3.1.2. A caption is the one place a screen reader is most
    // likely to be asked to speak: without a language the Persian line goes to
    // an English voice. The bilingual second line is deliberately NOT marked
    // fa — it is the ORIGINAL, and claiming otherwise would be worse than
    // saying nothing.
    overlayFa.lang = settings?.ytTargetLang || 'fa';
    overlayOrig = el('div', 'orig');
    overlayInner.append(overlayFa, overlayOrig);
    overlayInner.addEventListener('pointerdown', onDragStart);
    overlayInner.addEventListener('click', (e) => e.stopPropagation());
    overlay.appendChild(overlayInner);
    const surface = ensureSurface();
    if (surface) surface.appendChild(overlay);
    else player.appendChild(overlay);
    applyAppearance();
    window.addEventListener('resize', applyAppearance);
    document.addEventListener('fullscreenchange', applyAppearance);
    ensureVideo();
  }

  /**
   * Wire the caption pipeline to playback (v3.1.0).
   *
   * Kept separate from `ensureOverlay` because these are cue-scheduling
   * concerns — which cue is due, what to translate next, the safety tick, the
   * live-track refetch. The live engine wants the overlay to draw its
   * transcript in and none of this; folding the two together (as my first cut
   * of this split did) made `startDub` re-enter the caption machinery it is
   * supposed to be independent of.
   */
  function attachPlayback() {
    ensureVideo();
    if (!video) return;
    ptr = 0;
    lastShown = null;
    video?.addEventListener('timeupdate', tick);
    // Every one of these changes WHAT needs translating next, so each bypasses
    // the throttle. `pause` matters as much as `play`: timeupdate stops firing
    // on a paused video, and a paused frame still displays a cue that may not
    // be translated yet.
    for (const event of ['seeked', 'seeking', 'play', 'pause', 'ratechange']) {
      video?.addEventListener(event, nudge);
    }
    // Safety net: `timeupdate` does not fire while paused and is throttled in
    // background tabs, so scheduling never depends on it alone (v2.1.0).
    clearInterval(safetyTimer);
    safetyTimer = setInterval(tick, SAFETY_TICK_MS);
    // Live stream: keep pulling the growing caption track (v1.8).
    clearInterval(liveTimer);
    if (info.isLive) liveTimer = setInterval(() => void refreshLiveTrack(), 45000);
    // Dubbing starts here rather than on the first tick, so the AudioContext is
    // created inside the click that started the pipeline and is therefore not
    // suspended by the autoplay policy.
    if (settings?.ytDub) startDub();
    tick();
  }

  /** Something changed the playback position or state: schedule immediately
   *  instead of waiting out the throttle. */
  function nudge() {
    lastWindowCheck = 0;
    // A seek, a pause or a speed change breaks the mapping between media time
    // and the audio clock, so everything queued must be thrown away before the
    // tick re-derives it. Without this, a seek backwards replays the old queue
    // on top of the new position.
    tick();
  }

  function tick() {
    // NOTE the missing `!overlayInner` guard. Until v2.4.5 it was here, and it
    // is why turning the subtitle text off also killed the voice: no overlay,
    // no tick, no dubbing. Text and speech are two outputs of one pipeline and
    // neither may gate the other.
    if (state !== 'active' || !cues || !video) return;
    const ms = video.currentTime * 1000;
    while (ptr < cues.length - 1 && cues[ptr + 1].s <= ms) ptr += 1;
    while (ptr > 0 && cues[ptr].s > ms) ptr -= 1;
    const cue = cues[ptr];
    if (overlayInner) renderOverlay(cue, ms);

    // The dub runs off the same tick as the overlay, so the voice and the text
    // can never disagree about where the playhead is.
    if (dubEnabled() && dubber) dubber.update();

    const now = Date.now();
    if (now - lastWindowCheck >= WINDOW_CHECK_MS) {
      lastWindowCheck = now;
      requestWindow();
    }
  }

  /** Paint the caption box for the cue under the playhead. */
  function renderOverlay(cue, ms) {
    // While the live engine is speaking, the box shows what IT said — the
    // transcript arrives with the audio and there are often no cues at all to
    // paint from. handleLiveText owns the box in that mode.
    if (dubState === 'active' && dubEngineName() === 'live' && dubStats?.live?.state === 'live') return;
    // Subtitles switched off: the box stays built (rebuilding it on every
    // toggle would lose its dragged position) but shows nothing.
    if (!visualWanted) {
      if (lastShown !== null) { lastShown = null; overlayInner.style.display = 'none'; }
      return;
    }
    const visible = cue && cue.s <= ms && ms < cue.e;
    // Untranslated cue: show the original rather than nothing; it flips to
    // Persian as soon as its batch arrives.
    const text = visible ? cue.fa || cue.orig : null;
    const bilingual = !!(visible && settings?.ytBilingual && cue.fa);
    const shownKey = text === null ? null : `${text}\u0000${bilingual ? cue.orig : ''}`;
    if (shownKey !== lastShown) {
      lastShown = shownKey;
      if (text) {
        overlayFa.textContent = text;
        overlayOrig.textContent = bilingual ? cue.orig : '';
        overlayOrig.style.display = bilingual ? 'block' : 'none';
        overlayInner.style.display = 'inline-block';
        /**
         * «Not translated yet» — v3.2.5, and this was a measurable defect.
         *
         * It used to be `style.opacity = '0.75'`. Element opacity scales the
         * scrim AND the ink together, so it does not merely dim the text — it
         * thins the very background the text is legible against. Measured on the
         * default theme over a bright frame: 11.40:1 falls to 3.82:1, under the
         * 4.5:1 AA floor. And this is the state in which the viewer is reading the
         * ORIGINAL foreign line, i.e. exactly when they need it clearest. (The
         * old hard-coded bar had the same problem; nothing measured it.)
         *
         * The provisional state is now carried by the BORDER — dashed, in the
         * accent — which costs no contrast at all and matches how the rest of the
         * product says «in progress».
         */
        overlayInner.classList.toggle('pending', !!(visible && !cue.fa));
      } else {
        overlayInner.style.display = 'none';
      }
    }
  }

  /**
   * Remove the caption box and its listeners.
   *
   * Since v2.4.5 this does NOT touch the dub. Tearing down the visual layer is
   * something a track switch does routinely, and it must not silence a voice
   * the viewer never asked to stop. `stop()` and `restartPipeline()` end the
   * dub explicitly instead.
   */
  function teardownOverlay() {
    overlay?.remove();
    overlay = null;
    overlayInner = null;
    overlayFa = null;
    overlayOrig = null;
    clearInterval(liveTimer);
    liveTimer = 0;
    window.removeEventListener('resize', applyAppearance);
    document.removeEventListener('fullscreenchange', applyAppearance);
    video?.removeEventListener('timeupdate', tick);
    for (const event of ['seeked', 'seeking', 'play', 'pause', 'ratechange']) {
      video?.removeEventListener(event, nudge);
    }
    clearInterval(safetyTimer);
    safetyTimer = 0;
  }

  function stop() {
    cancelRequested = true;
    startGen += 1;
    for (const controller of captionFetches) controller.abort();
    trackWaiters.resolve();
    inFlight = 0;
    bulkRunning = false;
    state = 'idle';
    bulkCancel = true;
    /**
     * Stop only what THIS pipeline owns (v3.1.0).
     *
     * A caption-driven dub speaks translated cues, so it cannot outlive them:
     * a queued clip would leave a Persian voice talking over a video with no
     * subtitles, unstoppable, with the original audio still ducked. But the
     * LIVE engine never touched a cue — stopping it here would mean the
     * subtitle button silently switches off the voice, which is the coupling
     * this release exists to remove.
     */
    if (dubNeedsCaptions()) stopDub();
    setCaptionVisibility(false);
    closePanel();
    // Gear stays available in idle state so settings remain reachable.
    if (dubState !== 'active') teardownOverlay();
    window.postMessage({ source: 'gxt-yt-cmd', cmd: 'captionsOn' }, '*');
    updatePill(pillDefaultLabel());
    restylePill();
  }

  /** Tear down the active pipeline and reload with current options — shared
   *  by the source-track switch and the sentence-merge toggle (v1.8). */
  function restartPipeline() {
    if (state === 'idle') return;
    bulkCancel = true;
    for (const controller of captionFetches) controller.abort();
    // The cue list is about to be rebuilt (different track, or re-segmented
    // into sentences), so every id the dub holds becomes meaningless.
    if (dubNeedsCaptions()) stopDub();
    teardownOverlay();
    cues = null;
    sourceCues = null;
    requested.clear();
    inFlight = 0;
    bulkRunning = false;
    lastFailAt = 0;
    ptr = 0;
    lastShown = null;
    void start();
  }

  /** Retire translation identity synchronously, retaining acquired captions,
   * native CC and the playback clock. A→B→A cannot revive the first A. */
  function retranslateCurrent() {
    if (state === 'idle') return;
    if (!cues?.length || state !== 'active') { restartPipeline(); return; }
    ++startGen;
    bulkCancel = true;
    bulkRunning = false;
    inFlight = 0;
    requested.clear();
    lastFailAt = 0;
    if (dubNeedsCaptions()) stopDub();
    const base = info.isLive ? cues : (sourceCues || cues);
    cues = base.map(cue => ({ ...cue, fa: null }));
    if (!info.isLive && (settings?.ytSentenceMerge || settings?.ytDub)) cues = mergeSentences(cues);
    ptr = 0;
    lastShown = undefined;
    if (overlayFa) overlayFa.lang = settings?.ytTargetLang || 'fa';
    tick();
    if (settings?.ytDub && dubNeedsCaptions()) startDub();
    requestWindow();
    updateBulkButton();
  }

  /** Reload captions with a newly chosen source track. Keeps native captions
   *  off (we're mid-session) and lets start()'s generation guard retire the
   *  previous load; the overlay is rebuilt when the new track arrives. */
  function switchTrack(id) {
    if (id === selectedTrackId) return;
    selectedTrackId = id;
    if (state === 'idle') return; // applies on the next activation
    restartPipeline();
  }

  /**
   * @param {string} [nextVideoId] the video we are moving TO, so its own
   *   captured caption URLs survive the reset.
   */
  function resetForNewVideo(nextVideoId) {
    capturedBodies.length = 0;
    lastCaptionError = '';
    infoSeen = false;
    infoSettled = false;
    cancelRequested = true;
    bulkCancel = true;
    stop();
    stopDub();
    info = {videoId:nextVideoId || '',tracks:[]}; // monotonic metadata is scoped to ONE video
    cues = null;
    sourceCues = null;
    requested.clear();
    inFlight = 0;
    bulkRunning = false;
    bulkConfirmed = false;
    lastFailAt = 0;
    ptr = 0;
    lastShown = null;
    selectedTrackId = null; // a new video has its own tracks
    visualWanted = false;
    // v3.3.0 — the twelfth piece of state, and the one that was missed. Without
    // this the caption-URL cache grew across every video in the session and one
    // video could be served another's subtitles.
    forgetCapturedUrls(nextVideoId);
    // Anything parked waiting for the previous video's tracks must be released,
    // or it sits out its whole ladder for a video nobody is watching.
    trackWaiters.resolve();
    // A new video gets a fresh auto-start decision, whatever happened on the
    // previous one.
    autoStartedFor = '';
    userStoppedFor = '';
    state = 'idle';
  }

  /**
   * Ask the page script for a fresh answer.
   *
   * The channel used to be push-only, so a content script that missed the
   * window simply waited for a poll that had already died. `resend` also
   * restarts discovery when the answer is not settled, which is what turns «the
   * user clicked the button early» from a hard error into a short wait.
   */
  function requestInfo() {
    try {
      window.postMessage({ source: 'gxt-yt-cmd', cmd: 'resend' }, '*');
    } catch {
      /* the page may be mid-navigation */
    }
  }

  /**
   * Everything parked waiting for a caption track to show up.
   *
   * One shared latch rather than a promise per caller: several things can be
   * waiting (the pill, auto-start, a track switch) and they all want the same
   * event.
   */
  const trackWaiters = {
    /** @type {Array<() => void>} */
    list: [],
    wait(ms) {
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          const at = this.list.indexOf(done);
          if (at > -1) this.list.splice(at, 1);
          resolve();
        };
        const timer = setTimeout(done, ms);
        this.list.push(done);
      });
    },
    resolve() {
      for (const done of [...this.list]) done();
    },
  };

  /**
   * Wait, briefly and with backoff, for this video's caption tracks — v3.3.0.
   *
   * THE BUG THIS FIXES. Since v3.1.0 the controls mount as soon as the player
   * exists, which is deliberate and correct: the live dubbing engine needs no
   * captions and its only in-player switch lives there. But it means the
   * subtitle button is clickable BEFORE the page script has reported anything,
   * and `start()` opened with a bare `pickTrack()` — which returns null when
   * `info.tracks` is empty — and hard-failed with «این ویدیو زیرنویس ندارد».
   * A video with perfectly good subtitles, told it had none, because the click
   * beat the metadata. That is the other half of the reported intermittency, and
   * it is the half that reloading does NOT fix, because reloading makes the race
   * tighter, not looser.
   *
   * Asking is cheap and the poll may have gone quiet, so each attempt requests a
   * resend before waiting. The total budget is deliberately small: this is on the
   * path of a button the user just pressed, and the pill says what it is doing.
   *
   * @returns {Promise<boolean>} whether tracks are now known.
   */
  const TRACK_WAIT_MS = [150, 300, 600, 1000, 1500];

  async function awaitTracks() {
    if (hasTracks()) return true;
    const vid = info.videoId;
    for (let i = 0; i < TRACK_WAIT_MS.length; i += 1) {
      requestInfo();
      await trackWaiters.wait(TRACK_WAIT_MS[i]);
      if (hasTracks()) return true;
      // A navigation mid-wait makes this attempt meaningless; the new video's
      // own activation will take over.
      if (info.videoId !== vid) return hasTracks();
      // A settled «none» is a real answer and there is no point waiting out the
      // rest of the ladder for it.
      if (infoSettled && i >= 2) return false; // explicit click gives a late caption module a bounded chance
      if (cancelRequested) return hasTracks();
    }
    return hasTracks();
  }

  // ---------------------------------------------------------------- wiring

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    // Caption URLs the player itself requested (they carry a valid pot).
    if (data?.source === 'gxt-yt-body') { rememberCaptionBody(data); return; }
    if (data?.source === 'gxt-yt-cc') {
      noteCapturedCaptionUrl(data.url);
      return;
    }
    if (data?.source !== 'gxt-yt') return;
    if (typeof data.videoId !== 'string' || !Array.isArray(data.tracks)) return;
    const routeId = routeVideoId();
    if (!globalThis.__gxtYtTestMode && (!routeId || routeId !== data.videoId)) return;
    if (data.videoId !== info.videoId) resetForNewVideo(data.videoId);
    /**
     * NEVER LET A LATER MESSAGE TAKE TRACKS AWAY — v3.3.0.
     *
     * The page script posts repeatedly as the player warms up, and those
     * messages are not monotonic: a settled response listing three tracks can
     * be followed by an unsettled one listing none (the player rebuilding
     * itself mid-video, an ad taking over, a heartbeat catching a transient
     * state). Assigning `info = data` unconditionally meant any such message
     * erased a good answer, and the button went dead again on a video that had
     * been working a moment earlier.
     *
     * Within one video the knowledge only ever GROWS. A cross-video change went
     * through `resetForNewVideo` above, which is where forgetting belongs.
     */
    const better = !hasTracks() || (data.tracks?.length || 0) > 0;
    if (better) info = data;
    infoSeen = true;
    // Tracks answer the question by existing, whoever sent them and whatever
    // they claim about themselves — so the receiver does not depend on the
    // sender having got its own `settled` flag right.
    if (data.settled || data.tracks?.length) infoSettled = true;
    // A track list that arrived while the pill was waiting for one is exactly
    // what `awaitTracks` is parked on.
    if (hasTracks() || infoSettled) trackWaiters.resolve();
    mountPill();
  });

  /**
   * Re-arm discovery on navigation.
   *
   * `mountPill` alone was not enough: the page script's poll used to be dead by
   * then, so the mount found an empty `info` and nothing ever refilled it.
   */
  function navigationChanged() {
    const nextId = routeVideoId();
    if ((!globalThis.__gxtYtTestMode || nextId) && nextId !== info.videoId) {
      resetForNewVideo(nextId);
      info = { videoId: nextId, tracks: [] };
    }
    requestInfo();
    mountPill();
    setTimeout(mountPill, 700);
  }
  for (const type of ['yt-navigate-finish', 'yt-player-updated']) {
    document.addEventListener(type, navigationChanged);
  }
  window.addEventListener('popstate', navigationChanged);

  // Pure scheduling primitives, exposed for the self-test (same `_internal`
  // convention the background modules use). Nothing else reads these.
  globalThis.GXT.yt = {
    _internal: {
      cueIndexAt, pendingBetween, planBatch, NEAR_MS, NEAR_BATCH, BATCH_CUES,
      // v3.1.0 — the two state machines, so a test can assert that neither
      // gates the other.
      trackCount: () => info.tracks?.length || 0,
      // v3.3.0 — the caption-discovery state a test needs to distinguish
      // «not known yet» from «definitively none», which is the whole bug.
      infoSettled: () => infoSettled,
      videoId: () => info.videoId,
      capturedCount: () => capturedUrls.length,
      noteCapturedCaptionUrl,
      pickCapturedUrl,
      /**
       * v3.2.0 — the player UI moved into a shadow root for style isolation,
       * so `document.getElementById` no longer reaches it. These are how a
       * test (or a future in-page tool) looks inside.
       */
      surfaceRoot: () => surfaceRoot,
      q: (sel) => surfaceRoot?.querySelector(sel) || null,
      qa: (sel) => [...(surfaceRoot?.querySelectorAll(sel) || [])],
      subState: () => state,
      dubState: () => dubState,
      visualWanted: () => visualWanted,
      dubNeedsCaptions,
      knownCaptionless,
      /**
       * The staleness contract, probeable (v3.2.5).
       *
       * `applyBatch` is the one place in this pipeline that WRITES through a
       * caller-supplied index, and the indices come from a plan made before an
       * await. If the cue list is replaced meanwhile — a source-track switch, or
       * «جمله‌بندی هوشمند» merging fragments into a SHORTER list, both of which
       * happen inside a single video — those indices can point past the end, and
       * `cues[i].fa = t` throws out of an async function nobody awaits.
       *
       * Driving that race through the whole player reproduced it only sometimes,
       * which is worse than not testing it: it was in fact firing on some runs of
       * dev/mock-yt.html while the page reported every check green. So the
       * contract is probed directly instead. A fake list is installed, the real
       * `applyBatch` runs against it, and everything is restored — no pipeline,
       * no timing, no flake.
       *
       * @returns {{threw: string|null, written: number}}
       */
      applyBatchProbe(cueCount, batch, list) {
        const savedCues = cues;
        const savedState = state;
        cues = Array.from({ length: cueCount }, (_, i) => ({
          s: i * 1000, e: i * 1000 + 900, orig: `line ${i}`, fa: null,
        }));
        state = 'active';
        let threw = null;
        try {
          applyBatch(batch, { ok: true, list, failed: null });
        } catch (error) {
          threw = String(error?.message || error);
        }
        const written = cues.filter((c) => c.fa).length;
        cues = savedCues;
        state = savedState;
        return { threw, written };
      },
    },
  };

  void (async () => {
    try {
      settings = await globalThis.GXT.getSettings();
    } catch {
      settings = null;
    }
    globalThis.GXT?.onStorageChanged?.(({ settings: next }) => {
      if (!next) return;
      const before = settings;
      settings = next;
      if (!settings.enabled || settings.youtube === false) {
        stop();
        stopDub();
        removeControls();
        // Switching the extension (or the YouTube feature) back on is a fresh
        // intent: let auto-start have another go at the video still on screen.
        autoStartedFor = '';
        return;
      }
      // Sentence-merge is applied once, when the caption track is parsed, so a
      // change from the popup needs a pipeline restart to re-segment the video
      // that is already playing (the in-player panel already does this).
      const translationChanged = before &&
        globalThis.GXT.youtubeTranslationKey?.(before) !== globalThis.GXT.youtubeTranslationKey?.(next);
      if (before && state !== 'idle' && (translationChanged ||
          before.ytSentenceMerge !== next.ytSentenceMerge)) {
        retranslateCurrent();
      }
      // Dubbing, changed from the popup while a video is running. Turning it ON
      // needs the cue list rebuilt as SENTENCES (speech cannot use reading-sized
      // cues), unless merging was already on; turning it OFF must silence and
      // restore the original volume immediately, not at the next video.
      if (before && before.ytSubtitles !== next.ytSubtitles) {
        setCaptionVisibility(next.ytSubtitles !== false);
        if (next.ytSubtitles !== false && state === 'idle' && hasTracks()) void start();
        if (next.ytSubtitles === false && state === 'active' && dubState !== 'active') stop();
      }
      if (before && before.ytDub !== next.ytDub) {
        if (next.ytDub) {
          if (dubNeedsCaptions() && state === 'active' && !next.ytSentenceMerge && !info.isLive) {
            restartPipeline();
          } else if (dubNeedsCaptions() && state === 'idle') {
            void onDubClick();
          } else {
            startDub();
          }
        } else {
          stopDub();
          if (state === 'active' && !visualWanted) stop();
        }
      }
      dubber?.configure(next);
      // Auto-start switched on from the popup should apply to the video that
      // is already open, not only the next one.
      if (before && !before.ytAuto && next.ytAuto) userStoppedFor = '';
      mountPill(); // ends in maybeAutoStart()
      applyAppearance();
      // A theme/accent/density/opacity change repaints the in-player chrome live.
      const lookKey = (s) =>
        globalThis.GXT.theme?.settingsKey?.(s) || JSON.stringify(s);
      if (before && lookKey(before) !== lookKey(next)) {
        restylePill();
        if (panel) {
          closePanel();
          togglePanel();
        }
      }
      // Bilingual toggle flips from the popup too — repaint the caption.
      lastShown = undefined;
      tick();
    });
    // MAIN runs at document_start and can publish before this isolated script
    // exists. Pull once after registering our listener; a deduplicated push
    // cannot deliver an already-published answer to a late subscriber.
    if (settings?.enabled && settings.youtube !== false) requestInfo();
    mountPill();
  })();

  /**
   * Test seam — rewritten in v3.2.5.
   *
   * It used to expose `look()`, the inline paint helper, so a suite could assert
   * the palette contract without driving the player. That helper is gone (see
   * above), and asserting on it had become a test of a code path the product no
   * longer executed: it could have stayed green through any amount of breakage in
   * the stylesheet that actually paints this UI.
   *
   * What a suite needs instead is the ability to re-theme the LIVE surface and
   * then measure it. `__applyTheme` does exactly that and returns the shadow
   * root, so dev/mock-yt.html can walk the real nodes with getComputedStyle for
   * every theme and accent.
   */
  globalThis.GXT = globalThis.GXT || {};
  globalThis.GXT.youtube = Object.assign(globalThis.GXT.youtube || {}, {
    /**
     * Re-theme the in-player surface with `override` merged over the live
     * settings and hand back the shadow root to measure.
     *
     * Unlike `__look`, this does NOT restore the previous settings: the point is
     * to leave the surface in the state being measured. Callers pass the
     * original settings back when they are done.
     */
    __applyTheme(override) {
      if (override) settings = { ...(settings || {}), ...override };
      const host = globalThis.GXT.ui?.surface
        ? null // the shared layer owns the host; configure() re-themes it
        : ownHost;
      globalThis.GXT.ui?.configure?.(settings);
      if (host && globalThis.GXT.theme) {
        host.style.cssText = `${HOST_STYLE} ${globalThis.GXT.theme.tokens(settings, {
          inPage: true,
        })}`;
      }
      applyAppearance();
      return surfaceRoot;
    },
    /** The live shadow root, or null before the controls have mounted. */
    __root: () => surfaceRoot,
  });
})();
