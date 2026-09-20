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
    async set(patch) { const changes={}; for(const [k,v] of Object.entries(patch)) changes[k]={oldValue:copy(state[k]),newValue:copy(v)}; Object.assign(state, copy(patch)); for(const fn of events.storage||[]) fn(changes,'local'); },
    async remove(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) delete state[key]; },
  };
  const chrome = {
    storage: { local: storage, session: storage, onChanged: event('storage') },
    runtime: { id:'test-extension', getURL:(s='') => 'chrome-extension://test-extension/'+s,
      getManifest:() => ({version:'test'}), onInstalled:event('installed'), onStartup:event('startup'),
      onMessage:event('message'), onConnect:event('connect') },
    action: { setBadgeText:async()=>{}, setBadgeBackgroundColor:async()=>{} },
    scripting:{getRegisteredContentScripts:async()=>[],registerContentScripts:async()=>{},unregisterContentScripts:async()=>{}}, contextMenus: { onClicked:event('menu'),removeAll:async()=>{},create:()=>{} }, commands: { onCommand:event('command') },
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

const configured={settings:{provider:'openai',openaiBaseUrl:'https://test.example/v1',openaiModel:'model-a',batchSize:8,memoryEnabled:false},openaiApiKey:'synthetic-test-key'};
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}throw Error('condition timeout');};
async function worker(initial=configured, extras={}){const e=environment(initial,extras);e.load('background/service-worker.js','globalThis.auditHandlers=handlers;');await tick();return e;}
const item=(id,text='A source sentence.',ctx='')=>({id,text,lang:'en',author:'Alice',ctx});
const translated=group=>({map:new Map(group.map((x,i)=>[i,{t:'ترجمه '+x.text,sl:'en'}])),model:'model-a'});
const send=(e,items)=>e.ctx.auditHandlers.TRANSLATE_BATCH({items});
const measured={};

test('twenty identical concurrent X requests with different DOM ids use one paid batch',async()=>{
 const e=await worker(),gate=deferred();let calls=0;e.ctx.GXT.openai.translateBatch=async group=>{calls++;await gate.promise;return translated(group);};
 const pending=Array.from({length:20},(_,i)=>send(e,[item('tab-'+i)]));await until(()=>calls>0);await new Promise(r=>setTimeout(r,25));gate.resolve();
 const results=await Promise.all(pending);measured.concurrentX={logicalRequests:20,providerCalls:calls,saved:20-calls};
 assert.equal(calls,1);results.forEach((r,i)=>assert.equal(r.results['tab-'+i].ok,true));
});
test('a shared X result performs its quality review only once',async()=>{
 const e=await worker({...configured,settings:{...configured.settings,qualityMode:true}}),gate=deferred();let calls=0,reviews=0;
 e.ctx.GXT.openai.translateBatch=async group=>{calls++;await gate.promise;return translated(group);};e.ctx.GXT.openai.reviewTexts=async texts=>{reviews++;return{list:texts.map(()=> 'بازبینی باکیفیت')};};
 const a=send(e,[item('a')]),b=send(e,[item('b')]);await until(()=>calls>0);await new Promise(r=>setTimeout(r,20));gate.resolve();const rs=await Promise.all([a,b]);assert.equal(calls,1);assert.equal(reviews,1);assert.equal(rs[1].results.b.t,'بازبینی باکیفیت');
});
test('failed in-flight X batch is removed and a later attempt reaches provider',async()=>{
 const e=await worker(),gate=deferred();let calls=0;e.ctx.GXT.openai.translateBatch=async group=>{calls++;if(calls===1){await gate.promise;throw Error('provider failed');}return translated(group);};
 const a=send(e,[item('a')]),b=send(e,[item('b')]);await until(()=>calls>0);await new Promise(r=>setTimeout(r,20));gate.resolve();const rs=await Promise.all([a,b]);assert.equal(rs[0].results.a.ok,false);assert.equal(rs[1].results.b.ok,false);assert.equal((await send(e,[item('retry')])).results.retry.ok,true);assert.equal(calls,2);
});
test('X context and author differences cannot join the same pending operation',async()=>{
 const e=await worker(),gate=deferred();let calls=0;e.ctx.GXT.openai.translateBatch=async group=>{calls++;await gate.promise;return translated(group);};
 const pending=[send(e,[item('a','Same reply','quote A')]),send(e,[item('b','Same reply','quote B')]),send(e,[{...item('c','Same reply','quote A'),author:'Bob'}])];await until(()=>calls===3);gate.resolve();await Promise.all(pending);assert.equal(calls,3);
});
test('overlapping X batches with different neighboring items retain independent full context',async()=>{
 const e=await worker(),gate=deferred();let calls=0;e.ctx.GXT.openai.translateBatch=async group=>{calls++;await gate.promise;return translated(group);};
 const pending=[send(e,[item('a','same'),item('b','neighbor one')]),send(e,[item('c','same'),item('d','neighbor two')])];await until(()=>calls===2);gate.resolve();await Promise.all(pending);assert.equal(calls,2);
});
test('model changes isolate pending X work and returning A cannot join old A',async()=>{
 const e=await worker(),gates=[deferred(),deferred(),deferred()];let calls=0;e.ctx.GXT.openai.translateBatch=async group=>{const n=calls++;await gates[n].promise;return translated(group);};
 const a=send(e,[item('a')]);await until(()=>calls===1);await e.ctx.GXT.setSettings({openaiModel:'model-b'});const b=send(e,[item('b')]);await until(()=>calls===2);await e.ctx.GXT.setSettings({openaiModel:'model-a'});const c=send(e,[item('c')]);await until(()=>calls===3);gates.forEach(g=>g.resolve());await Promise.all([a,b,c]);assert.equal(calls,3);
});
test('appearance changes preserve a compatible shared translation',async()=>{
 const e=await worker(),gate=deferred();let calls=0;e.ctx.GXT.openai.translateBatch=async group=>{calls++;await gate.promise;return translated(group);};
 const a=send(e,[item('a')]);await until(()=>calls===1);await e.ctx.GXT.setSettings({uiTheme:'paper'});const b=send(e,[item('b')]);await new Promise(r=>setTimeout(r,20));gate.resolve();await Promise.all([a,b]);assert.equal(calls,1);
});
test('cache clear retires pending work and late cleanup cannot evict replacement flight',async()=>{
 const e=await worker(),old=deferred(),fresh=deferred();let calls=0;e.ctx.GXT.openai.translateBatch=async group=>{calls++;await(calls===1?old.promise:fresh.promise);return translated(group);};
 const a=send(e,[item('a')]);await until(()=>calls===1);await e.ctx.GXT.cache.clearAll();const b=send(e,[item('b')]);await until(()=>calls===2);old.resolve();await a;assert.equal(Object.keys(e.state).filter(k=>k.startsWith('t:')).length,0);const c=send(e,[item('c')]);await new Promise(r=>setTimeout(r,20));fresh.resolve();await Promise.all([b,c]);assert.equal(calls,2);
});
test('memory clear retires shared work even when hints are empty',async()=>{
 const e=await worker(),gate=deferred();let calls=0;e.ctx.GXT.openai.translateBatch=async group=>{calls++;await gate.promise;return translated(group);};
 const a=send(e,[item('a')]);await until(()=>calls===1);await e.ctx.GXT.clearMemory();const b=send(e,[item('b')]);await until(()=>calls===2);gate.resolve();await Promise.all([a,b]);assert.equal(calls,2);
});
test('twenty identical generic requests share translation, repair, review and stats',async()=>{
 const e=await worker({...configured,settings:{...configured.settings,qualityMode:true}}),gate=deferred();let calls=0,reviews=0;e.ctx.GXT.openai.translateTexts=async texts=>{calls++;await gate.promise;return{list:texts.map(()=> 'ترجمه'),model:'model-a'};};e.ctx.GXT.openai.reviewTexts=async texts=>{reviews++;return{list:texts.map(()=> 'ترجمهٔ بازبینی‌شده')};};
 const pending=Array.from({length:20},()=>e.ctx.auditHandlers.TRANSLATE_TEXTS({texts:['source'],kind:'page',context:['same context']}));await until(()=>calls>0);await new Promise(r=>setTimeout(r,20));gate.resolve();const rs=await Promise.all(pending);await tick();measured.concurrentGeneric={logicalRequests:20,translationCalls:calls,reviewCalls:reviews};assert.equal(calls,1);assert.equal(reviews,1);assert.equal(rs[19].list[0],'ترجمهٔ بازبینی‌شده');assert.equal(e.state.stats.apiCalls,2);
});
test('generic different context, ordering, kind and quality stay independent',async()=>{
 const e=await worker({...configured,settings:{...configured.settings,qualityMode:true}}),gate=deferred();let calls=0;e.ctx.GXT.openai.translateTexts=async texts=>{calls++;await gate.promise;return{list:texts.map(()=> 'ترجمه'),model:'model-a'};};e.ctx.GXT.openai.reviewTexts=async t=>({list:t});
 const payloads=[{texts:['a','b'],kind:'page',context:['one']},{texts:['a','b'],kind:'page',context:['two']},{texts:['b','a'],kind:'page',context:['one']},{texts:['a','b'],kind:'selection',context:['one']}];const ps=payloads.map(p=>e.ctx.auditHandlers.TRANSLATE_TEXTS(p));await until(()=>calls===4);gate.resolve();await Promise.all(ps);assert.equal(calls,4);
});
test('cache disk read failure keeps hot hits and lets misses translate',async()=>{
 const e=await worker();await e.ctx.GXT.cache.setMany([['t:hot',{t:'hot value'}]]);const get=e.storage.get;e.storage.get=async keys=>{if(Array.isArray(keys)&&keys.some(k=>k.startsWith('t:')))throw Error('disk unavailable');return get(keys);};
 const hits=await e.ctx.GXT.cache.getMany(['t:hot','t:miss']);assert.equal(hits['t:hot'].t,'hot value');let calls=0;e.ctx.GXT.openai.translateBatch=async g=>{calls++;return translated(g)};assert.equal((await send(e,[item('a')])).results.a.ok,true);assert.equal(calls,1);
});
test('in-flight registry is bounded and settled work is released',async()=>{
 const e=await worker(),gate=deferred();const cache=e.ctx.GXT.cache;
 const ps=Array.from({length:400},(_,i)=>cache.coalesce('bounded-'+i,async()=>{await gate.promise;return i;}));assert.ok(cache._internal.inflightCount()<=256);gate.resolve();await Promise.all(ps);assert.equal(cache._internal.inflightCount(),0);
});
test('credential A B A transitions cannot revive an old shared request',async()=>{
 const e=await worker(),gate=deferred();let calls=0;e.ctx.GXT.openai.translateBatch=async group=>{calls++;await gate.promise;return translated(group);};
 const a=send(e,[item('a')]);await until(()=>calls===1);await e.ctx.GXT.setOpenaiKey('synthetic-key-b');const b=send(e,[item('b')]);await until(()=>calls===2);await e.ctx.GXT.setOpenaiKey('synthetic-test-key');const c=send(e,[item('c')]);await until(()=>calls===3);gate.resolve();await Promise.all([a,b,c]);assert.equal(calls,3);
});
test('glossary and pinned correction changes cannot share mismatched instructions',async()=>{
 const e=await worker({...configured,settings:{...configured.settings,memoryEnabled:true}}),gate=deferred();let calls=0;e.ctx.GXT.openai.translateBatch=async group=>{calls++;await gate.promise;return translated(group);};
 const a=send(e,[item('a','NASA source')]);await until(()=>calls===1);await e.ctx.GXT.setSettings({glossary:'NASA = نخست'});const b=send(e,[item('b','NASA source')]);await until(()=>calls===2);await e.ctx.GXT.memory.pin('NASA','اصلاح');const c=send(e,[item('c','NASA source')]);await until(()=>calls===3);gate.resolve();await Promise.all([a,b,c]);assert.equal(calls,3);
});
test('generic shared repair retries only the missing line once',async()=>{
 const e=await worker(),gate=deferred(),sizes=[];e.ctx.GXT.openai.translateTexts=async texts=>{sizes.push(texts.length);if(sizes.length===1){await gate.promise;return{list:['سالم',null],model:'model-a'};}return{list:['ترمیم'],model:'model-a'};};
 const req={texts:['first','second'],kind:'page'};const a=e.ctx.auditHandlers.TRANSLATE_TEXTS(req),b=e.ctx.auditHandlers.TRANSLATE_TEXTS(req);await until(()=>sizes.length>0);await new Promise(r=>setTimeout(r,20));gate.resolve();const rs=await Promise.all([a,b]);assert.deepEqual(sizes,[2,1]);assert.deepEqual(Array.from(rs[1].list),['سالم','ترمیم']);
});
test('batch size changes keep the model surrounding context independent',async()=>{
 const e=await worker(),gate=deferred(),sizes=[];e.ctx.GXT.openai.translateBatch=async group=>{sizes.push(group.length);await gate.promise;return translated(group);};
 const a=send(e,[item('a'),item('b','second')]);await until(()=>sizes.length===1);await e.ctx.GXT.setSettings({batchSize:1});const b=send(e,[item('c'),item('d','second')]);await until(()=>sizes.length===3);gate.resolve();await Promise.all([a,b]);assert.deepEqual(sizes,[2,1,1]);
});
test('an expired old flight cannot remove its still-pending replacement',async()=>{
 let now=1000;class Clock extends Date{static now(){return now;}}
 const e=environment({}, {Date:Clock});e.load('background/cache.js');const c=e.ctx.GXT.cache,old=deferred(),fresh=deferred();
 const a=c.coalesce('same',()=>old.promise);await tick();now+=c._internal.MAX_FLIGHT_AGE_MS;const b=c.coalesce('same',()=>fresh.promise);await tick();old.resolve('old');await a;assert.equal(c._internal.inflightCount(),1);const duplicate=c.coalesce('same',()=>{throw Error('must join replacement')});fresh.resolve('new');assert.equal(await b,'new');assert.equal(await duplicate,'new');assert.equal(c._internal.inflightCount(),0);
});
test('failed L2 read after clear cannot return a stale L1 hit',async()=>{
 const e=await worker();await e.ctx.GXT.cache.setMany([['t:hot',{t:'stale'}]]);const get=e.storage.get,entered=deferred(),fail=deferred();e.storage.get=async keys=>{if(Array.isArray(keys)&&keys.includes('t:missing')){entered.resolve();await fail.promise;throw Error('disk failed');}return get(keys);};
 const read=e.ctx.GXT.cache.getMany(['t:hot','t:missing']);await entered.promise;await e.ctx.GXT.cache.clearAll();fail.resolve();assert.equal(Object.keys(await read).length,0);
});

(async()=>{const results=[];for(const {name,run} of tests){let timer;try{await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('TEST_TIMEOUT')),4000)})]);results.push({name,status:'pass'});}catch(e){results.push({name,status:'fail',error:String(e.message)});}finally{clearTimeout(timer);}}const report={source:root,total:results.length,passed:results.filter(r=>r.status==='pass').length,failed:results.filter(r=>r.status==='fail').length,measured,results};console.log(JSON.stringify(report,null,2));process.exitCode=report.failed?1:0;})()

