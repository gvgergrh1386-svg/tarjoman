/**
 * YouTube MAIN-world helper — v3.3.8.
 *
 * Runs in the page's own world because caption-track metadata lives on
 * page-owned objects (the #movie_player API / ytInitialPlayerResponse) that
 * isolated content scripts cannot see. It only ever posts data OUT and accepts
 * a few whitelisted caption commands IN.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE WAS REWRITTEN — the «یوتیوب زیرنویس را نداد» bug
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Reported as: on videos that definitely have subtitles, the subtitle button
 * often fails, and the workaround is to reload the page and toggle the button
 * until it catches. Three defects in this file produced that, and all three are
 * about TIME.
 *
 * 1. THE POLL HAD A TEN-SECOND LIFETIME, THEN DIED FOREVER. It was
 *
 *        let tries = 0;
 *        const timer = setInterval(() => {
 *          tries += 1; send(); if (tries >= 10) clearInterval(timer);
 *        }, 1000);
 *
 *    — ten sends in the first ten seconds after document_start, and then no
 *    polling for the rest of the tab's life. Every SPA navigation after that
 *    was served by a single `setTimeout(send, 500)`. One guess, 500ms after
 *    `yt-navigate-finish`, was the entire mechanism. If the player was not
 *    ready at that instant, nothing correct was ever posted again.
 *
 * 2. A STALE PLAYER RESPONSE WAS POSTED AS AUTHORITATIVE, AND NEVER CORRECTED.
 *    500ms after `yt-navigate-finish`, `getPlayerResponse()` frequently still
 *    returns the PREVIOUS video's response. `send()` posted it. On the
 *    receiving side the id matched what was already stored, so nothing reset —
 *    the extension sat on video B holding video A's caption tracks, with no
 *    poll left alive to fix it. Clicking the pill then fetched A's captions.
 *
 * 3. AN EMPTY TRACKLIST WAS TREATED AS «THIS VIDEO HAS NO CAPTIONS».
 *    `send()` posted `tracks: []` as soon as a videoId existed, and
 *    `pr.captions` is routinely absent from an early or partial player
 *    response. The receiver marked the video caption-less and DISABLED the
 *    subtitle button. Reloading and toggling until a later tick caught the
 *    populated response is precisely the workaround that was reported.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT REPLACES IT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * · The poll RESTARTS on every navigation and runs until the answer is
 *   COHERENT — meaning the videoId it found matches the one the URL asks for —
 *   rather than for a fixed number of ticks. Intervals back off (fast while the
 *   player is warming up, slow once it is quiet) so a long watch costs nothing.
 * · Tracks come from THREE sources, tried in order, because they become
 *   available at different times: the player's live response, the player's own
 *   caption tracklist (populated when the captions module loads, which happens
 *   for some videos whose playerResponse never carries `captions`), and the
 *   initial page payload as a last resort.
 * · Every message says whether the answer is SETTLED. «I have not found
 *   captions yet» and «this video has none» are different claims and are no
 *   longer sent as the same message.
 * · A stale videoId is never posted at all.
 * · The receiver can ASK (`cmd: 'resend'`). Before, this channel was push-only,
 *   so a content script that missed the window had no way to enquire.
 */
'use strict';
(() => {
  if (window.__gxtYtMain) return;
  window.__gxtYtMain = true;

  // ------------------------------------------------ caption-URL capture
  //
  // v1.6.3 — YouTube stamps caption baseUrls with `exp=xpe`, which makes the
  // timedtext endpoint answer any programmatic request with an EMPTY 200 body
  // unless a runtime-generated proof-of-origin token (`pot`) is attached. The
  // player mints that token itself, so the one reliable way to obtain a
  // fetchable caption URL is to observe the request the player already makes.
  // Transparent pass-through hooks on fetch/XHR at document_start forward any
  // /api/timedtext URL we see.

  const seen = new Set();

  function noteCaptionUrl(raw) {
    try {
      if (!raw) return;
      const url = String(typeof raw === 'string' ? raw : raw instanceof URL ? raw.href : raw.url || '');
      if (!url || url.indexOf('/api/timedtext') === -1) return;
      if (seen.has(url)) return;
      seen.add(url);
      if (seen.size > 24) seen.delete(seen.values().next().value);
      window.postMessage({ source: 'gxt-yt-cc', url }, '*');
    } catch {
      /* never break YouTube */
    }
  }

  // Reuse a response the page legitimately received. Re-fetching a signed
  // timedtext URL can fail even when the native player has the caption body.
  // Observation never consumes or replaces the response returned to YouTube.
  const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
  const captionBodies = new Map();
  let captionPageGeneration = 0;
  let captionPageId = '';
  let readingBodies = 0;
  function syncCaptionPage(force = false) {
    const current = wantedVideoId();
    if (force || current !== captionPageId) {
      captionPageGeneration++;
      captionPageId = current;
      captionBodies.clear();
      seen.clear();
    }
  }
  function captionRequest(raw) {
    try {
      syncCaptionPage();
      const url = new URL(typeof raw === 'string' ? raw : raw?.url || raw?.href || '', location.href);
      if (url.pathname !== '/api/timedtext' || !/^(?:www\.)?youtube\.com$/.test(url.hostname) ||
          !url.searchParams.get('v') || url.searchParams.get('v') !== wantedVideoId() || url.searchParams.has('tlang')) return null;
      return {url:url.href,videoId:wantedVideoId(),generation:captionPageGeneration};
    } catch { return null; }
  }
  function publishCaptionBody(request, body) {
    syncCaptionPage();
    if (!request || request.generation !== captionPageGeneration || request.videoId !== wantedVideoId() ||
        typeof body !== 'string' || !body.trim() || body.length > MAX_CAPTURE_BYTES) return;
    const record = {...request,body};
    captionBodies.delete(request.url);
    captionBodies.set(request.url,record);
    let bytes = [...captionBodies.values()].reduce((sum,r)=>sum+r.body.length,0);
    while (captionBodies.size > 3 || bytes > MAX_CAPTURE_BYTES * 2) {
      const first=captionBodies.keys().next().value; bytes-=captionBodies.get(first).body.length; captionBodies.delete(first);
    }
    window.postMessage({source:'gxt-yt-body',...record},'*');
  }
  async function observeCaptionResponse(response, request) {
    if (!request || !response?.ok || readingBodies >= 2 || Number(response.headers?.get('content-length') || 0) > MAX_CAPTURE_BYTES) return;
    let reader, timer;
    readingBodies++;
    try {
      const clone = response.clone();
      if (!clone.body?.getReader) return;
      reader = clone.body.getReader();
      timer = setTimeout(()=>{void reader.cancel().catch(()=>{});},4000);
      const decoder=new TextDecoder(); let body='',bytes=0;
      for (;;) {
        const {done,value}=await reader.read();
        if (done) break;
        bytes+=value.byteLength;
        if (bytes>MAX_CAPTURE_BYTES || request.generation!==captionPageGeneration) {void reader.cancel().catch(()=>{});return;}
        body+=decoder.decode(value,{stream:true});
      }
      body+=decoder.decode();
      publishCaptionBody(request,body);
    } catch { /* observing a response must never break playback */ }
    finally {clearTimeout(timer);try{reader?.releaseLock();}catch{} readingBodies--;}
  }
  try {
    const origFetch=window.fetch;
    if (typeof origFetch==='function') window.fetch=function(input) {
      let request=null;
      try {noteCaptionUrl(input);request=captionRequest(input);} catch {}
      const result=origFetch.apply(this,arguments);
      if (request) void result.then(response=>observeCaptionResponse(response,request),()=>{});
      return result;
    };
  } catch { /* leave unusual fetch implementations alone */ }
  try {
    const origOpen=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url) {
      let request=null;
      try {noteCaptionUrl(url);request=captionRequest(url);} catch {}
      if (request) this.addEventListener('loadend',()=>{
        try {
          if (this.status<200 || this.status>=300) return;
          const body=this.responseType==='json' ? JSON.stringify(this.response) : (!this.responseType || this.responseType==='text') ? this.responseText : '';
          publishCaptionBody(request,body);
        } catch {}
      },{once:true});
      return origOpen.apply(this,arguments);
    };
  } catch {}
  document.addEventListener('yt-navigate-start',()=>syncCaptionPage(true),true);
  window.addEventListener('popstate',()=>syncCaptionPage(true));

  // ------------------------------------------------------ track metadata

  // v1.8: Shorts uses its own player element with the same ytp API surface.
  const getPlayer = () =>
    document.getElementById('movie_player') || document.getElementById('shorts-player');

  /**
   * The videoId the ADDRESS BAR is asking for.
   *
   * This is the arbiter of staleness, and it is why defect 2 above is fixable
   * at all: the player's response can lag, but the URL cannot — YouTube has
   * already committed to the new video by the time `yt-navigate-finish` fires.
   * Anything the player reports that disagrees with this is the previous video
   * and must be discarded rather than published.
   *
   * Returns '' on a page that is not a video (the home feed, a channel), where
   * there is nothing to be stale about.
   */
  function wantedVideoId() {
    try {
      const path = location.pathname;
      if (path.startsWith('/watch')) {
        return new URLSearchParams(location.search).get('v') || '';
      }
      const shorts = path.match(/^\/shorts\/([\w-]+)/);
      if (shorts) return shorts[1];
      // /live/<id> and /embed/<id> both play a video.
      const other = path.match(/^\/(?:live|embed)\/([\w-]+)/);
      return other ? other[1] : '';
    } catch {
      return '';
    }
  }

  const trackName = (t) =>
    t?.name?.simpleText ||
    (Array.isArray(t?.name?.runs) ? t.name.runs.map((r) => r.text).join('') : '') ||
    // The player's own tracklist uses different field names from the ones in a
    // player response; accept both so STRATEGY B produces comparable objects.
    t?.displayName ||
    t?.languageName?.simpleText ||
    '';

  const normalise = (t) => ({
    baseUrl: t?.baseUrl || t?.url || '',
    lang: t?.languageCode || t?.lang || '',
    kind: t?.kind || (t?.vss_id?.startsWith('a.') ? 'asr' : '') || '',
    name: trackName(t),
  });

  /**
   * STRATEGY A — the player's live response, else the initial page payload.
   *
   * `getPlayerResponse()` is authoritative once the player has swapped to the
   * new video. `ytInitialPlayerResponse` only ever describes the video the
   * document was LOADED with, so on an SPA navigation it is permanently stale;
   * it is kept strictly as a first-paint fallback and its videoId is checked
   * like everything else.
   */
  function fromPlayerResponse(player) {
    let live = null;
    try { live = player?.getPlayerResponse?.(); } catch { /* use initial payload */ }
    const wanted = wantedVideoId();
    let fallback = null;
    for (const pr of [live, window.ytInitialPlayerResponse]) {
      const videoId = pr?.videoDetails?.videoId || '';
      if (!videoId || (wanted && videoId !== wanted)) continue;
      const renderer = pr?.captions?.playerCaptionsTracklistRenderer;
      const tracks = (renderer?.captionTracks || []).map(normalise);
      const isLivePr = pr === live;
      /**
       * WHEN IS THE CAPTION QUESTION ACTUALLY ANSWERED?
       *
       * The obvious rule — «settled once a `captions` renderer exists» — is
       * WRONG, and getting this wrong the first time is instructive. For a video
       * that genuinely has no captions, YouTube omits the `captions` key
       * entirely rather than sending an empty list. Under that rule such a video
       * would never settle: the button would stay enabled, every press would
       * burn the whole retry ladder before saying «no subtitles», and
       * `knownCaptionless()` would be dead code.
       *
       * A player response is not delivered in pieces. It is one JSON object, and
       * `getPlayerResponse()` returns either the PREVIOUS video's complete
       * response or the new video's complete response — never half of one. So
       * the timing problem is entirely a STALENESS problem, which the videoId
       * check above already solves, and completeness is the right test here.
       * `playabilityStatus` is present on every genuine response and is the
       * cheapest marker of one.
       *
       * The single exception is the `ytInitialPlayerResponse` fallback with no
       * tracks. That object describes the video the DOCUMENT was loaded with, and
       * on some watch pages it legitimately lacks captions that the player's own
       * response does carry. Tracks found there are real (tracks are tracks), but
       * their ABSENCE is not evidence — so it does not settle.
       */
      const complete = !!(pr.playabilityStatus || pr.streamingData);
      const settled = tracks.length
        ? true
        : isLivePr
          ? complete
          : false;
      const result = {
        videoId,
        title: pr?.videoDetails?.title || '',
        isLive: !!pr?.videoDetails?.isLive,
        tracks,
        settled,
        via: isLivePr ? 'playerResponse' : 'ytInitialPlayerResponse',
      };
      if (tracks.length) return result;
      if (!fallback) fallback = result;
    }
    return fallback;
  }

  /**
   * STRATEGY B — the player's own caption tracklist.
   *
   * A genuinely independent source, not a retry of A: this list is populated by
   * the captions MODULE, which loads on its own schedule and sometimes carries
   * tracks for a video whose player response never grows a `captions` key. It
   * has no `baseUrl` (the player keeps that private), so it cannot replace A —
   * but it can prove that captions EXIST, which is enough to stop the receiver
   * declaring a video caption-less and disabling its own button.
   */
  function fromPlayerTracklist(player) {
    try {
      const list = player?.getOption?.('captions', 'tracklist');
      if (!Array.isArray(list) || !list.length) return null;
      return list.map(normalise).filter((t) => t.lang || t.name);
    } catch {
      // getOption throws if the captions module is not loaded. Normal, not an
      // error: strategy A is the usual winner and this is the safety net.
      return null;
    }
  }

  /** The last payload posted, so an unchanged answer is not re-broadcast. */
  let lastSent = '';

  /**
   * Gather and publish, if there is anything coherent to publish.
   * @returns {boolean} true once a SETTLED answer for the wanted video is out.
   */
  function send(force = false) {
    try {
      const wanted = wantedVideoId();
      const player = getPlayer();
      const found = fromPlayerResponse(player);
      if (!found) return false;
      // Defect 2: never publish another video's data. On a page with no video
      // id in the URL (an embed on a channel page) there is nothing to compare
      // against, so the player's own answer stands.
      if (wanted && found.videoId !== wanted) return false;

      let { tracks, settled, via } = found;
      // Strategy B fills in for a response that has not grown its captions key.
      if (!tracks.length) {
        const fallback = fromPlayerTracklist(player);
        if (fallback && fallback.length) {
          tracks = fallback;
          settled = true;
          via = `${via}+tracklist`;
        }
      }

      const payload = {
        source: 'gxt-yt',
        videoId: found.videoId,
        title: found.title,
        isLive: found.isLive,
        tracks,
        // `settled: false` means «still looking» — the receiver must not turn
        // that into «this video has no subtitles».
        settled,
        via,
      };
      const key = JSON.stringify(payload);
      if (force === true || key !== lastSent) {
        lastSent = key;
        window.postMessage(payload, '*');
      }
      return settled;
    } catch {
      return false; // never break YouTube
    }
  }

  // ------------------------------------------------------------- polling
  //
  // BACKOFF, RESTARTED PER NAVIGATION. The old poll ran ten times at a flat
  // 1s and then stopped for good. This one is fast while the player is warming
  // up (which is the only time it matters), stretches out as it goes, and keeps
  // a slow heartbeat afterwards so a late-loading caption track is still picked
  // up — a video whose captions module loads twenty seconds in used to be
  // unreachable for the rest of the session.
  //
  // The schedule is in milliseconds FROM the navigation, not an interval, so
  // the early attempts really are early regardless of timer drift.
  const PROBE_SCHEDULE = [
    0, 120, 260, 450, 700, 1000, 1400, 1900, 2500, 3200, 4200, 5500, 7000, 9000,
    12000, 16000, 21000, 27000,
  ];
  /** After the schedule runs out, keep a quiet heartbeat for late tracks. */
  const HEARTBEAT_MS = 15000;

  let timers = [];
  let heartbeat = 0;

  function stopPolling() {
    for (const id of timers) clearTimeout(id);
    timers = [];
    clearInterval(heartbeat);
    heartbeat = 0;
  }

  /**
   * (Re)start discovery for whatever the URL now points at.
   *
   * Called at load, on every YouTube navigation event, and when the content
   * script asks. Idempotent: it always clears the previous schedule first, so
   * two navigation events in quick succession cannot leave two ladders running.
   */
  function startPolling() {
    stopPolling();
    lastSent = '';
    /**
     * THE LADDER ALWAYS RUNS TO THE END. My first cut stopped it as soon as the
     * answer was «settled», which sounds like a sensible optimisation and is the
     * same mistake the old code made in a different costume: a video whose
     * complete player response has no captions settles immediately, and its
     * caption module can still publish a tracklist a second later (see STRATEGY
     * B). Bailing out meant that track was invisible until the next heartbeat —
     * fifteen seconds of the button insisting the video has no subtitles. The
     * harness caught it on the one assertion that matters most here.
     *
     * `send()` is a few property reads and a JSON.stringify of a small object,
     * and it only POSTS when the answer actually changed, so running every rung
     * costs nothing worth optimising. Being clever about when to stop looking is
     * what produced this whole class of bug.
     */
    for (const delay of PROBE_SCHEDULE) {
      timers.push(setTimeout(send, delay));
    }
    // And a permanent slow heartbeat after the ladder, for a track that shows up
    // minutes in (a live stream that starts captioning mid-broadcast).
    heartbeat = setInterval(send, HEARTBEAT_MS);
  }

  /**
   * Every event YouTube gives us for «the page became a different video».
   *
   * `yt-navigate-finish` is the documented one and it is what the old code
   * used, but it is not always the last word — `yt-player-updated` fires when
   * the player itself swaps, which is exactly the moment a stale player
   * response becomes fresh. Listening to all of them costs nothing (the poll
   * is idempotent) and removes the dependence on any single one of them being
   * the right hook.
   */
  for (const type of [
    'yt-navigate-finish',
    'yt-navigate-start',
    'yt-player-updated',
    'yt-page-data-updated',
  ]) {
    document.addEventListener(type, startPolling, true);
  }

  // A history change with no YouTube event at all (a back button on some
  // surfaces) still has to be caught, and the URL is the thing that changed.
  window.addEventListener('popstate', startPolling);
  window.addEventListener('yt-navigate', startPolling);

  startPolling();

  // --------------------------------------------------------- commands in

  /**
   * Native captions are a borrowed resource, not an on/off switch.
   * Remember exactly what the viewer had (including the selected track), then
   * restore it on release. This prevents a translation session from turning
   * YouTube captions on for someone who had them off, or changing their track.
   */
  let captionLease = null;
  let probeLease = null;
  let probeNudgeTimer = 0;
  let probeRequestId = null;

  function nativeCaptionButton() {
    return document.querySelector('.ytp-subtitles-button');
  }

  function nativeCaptionState() {
    const pressed = nativeCaptionButton()?.getAttribute('aria-pressed');
    return pressed === 'true' ? true : pressed === 'false' ? false : null;
  }

  /** Use YouTube's own CC action whenever possible. This is deliberately the
   * same action the user reported doing by hand; loadModule alone does not
   * always make the player mint and request a fresh PoToken URL. */
  function setNativeCaptions(player, on) {
    const button = nativeCaptionButton();
    const current = nativeCaptionState();
    if (button && current != null && current !== on) {
      button.click();
      return;
    }
    if (on) {
      player?.loadModule?.('captions');
      if (current !== true) player?.toggleSubtitles?.();
    } else {
      player?.unloadModule?.('captions');
    }
  }

  function captionSnapshot(player) {
    let track = null;
    let on = false;
    try { track = player?.getOption?.('captions', 'track') || null; } catch { /* unavailable */ }
    try {
      const native = nativeCaptionState();
      on = native != null
        ? native
        : typeof player?.isSubtitlesOn === 'function'
          ? !!player.isSubtitlesOn()
          : !!track;
    } catch { on = !!track; }
    // The player may mutate its current track when selecting another one.
    // Preserve the native auto-translation setting independently of that object.
    if (track && typeof track === 'object') {
      track = { ...track, ...(track.translationLanguage ? { translationLanguage: { ...track.translationLanguage } } : {}) };
    }
    return { on, track, videoId: wantedVideoId() };
  }

  function restoreCaptions(player, snapshot) {
    if (!snapshot) return;
    if (snapshot.on) setNativeCaptions(player, true);
    if (snapshot.track && snapshot.videoId === wantedVideoId()) {
      try { player?.setOption?.('captions', 'track', snapshot.track); } catch { /* stale track */ }
    }
    // Restore the remembered target even when CC started OFF. A probe changes
    // that preference too; turn captions off LAST because setOption can enable
    // the module as a side effect.
    if (!snapshot.on) setNativeCaptions(player, false);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'gxt-yt-cmd') return;
    const player = getPlayer();
    try {
      const cmd = event.data.cmd;
      if (cmd === 'captionsOff') {
        clearTimeout(probeNudgeTimer);
        if (!captionLease) captionLease = probeLease || captionSnapshot(player);
        probeLease = null;
        setNativeCaptions(player, false);
      } else if (cmd === 'captionsOn') {
        if (captionLease) restoreCaptions(player, captionLease);
        captionLease = null;
      }
      else if (cmd === 'resend') {
        syncCaptionPage();
        for (const record of captionBodies.values()) window.postMessage({source:'gxt-yt-body',...record},'*');
        /**
         * The PULL channel — v3.3.0.
         *
         * This was push-only, so a content script that missed the window had no
         * way to enquire and simply waited forever. Now the receiver can ask,
         * and asking also RESTARTS discovery when the answer is not settled yet,
         * which is what makes «the user clicked the button early» recoverable
         * instead of a hard error.
         */
        if (!send(true) && event.data.retry !== false) startPolling();
      } else if (cmd === 'captionsProbe') {
        // Nudge the player into loading its caption module so it issues its
        // own (token-carrying) timedtext request, which our hooks capture.
        // Selecting a track is what actually triggers the fetch.
        if (!captionLease && !probeLease) probeLease = captionSnapshot(player);
        probeRequestId = event.data.requestId ?? null;
        const probeVideoId = wantedVideoId();
        setNativeCaptions(player, true);
        const selectWantedTrack = () => { try {
          if (wantedVideoId() !== probeVideoId || getPlayer() !== player) return;
          const list = player?.getOption?.('captions', 'tracklist') || [];
          const wanted =
            list.find((t) => t.languageCode === event.data.lang && normalise(t).kind === (event.data.kind || '')) ||
            list.find((t) => t.languageCode === event.data.lang) ||
            list.find((t) => t.kind !== 'asr') ||
            list[0];
          if (wanted) {
            // A track object can inherit the viewer's native auto-translate
            // target. Explicitly clear it on a COPY so the player requests
            // original captions, then restore the exact snapshot on release.
            player?.setOption?.('captions', 'track', { ...wanted, translationLanguage: null });
          }
        } catch {
          /* tracklist unavailable: loadModule alone may still trigger a fetch */
        } };
        selectWantedTrack();
        clearTimeout(probeNudgeTimer);
        probeNudgeTimer = setTimeout(() => {
          if (!probeLease || captionLease || wantedVideoId() !== probeVideoId || getPlayer() !== player) return;
          setNativeCaptions(player, true);
          selectWantedTrack();
        }, 180);
        // Loading the module often populates the tracklist, which can settle a
        // video that strategy A never answered for. Look again shortly after.
        setTimeout(send, 300);
        setTimeout(send, 900);
      } else if (cmd === 'captionsProbeDone') {
        if ((event.data.requestId ?? null) !== probeRequestId) return;
        clearTimeout(probeNudgeTimer);
        probeNudgeTimer = 0;
        if (probeLease && !captionLease) restoreCaptions(player, probeLease);
        probeLease = null;
        probeRequestId = null;
      }
    } catch {
      /* ignore */
    }
  });
})();
