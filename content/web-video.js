/* Opt-in general HTML video integration, isolated from the YouTube adapter.
 * One mutation/resize/intersection observer per document; no polling scans.
 * Every pending operation belongs to a player, media, source and settings epoch. */
'use strict';
(() => {
  const GXT = globalThis.GXT ||= {};
  if (GXT.webVideo || !GXT.videoSources || /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(location.hostname)) return;
  const managers=new Map();const playerPreferences=new WeakMap();let latestSettings=null;let managerNumber=0;
  function createManager(window) {
  const document=window.document;const location=globalThis.location;
  const getComputedStyle=window.getComputedStyle.bind(window);
  const requestAnimationFrame=window.requestAnimationFrame.bind(window),cancelAnimationFrame=window.cancelAnimationFrame.bind(window);
  const MutationObserver=window.MutationObserver,ResizeObserver=window.ResizeObserver,IntersectionObserver=window.IntersectionObserver;
  let innerWidth=window.innerWidth,innerHeight=window.innerHeight;const managerId=++managerNumber;
  const DEFAULTS = { webVideoEnabled: false, webVideoSubtitles: true, webVideoDub: true,
    webVideoDisplay: 'auto', webVideoSiteMode: 'all', webVideoBlockedSites: [], webVideoAllowedSites: [], webVideoDubEngine: 'auto' };
  const records = new Map(); const candidates = new Set(); const objectIds = new WeakMap();
  let settings = { ...DEFAULTS }; let enabled = false; let disposed = false;
  let nextId = 0; let objectId = 0; let pageGeneration = 1; let pageURL = location.href;
  let mutations = null; let resize = null; let intersection = null; let layoutFrame = 0;
  let dock = null; let dockRoot = null; const globalListeners = []; const shadowRoots = new Set();
  const isMine = node => !!node?.closest?.('[data-gxt-web-video],[data-gxt-web-video-dock]') || !!node?.getRootNode?.().host?.closest?.('[data-gxt-web-video],[data-gxt-web-video-dock]');
  const within = (root, node) => { for(let n=node;n;n=n.getRootNode?.().host)if(root===n||root?.contains?.(n))return true;return false; };
  function fullscreenElement() {let el=document.fullscreenElement;while(el?.shadowRoot?.fullscreenElement)el=el.shadowRoot.fullscreenElement;return el;}
  const inViewport = video => {const r=video.getBoundingClientRect();return r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;};
  const OBSERVE = {childList:true,subtree:true,attributes:true,attributeFilter:['src','type','controls','style','class','hidden','aria-hidden','data-subtitles','data-captions','srclang','label']};
  function siteAllowed(s, host = location.hostname) {
    if (!s.webVideoEnabled || s.enabled === false) return false;
    const matches = list => Array.isArray(list) && list.some(entry => {
      const domain = String(entry).trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
      return domain && (host.toLowerCase() === domain || host.toLowerCase().endsWith('.' + domain));
    });
    return !matches(s.webVideoBlockedSites) && (s.webVideoSiteMode !== 'allowlist' || matches(s.webVideoAllowedSites));
  }
  const intersects = (a, b) => a.x < b.x + b.width + 5 && a.x + a.width + 5 > b.x && a.y < b.y + b.height + 5 && a.y + a.height + 5 > b.y;
  function choosePlacement(width, height, obstacles = []) {
    if (width < 150 || height < 94) return { mode: 'external', x: 0, y: 0, width: 0, height: 0 };
    const modes = width >= 560 && height >= 260 ? ['full', 'compact', 'icon'] : width >= 220 && height >= 150 ? ['compact', 'icon'] : ['icon'];
    for (const mode of modes) {
      const w = mode === 'full' ? 234 : mode === 'compact' ? 126 : 36; const h = 34;
      const positions = [[width - w - 10, 10], [10, 10], [width - w - 10, 62], [10, 62],
        [width - w - 10, height - h - 78], [10, height - h - 78]];
      for (const [x, y] of positions) {
        const candidate = { mode, x, y, width: w, height: h };
        if (x >= 6 && y >= 6 && x + w <= width - 6 && y + h <= height - 6 && !obstacles.some(o => intersects(candidate, o))) return candidate;
      }
    }
    return { mode: 'external', x: 0, y: 0, width: 0, height: 0 };
  }
  function score(video, rect, interacted = false) {
    if (!video.isConnected || rect.width < 60 || rect.height < 40 || video.hidden) return -1;
    const style = getComputedStyle(video);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return -1;
    // Muted looping background clips are passive candidates until interacted with.
    const background = video.loop && video.muted && !video.controls;
    return Math.min(80, Math.sqrt(rect.width * rect.height) / 8) + (!video.paused && !video.ended ? 100 : 0)
      + (interacted ? 150 : 0) + (video.controls ? 12 : 0) - (background && !interacted ? 140 : 0);
  }
  function containerFor(video) {
    const rect = video.getBoundingClientRect(); let best = video;
    for (let parent = video.parentElement, depth = 0; parent && parent !== document.body && depth < 4; parent = parent.parentElement, depth++) {
      if (parent.querySelectorAll('video').length !== 1) break;
      const r = parent.getBoundingClientRect();
      if (r.width > rect.width * 1.35 + 32 || r.height > rect.height * 1.5 + 80) break;
      best = parent;
      if (parent.matches('[role="region"],.video-js,.plyr,.jwplayer,[data-player]')) break;
    }
    return best || video;
  }
  function obstaclesFor(record, rect) {
    const obstacles = [];
    if (record.video.controls) obstacles.push({ x: 0, y: Math.max(0, rect.height - 68), width: rect.width, height: 68 });
    if (Array.from(record.video.textTracks || []).some(t => t.mode === 'showing'))
      obstacles.push({ x: rect.width * .08, y: rect.height * .62, width: rect.width * .84, height: rect.height * .30 });
    const elements = record.container.querySelectorAll('button,input,[role="button"],[role="slider"],[role="toolbar"],.vjs-control-bar,.plyr__controls,.jw-controlbar,[class*="caption"],[class*="subtitle"]');
    for (const el of [...elements].slice(0, 90)) {
      if (isMine(el)) continue;
      const r = el.getBoundingClientRect(); const style = getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      if (r.right <= rect.left || r.left >= rect.right || r.bottom <= rect.top || r.top >= rect.bottom) continue;
      obstacles.push({ x: r.left - rect.left, y: r.top - rect.top, width: r.width, height: r.height });
    }
    return obstacles;
  }
  const STYLE = `
    :host{all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;min-width:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;outline:0!important;background:transparent!important;transform:none!important;box-shadow:none!important;overflow:visible!important;z-index:2147483000!important;font:13px/1.5 system-ui,sans-serif!important;direction:var(--gxt-ui-dir,rtl)!important;color:var(--gxt-fg,#fff)!important;pointer-events:none!important;contain:layout style!important}
    :host([hidden]){display:none!important}:host::before,:host::after{content:none!important;display:none!important}:host([data-panel-open]){z-index:2147483100!important}
    *{box-sizing:border-box} [hidden]{display:none!important}
    button,select,input{font:inherit;color:var(--gxt-fg,#fff);accent-color:var(--gxt-accent-solid,#3475b9)}button,select,input[type=text]{border:1px solid var(--gxt-line-strong,#777);border-radius:var(--gxt-radius-sm,8px);background:var(--gxt-bg,#111722);color:var(--gxt-fg,#fff);min-height:30px;padding:3px 9px}button,select{cursor:pointer}input[type=text]{width:100%;min-width:0}input::placeholder{color:var(--gxt-fg-muted,#ccd0d7);opacity:1}select option{background:var(--gxt-bg,#111722);color:var(--gxt-fg,#fff)}
    button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--gxt-accent,#61acff);outline-offset:2px}button:disabled,select:disabled,input:disabled{opacity:1;color:var(--gxt-fg-muted,#ccd0d7);border-style:dashed;cursor:not-allowed}button[aria-pressed=true]{background:var(--gxt-accent-solid,#3475b9);color:var(--gxt-accent-fg,#fff)}
    .caption{touch-action:none;user-select:none;cursor:grab;pointer-events:auto!important}.caption.drag-disabled{pointer-events:none!important}.caption:active{cursor:grabbing}.caption:empty{display:none!important}.caption{z-index:1}.toolbar{z-index:2}.panel{z-index:3}
    .toolbar{position:absolute;display:flex;align-items:center;gap:4px;pointer-events:auto;white-space:nowrap;background:var(--gxt-bg,#111722);padding:2px;border:1px solid var(--gxt-border,#777);border-radius:var(--gxt-radius-md,10px);height:34px;max-width:100vw;box-shadow:var(--gxt-shadow,0 2px 8px #0008)}
    .toolbar button{min-height:28px;padding:1px 7px;border:0}.toolbar[data-mode=compact] .label{display:none}.toolbar[data-mode=icon] .feature{display:none}.toolbar[data-mode=icon] .menu{width:30px;padding:0}
    .panel{pointer-events:auto;position:fixed;width:310px;max-width:calc(100vw - 20px);max-height:min(420px,70vh);overflow:auto;padding:13px;background:var(--gxt-bg,#131923);border:1px solid var(--gxt-border,#777);border-radius:var(--gxt-radius-lg,14px);box-shadow:var(--gxt-shadow,0 5px 22px #0008)}
    .panel strong{display:block;margin-bottom:8px}.panel label{display:block;margin:8px 0}.panel select{display:block;width:100%;max-width:100%}.actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.status{font-size:12px;color:var(--gxt-fg-muted,#ccd0d7);margin:8px 0;overflow-wrap:anywhere}.file{width:100%;font-size:12px}.caption{position:absolute;direction:var(--gxt-content-dir,rtl);unicode-bidi:plaintext;text-align:center;white-space:pre-line;overflow-wrap:anywhere;color:white;background:#080c13ed;border-radius:7px;padding:5px 10px;font:600 clamp(13px,2.1vw,24px)/1.5 system-ui;max-height:30%;overflow:hidden;pointer-events:none;text-shadow:0 1px 3px #000}.external-caption{position:fixed;bottom:62px;right:16px;max-width:360px;max-height:100px}
    .dock{pointer-events:auto;position:fixed;right:12px;bottom:12px;max-width:300px;display:flex;gap:5px;flex-wrap:wrap;padding:6px;background:var(--gxt-bg,#131923);border:1px solid var(--gxt-border,#777);border-radius:10px}.dock button{font-size:12px}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}@media(forced-colors:active){button,.toolbar,.panel,.caption,.dock{background:Canvas;color:CanvasText;border:1px solid CanvasText}}
  `;
  const translationKey = s => JSON.stringify([GXT.cacheNamespace?.(s), s.provider, s.model, s.openaiModel,
    s.openaiBaseUrl, s.targetLang, s.tone, s.glossary, s.customInstruction, s.temperature, s.translationMode]);
  function mediaKey(video) {
    const obj = video.srcObject;
    if (obj && !objectIds.has(obj)) objectIds.set(obj, ++objectId);
    return JSON.stringify([video.getAttribute('src'), video.currentSrc, [...video.querySelectorAll('source')].map(s => [s.src, s.type]), obj ? objectIds.get(obj) : null]);
  }
  async function send(message) { try { return await chrome.runtime.sendMessage(message); } catch { return { ok: false, code: 'DISCONNECTED' }; } }
  class Player {
    constructor(video, interacted = false) {
      this.video = video; this.id = `web-player-${managerId}-${++nextId}`; this.videoGeneration = 1; this.generation = 1;
      this.mediaKey = mediaKey(video); this.container = containerFor(video); this.disposed = false;
      this.listeners = []; this.sources = []; this.sourceId = ''; this.cues = []; this.translated = new Map(); this.failed = new Set();
      this.subtitles = false; this.dubbing = false; this.interacted = interacted; this.visible = true; this.readyForSource = true;
      this.pending = false; this.loading = false; this.sourceReadGeneration = 0; this.controller = null; this.dubber = null;
      this.translationJobs=new Set();this.requestedCues=new Set();this.retryState=new Map();this.retryTimer=0;this.sourceDirty=false;
      this.metrics={requested:0,translated:0,late:0,retried:0,failed:0};
      this.dubOptions=playerPreferences.get(video)?.dubOptions||{engine:settings.webVideoDubEngine||'auto'};this.activeDubEngine='';this.liveText='';this.liveTextAt=0;
      this.visual=playerPreferences.get(video)?.visual||{scale:Number(settings.ytScale)||1,x:50,y:72,bilingual:false,manual:false,drag:true,...settings.webVideoCaptionPosition};
      playerPreferences.set(video,{dubOptions:this.dubOptions,visual:this.visual});
      this.idle=false;this.idleTimer=0;this.lastInteraction=Date.now();this.fullscreen=false;this.chromeHeld=false;
      this.sourceReader = GXT.videoSources.create(video, () => ({ playerId: this.id,
        videoId: `${this.id}:${this.videoGeneration}`, videoGeneration: this.videoGeneration, pageGeneration }), () => this.sourcesChanged());
      this.buildUI();
      this.interact = () => this.wakeControls();
      this.containerListeners = []; this.bindContainer();
      for (const type of ['play', 'pause', 'ended', 'seeking', 'seeked', 'ratechange', 'timeupdate']) this.listen(video, type, () => {
        checkPage(); this.checkMedia(); if (['play','pause','ended'].includes(type)) this.wakeControls(); this.tick();
      });
      for (const type of ['loadedmetadata', 'loadeddata', 'emptied', 'loadstart']) this.listen(video, type, () => {
        this.checkMedia();
        if (type === 'emptied') this.invalidateMedia();
        if (type === 'loadedmetadata' || type === 'loadeddata') { this.readyForSource = true; this.sourcesChanged(); }
        queueLayout();
      });
      this.listen(video, 'load', () => this.sourcesChanged(), true);
      this.refreshSources();
      resize?.observe(video); if (this.container !== video) resize?.observe(this.container);
      intersection?.observe(video);
    }
    listen(target, type, fn, capture = false) { target.addEventListener(type, fn, capture); this.listeners.push(() => target.removeEventListener(type, fn, capture)); }
    bindContainer() {
      for(const off of this.containerListeners)off();this.containerListeners=[];
      for(const type of ['pointerdown','pointermove','keydown']){const target=this.container;target.addEventListener(type,this.interact);this.containerListeners.push(()=>target.removeEventListener(type,this.interact));}
    }
    checkContainer() {
      const container=containerFor(this.video);if(container===this.container)return;
      if(this.container!==this.video)resize?.unobserve(this.container);
      this.container=container;this.bindContainer();if(container!==this.video)resize?.observe(container);
    }
    wakeControls() {
      if(this.disposed)return;this.interacted=true;this.idle=false;this.lastInteraction=Date.now();
      if(this.layout?.mode!=='external'&&this.inView)this.toolbar.hidden=false;
      this.armIdle();queueLayout();
    }
    armIdle() {
      clearTimeout(this.idleTimer);this.idleTimer=0;
      if(!this.fullscreen||this.video.paused||!this.panel.hidden||this.chromeHeld||this.disposed)return;
      this.idleTimer=setTimeout(()=>{this.idleTimer=0;this.idle=true;queueLayout();},2500);
    }
    nativeControlsHidden() {
      const controls=[...this.container.querySelectorAll('.vjs-control-bar,.plyr__controls,.jw-controlbar,.mejs__controls,[role="toolbar"],[data-controls]')].filter(el=>!isMine(el));
      return controls.length>0&&controls.every(el=>{const css=getComputedStyle(el);return el.hidden||css.visibility==='hidden'||css.display==='none'||Number(css.opacity)===0||el.getAttribute('aria-hidden')==='true';});
    }
    dubEngine() {return this.dubbing&&this.activeDubEngine?this.activeDubEngine:this.dubOptions.engine==='auto'?(this.sources.length?'caption':'live'):this.dubOptions.engine;}
    dubSettings() {return {...settings,ytLiveModel:this.dubOptions.model??settings.ytLiveModel,ytLiveSourceLang:this.dubOptions.sourceLang??settings.ytLiveSourceLang,ytLiveDuck:this.dubOptions.duck??settings.ytLiveDuck,ytDubDuck:this.dubOptions.duck??settings.ytDubDuck};}
    setDubOptions(patch) {
      const before=this.dubEngine();Object.assign(this.dubOptions,patch);const active=this.dubbing;
      if(active&&patch.engine&&patch.engine!==before){this.dubbing=false;this.activeDubEngine='';this.dubber?.stop();void this.toggleDub();}
      else this.dubber?.configure(this.dubSettings());
      this.message='';this.paintStatus();this.wakeControls();
    }
    handleDubState(stats) {
      if(this.disposed)return;
      const error=stats.error||stats.lastError;
      if(stats.live?.state==='completed'){this.dubbing=false;this.activeDubEngine='';this.paintStatus(globalThis.GXT.i18n.t("content_web_video_createManager_60"));return;}
      if(error&&stats.mode==='caption'&&stats.running){this.paintStatus(error.error||error.message||globalThis.GXT.i18n.t("content_web_video_createManager_59"));return;}
      if(error||stats.live?.state==='error'){
        this.dubbing=false;this.activeDubEngine='';
        this.dubber?.stop();
        this.paintStatus(error?.error||error?.message||globalThis.GXT.i18n.t("content_web_video_createManager_58"));
      } else if(this.dubbing&&this.activeDubEngine==='live') {
        const states={get capturing() { return globalThis.GXT.i18n.t("content_web_video_states_8"); },get connecting() { return globalThis.GXT.i18n.t("content_web_video_states_7"); },get live() { return globalThis.GXT.i18n.t("content_web_video_states_6"); },get active() { return globalThis.GXT.i18n.t("content_web_video_states_6"); },get ready() { return globalThis.GXT.i18n.t("content_web_video_states_5"); },get paused() { return globalThis.GXT.i18n.t("content_web_video_states_4"); },get draining() { return globalThis.GXT.i18n.t("content_web_video_states_3"); },get reconnecting() { return globalThis.GXT.i18n.t("content_web_video_states_2"); },get stopped() { return globalThis.GXT.i18n.t("content_web_video_states_1"); }};
        if(stats.live?.state==='stopped'){this.dubbing=false;this.activeDubEngine='';}
        if(states[stats.live?.state])this.paintStatus(states[stats.live.state]);
      }
    }
    buildUI() {
      this.host = document.createElement('div'); this.host.dataset.gxtWebVideo = ''; this.host.dataset.playerId = this.id;
      this.shadow = this.host.attachShadow({ mode: 'open' });
      const style = document.createElement('style'); style.textContent = STYLE; this.shadow.append(style);
      this.toolbar = document.createElement('div'); this.toolbar.className = 'toolbar'; this.toolbar.setAttribute('role', 'toolbar'); globalThis.GXT.i18n.bind(this.toolbar,'ariaLabel',()=>(globalThis.GXT.i18n.t("content_web_video_createManager_57")));
      const button = (className, label, text, fn) => { const el = document.createElement('button');el.type='button';el.className=className;globalThis.GXT.i18n.bindLabel(el,'title',label);globalThis.GXT.i18n.bindLabel(el,'ariaLabel',label);globalThis.GXT.i18n.bindLabel(el,'innerHTML',text);el.addEventListener('click',e=>{e.stopPropagation();void fn()});return el; };
      this.subButton = button('feature', globalThis.GXT.i18n.t("content_web_video_createManager_30"), globalThis.GXT.i18n.t("content_web_video_createManager_56"), () => this.toggleSubtitles());
      this.dubButton = button('feature', globalThis.GXT.i18n.t("content_web_video_createManager_29"), globalThis.GXT.i18n.t("content_web_video_createManager_55"), () => this.toggleDub());
      this.menuButton = button('menu', globalThis.GXT.i18n.t("content_web_video_createManager_54"), '⋯', () => this.openPanel());
      this.toolbar.append(this.subButton, this.dubButton, this.menuButton);
      this.panel = document.createElement('div'); this.panel.className = 'panel';this.panel.hidden=true;this.panel.setAttribute('role','region');globalThis.GXT.i18n.bind(this.panel,'ariaLabel',()=>(globalThis.GXT.i18n.t("content_web_video_createManager_53")));
      const title = document.createElement('strong');globalThis.GXT.i18n.bind(title, "textContent", () => (globalThis.GXT.i18n.t("content_web_video_createManager_52")));
      const label=document.createElement('label');const sourceLabel=document.createElement('span');globalThis.GXT.i18n.bind(sourceLabel, "textContent", () => (globalThis.GXT.i18n.t("content_web_video_createManager_51")));label.append(sourceLabel);this.select=document.createElement('select');globalThis.GXT.i18n.bind(this.select,'ariaLabel',()=>(globalThis.GXT.i18n.t("content_web_video_createManager_51")));this.select.addEventListener('change',()=>{void this.selectSource(this.select.value)});label.append(this.select);
      this.status=document.createElement('p');this.status.className='status';this.status.setAttribute('role','status');
      const field=(text,input)=>{const label=document.createElement('label');const caption=document.createElement('span');globalThis.GXT.i18n.bindLabel(caption,'textContent',text);label.append(caption,input);return label};
      const choice=(items,value,change)=>{const select=document.createElement('select');for(const [id,text]of items){const option=document.createElement('option');option.value=id;globalThis.GXT.i18n.bindLabel(option,'textContent',text);select.append(option)}select.value=value;select.addEventListener('change',()=>change(select.value));return select};
      this.engineSelect=choice([['auto',globalThis.GXT.i18n.t("content_web_video_createManager_50")],['caption',globalThis.GXT.i18n.t("content_web_video_createManager_49")],['live',globalThis.GXT.i18n.t("content_web_video_createManager_48")]],this.dubOptions.engine,value=>this.setDubOptions({engine:value}));
      this.liveModelInput=document.createElement('select');this.liveModelInput.dir='ltr';
      this.liveModelInput.addEventListener('change',()=>this.setDubOptions({model:this.liveModelInput.value}));
      this.modelsButton=button('',globalThis.GXT.i18n.t("content_web_video_createManager_47"),globalThis.GXT.i18n.t("content_web_video_createManager_47"),()=>this.refreshModels(true));
      void this.refreshModels(false);
      this.sourceLanguageSelect=choice([['',globalThis.GXT.i18n.t("content_web_video_createManager_46")],['en',globalThis.GXT.i18n.t("content_render_LANG_NAMES_34")],['ja',globalThis.GXT.i18n.t("content_render_LANG_NAMES_33")],['ko',globalThis.GXT.i18n.t("content_render_LANG_NAMES_32")],['zh',globalThis.GXT.i18n.t("content_render_LANG_NAMES_31")],['ar',globalThis.GXT.i18n.t("content_render_LANG_NAMES_30")],['de',globalThis.GXT.i18n.t("content_render_LANG_NAMES_26")],['fr',globalThis.GXT.i18n.t("content_render_LANG_NAMES_27")],['es',globalThis.GXT.i18n.t("content_render_LANG_NAMES_28")],['ru',globalThis.GXT.i18n.t("content_render_LANG_NAMES_29")],['tr',globalThis.GXT.i18n.t("content_render_LANG_NAMES_25")]],settings.ytLiveSourceLang||'',value=>this.setDubOptions({sourceLang:value}));
      this.duckInput=document.createElement('input');this.duckInput.type='range';this.duckInput.min='0';this.duckInput.max='100';this.duckInput.value=String(settings.ytLiveDuck??10);this.duckInput.addEventListener('change',()=>this.setDubOptions({duck:Number(this.duckInput.value)}));
      const liveFields=document.createElement('div');liveFields.append(field(globalThis.GXT.i18n.t("content_web_video_createManager_45"),this.engineSelect),field(globalThis.GXT.i18n.t("content_web_video_createManager_44"),this.liveModelInput),this.modelsButton,field(globalThis.GXT.i18n.t("content_web_video_createManager_43"),this.sourceLanguageSelect),field(globalThis.GXT.i18n.t("content_web_video_createManager_42"),this.duckInput));
      const visualFields=document.createElement('div');const visualSlider=(title,key,min,max,step)=>{const input=document.createElement('input');input.type='range';input.min=min;input.max=max;input.step=step;input.value=this.visual[key];input.setAttribute('aria-label',title);input.addEventListener('input',()=>{this.visual[key]=Number(input.value);if(key!=='scale'){this.visual.manual=true;this.savePosition();}this.layoutNow();});visualFields.append(field(title,input));return input;};
      this.scaleInput=visualSlider(globalThis.GXT.i18n.t("content_web_video_createManager_41"),'scale',.5,2.5,.05);this.positionXInput=visualSlider(globalThis.GXT.i18n.t("content_web_video_createManager_40"),'x',0,100,1);this.positionYInput=visualSlider(globalThis.GXT.i18n.t("content_web_video_createManager_39"),'y',0,100,1);
      const fine=document.createElement('details');const fineTitle=document.createElement('summary');globalThis.GXT.i18n.bind(fineTitle, "textContent", () => (globalThis.GXT.i18n.t("content_web_video_createManager_38")));fine.append(fineTitle,this.positionXInput.parentElement,this.positionYInput.parentElement);visualFields.append(fine);
      this.bilingualInput=document.createElement('input');this.bilingualInput.type='checkbox';this.bilingualInput.addEventListener('change',()=>{this.visual.bilingual=this.bilingualInput.checked;this.tick();this.layoutNow();});visualFields.append(field(globalThis.GXT.i18n.t("content_web_video_createManager_37"),this.bilingualInput));
      visualFields.append(button('',globalThis.GXT.i18n.t("content_web_video_createManager_36"),globalThis.GXT.i18n.t("content_web_video_createManager_35"),()=>{this.visual.drag=!this.visual.drag;this.caption.classList.toggle('drag-disabled',!this.visual.drag);this.paintStatus(this.visual.drag?globalThis.GXT.i18n.t("content_web_video_createManager_34"):'');}),button('',globalThis.GXT.i18n.t("content_web_video_createManager_33"),globalThis.GXT.i18n.t("content_web_video_createManager_32"),()=>{this.visual.manual=false;this.visual.drag=false;this.visual.drag=true;this.caption.classList.remove('drag-disabled');this.savePosition();this.layoutNow();}));
      const fileLabel=document.createElement('label');const fileCaption=document.createElement('span');globalThis.GXT.i18n.bind(fileCaption, "textContent", () => (globalThis.GXT.i18n.t("content_web_video_createManager_31")));fileLabel.append(fileCaption);const file=document.createElement('input');file.type='file';file.accept='.vtt,.srt';file.className='file';file.addEventListener('change',()=>{void this.importFile(file.files?.[0]);file.value=''});fileLabel.append(file);
      const actions=document.createElement('div');actions.className='actions';
      this.panelSub=button('', globalThis.GXT.i18n.t("content_web_video_createManager_30"), globalThis.GXT.i18n.t("shared_video_sources_label_1"),()=>this.toggleSubtitles());this.panelDub=button('', globalThis.GXT.i18n.t("content_web_video_createManager_29"), globalThis.GXT.i18n.t("content_web_video_createManager_28"),()=>this.toggleDub());
      actions.append(this.panelSub,this.panelDub,button('', globalThis.GXT.i18n.t("content_web_video_createManager_27"), globalThis.GXT.i18n.t("content_web_video_createManager_27"),async()=>{this.failed.clear();this.retryState.clear();clearTimeout(this.retryTimer);this.retryTimer=0;await this.loadSource();this.tick()}),button('', globalThis.GXT.i18n.t("content_web_video_createManager_26"), globalThis.GXT.i18n.t("content_web_video_createManager_25"),()=>this.disableSite()),button('', globalThis.GXT.i18n.t("content_web_video_createManager_24"), globalThis.GXT.i18n.t("content_manga_finish_1"),()=>{this.panel.hidden=true;this.wakeControls()}));
      this.panel.append(title,label,liveFields,visualFields,this.status,fileLabel,actions);
      this.caption=document.createElement('div');this.caption.className='caption';this.caption.dir='auto';this.caption.hidden=true;
      this.shadow.append(this.toolbar,this.panel,this.caption);(document.body||document.documentElement).append(this.host);this.applyTheme();
      for(const node of [this.toolbar,this.panel]){node.addEventListener('pointerenter',()=>{this.chromeHeld=true;this.wakeControls()});node.addEventListener('pointerleave',()=>{this.chromeHeld=false;this.armIdle()});node.addEventListener('focusin',()=>{this.chromeHeld=true;this.wakeControls()});node.addEventListener('focusout',()=>{queueMicrotask(()=>{this.chromeHeld=!!this.shadow.activeElement;this.armIdle()})});}
      globalThis.GXT.i18n.bind(this.caption, "title", () => (globalThis.GXT.i18n.t("content_web_video_createManager_23")));this.caption.tabIndex=0;globalThis.GXT.i18n.bind(this.caption,'ariaLabel',()=>(globalThis.GXT.i18n.t("content_web_video_createManager_22")));
      let drag=null;
      this.caption.addEventListener('pointerdown',event=>{
        if(!this.visual.drag||event.button!==0||event.isPrimary===false)return;
        const box=this.caption.getBoundingClientRect();
        drag={id:event.pointerId,x:event.clientX,y:event.clientY,cx:box.left+box.width/2,cy:box.top+box.height/2,moved:false};
        this.caption.setPointerCapture?.(event.pointerId);event.preventDefault();event.stopPropagation();
      });
      this.caption.addEventListener('pointermove',event=>{
        if(!drag||drag.id!==event.pointerId)return;
        const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(!drag.moved&&Math.hypot(dx,dy)<4)return;drag.moved=true;
        const r=this.video.getBoundingClientRect();if(!r.width||!r.height)return;
        this.visual.manual=true;this.visual.x=Math.max(0,Math.min(100,(drag.cx+dx-r.left)/r.width*100));this.visual.y=Math.max(0,Math.min(100,(drag.cy+dy-r.top)/r.height*100));
        this.positionXInput.value=this.visual.x;this.positionYInput.value=this.visual.y;this.layoutNow();event.preventDefault();event.stopPropagation();
      });
      const endDrag=event=>{if(!drag||event.pointerId!==drag.id)return;const moved=drag.moved;drag=null;if(moved)this.savePosition();};
      for(const type of ['pointerup','pointercancel','lostpointercapture'])this.caption.addEventListener(type,endDrag);
      this.caption.addEventListener('keydown',event=>{const delta={ArrowLeft:[-2,0],ArrowRight:[2,0],ArrowUp:[0,-2],ArrowDown:[0,2]}[event.key];if(!delta)return;event.preventDefault();event.stopPropagation();this.visual.manual=true;this.visual.x=Math.max(0,Math.min(100,this.visual.x+delta[0]));this.visual.y=Math.max(0,Math.min(100,this.visual.y+delta[1]));this.layoutNow();this.savePosition();});
    }
    savePosition() {
      void GXT.setSettings({webVideoCaptionPosition:{x:this.visual.x,y:this.visual.y,manual:this.visual.manual}}).catch(()=>this.paintStatus(globalThis.GXT.i18n.t("content_web_video_createManager_21")));
    }
    async refreshModels(refresh) {
      const revision=this.modelRevision=(this.modelRevision||0)+1;
      if(refresh)this.modelsButton.disabled=true;
      try {
        let models;
        if(refresh){const result=await send({type:'LIST_MODELS',provider:'gemini'});if(!result?.ok)throw Error(result?.error||globalThis.GXT.i18n.t("content_web_video_createManager_20"));models=result.models;}
        else {const stored=await chrome.storage.local.get(GXT.MODEL_LIST_KEY);models=stored[GXT.MODEL_LIST_KEY];}
        if(this.disposed||revision!==this.modelRevision)return;
        const selected=this.dubOptions.model??settings.ytLiveModel??'';
        const entries=GXT.classifyModels(models||[]).live;
        this.liveModelInput.replaceChildren();
        for(const [id,label] of [['',globalThis.GXT.i18n.t("shared_theme_THEMES_10")],...entries.map(m=>[m.id,m.displayName||m.id])]){const option=document.createElement('option');option.value=id;option.textContent=label;this.liveModelInput.append(option);}
        if(selected&&!entries.some(m=>m.id===selected)){const option=document.createElement('option');option.value=selected;globalThis.GXT.i18n.bind(option, "textContent", () => (selected+globalThis.GXT.i18n.t("content_web_video_createManager_19")));this.liveModelInput.append(option);}
        this.liveModelInput.value=selected;
        if(refresh)this.paintStatus(globalThis.GXT.i18n.t("content_web_video_createManager_18", {v0:(entries.length)}));
      }catch(error){if(!this.disposed&&refresh)this.paintStatus(error.message);}finally{if(!this.disposed&&refresh)this.modelsButton.disabled=false;}
    }

    applyTheme() {
      const css = `position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;pointer-events:none;${GXT.theme?.tokens(settings,{inPage:true})||''}`;
      this.host.style.cssText=css;
      this.dubber?.configure(this.dubSettings());
    }
    refreshSources() {
      if (this.disposed || !this.readyForSource) return;
      const found=this.sourceReader.discover();if(this.localSource)found.push(this.localSource);
      const signature=list=>JSON.stringify(list.map(s=>[s.id,s.language,s.label,s.automatic]));
      const changed=signature(found)!==signature(this.sources);this.sources=found;
      if (!this.sources.some(s=>s.id===this.sourceId)) {
        const next=(this.sources.find(s=>s.selected)||this.sources[0])?.id||'';
        if(next!==this.sourceId){this.sourceId=next;this.retire({keepLive:true});}
      }
      if(changed){this.select.replaceChildren();for(const s of this.sources){const opt=document.createElement('option');opt.value=s.id;globalThis.GXT.i18n.bind(opt, "textContent", () => (`${s.label} · ${s.language}${s.automatic?globalThis.GXT.i18n.t("content_web_video_createManager_17"):''}`));this.select.append(opt)}this.select.value=this.sourceId;}
      this.paintStatus();
      return changed;
    }
    sourcesChanged() { if(this.disposed)return;this.refreshSources();if(this.subtitles||(this.dubbing&&this.dubEngine()==='caption')){if(this.loading)this.sourceDirty=true;else void this.loadSource();}queueLayout(); }
    retire({keepLive=false}={}) {
      this.generation++;this.sourceReadGeneration++;this.controller?.abort();this.controller=null;this.loading=false;this.pending=false;
      this.translationJobs.clear();this.requestedCues.clear();this.retryState.clear();clearTimeout(this.retryTimer);this.retryTimer=0;this.sourceDirty=false;
      this.message='';
      this.cues=[];this.translated.clear();this.failed.clear();this.caption.textContent='';this.caption.hidden=true;
      if(!keepLive||this.activeDubEngine!=='live')this.dubber?.stop();
    }
    invalidateMedia() {
      this.videoGeneration++;this.dubbing=false;this.activeDubEngine='';this.liveText='';this.retire();this.localSource=null;this.sources=[];this.sourceId='';this.readyForSource=false;
      this.sourceReader.release();this.select.replaceChildren();this.paintStatus();
    }
    checkMedia() { const key=mediaKey(this.video);if(key!==this.mediaKey){this.mediaKey=key;this.invalidateMedia();} }
    async selectSource(id) {
      if(!this.sources.some(s=>s.id===id)||id===this.sourceId)return;
      this.retire({keepLive:true});this.sourceReader.release();this.sourceId=id;this.select.value=id;
      if(this.subtitles||(this.dubbing&&this.dubEngine()==='caption'))await this.loadSource();this.paintStatus();
    }
    async loadSource() {
      const source=this.sources.find(s=>s.id===this.sourceId);if(!source||this.disposed||!this.readyForSource)return;
      this.controller?.abort();const controller=new AbortController();this.controller=controller;
      const gen=this.generation;const readGen=++this.sourceReadGeneration;this.loading=true;this.paintStatus(globalThis.GXT.i18n.t("content_web_video_createManager_16"));
      const timeout=setTimeout(()=>controller.abort(),12000);
      try {
        const cues=await this.sourceReader.read(source,controller.signal);
        if(this.disposed||gen!==this.generation||readGen!==this.sourceReadGeneration||controller.signal.aborted)return;
        this.cues=cues.map(c=>({...c,translation:this.translated.get(`${c.id}:${c.text}`)||''}));
        const retained=new Set(this.cues.map(c=>`${c.id}:${c.text}`));
        for(const key of this.retryState.keys())if(!retained.has(key))this.retryState.delete(key);
        this.paintStatus(cues.length?'':globalThis.GXT.i18n.t("content_web_video_createManager_15"));
        this.tick();
      } catch(e) {
        if(!this.disposed&&gen===this.generation&&readGen===this.sourceReadGeneration)this.paintStatus(e.name==='AbortError'?globalThis.GXT.i18n.t("content_web_video_createManager_14"):globalThis.GXT.i18n.t("content_web_video_createManager_13"));
      } finally {clearTimeout(timeout);if(gen===this.generation&&readGen===this.sourceReadGeneration){this.loading=false;if(this.sourceDirty){this.sourceDirty=false;void this.loadSource();}}}
    }
    async importFile(file) {
      if(!file)return;if(file.size>GXT.videoSources.MAX_BYTES){this.paintStatus(globalThis.GXT.i18n.t("content_web_video_createManager_12"));return;}
      const gen=this.generation;const videoGen=this.videoGeneration;
      try {const text=await file.text();if(this.disposed||gen!==this.generation||videoGen!==this.videoGeneration)return;
        const cues=GXT.videoSources.parseVtt(text);if(!cues.length){this.paintStatus(globalThis.GXT.i18n.t("content_web_video_createManager_11"));return;}
        this.localSource={id:`local:${++this.sourceReadGeneration}`,playerId:this.id,videoId:`${this.id}:${videoGen}`,pageGeneration,videoGeneration:videoGen,language:'und',kind:'subtitles',type:'local-file',automatic:null,label:file.name.slice(0,120),url:null,cues};
        this.readyForSource=true;this.refreshSources();await this.selectSource(this.localSource.id);this.paintStatus(globalThis.GXT.i18n.t("content_web_video_createManager_10"));
      }catch{this.paintStatus(globalThis.GXT.i18n.t("content_web_video_createManager_9"));}
    }
    async toggleSubtitles() {
      if(!settings.webVideoSubtitles||(!this.sources.length&&!this.subtitles&&!(this.dubbing&&this.activeDubEngine==='live')))return;
      this.interacted=true;this.subtitles=!this.subtitles;
      if(this.subtitles){if(!this.cues.length)await this.loadSource();this.tick();}
      else {this.caption.hidden=true;if(!this.dubbing){this.retire();this.sourceReader.release();}}
      this.paintStatus();queueLayout();
    }
    async toggleDub() {
      if(!settings.webVideoDub||(!this.sources.length&&this.dubEngine()==='caption'&&!this.dubbing)||!GXT.dub)return;
      this.interacted=true;this.dubbing=!this.dubbing;
      if(this.dubbing){
        this.message='';this.activeDubEngine=this.dubEngine();
        // Create/resume the audio graph in the click, before any async fetch.
        this.dubber ||= GXT.dub.create({video:this.video,settings:this.dubSettings(),send,canCompress:false,captureMode:'stream',connectLive:()=>chrome.runtime.connect({name:'gxt-live-web'}),onState:stats=>this.handleDubState(stats),onLiveText:message=>{
          if(!this.dubbing||this.activeDubEngine!=='live'||this.disposed)return;
          if(message.kind==='turnEnd'){this.liveText='';this.liveSourceText='';}
          else if(message.kind==='source')this.liveSourceText=String(message.text||'').slice(-220);
          else if(message.kind==='target'){const now=Date.now();this.liveText=(now-this.liveTextAt>2500?String(message.text||''):this.liveText+String(message.text||'')).slice(-240);this.liveTextAt=now;}
          this.tick();
        }});
        const engine=this.activeDubEngine;this.dubber.configure(this.dubSettings());this.dubber.start(engine);
        if(engine==='caption'){if(!this.cues.length)await this.loadSource();this.feedDub();}this.tick();
      } else {this.activeDubEngine='';this.liveText='';this.dubber?.stop();if(!this.subtitles){this.retire();this.sourceReader.release();}}
      this.paintStatus();queueLayout();
    }
    feedDub() {
      if(!this.dubbing||!this.dubber||this.dubEngine()!=='caption')return;this.dubber.start('caption');
      this.dubber.setUpstreamPending?.(this.pending||this.loading||this.retryState.size>0);
      this.dubber.setSegments(this.cues.filter(c=>c.translation).map(c=>({id:`${this.generation}:${c.id}:${c.text}`,start:c.start,end:c.end,text:c.translation})));this.dubber.update();
    }
    tick() {
      if(this.disposed||!this.video.isConnected)return;
      const ms=this.video.currentTime*1000;
      const active=this.cues.filter(c=>c.start<=ms&&c.end>ms);
      const live=this.dubbing&&this.activeDubEngine==='live';
      const text=live?this.liveText+(this.visual.bilingual&&this.liveSourceText?'\n'+this.liveSourceText:''):active.map(c=>c.translation?(c.translation+(this.visual.bilingual?'\n'+c.text:'')):'').filter(Boolean).join('\n');
      if(this.caption.textContent!==text)this.caption.textContent=text;
      this.caption.hidden=!this.subtitles||!text;
      if(!live&&(this.subtitles||this.dubbing))this.requestWindow(ms);
      if(this.dubbing)this.dubber?.update();
    }
    requestWindow(ms) {
      if(this.translationJobs.size>=2||!this.cues.length||this.disposed)return;
      const cueKey=c=>`${c.id}:${c.text}`;const now=Date.now();
      // Retries belong to already accepted input. Natural EOF closes admission
      // of new cues, but must not discard these pending pieces of the pipeline.
      const batch=this.cues.filter(c=>(this.retryState.has(cueKey(c))||(!this.video.ended&&c.end>ms&&c.start<ms+45000*Math.max(1,this.video.playbackRate||1)))&&!c.translation&&!this.failed.has(cueKey(c))&&!this.requestedCues.has(cueKey(c))&&(this.retryState.get(cueKey(c))?.at||0)<=now).slice(0,this.translationJobs.size?12:6);
      if(!batch.length)return;
      const job={};this.translationJobs.add(job);batch.forEach(c=>this.requestedCues.add(cueKey(c)));this.pending=true;this.metrics.requested+=batch.length;
      this.dubber?.setUpstreamPending?.(true);const gen=this.generation;const source=this.sourceId;const at=this.cues.indexOf(batch[0]);
      void send({type:'TRANSLATE_TEXTS',kind:'subtitle',source:'web-video',texts:batch.map(c=>c.text),context:this.cues.slice(Math.max(0,at-4),at).map(c=>c.text)}).then(res=>{
        if(this.disposed||gen!==this.generation||source!==this.sourceId||!this.video.isConnected)return;
        this.translationJobs.delete(job);this.pending=this.translationJobs.size>0;
        batch.forEach((cue,i)=>{
          const key=cueKey(cue);this.requestedCues.delete(key);const t=res?.ok&&res.list?.length===batch.length&&res.list[i];
          if(typeof t==='string'&&t.trim()){cue.translation=t.trim();this.translated.set(key,cue.translation);this.retryState.delete(key);this.metrics.translated++;const current=this.cues.find(c=>cueKey(c)===key);if((current||cue).end<=this.video.currentTime*1000)this.metrics.late++;}
          else {const count=(this.retryState.get(key)?.count||0)+1;const code=res?.failed?.code||res?.code||'MISSING';
            if(count<=2&&['MISSING','NETWORK','TIMEOUT','RATE_LIMIT','SERVER','ERR','DISCONNECTED'].includes(code)){
              const delay=Math.max(Math.min(30000,Number(res?.failed?.detail?.retryAfterMs||res?.retryAfterMs)||0),500*2**(count-1));this.retryState.set(key,{count,at:Date.now()+delay});this.metrics.retried++;
              clearTimeout(this.retryTimer);this.retryTimer=setTimeout(()=>{this.retryTimer=0;this.tick();},delay);
            }else{this.retryState.delete(key);this.failed.add(key);this.metrics.failed++;}
          }
        });
        // Reconcile any live textTrack cue refresh while the request was pending.
        for(const cue of this.cues)cue.translation=this.translated.get(`${cue.id}:${cue.text}`)||'';
        if(this.failed.size)this.paintStatus(globalThis.GXT.i18n.t("content_web_video_createManager_8"));else this.paintStatus();
        this.feedDub();this.tick();
      });
      // One urgent batch and one look-ahead batch can advance independently.
      // Claim cue identities first so neither request can include the other.
      this.requestWindow(ms);
    }
    paintStatus(message) {
      if(message!==undefined)this.message=message;
      const available=this.sources.length>0;
      const live=this.dubEngine()==='live';
      this.subButton.disabled=this.panelSub.disabled=!settings.webVideoSubtitles||(!available&&!(this.dubbing&&live));
      this.dubButton.disabled=this.panelDub.disabled=!settings.webVideoDub||(!available&&!live)||!GXT.dub;
      this.subButton.setAttribute('aria-pressed',String(this.subtitles));this.panelSub.setAttribute('aria-pressed',String(this.subtitles));
      this.dubButton.setAttribute('aria-pressed',String(this.dubbing));this.panelDub.setAttribute('aria-pressed',String(this.dubbing));
      this.select.disabled=!available;
      globalThis.GXT.i18n.bind(this.dubButton, "title", () => (live?globalThis.GXT.i18n.t("content_web_video_createManager_7"):globalThis.GXT.i18n.t("content_web_video_createManager_6")));
      globalThis.GXT.i18n.bind(this.status, "textContent", () => (this.message||(available?(live?globalThis.GXT.i18n.t("content_web_video_createManager_5"):globalThis.GXT.i18n.t("content_web_video_createManager_4")):(live?globalThis.GXT.i18n.t("content_web_video_createManager_3"):globalThis.GXT.i18n.t("content_web_video_createManager_2")))));
      globalThis.GXT.i18n.bind(this.menuButton, "title", () => (this.status.textContent+globalThis.GXT.i18n.t("content_web_video_createManager_1")));
    }
    openPanel() {this.panel.hidden=!this.panel.hidden;this.host.toggleAttribute('data-panel-open',!this.panel.hidden);this.chromeHeld=false;this.wakeControls();if(!this.panel.hidden)this.engineSelect.focus();}
    async disableSite() {
      const next=[...new Set([...(settings.webVideoBlockedSites||[]),location.hostname])];
      applySettings({...settings,webVideoBlockedSites:next});
      try {if(GXT.setWebVideoSiteBlocked)await GXT.setWebVideoSiteBlocked(location.hostname,true);else await GXT.setSettings({webVideoBlockedSites:next});}
      catch {applySettings(await GXT.getSettings());}
    }
    layoutNow() {
      if(this.disposed)return;const rect=this.video.getBoundingClientRect();const fullscreen=fullscreenElement();
      const isFull=!!fullscreen&&within(fullscreen,this.video);if(isFull!==this.fullscreen){this.fullscreen=isFull;this.idle=false;this.lastInteraction=0;this.armIdle();}
      const inView=rect.bottom>0&&rect.right>0&&rect.top<innerHeight&&rect.left<innerWidth;
      if(!inView&&!this.subtitles&&!this.dubbing&&this.panel.hidden){this.toolbar.hidden=true;this.inView=false;return;}
      const fsVideo=fullscreen===this.video;
      const parent=fullscreen&&fullscreen!==this.video&&within(fullscreen,this.video)?fullscreen:(document.body||document.documentElement);
      if(this.host.parentElement!==parent)parent.append(this.host);
      const obstacles=obstaclesFor(this,rect);this.layout=fsVideo?{mode:'external',x:0,y:0,width:0,height:0}:choosePlacement(rect.width,rect.height,obstacles);
      const candidate=score(this.video,rect,this.interacted)>=0;
      const chromeIdle=this.fullscreen&&this.panel.hidden&&!this.chromeHeld&&(this.idle||(Date.now()-this.lastInteraction>350&&this.nativeControlsHidden()));
      this.toolbar.hidden=!candidate||!inView||this.layout.mode==='external'||chromeIdle||(settings.webVideoDisplay==='interaction'&&!this.interacted);
      this.host.hidden=!!fullscreen&&!within(fullscreen,this.video);
      this.host.toggleAttribute('data-panel-open',!this.panel.hidden);
      this.toolbar.dataset.mode=this.layout.mode;
      Object.assign(this.toolbar.style,{left:`${rect.left+this.layout.x}px`,top:`${rect.top+this.layout.y}px`,width:`${this.layout.width}px`});
      const panelHeight=this.panel.hidden?Math.min(420,innerHeight*.7):this.panel.getBoundingClientRect().height;
      Object.assign(this.panel.style,{left:`${Math.max(10,Math.min(innerWidth-320,rect.right-310))}px`,top:`${Math.max(10,Math.min(innerHeight-panelHeight-10,rect.top+this.layout.y+42))}px`});
      const external=this.layout.mode==='external';this.caption.classList.toggle('external-caption',external);
      if(!external){
        // Prefer the lower subtitle band, reserve the native caption band, and
        // move above it when the site's own captions are visible.
        const native=Array.from(this.video.textTracks||[]).some(t=>t.mode==='showing');
        const capWidth=rect.width*.84;const capHeight=Math.max(35,Math.min(96*this.visual.scale,rect.height*.35));
        const excluded=[...obstacles,this.layout];
        const cap=this.visual.manual?{x:Math.max(6,Math.min(rect.width-capWidth-6,rect.width*this.visual.x/100-capWidth/2)),y:Math.max(6,Math.min(rect.height-capHeight-6,rect.height*this.visual.y/100-capHeight/2))}:[native?.32:.62,.38,.16].map(f=>({x:rect.width*.08,y:rect.height*f,width:capWidth,height:capHeight})).find(c=>c.y+c.height<rect.height-6&&!excluded.some(o=>intersects(c,o)));
        if(cap){Object.assign(this.caption.style,{left:`${rect.left+cap.x}px`,top:`${rect.top+cap.y}px`,width:`${capWidth}px`,maxHeight:`${capHeight}px`,fontSize:`${Math.max(10,Math.min(60,Math.min(24,rect.width/27)*this.visual.scale))}px`});}
        else {this.caption.classList.add('external-caption');this.caption.style.cssText='';}
      }else{this.caption.style.cssText='';}
      this.score=candidate?score(this.video,rect,this.interacted):-1;this.inView=inView;
    }
    settingsChanged(before) {
      this.applyTheme();
      if(before.ytLiveModel!==settings.ytLiveModel)void this.refreshModels(false);
      if(!settings.webVideoSubtitles&&this.subtitles){this.subtitles=false;this.caption.hidden=true;}
      if(!settings.webVideoDub&&this.dubbing){this.dubbing=false;this.dubber?.stop();}
      if(translationKey(before)!==translationKey(settings)) {this.retire({keepLive:true});if(this.subtitles||(this.dubbing&&this.dubEngine()==='caption'))void this.loadSource();}
      if(!this.subtitles&&!this.dubbing){this.retire();this.sourceReader.release();}
      this.paintStatus();
    }
    dispose() {
      if(this.disposed)return;this.disposed=true;this.retire();this.sourceReader.dispose();
      clearTimeout(this.idleTimer);this.idleTimer=0;
      for(const off of this.listeners)off();this.listeners=[];
      for(const off of this.containerListeners)off();this.containerListeners=[];
      resize?.unobserve(this.video);if(this.container!==this.video)resize?.unobserve(this.container);intersection?.unobserve(this.video);
      this.dubber?.dispose?.();this.dubber=null;this.host.remove();this.localSource=null;
    }
  }
  function ensureDock() {
    if(dock)return;dock=document.createElement('div');dock.dataset.gxtWebVideoDock='';dockRoot=dock.attachShadow({mode:'open'});
    const style=document.createElement('style');style.textContent=STYLE;dockRoot.append(style);const box=document.createElement('div');box.className='dock';globalThis.GXT.i18n.bind(box,'ariaLabel',()=>(globalThis.GXT.i18n.t("content_web_video_ensureDock_1")));dockRoot.append(box);(document.body||document.documentElement).append(dock);
  }
  function paintDock() {
    const list=[...records.values()].filter(r=>r.layout?.mode==='external'&&r.inView&&r.score>=0&&(!r.fullscreen||!r.idle||!r.panel.hidden)&&(settings.webVideoDisplay!=='interaction'||r.interacted));
    if(!list.length){dock?.remove();dock=null;dockRoot=null;return;}ensureDock();
    const fs=fullscreenElement();const parent=fs&&fs.localName!=='video'&&list.some(r=>within(fs,r.video))?fs:(document.body||document.documentElement);if(dock.parentElement!==parent)parent.append(dock);
    dock.style.cssText=`position:fixed;left:0;top:0;z-index:2147483000;pointer-events:none;${GXT.theme?.tokens(settings,{inPage:true})||''}`;
    const box=dockRoot.querySelector('.dock');box.replaceChildren();
    for(const [index,r] of list.slice(0,8).entries()){const b=document.createElement('button');b.type='button';globalThis.GXT.i18n.bind(b, "textContent", () => (globalThis.GXT.i18n.t("content_web_video_paintDock_2", {v0:(index+1)})));globalThis.GXT.i18n.bind(b, "title", () => (globalThis.GXT.i18n.t("content_web_video_paintDock_1")));b.addEventListener('click',()=>r.openPanel());box.append(b);}
  }
  function queueLayout() {if(!enabled||layoutFrame||(!records.size&&!dock))return;layoutFrame=requestAnimationFrame(()=>{layoutFrame=0;innerWidth=window.innerWidth;innerHeight=window.innerHeight;checkPage();for(const r of records.values())r.layoutNow();paintDock();});}
  function addVideo(video, interacted = false) {
    if(!enabled||records.has(video)||!video.isConnected||video.ownerDocument!==document||isMine(video))return;
    if(score(video,video.getBoundingClientRect(),interacted)<0)return;
    records.set(video,new Player(video,interacted));queueLayout();
  }
  function observeVideo(video) {
    if(candidates.has(video)||isMine(video))return;candidates.add(video);intersection?.observe(video);
    const r=video.getBoundingClientRect();if(r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth)addVideo(video);
  }
  function observeShadow(root) {
    if(!root||shadowRoots.has(root)||isMine(root.host))return;
    shadowRoots.add(root);mutations?.observe(root,OBSERVE);root.addEventListener('play',wakeVideoEvent,true);scan(root);
  }
  function scan(node) {
    if(![1,11].includes(node.nodeType)||isMine(node))return;
    if(node.localName==='video')observeVideo(node);
    for(const v of node.querySelectorAll('video'))observeVideo(v);
    if(node.shadowRoot)observeShadow(node.shadowRoot);
    for(const el of node.querySelectorAll('*'))if(el.shadowRoot&&!isMine(el))observeShadow(el.shadowRoot);
  }
  function wakeVideoEvent(event) {
    const path=event.composedPath?.()||[event.target];
    for(const node of path){if(node?.host&&node.nodeType===11)observeShadow(node);else if(node?.shadowRoot)observeShadow(node.shadowRoot);}
    const video=path.find(node=>node?.localName==='video');
    if(video&&!isMine(video)){observeVideo(video);addVideo(video,event.type!=='play');const r=records.get(video);r?.wakeControls();}
    if(event.type==='keydown')for(const r of records.values())if(r.fullscreen)r.wakeControls();
  }
  function checkPage() {
    if(location.href===pageURL)return;pageURL=location.href;pageGeneration++;
    for(const r of records.values()){r.dubbing=false;r.activeDubEngine='';r.retire();r.refreshSources();if(r.subtitles)void r.loadSource();}
  }
  function start() {
    if(enabled||disposed||!siteAllowed(settings))return;enabled=true;
    resize=new ResizeObserver(()=>queueLayout());intersection=new IntersectionObserver(entries=>{for(const e of entries){if(e.isIntersecting)addVideo(e.target);const r=records.get(e.target);if(r)r.visible=e.isIntersecting;}queueLayout();});
    mutations=new MutationObserver(changes=>{
      checkPage();let layout=false;
      for(const change of changes){if(isMine(change.target))continue;
        if(change.type==='childList'){for(const node of change.addedNodes)scan(node);layout=true;}
        else {for(const v of candidates)if(within(change.target,v)&&inViewport(v))addVideo(v);for(const r of records.values())if(within(r.container,change.target)||within(change.target,r.video)){r.checkMedia();const changed=r.refreshSources();if(changed&&(r.subtitles||(r.dubbing&&r.dubEngine()==='caption')))void r.loadSource();layout=true;}}
      }
      for(const [video,r] of records)if(!video.isConnected||video.ownerDocument!==document){r.dispose();records.delete(video);layout=true;}else if(layout)r.checkContainer();
      for(const video of candidates)if(!video.isConnected||video.ownerDocument!==document){intersection?.unobserve(video);candidates.delete(video);}
      let retiredRoot=false;for(const root of shadowRoots)if(!root.host.isConnected){root.removeEventListener('play',wakeVideoEvent,true);shadowRoots.delete(root);retiredRoot=true;}
      if(retiredRoot){mutations.disconnect();mutations.observe(document.documentElement,OBSERVE);for(const root of shadowRoots)mutations.observe(root,OBSERVE);}
      if(layout)queueLayout();
    });
    mutations.observe(document.documentElement,OBSERVE);
    scan(document.documentElement);
    const listen=(target,type,fn,options)=>{target.addEventListener(type,fn,options);globalListeners.push(()=>target.removeEventListener(type,fn,options));};
    for(const event of ['play','pointerdown','pointerover','keydown'])listen(document,event,wakeVideoEvent,true);
    for(const type of ['resize','scroll'])listen(window,type,queueLayout,{passive:true,capture:true});
    for(const type of ['fullscreenchange'])listen(document,type,queueLayout);
    for(const type of ['popstate','hashchange'])listen(window,type,()=>{checkPage();queueLayout()});
    if(window.navigation)listen(window.navigation,'currententrychange',()=>{checkPage();queueLayout()});
    if(GXT.theme?.onSchemeChange)globalListeners.push(GXT.theme.onSchemeChange(()=>{if(settings.uiTheme==='auto'){for(const r of records.values())r.applyTheme();queueLayout();}}));
    queueLayout();
  }
  function stop() {
    enabled=false;mutations?.disconnect();resize?.disconnect();intersection?.disconnect();mutations=resize=intersection=null;
    if(layoutFrame)cancelAnimationFrame(layoutFrame);layoutFrame=0;
    for(const r of records.values())r.dispose();records.clear();
    candidates.clear();
    for(const root of shadowRoots)root.removeEventListener('play',wakeVideoEvent,true);shadowRoots.clear();
    for(const off of globalListeners)off();globalListeners.length=0;dock?.remove();dock=null;dockRoot=null;
  }
  function applySettings(next) {
    const before=settings;settings=GXT.forScope({...DEFAULTS,...next},'web');
    if(!siteAllowed(settings)){stop();return;}if(!enabled){start();return;}
    for(const r of records.values())r.settingsChanged(before);queueLayout();
  }
  const api={start,stop,refresh:()=>{scan(document.documentElement);for(const r of records.values())r.sourcesChanged();queueLayout()},snapshot:()=>({observing:!!mutations,candidateCount:candidates.size,pageGeneration,
    externalCount:[...records.values()].filter(r=>r.layout?.mode==='external'&&r.inView).length,
    players:[...records.values()].map(r=>({id:r.id,connected:r.video.isConnected,videoGeneration:r.videoGeneration,generation:r.generation,
      mode:r.layout?.mode,sourceCount:r.sources.length,score:r.score,primary:r===[...records.values()].sort((a,b)=>b.score-a.score)[0]}))}),
    _internal:{siteAllowed,choosePlacement,score,containerFor},_test:{get:video=>records.get(video),localGet:video=>records.get(video),applySettings},
    applySettings,credentialsChanged:()=>{for(const r of records.values()){r.dubbing=false;r.activeDubEngine='';r.retire();if(r.subtitles)void r.loadSource();}}};
  api.refreshModels=()=>{for(const r of records.values())void r.refreshModels(false);};
  window.addEventListener('pagehide',()=>{stop();if(window!==globalThis)managers.delete(window);});window.addEventListener('pageshow',()=>start());
  return api;
  }
  function attachWindow(window) {
    if(managers.has(window))return managers.get(window);
    try {if(!window.document?.documentElement)return null;}catch{return null;}
    const api=createManager(window);managers.set(window,api);if(latestSettings)api.applySettings(latestSettings);return api;
  }
  const primary=attachWindow(globalThis);GXT.webVideo=primary;
  primary._test.get=video=>managers.get(video?.ownerDocument?.defaultView)?._test.localGet(video);
  primary._test.attachWindow=attachWindow;
  primary._test.managerCount=()=>managers.size;
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&GXT.MODEL_LIST_KEY in changes)for(const api of managers.values())api.refreshModels();});
  GXT.onStorageChanged(({settings:next,apiKeyChanged})=>{if(next){latestSettings=next;for(const api of managers.values())api.applySettings(next);}else if(apiKeyChanged)for(const api of managers.values())api.credentialsChanged();});
  try {const pip=globalThis.documentPictureInPicture;if(pip){pip.addEventListener('enter',event=>{attachWindow(event.window)});if(pip.window)attachWindow(pip.window);}}catch{/* Only browser-accessible, same-origin Document PiP is supported. */}
  void GXT.getSettings().then(next=>{latestSettings=next;for(const api of managers.values())api.applySettings(next);}).catch(()=>{});
})();
