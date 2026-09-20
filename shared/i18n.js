/* Tarjoman UI localization. Content, prompts and cache identities are separate. */
'use strict';
(() => {
  const G = globalThis.GXT = globalThis.GXT || {};
  if (G.i18n) return;
  const catalogs = G.catalogs || {};
  const supported = ['fa', 'en'];
  let settings = { uiLanguage:'fa', regionLocale:'fa-IR', calendar:'persian', numberingSystem:'arabext', hourCycle:'h23', timeZone:'Asia/Tehran', weekStart:'sat' };
  const listeners = new Set();
  const bindings = new Set();
  const roots = new Set();
  const renderedMessages = new Map();
  let configuring = false;
  const languages = () => globalThis.navigator?.languages || [globalThis.navigator?.language || 'en'];
  function language(s = settings, langs = languages()) {
    if (supported.includes(s.uiLanguage)) return s.uiLanguage;
    for (const value of langs) {
      const code = String(value).toLowerCase().split(/[-_]/)[0];
      if (supported.includes(code)) return code;
    }
    return 'en';
  }
  function locale(s = settings) {
    if (s.regionLocale && s.regionLocale !== 'auto') return s.regionLocale;
    return languages()[0] || 'en-US';
  }
  function direction(s = settings) { return language(s) === 'fa' ? 'rtl' : 'ltr'; }
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  function t(key, values = {}, lang = language()) {
    let message = catalogs[lang]?.[key] ?? catalogs.en?.[key] ?? catalogs.fa?.[key];
    if (message == null) throw new Error(`Missing UI message: ${key}`);
    if (typeof message === 'object') {
      const category = new Intl.PluralRules(lang).select(Number(values.count));
      message = message[category] ?? message.other;
    }
    const result = String(message).replace(/\{([A-Za-z]\w*)\}/g, (all, name) => Object.hasOwn(values,name) ? String(values[name]) : all);
    renderedMessages.set(result,{key,values});
    if(renderedMessages.size>2048)renderedMessages.delete(renderedMessages.keys().next().value);
    return result;
  }
  function html(key, values = {}) { return escape(t(key,values)); }
  function options(extra = {}) {
    const out = {};
    for (const key of ['calendar','numberingSystem','hourCycle','timeZone']) if(settings[key] && settings[key] !== 'auto') out[key] = settings[key];
    return {...out,...extra};
  }
  function number(value, extra = {}) { return new Intl.NumberFormat(locale(),options(extra)).format(Number(value || 0)); }
  function date(value, extra = {}) { return new Intl.DateTimeFormat(locale(), options({year:'numeric',month:'numeric',day:'numeric',...extra})).format(new Date(value)); }
  function time(value, extra = {}) { return new Intl.DateTimeFormat(locale(),options({hour:'2-digit',minute:'2-digit',second:'2-digit',...extra})).format(new Date(value)); }
  function relative(value, unit='minute') { return new Intl.RelativeTimeFormat(locale(),{numeric:'auto',numberingSystem:settings.numberingSystem === 'auto' ? undefined : settings.numberingSystem}).format(value,unit); }
  function weekStart() {
    if(settings.weekStart !== 'auto') return settings.weekStart;
    const info = new Intl.Locale(locale());
    const day = (info.getWeekInfo?.() || info.weekInfo)?.firstDay;
    return ({1:'mon',5:'fri',6:'sat',7:'sun'})[day] || 'mon';
  }
  function configure(next) {
    const signature = s => JSON.stringify(['uiLanguage','regionLocale','calendar','numberingSystem','hourCycle','timeZone','weekStart'].map(k=>s[k]));
    const before = signature(settings);
    settings = {...settings,...next};
    if (before !== signature(settings) && !configuring) {
      configuring=true;
      try {
        for(const item of bindings) {
          const el=item.ref.deref();
          if(!el || (item.wasConnected && !el.isConnected)) { bindings.delete(item);continue; }
          // Another renderer or the user may have replaced this content since
          // the binding was created. Never restore stale status or edited text.
          if(el[item.property] !== item.lastValue) {bindings.delete(item);continue;}
          const record=elementBindings.get(el)?.[item.property];
          if(!record || record.item!==item){bindings.delete(item);continue;}
          el[item.property]=record.render();item.lastValue=el[item.property];item.wasConnected ||= !!el.isConnected;
        }
        for(const ref of roots) { const root=ref.deref();if(root)apply(root);else roots.delete(ref); }
        for(const fn of listeners) fn();
      } finally { configuring=false; }
    }
  }
  const elementBindings = new WeakMap();
  function bind(el,property,render) {
    const previous=elementBindings.get(el)?.[property];if(previous)bindings.delete(previous.item);
    // Keep closures in an ephemeron-owned record, not the global Set. A renderer
    // may capture its own element; the Set must never make that element live.
    const item={ref:new WeakRef(el),property,wasConnected:!!el.isConnected};
    elementBindings.set(el,{...elementBindings.get(el),[property]:{item,render}});bindings.add(item);
    if(bindings.size%128===0)for(const old of bindings){const node=old.ref.deref();if(!node||(old.wasConnected&&!node.isConnected))bindings.delete(old);}
    el[property]=render();item.lastValue=el[property];return item.lastValue;
  }
  // Call only for extension UI labels. Never use this for translated/user text.
  function bindLabel(el,property,value) {
    const message=renderedMessages.get(value);
    if(message)return bind(el,property,()=>t(message.key,message.values));
    return el[property]=value;
  }
  const registered = new WeakSet();
  function apply(root) {
    if (!root) return;
    if(!registered.has(root)) {registered.add(root);roots.add(new WeakRef(root));}
    const host = root.documentElement || root.host || root;
    host.setAttribute?.('lang',language()); host.setAttribute?.('dir',direction());
    host.style?.setProperty('--gxt-ui-dir',direction());
    host.style?.setProperty('--gxt-ui-align','start');
    for (const el of root.querySelectorAll?.('[data-i18n]') || []) el.textContent = t(el.dataset.i18n);
    for (const attr of ['title','placeholder','aria-label','alt']) for(const el of root.querySelectorAll?.(`[data-i18n-${attr}]`) || []) el.setAttribute(attr,t(el.getAttribute(`data-i18n-${attr}`)));
  }
  function watch(root) { apply(root); const fn=()=>apply(root);listeners.add(fn);return()=>listeners.delete(fn); }
  function onChange(fn) { listeners.add(fn); return ()=>listeners.delete(fn); }
  G.i18n = {t,html,escape,language,direction,locale,configure,bind,bindLabel,number,date,time,relative,weekStart,apply,watch,onChange};
})();
