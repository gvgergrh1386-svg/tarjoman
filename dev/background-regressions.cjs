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

test('memory: failed clear rejects and next mutation recovers', async () => {
  const e=environment({transMemory:{terms:{nasa:{s:'NASA',t:'ناسا',n:2}},count:1}}); e.load('shared/settings.js');
  const set=e.storage.set; let fail=true;
  e.storage.set=async(p)=>{if(fail){fail=false;throw new Error('Injected quota failure');}return set(p);};
  await assert.rejects(e.ctx.GXT.clearMemory(), /Injected quota/);
  await e.ctx.GXT.clearMemory(); assert.equal(e.state.transMemory.count,0);
});
test('memory: failed manual correction must not report success', async () => {
  const e=environment(); e.load('shared/settings.js');e.load('shared/memory.js');
  e.storage.set=async()=>{throw new Error('Injected write failure');};
  await assert.rejects(e.ctx.GXT.memory.pin('NASA','ناسا'), /Injected write/);
});
test('cache: failed clear rejects and queue recovers', async () => {
  const e=environment({'t:a':{t:'old'},cacheCount:1});e.load('background/cache.js');
  const remove=e.storage.remove;let fail=true;
  e.storage.remove=async(k)=>{if(fail){fail=false;throw new Error('Injected removal failure');}return remove(k);};
  await assert.rejects(e.ctx.GXT.cache.clearAll(), /Injected removal/);
  await e.ctx.GXT.cache.clearAll();assert.equal(e.state.cacheCount,0);assert.equal(e.state['t:a'],undefined);
});
test('backup: replacement is ordered after earlier settings mutation', async () => {
  const e=environment({settings:{glossary:'original'}});e.load('shared/settings.js');
  const entered=deferred(),release=deferred();
  const write=e.ctx.GXT.setSettings0(async()=>{entered.resolve();await release.promise;return {glossary:'earlier edit'};});
  await entered.promise;
  const restore=e.ctx.GXT.importBackup({format:'tarjoman-backup',version:1,settings:{glossary:'restored'}},{mode:'replace'});
  await tick();release.resolve();await Promise.all([write,restore]);
  assert.equal((await e.ctx.GXT.getSettings()).glossary,'restored');
});
test('quota: Pacific next midnight respects spring DST and exact milliseconds', async()=>{
  const e=environment();e.load('shared/settings.js');
  assert.equal(e.ctx.GXT.pacificDayAndReset(new Date('2026-03-08T09:30:00.250Z')).resetTs,Date.parse('2026-03-09T07:00:00Z'));
});
test('quota: Pacific next midnight respects autumn DST', async()=>{
  const e=environment();e.load('shared/settings.js');
  assert.equal(e.ctx.GXT.pacificDayAndReset(new Date('2026-11-01T08:30:00Z')).resetTs,Date.parse('2026-11-02T08:00:00Z'));
});

function liveEnvironment() {
  const sockets=[],timers=new Map();let timerId=0;
  class Socket { constructor(){this.readyState=1;sockets.push(this);} send(){} close(){this.readyState=3;} }
  const e=environment({}, {WebSocket:Socket,setTimeout:(fn)=>{timers.set(++timerId,fn);return timerId;},clearTimeout:(id)=>timers.delete(id)});
  e.ctx.GXT={};e.load('background/live.js');
  return {...e,sockets,timers};
}
test('live: late Blob message after stop produces no audio', async()=>{
  const e=liveEnvironment(),output=[];const ready=deferred();
  const session=e.ctx.GXT.live.createSession({apiKeys:['synthetic-test-key'],onAudio:(x)=>output.push(x)});
  session.start();const blob=new Blob([]);blob.text=()=>ready.promise;
  const arriving=e.sockets[0].onmessage({data:blob});session.stop();
  ready.resolve(JSON.stringify({serverContent:{modelTurn:{parts:[{inlineData:{data:'old-audio'}}]}}}));
  await arriving;assert.equal(output.length,0);
});
test('live: repeated start has one socket and stop clears reconnect timer', async()=>{
  const e=liveEnvironment();const session=e.ctx.GXT.live.createSession({apiKeys:['synthetic-test-key']});
  session.start();session.start();assert.equal(e.sockets.length,1);
  await e.sockets[0].onmessage({data:'{"setupComplete":{}}'});e.sockets[0].onclose({code:1006});
  assert.equal(e.timers.size,1);session.stop();assert.equal(e.timers.size,0);
});
test('live: old socket close after restart cannot disconnect new socket', async()=>{
  const e=liveEnvironment();const session=e.ctx.GXT.live.createSession({apiKeys:['synthetic-test-key']});
  session.start();const old=e.sockets[0];session.stop();session.start();
  await e.sockets[1].onmessage({data:'{"setupComplete":{}}'});old.onclose({code:1000});
  assert.equal(session.state().ready,true);assert.equal(e.timers.size,0);
});
test('settings: 100 serialized writes preserve concurrent fields', async()=>{
  const e=environment();e.load('shared/settings.js');
  await Promise.all(Array.from({length:100},(_,n)=>e.ctx.GXT.setSiteSetting(`https://host${n}.example`,'enabled',false)));
  assert.equal(Object.keys((await e.ctx.GXT.getSettings()).sitePrefs).length,100);
});
test('cache: same-key concurrency, clear ordering, restart persistence', async()=>{
  const e=environment();e.load('background/cache.js');
  await Promise.all(Array.from({length:100},(_,n)=>e.ctx.GXT.cache.setMany([['t:shared',{t:String(n)}]])));
  assert.equal(e.state.cacheCount,1);
  const again=environment(e.state);again.load('background/cache.js');
  assert.equal((await again.ctx.GXT.cache.getMany(['t:shared']))['t:shared'].t,'99');
  await Promise.all([e.ctx.GXT.cache.setMany([['t:last',{t:'last'}]]),e.ctx.GXT.cache.clearAll()]);
  assert.equal(e.state.cacheCount,0);assert.equal(Object.keys(await e.ctx.GXT.cache.getMany(['t:shared','t:last'])).length,0);
});

async function workerEnvironment(initial={}, extras={}) {
  const e=environment(initial,extras);e.load('background/service-worker.js','globalThis.auditHandlers = handlers;');await tick();return e;
}
test('worker: a late fallback must preserve a model the user selected meanwhile', async()=>{
  const e=await workerEnvironment({apiKeys:['synthetic-test-key'],settings:{provider:'gemini',model:'model-a'}});
  const entered=deferred(),done=deferred();e.ctx.GXT.gemini.translateTexts=async()=>{entered.resolve();return done.promise;};
  const work=e.ctx.auditHandlers.TRANSLATE_TEXTS({texts:['Hello'],kind:'page'});await entered.promise;
  await e.ctx.GXT.setSettings({model:'model-b'});done.resolve({list:['سلام'],model:'fallback-a',softFallback:false});
  const result=await work;assert.equal(result.ok,true);assert.equal((await e.ctx.GXT.getSettings()).model,'model-b');
});
test('worker: clearing translation cache prevents an older request repopulating it', async()=>{
  const e=await workerEnvironment({settings:{provider:'google'}});const entered=deferred(),done=deferred();
  e.ctx.GXT.mt.translateTexts=async()=>{entered.resolve();return done.promise;};
  const work=e.ctx.auditHandlers.TRANSLATE_TEXTS({texts:['Hello'],kind:'page'});await entered.promise;
  await e.ctx.auditHandlers.CLEAR_CACHE();done.resolve({list:['سلام']});assert.equal((await work).ok,true);
  assert.equal(Object.keys(e.state).filter(k=>k.startsWith('t:')).length,0);
});
test('worker: clearing memory prevents an older translation relearning it', async()=>{
  const e=await workerEnvironment({settings:{provider:'google',memoryEnabled:true}});const entered=deferred(),done=deferred();
  e.ctx.GXT.mt.translateTexts=async()=>{entered.resolve();return done.promise;};
  const work=e.ctx.auditHandlers.TRANSLATE_TEXTS({texts:['NASA'],kind:'page'});await entered.promise;
  await e.ctx.auditHandlers.CLEAR_MEMORY();done.resolve({list:['ناسا']});assert.equal((await work).ok,true);await tick();
  assert.equal((await e.ctx.GXT.getMemory()).count,0);
});
test('worker: failed stats reset is reported as failure', async()=>{
  const e=await workerEnvironment();e.storage.set=async()=>{throw new Error('Injected stats write failure');};
  await assert.rejects(e.ctx.auditHandlers.RESET_STATS(),/Injected stats/);
});
test('worker: image body remains bounded by a deadline', async()=>{
  const e=await workerEnvironment({settings:{bridgeEnabled:true}}, {
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,25)),
    fetch:async(url,opts={})=>({ok:true,headers:new Headers({'Content-Type':'image/png'}),arrayBuffer:()=>new Promise((resolve,reject)=>{
      opts.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
    })}),
  });
  const result=await Promise.race([e.ctx.auditHandlers.BRIDGE_MANGA({url:'https://image.example/a.png'}),new Promise(resolve=>setTimeout(()=>resolve({code:'UNBOUNDED'}),100))]);
  assert.equal(result.ok,false);assert.equal(result.code,'TIMEOUT');
});
test('worker: oversized manga image is rejected before reading or forwarding', async()=>{
  let reads=0,forwarded=0;
  const e=await workerEnvironment({settings:{bridgeEnabled:true}}, {
    fetch:async()=>({ok:true,headers:new Headers({'Content-Length':String(24*1024*1024+1)}),arrayBuffer:async()=>{reads++;return new ArrayBuffer(1);}}),
  });
  e.ctx.GXT.bridge.manga=async()=>{forwarded++;return {ok:true};};
  const result=await e.ctx.auditHandlers.BRIDGE_MANGA({url:'https://image.example/huge.png'});
  assert.equal(result.ok,false);assert.equal(reads,0);assert.equal(forwarded,0);
});
test('Gemini SSE: CRLF frames fragmented between chunks preserve text', async()=>{
  const frame='data: '+JSON.stringify({candidates:[{content:{parts:[{text:'سلام'}]},finishReason:'STOP'}]})+'\r\n\r\n';
  const bytes=new TextEncoder().encode(frame);let at=0;
  const response=new Response(new ReadableStream({pull(controller){if(at<bytes.length)controller.enqueue(bytes.slice(at,++at));else controller.close();}}));
  const e=environment({}, {fetch:async()=>response});e.load('shared/settings.js');e.load('background/gemini.js');
  const result=await e.ctx.GXT.gemini._internal.apiStream('/stream?keyless=true','synthetic',{},()=>{});
  assert.equal(result.text,'سلام');assert.equal(result.finishReason,'STOP');assert.equal(response.body.locked,false);
});
test('bridge: timeout during HTTP error body remains a timeout', async()=>{
  const e=environment({}, {fetch:async(url,opts)=>({ok:false,status:503,json:()=>new Promise((resolve,reject)=>{
    opts.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
  })})});e.load('shared/settings.js');e.load('background/bridge.js');
  const result=await e.ctx.GXT.bridge._internal.call({},'/health',undefined,{timeout:25});
  assert.equal(result.code,'TIMEOUT');
});
test('worker: a pinned memory correction invalidates the affected AI cache entry', async()=>{
  const e=await workerEnvironment({apiKeys:['synthetic-test-key'],settings:{provider:'gemini',model:'model-a',memoryEnabled:true}});
  let calls=0;e.ctx.GXT.gemini.translateTexts=async(texts,cfg)=>{calls++;return {list:[cfg.extra?.memory?.NASA || 'ترجمه اول'],model:'model-a'};};
  const request={texts:['This uses NASA.'],kind:'page'};
  assert.equal((await e.ctx.auditHandlers.TRANSLATE_TEXTS(request)).list[0],'ترجمه اول');
  await e.ctx.GXT.memory.pin('NASA','اصلاح کاربر');
  assert.equal((await e.ctx.auditHandlers.TRANSLATE_TEXTS(request)).list[0],'اصلاح کاربر');assert.equal(calls,2);
});

test('worker: file subtitles use the global provider independently of YouTube override', async()=>{
  const e=await workerEnvironment({apiKeys:['synthetic-test-key'],settings:{provider:'gemini',model:'model-a',ytProvider:'google',qualityMode:false}});
  e.ctx.GXT.gemini.translateTexts=async()=>({list:['موتور فایل'],model:'model-a'});
  e.ctx.GXT.mt.translateTexts=async()=>({list:['موتور یوتیوب']});
  const file=await e.ctx.auditHandlers.TRANSLATE_TEXTS({texts:['File subtitle'],kind:'subtitle',source:'file'});
  const video=await e.ctx.auditHandlers.TRANSLATE_TEXTS({texts:['Video subtitle'],kind:'subtitle'});
  assert.equal(file.list[0],'موتور فایل');assert.equal(video.list[0],'موتور یوتیوب');
});

(async()=>{
  const results=[];
  for(const {name,run} of tests){
    let timer;
    try{await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('TEST_TIMEOUT')),5000);})]);results.push({name,status:'pass'});}
    catch(error){results.push({name,status:'fail',error:String(error.message)});}
    finally{clearTimeout(timer);}
  }
  const report={source:root,total:results.length,passed:results.filter(r=>r.status==='pass').length,failed:results.filter(r=>r.status==='fail').length,results};
  console.log(JSON.stringify(report,null,2));process.exitCode=report.failed?1:0;
})();
