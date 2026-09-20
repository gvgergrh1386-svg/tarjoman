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
    Uint8Array, DataView, Blob, Response, ReadableStream, AbortController, URLSearchParams, crypto:webcrypto,
    setTimeout, clearTimeout, btoa:(s)=>Buffer.from(s,'binary').toString('base64'),
    atob:(s)=>Buffer.from(s,'base64').toString('binary'),
    fetch:async()=>{throw new Error('Unexpected network call');}, ...extras });
  const load = (file, suffix='') => vm.runInContext(fs.readFileSync(path.join(root,file),'utf8')+'\n'+suffix, ctx, {filename:file});
  ctx.importScripts = (...files) => files.forEach((file) => load(path.join('background',file)));
  return {ctx,state,storage,events,load};
}

const env=(initial={},extra={})=>{const e=environment(initial,extra);e.load('background/service-worker.js','globalThis.auditHandlers=handlers;');return e};
const payload=(id='req-a')=>({requestId:id,projectId:'p',cues:[{id:'c1',text:'A continuous sentence',start:0,end:1000,speaker:'A'},{id:'c2',text:'ends here.',start:1000,end:2500,speaker:'A'}],contextBefore:[],contextAfter:[],rules:{glossary:[],characters:[],style:'natural'}});
const configured={settings:{provider:'openai',openaiBaseUrl:'https://unit.test/v1',openaiModel:'model-a',ytProvider:'google'},openaiApiKey:'synthetic'};
test('YouTube effective key covers dedicated Google Bing ABA and language',()=>{const e=env();const a={...e.ctx.GXT.DEFAULTS,provider:'gemini',ytProvider:'google'};assert.notEqual(e.ctx.GXT.youtubeTranslationKey(a),e.ctx.GXT.youtubeTranslationKey({...a,ytProvider:'bing'}));assert.notEqual(e.ctx.GXT.youtubeTranslationKey(a),e.ctx.GXT.youtubeTranslationKey({...a,ytTargetLang:'en'}));});
test('YouTube automatic prompt conservatively corrects only high-confidence ASR',()=>{const e=env();const p=e.ctx.GXT.prompt.buildGenericSystemPrompt('youtube-auto',{},null,['new rally networks']);assert.match(p,/ONLY.*highly certain/);assert.match(p,/two readings are plausible/);assert.match(p,/never guess confidently/);});
test('manual YouTube prompt disables ASR correction and preserves uncertain names',()=>{const e=env();const p=e.ctx.GXT.prompt.buildGenericSystemPrompt('youtube-manual',{},null,['an unusual name']);assert.match(p,/Disable ASR correction/);assert.match(p,/do not presume a name/);});
test('generic page and file prompts remain independent of YouTube ASR rules',()=>{const e=env();for(const kind of ['page','selection','subtitle'])assert.doesNotMatch(e.ctx.GXT.prompt.buildGenericSystemPrompt(kind,{gregorian:'today'},null,['hello']),/ASR|speech recognition/);});
test('workshop strict ID parser retains valid neighbors but rejects duplicates and extras',()=>{const e=env();const cues=payload().cues;const r=e.ctx.GXT.subtitlePrompts.parseWorkshop(JSON.stringify({entries:[{id:'c1',text:'الف'},{id:'c1',text:'ب'},{id:'alien',text:'ج'},{id:'c2',text:'پایان'}]}),cues);assert.equal(r.invalid,true);assert.equal(r.entries.length,1);assert.equal(r.entries[0].id,'c2');});
test('workshop invalid JSON and wrong shape fail visibly',()=>{const e=env();assert.throws(()=>e.ctx.GXT.subtitlePrompts.parseWorkshop('not JSON',payload().cues));assert.throws(()=>e.ctx.GXT.subtitlePrompts.parseWorkshop('{"t":[]}',payload().cues));});
test('workshop damaged protected tokens never apply',()=>{const e=env();const r=e.ctx.GXT.subtitlePrompts.parseWorkshop('{"entries":[{"id":"a","text":"متن"}]}',[{id:'a',text:'text ⟦0⟧'}]);assert.equal(r.entries.length,0);});
test('web-video subtitles use global provider without YouTube override',async()=>{const e=env({settings:{provider:'gemini',model:'m',ytProvider:'google'},apiKeys:['synthetic']});e.ctx.GXT.gemini.translateTexts=async(t,c)=>{assert.equal(c.kind,'subtitle');return{list:['وب'],model:'m'}};e.ctx.GXT.mt.translateTexts=async()=>{throw Error('YouTube provider leaked')};const r=await e.ctx.auditHandlers.TRANSLATE_TEXTS({texts:['web source'],kind:'subtitle',source:'web-video'});assert.equal(r.list[0],'وب');});
test('YouTube target model language and automatic metadata reach provider',async()=>{const e=env({settings:{provider:'google',model:'original',ytProvider:'gemini',ytModel:'dedicated',ytTargetLang:'en'},apiKeys:['synthetic']});e.ctx.GXT.gemini.translateTexts=async(t,c)=>{assert.equal(c.model,'dedicated');assert.equal(c.kind,'youtube-auto');assert.equal(c.extra.targetLang,'en');return{list:['English'],model:'dedicated'}};const r=await e.ctx.auditHandlers.TRANSLATE_TEXTS({texts:['input'],kind:'subtitle',source:'youtube',captionKind:'auto'});assert.equal(r.list[0],'English');});
test('YouTube manual and automatic outputs occupy separate cache scopes',async()=>{const e=env({settings:{provider:'gemini',model:'m'},apiKeys:['synthetic']});let calls=0;e.ctx.GXT.gemini.translateTexts=async()=>({list:['نسخه '+(++calls)],model:'m'});for(const captionKind of ['manual','auto','manual'])await e.ctx.auditHandlers.TRANSLATE_TEXTS({texts:['same input'],kind:'subtitle',source:'youtube',captionKind});assert.equal(calls,2);});
test('workshop route sends IDs duration context and rules through real OpenAI body',async()=>{let body;const e=env(configured,{fetch:async(u,o)=>{body=JSON.parse(o.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({entries:[{id:'c2',text:'پایان'},{id:'c1',text:'شروع'}]})}}]}))}});const p=payload();p.contextBefore=[{id:'prev',text:'previous',translated:'قبلی',speaker:'A'}];p.rules.glossary=[{source:'sentence',target:'جمله'}];const r=await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p);assert.equal(r.ok,true);assert.equal(r.entries.length,2);const input=JSON.parse(body.messages[1].content);assert.equal(input.cues[0].id,'c1');assert.equal(input.contextBefore[0].translated,'قبلی');assert.equal(input.rules.glossary[0].target,'جمله');assert.doesNotMatch(body.messages[0].content,/These captions are automatic/);});
test('workshop rejects duplicate IDs and oversize before sending network',async()=>{const e=env(configured);let p=payload();p.cues[1].id='c1';assert.equal((await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p)).code,'BAD_REQUEST');p=payload();p.cues[0].text='x'.repeat(16001);assert.equal((await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p)).code,'BAD_REQUEST');});
test('workshop cancel aborts actual fetch and returns promptly without writing cache',async()=>{const entered=deferred();let aborted=false;const e=env(configured,{fetch:async(u,o)=>{entered.resolve();return new Promise((_,reject)=>o.signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'))},{once:true}))}});const running=e.ctx.auditHandlers.TRANSLATE_WORKSHOP(payload('cancel-fetch'));await entered.promise;await e.ctx.auditHandlers.CANCEL_WORKSHOP({requestId:'cancel-fetch'});const r=await running;assert.equal(r.code,'CANCELLED');assert.equal(aborted,true);assert.equal(Object.keys(e.state).filter(k=>k.startsWith('t:')).length,0);});
test('workshop cancel aborts pending body and cannot apply a late body',async()=>{const entered=deferred();const e=env(configured,{fetch:async(u,o)=>({ok:true,json:()=>{entered.resolve();return new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Error('body abort')),{once:true}))}})});const work=e.ctx.auditHandlers.TRANSLATE_WORKSHOP(payload('cancel-body'));await entered.promise;await e.ctx.auditHandlers.CANCEL_WORKSHOP({requestId:'cancel-body'});assert.equal((await work).code,'CANCELLED');});
test('workshop cancel is owned by extension document identity',async()=>{const entered=deferred(),finish=deferred();const e=env(configured);e.ctx.GXT.openai.translateWorkshop=async()=>{entered.resolve();return finish.promise};const work=e.ctx.auditHandlers.TRANSLATE_WORKSHOP(payload('owned'),{documentId:'one'});await entered.promise;await e.ctx.auditHandlers.CANCEL_WORKSHOP({requestId:'owned'},{documentId:'two'});finish.resolve({entries:[{id:'c1',text:'یک'},{id:'c2',text:'دو'}],invalid:false});assert.equal((await work).ok,true);});
test('workshop cancellation before dispatch is honored',async()=>{const e=env(configured);await e.ctx.auditHandlers.CANCEL_WORKSHOP({requestId:'before'});assert.equal((await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(payload('before'))).code,'CANCELLED');});
test('workshop partial result preserves valid cue without full block retry',async()=>{const e=env(configured);let calls=0;e.ctx.GXT.openai.translateWorkshop=async()=>{calls++;return{entries:[{id:'c2',text:'پایان'}],invalid:true}};const r=await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(payload());assert.equal(calls,1);assert.equal(r.partial,true);assert.equal(r.entries[0].id,'c2');});
test('Google dedicated target language is sent to endpoint',async()=>{let url;const e=env({}, {fetch:async u=>{url=String(u);return new Response(JSON.stringify([[['Hello','سلام']],null,'fa']))}});const r=await e.ctx.GXT.mt.translateTexts(['سلام'],{engine:'google',targetLang:'en'});assert.equal(new URL(url).searchParams.get('tl'),'en');assert.equal(r.list[0],'Hello');});
test('workshop display wrapping may change while meaning tokens remain protected',()=>{const e=env();const r=e.ctx.GXT.subtitlePrompts.parseWorkshop(JSON.stringify({entries:[{id:'c',text:'خط نخست\nخط دوم'}]}),[{id:'c',text:'A sentence with two clauses.'}]);assert.equal(r.invalid,false);assert.equal(r.entries[0].text,'خط نخست\nخط دوم');});
test('workshop parser rejects reversed formatting order before cache or memory accepts it',()=>{const e=env();const r=e.ctx.GXT.subtitlePrompts.parseWorkshop(JSON.stringify({entries:[{id:'c',text:'⟦1⟧متن⟦0⟧'}]}),[{id:'c',text:'⟦0⟧source⟦1⟧'}]);assert.equal(r.invalid,true);assert.equal(r.entries.length,0);});
test('already-cancelled abort wait observes a rejecting provider promise without unhandled rejection',async()=>{const e=env();const controller=new AbortController();controller.abort();const unhandled=[];const listener=error=>unhandled.push(error);process.on('unhandledRejection',listener);try{let failure;try{await e.ctx.GXT.abort.wait(Promise.reject(Error('LATE_PROVIDER_REJECTION')),controller.signal);}catch(error){failure=error;}await tick();assert.equal(failure.code,'CANCELLED');assert.equal(unhandled.length,0);}finally{process.off('unhandledRejection',listener);}});
test('workshop export-control injection cannot enter a valid translation cache entry',()=>{const e=env();for(const text of ['ترجمه\u0000','ترجمه\n\n00:00:02.000 --> 00:00:03.000','{\\p1}m 0 0 l 1 1']){const r=e.ctx.GXT.subtitlePrompts.parseWorkshop(JSON.stringify({entries:[{id:'c',text}]}),[{id:'c',text:'Source'}]);assert.equal(r.invalid,true);assert.equal(r.entries.length,0);}});
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
