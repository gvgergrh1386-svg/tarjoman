'use strict';
// Run against a checkout or its untouched backup. No account or external network.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const copy = (v) => v === undefined ? undefined : structuredClone(v);
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const tests = [];
const test = (name, run) => tests.push({name,run});

function environment(initial = {}, extras = {}) {
  const state = copy(initial), events = {};
  const event = (name) => ({ addListener: (fn) => { (events[name] ||= []).push(fn); } });
  const storage = {
    async get(keys) {
      if (keys == null) return copy(state);
      const out = {};
      for (const key of typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)) {
        if (Object.hasOwn(state, key)) out[key] = copy(state[key]);
        else if (typeof keys === 'object' && !Array.isArray(keys)) out[key] = copy(keys[key]);
      }
      return out;
    },
    async set(patch) { Object.assign(state, copy(patch)); },
    async remove(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) delete state[key]; },
  };
  const chrome = {
    storage: { local: storage, session: storage, onChanged: event('storage') },
    runtime: { id:'test-extension', getURL:(s='') => 'chrome-extension://test-extension/'+s,
      getManifest:() => ({version:'test'}), onInstalled:event('installed'), onStartup:event('startup'),
      onMessage:event('message'), onConnect:event('connect') },
    action: { setBadgeText:async()=>{}, setBadgeBackgroundColor:async()=>{} },
    contextMenus: { onClicked:event('menu') }, commands: { onCommand:event('command') },
  };
  const ctx = vm.createContext({ console, chrome, URL, TextEncoder, TextDecoder, ArrayBuffer,
    Uint8Array, DataView, Blob, Response, ReadableStream, AbortController, crypto:webcrypto,
    setTimeout, clearTimeout, btoa:(s)=>Buffer.from(s,'binary').toString('base64'),
    atob:(s)=>Buffer.from(s,'base64').toString('binary'),
    fetch:async()=>{throw new Error('Unexpected network call');}, ...extras });
  const load = (file, suffix='') => vm.runInContext(fs.readFileSync(path.join(root,file),'utf8')+'\n'+suffix, ctx, {filename:file});
  ctx.importScripts = (...files) => files.forEach((file) => load(path.join('background',file)));
  return {ctx,state,storage,events,load};
}

function worker(settings={}) {
  const e=environment({settings:{enabled:true,webVideoEnabled:true,webVideoDub:true,...settings},apiKeys:['synthetic-key']});
  e.load('background/service-worker.js');
  const configs=[],pushed=[];let stopped=0,started=0;
  e.ctx.GXT.live.createSession=config=>{configs.push(config);return {start(){started++;},stop(){stopped++;},push(v){pushed.push(v);}};};
  function connect(name='gxt-live-web',sender={id:'test-extension',tab:{id:12},url:'https://video.example/watch'}){
    const messages=[];let receive,disconnect,closed=false;
    e.events.connect[0]({name,sender,postMessage:m=>messages.push(m),disconnect:()=>{closed=true;},
      onMessage:{addListener:fn=>{receive=fn;}},onDisconnect:{addListener:fn=>{disconnect=fn;}}});
    return {messages,get closed(){return closed;},send:m=>{assert.ok(receive,'Live web route was not registered');return receive(m);},disconnect:()=>disconnect?.()};
  }
  return {...e,configs,pushed,connect,get started(){return started;},get stopped(){return stopped;}};
}
test('web Live: per-player model and source language reach the real session factory',async()=>{
  const e=worker({ytLiveModel:'global-model',ytLiveSourceLang:'ja'}),p=e.connect();
  await p.send({t:'start',model:'gemini-3.5-live-translate-preview',sourceLang:'en'});
  assert.equal(e.configs.length,1);assert.equal(e.configs[0].model,'gemini-3.5-live-translate-preview');
  assert.equal(e.configs[0].sourceLang,'en');assert.equal(e.started,1);
});
test('web Live: caption availability is not a prerequisite',async()=>{
  const e=worker(),p=e.connect();await p.send({t:'start',model:'',sourceLang:''});
  assert.equal(e.started,1);assert.equal(e.configs[0].model,undefined);
});

test('web Live: default automatic language from the real dub client starts without a language restriction',async()=>{
  const e=worker({ytLiveSourceLang:'ja'}),p=e.connect();await p.send({t:'start',model:'',sourceLang:'auto'});
  assert.equal(e.started,1);assert.equal(e.configs[0].sourceLang,'');
});
test('web Live: disabled or blocked site never starts a paid session',async()=>{
  for(const settings of [{webVideoDub:false},{webVideoEnabled:false},{enabled:false},{webVideoBlockedSites:['example']},{webVideoSiteMode:'allowlist',webVideoAllowedSites:['other.example']}]){
    const e=worker(settings),p=e.connect();await p.send({t:'start'});
    assert.equal(e.started,0);assert.equal(p.messages.at(-1)?.error?.code,'DISABLED');
  }
});
test('web Live: malformed per-player model and source language are rejected',async()=>{
  for(const options of [{model:'x/y'},{model:9},{sourceLang:'x'.repeat(30)},{sourceLang:{text:'en'}}]){
    const e=worker(),p=e.connect();await p.send({t:'start',...options});
    assert.equal(e.started,0);assert.equal(p.messages.at(-1)?.error?.code,'INVALID_SETTINGS');
  }
});
test('web Live: repeated start and stop during initialization cannot leave a socket',async()=>{
  const e=worker(),p=e.connect(),gate=deferred();const real=e.ctx.GXT.getSettings;
  e.ctx.GXT.getSettings=async()=>{await gate.promise;return real();};
  const a=p.send({t:'start'}),b=p.send({t:'start'});await p.send({t:'stop'});gate.resolve();await Promise.all([a,b]);
  assert.equal(e.started,0);await p.send({t:'start'});assert.equal(e.started,1);p.disconnect();assert.equal(e.stopped,1);
});
test('web Live: external or non-web senders are disconnected',async()=>{
  const e=worker();for(const sender of [{id:'foreign',tab:{id:1},url:'https://video.example/'},{id:'test-extension',url:'chrome-extension://test-extension/popup/popup.html'}]){
    assert.equal(e.connect('gxt-live-web',sender).closed,true);
  }
});
test('web Live: bounded audio and old session callbacks retain ownership',async()=>{
  const e=worker(),p=e.connect();await p.send({t:'start'});const old=e.configs[0];
  await p.send({t:'audio',data:'AAAA'});await p.send({t:'audio',data:'a'.repeat(70000)});assert.equal(e.pushed.length,1);
  await p.send({t:'stop'});await p.send({t:'start'});const count=p.messages.length;
  old.onAudio('stale');old.onState({state:'ready'});assert.equal(p.messages.length,count);
});
test('YouTube Live: web-only override fields do not change existing global routing',async()=>{
  const e=worker({ytLiveModel:'global-model',ytLiveSourceLang:'ja'}),p=e.connect('gxt-live');
  await p.send({t:'start',model:'different',sourceLang:'en'});
  assert.equal(e.configs[0].model,'global-model');assert.equal(e.configs[0].sourceLang,'ja');
});
(async()=>{const results=[];for(const {name,run} of tests){try{await run();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.message});}}
  const passed=results.filter(r=>r.ok).length;console.log(JSON.stringify({source:root,passed,total:results.length,results},null,2));process.exitCode=passed===results.length?0:1;})();
