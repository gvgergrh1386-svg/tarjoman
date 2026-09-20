/* General, browser-accessible subtitle sources. No MAIN-world hooks, network
 * interception, player commands, DRM access or cross-origin permission bypass. */
'use strict';
(() => {
  const GXT = globalThis.GXT ||= {};
  if (GXT.videoSources) return;
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_CUES = 20000;
  let nextTrack = 0;
  const trackIds = new WeakMap();
  const clean = (text) => String(text || '').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|nbsp|quot);/g,
    (s) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&quot;': '"' })[s]).trim();
  function safeURL(value, base) {
    try {
      if (!String(value || '').trim()) return null;
      const url = new URL(String(value), base);
      return ['https:', 'http:', 'blob:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }
  function time(value) {
    const parts = String(value).replace(',', '.').split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d+(?:\.\d+)?$/.test(p))) return NaN;
    const nums = parts.map(Number);
    if (nums.at(-1) >= 60 || nums.at(-2) >= 60) return NaN;
    return nums.reduce((n, p) => n * 60 + p, 0) * 1000;
  }
  function parseVtt(input) {
    if (typeof input !== 'string' || input.length > MAX_BYTES) throw new Error(globalThis.GXT.i18n.t("shared_video_sources_parseVtt_1"));
    const cues = [];
    for (const block of input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
      const lines = block.trim().split('\n');
      if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
      const at = lines.findIndex(l => l.includes('-->'));
      if (at < 0) continue;
      const match = lines[at].match(/^(\S+)\s+-->\s+(\S+)/);
      if (!match) continue;
      const start = time(match[1]); const end = time(match[2]);
      const raw = lines.slice(at + 1).join('\n'); const text = clean(raw);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
      const speaker = raw.match(/<v(?:\.[^\s>]+)?\s+([^>]+)>/)?.[1] || '';
      cues.push({ id: `${start}:${end}:${cues.length}`, start, end, text, speaker });
      if (cues.length > MAX_CUES) throw new Error(globalThis.GXT.i18n.t("shared_video_sources_fromTrack_1"));
    }
    return cues.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  function fromTrack(track) {
    const out = [];
    let list;
    try { list = track.cues; } catch { return out; }
    if ((list?.length || 0) > MAX_CUES) throw new Error(globalThis.GXT.i18n.t("shared_video_sources_fromTrack_1"));
    try {
      for (let i = 0; i < Math.min(list?.length || 0, MAX_CUES); i++) {
        const cue = list[i]; const text = clean(cue.text);
        const start = Number(cue.startTime) * 1000; const end = Number(cue.endTime) * 1000;
        if (Number.isFinite(start) && Number.isFinite(end) && end > start && text)
          out.push({ id: `${start}:${end}:${i}`, start, end, text, speaker: String(cue.text).match(/<v\s+([^>]+)>/)?.[1] || '' });
      }
    } catch { /* Unavailable browser cues remain unavailable. */ }
    return out.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  async function fetchVtt(url, signal) {
    const response = await fetch(url, { signal, credentials: 'same-origin', mode: 'cors' });
    if (!response.ok) throw new Error(globalThis.GXT.i18n.t("shared_video_sources_fetchVtt_2", {v0:(response.status)}));
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error(globalThis.GXT.i18n.t("shared_video_sources_fetchVtt_1"));
    const reader = response.body?.getReader();
    if (!reader) return parseVtt(await response.text());
    let size = 0; let text = ''; const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error(globalThis.GXT.i18n.t("shared_video_sources_fetchVtt_1"));
        text += decoder.decode(value, { stream: true });
      }
      return parseVtt(text + decoder.decode());
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  function create(video, identity, onChange) {
    const activated = new Map(); const listeners = new Map();
    let disposed = false;
    let domScope = null; let domObserver = null; let domSequence = 0;
    let domCues = []; let domText = ''; let domWatching = false;
    const DOM_CAPTIONS = '.vjs-text-track-display,.plyr__captions,.jw-captions,.shaka-text-container,[data-caption-text]';
    const mine = el => !!el.closest?.('[data-gxt-web-video],[data-gxt-web-video-dock]');
    function captionScope() {
      let scope=video.parentElement;
      for(let i=0;scope&&i<4;i++,scope=scope.parentElement) {
        if(scope.querySelectorAll('video').length!==1) return null;
        if(scope.querySelector(DOM_CAPTIONS)) return scope;
      }
      return null;
    }
    function captureDom() {
      if(!domWatching||!domScope||disposed) return;
      const nodes=[...domScope.querySelectorAll(DOM_CAPTIONS)].filter(el=>!mine(el));
      const text=nodes.filter(el=>!nodes.some(parent=>parent!==el&&parent.contains(el))).filter(el=>{
        const css=video.ownerDocument.defaultView.getComputedStyle(el);
        return !el.hidden&&css.display!=='none'&&css.visibility!=='hidden';
      }).map(el=>(el.innerText||el.textContent||'').trim()).filter(Boolean).join('\n');
      if(text===domText)return;
      const now=Math.max(0,video.currentTime*1000);
      const previous=domCues.at(-1);
      if(previous&&previous.end===Infinity)previous.end=Math.max(previous.start,now);
      domText=text;
      if(text)domCues.push({id:`dom-${++domSequence}`,start:now,end:Infinity,text,live:true});
      if(domCues.length>MAX_CUES)domCues.splice(0,domCues.length-MAX_CUES);
      onChange?.();
    }
    const listChanged = () => { if (!disposed) onChange?.(); };
    for (const type of ['addtrack', 'removetrack', 'change']) video.textTracks?.addEventListener(type, listChanged);
    const source = (extra) => ({ ...identity(), ...extra });
    function discover() {
      if (disposed) return [];
      const out = []; const current = new Set(); const urls = new Set();
      const tags = [...video.querySelectorAll('track')];
      for (const track of Array.from(video.textTracks || []).slice(0, 40)) {
        if (!['subtitles', 'captions'].includes(track.kind)) continue;
        if (!trackIds.has(track)) trackIds.set(track, ++nextTrack);
        const tag = tags.find(t => t.track === track);
        const url = tag?.src ? safeURL(tag.src, video.baseURI) : null;
        const label = track.label || track.language || globalThis.GXT.i18n.t("shared_video_sources_label_1");
        const auto = tag?.dataset.generated === 'true' || /\b(?:auto[ -]generated|automatic|asr)\b/i.test(label);
        out.push(source({ id: `texttrack-${trackIds.get(track)}:${url || ''}`, language: track.language || 'und',
          kind: track.kind, type: url ? 'track' : 'textTracks', automatic: auto ? true : tag?.dataset.generated === 'false' ? false : null,
          label, url, track, selected: track.mode === 'showing' }));
        if (url) urls.add(url);
        current.add(track);
        if (!listeners.has(track)) { track.addEventListener('cuechange', listChanged); listeners.set(track, listChanged); }
      }
      for (const [track, listener] of listeners) {
        if (!current.has(track)) { track.removeEventListener('cuechange', listener); listeners.delete(track); }
      }
      // Only declarations associated with this exact player are used. A random
      // .vtt URL elsewhere on a multi-video page is not evidence of ownership.
      const parent = video.parentElement;
      const roots = parent && parent.querySelectorAll('video').length === 1 ? [video, parent] : [video];
      for (const root of roots) {
        for (const key of ['subtitles', 'captions']) {
          const raw = root.dataset[key];
          if (!raw || raw.length > 65536) continue;
          try {
            const entries = JSON.parse(raw);
            for (const item of (Array.isArray(entries) ? entries : [entries]).slice(0, 40)) {
              const url = safeURL(item.src || item.file || '', video.baseURI);
              if (!url || urls.has(url) || !/\.vtt(?:[?#]|$)/i.test(url)) continue;
              urls.add(url);
              out.push(source({ id: `declared:${url}`, language: item.srclang || item.language || 'und', kind: 'subtitles',
                type: 'page-data', automatic: typeof item.automatic === 'boolean' ? item.automatic : null,
                label: String(item.label || item.language || globalThis.GXT.i18n.t("shared_video_sources_discover_2")).slice(0, 160), url }));
            }
          } catch { /* malformed or non-subtitle page data is not executable */ }
        }
      }
      const scope=captionScope();
      if(scope) {
        out.push(source({id:'dom-captions',language:'und',kind:'subtitles',type:'dom',automatic:null,get label() { return globalThis.GXT.i18n.t("shared_video_sources_discover_1"); },url:null}));
        if(domScope!==scope) {
          domObserver?.disconnect();domScope=scope;
          domObserver=new MutationObserver(changes=>{if(changes.some(c=>!mine(c.target.nodeType===1?c.target:c.target.parentElement)))captureDom();});
          domObserver.observe(scope,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden']});
        }
      }
      return out;
    }
    async function read(s, signal) {
      if (disposed || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (s.cues) return s.cues;
      if (s.type==='dom') {domWatching=true;captureDom();return domCues.map(c=>({...c}));}
      if (s.track) {
        if (s.track.mode === 'disabled') { activated.set(s.track, 'disabled'); s.track.mode = 'hidden'; }
        const cues = fromTrack(s.track);
        if (cues.length) return cues;
      }
      if (s.url) return fetchVtt(s.url, signal);
      return [];
    }
    function release() {
      domWatching=false;domText='';domCues=[];
      for (const [track, before] of activated) {
        // Respect a native menu change to showing/disabled made since activation.
        if (track.mode === 'hidden') track.mode = before;
      }
      activated.clear();
    }
    function dispose() {
      disposed = true;
      domObserver?.disconnect();domObserver=null;domScope=null;
      for (const type of ['addtrack', 'removetrack', 'change']) video.textTracks?.removeEventListener(type, listChanged);
      for (const [track, listener] of listeners) track.removeEventListener('cuechange', listener);
      listeners.clear(); release();
    }
    return { discover, read, release, dispose };
  }
  GXT.videoSources = { create, parseVtt, fromTrack, safeURL, MAX_BYTES, MAX_CUES };
})();
