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

const translated=()=>({entries:[{id:'c1',text:'یک'},{id:'c2',text:'دو'}],invalid:false});
const openaiResponse=()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(translated())}}]}));
test('workshop dedicated provider model temperature prompt never mutate global settings',async()=>{
 const e=env({settings:{provider:'google',model:'global',customPrompt:'Global note'},apiKeys:['synthetic']});let sent;
 e.ctx.GXT.gemini.translateWorkshop=async(p,c)=>{sent=c;return translated()};
 const p=payload();p.translation={provider:'gemini',model:'gemini-3.5-flash',temperature:0.8,thinking:'high',customPrompt:'Use precise technical Persian'};
 assert.equal((await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p)).ok,true);assert.equal(sent.model,'gemini-3.5-flash');assert.equal(sent.extra.temperature,0.8);assert.equal(sent.extra.workshopThinking.level,'high');assert.match(sent.extra.workshopOptions.customPrompt,/precise technical/);assert.match(sent.extra.custom,/Global note/);assert.equal(sent.exactModel,true);assert.equal(e.state.settings.provider,'google');assert.equal(e.state.settings.model,'global');
});
test('workshop effective option changes isolate cache and returning same options reuses it',async()=>{
 const e=env(configured);let calls=0;e.ctx.GXT.openai.translateWorkshop=async()=>{calls++;return translated()};
 for(const temperature of [0.1,0.9,0.1]){const p=payload('t'+Math.random());p.translation={temperature};assert.equal((await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p)).ok,true)}assert.equal(calls,2);
});
test('workshop custom instruction changes isolate cache',async()=>{
 const e=env(configured);let calls=0;e.ctx.GXT.openai.translateWorkshop=async()=>{calls++;return translated()};
 for(const customPrompt of ['technical','casual','technical']){const p=payload('p'+Math.random());p.translation={customPrompt};await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p)}assert.equal(calls,2);
});
test('workshop invalid options fail before any paid request',async()=>{
 const e=env(configured);e.ctx.GXT.openai.translateWorkshop=()=>{throw Error('must not call')};
 for(const translation of [{temperature:9},{thinking:'ultra'},{provider:'foreign'},{thinkingBudget:0.5},{model:'x'.repeat(161)},[]]){const p=payload();p.translation=translation;assert.equal((await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p)).code,'BAD_REQUEST')}
});
test('workshop project reasoning reaches real Chat Completions body',async()=>{
 let body;const e=env(configured,{fetch:async(u,o)=>{body=JSON.parse(o.body);return openaiResponse()}});
 const p=payload();p.translation={model:'gpt-5.2',thinking:'high'};assert.equal((await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p)).ok,true);assert.equal(body.model,'gpt-5.2');assert.equal(body.reasoning_effort,'high');assert.equal(body.temperature,undefined);assert.equal(body.thinkingConfig,undefined);
});
test('workshop explicit Chat Completions temperature is retained for compatible models',async()=>{
 let body;const e=env(configured,{fetch:async(u,o)=>{body=JSON.parse(o.body);return openaiResponse()}});const p=payload();p.translation={temperature:0.65};await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p);assert.equal(body.temperature,0.65);assert.equal(body.reasoning_effort,undefined);
});
test('workshop empty temperature retains an explicit global tuning for the selected model',async()=>{
 let body;const e=env({...configured,settings:{...configured.settings,modelTuning:{'gpt-5.2':{temperature:0.7}}}},{fetch:async(u,o)=>{body=JSON.parse(o.body);return openaiResponse()}});const p=payload();p.translation={model:'gpt-5.2',thinking:'off'};assert.equal((await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p)).ok,true);assert.equal(body.temperature,0.7);assert.equal(body.reasoning_effort,'none');
});
test('workshop exact model version never silently invokes fallback',async()=>{
 let calls=0;const e=env({...configured,settings:{...configured.settings,openaiFallbackModel:'backup'}},{fetch:async()=>{calls++;return new Response(JSON.stringify({error:{message:'model missing'}}),{status:404})}});
 const p=payload();p.translation={model:'requested-version'};assert.equal((await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p)).ok,false);assert.equal(calls,1);
});
test('workshop Gemini 2.5 budget and Gemini3 level have different wire schemas',()=>{
 const e=env();const f=e.ctx.GXT.subtitlePrompts.workshopThinking;
 assert.equal(f('gemini-2.5-flash',{workshopThinking:{budget:2048}}).thinkingBudget,2048);
 assert.equal(f('gemini-3.5-flash',{workshopThinking:{level:'high'}}).thinkingLevel,'high');
 assert.equal(f('gemini-2.5-flash',{workshopThinking:{level:'off'}}).thinkingBudget,0);
 assert.equal(f('gemini-3.5-flash',{workshopThinking:{level:'auto'}}),null);
});
test('workshop unsupported thinking choices fail before generation',()=>{
 const f=env().ctx.GXT.subtitlePrompts.workshopThinking;
 for(const [model,options] of [['gemini-2.5-pro',{level:'off'}],['gemini-2.5-flash-lite',{budget:128}],['gemini-3.5-flash',{level:'off'}],['gemini-3.1-pro',{level:'minimal'}],['gemini-3.7-flash',{level:'minimal'}],['gemini-3.5-flash',{budget:2048}]])assert.throws(()=>f(model,{workshopThinking:options}),e=>e.code==='BAD_SETTINGS');
});
test('workshop Gemini request honors exact budget and model while preserving stable ID schema',async()=>{
 let body,url;const e=env({settings:{provider:'gemini',model:'gemini-3.5-flash'},apiKeys:['synthetic']},{fetch:async(u,o)=>{url=String(u);body=JSON.parse(o.body);return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(translated())}]}}]}))}});
 const p=payload();p.translation={model:'gemini-2.5-flash',thinkingBudget:2048,temperature:0.4};assert.equal((await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p)).ok,true);assert.match(url,/gemini-2.5-flash/);assert.equal(body.generationConfig.thinkingConfig.thinkingBudget,2048);assert.equal(body.generationConfig.temperature,0.4);assert.match(body.systemInstruction.parts[0].text,/unchanged IDs/);
});
test('workshop long project prompt is not truncated by the global instruction limit',async()=>{
 let body;const e=env({...configured,settings:{...configured.settings,customPrompt:'G'.repeat(1200)}},{fetch:async(u,o)=>{body=JSON.parse(o.body);return openaiResponse()}});const p=payload();p.translation={customPrompt:'P'.repeat(5800)+' PROJECT_END_MARKER'};assert.equal((await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p)).ok,true);assert.match(body.messages[0].content,/PROJECT_END_MARKER/);assert.ok(body.messages[0].content.includes('G'.repeat(1200)));
});
test('workshop machine translation remains selectable without model or key',async()=>{
 const e=env(configured);let engine;e.ctx.GXT.mt.translateTexts=async(t,c)=>{engine=c.engine;return {list:['یک','دو']}};const p=payload();p.translation={provider:'bing'};const r=await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(p);assert.equal(r.ok,true);assert.equal(engine,'bing');assert.equal(r.contextAware,false);
});
test('workshop project settings round trip and old projects receive safe defaults',()=>{
 const W=env().ctx.GXT.workshop;const doc={format:'srt',cues:[{start:0,end:1000,text:'Hello'}]};const p=W.createProject(doc,'a.srt');p.translation={provider:'gemini',model:'gemini-3.5-flash',temperature:0.8,thinking:'medium',thinkingBudget:null,customPrompt:'Editorial instruction'};const saved=W.snapshot(p);assert.deepEqual(JSON.parse(JSON.stringify(W.restore(saved).translation)),p.translation);delete saved.translation;assert.equal(W.restore(saved).translation.provider,'inherit');
});
test('workshop session sends immutable scoped settings with each chunk',async()=>{
 const W=env().ctx.GXT.workshop,p=W.createProject({format:'srt',cues:[{start:0,end:1000,text:'Hello'}]},'a.srt');p.translation={model:'custom-version',temperature:0.6};let sent;await new W.Session(p).run(async m=>{sent=m;return {ok:true,entries:[{id:m.cues[0].id,text:'سلام'}]}});assert.equal(sent.translation.model,'custom-version');assert.equal(sent.translation.temperature,0.6);p.translation.model='new';assert.equal(sent.translation.model,'custom-version');
});
test('workshop ASS font size outline and alignment preserve unrelated style and timing',()=>{
 const S=env().ctx.GXT.subs;const source='[V4+ Styles]\nFormat: Name, Fontname, Fontsize, Outline, Alignment, Encoding, PrimaryColour\nStyle: Default,Arial,48,2,2,178,&H00FFFFFF\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,Default,A,0,0,0,,Hello';
 const doc=S.parse(source,'a.ass'),items=S.collectTranslatable(doc).items;const output=S.build(doc,items,['سلام'],{font:'Vazirmatn',fontSize:36,outline:1.5,alignment:8,rtl:false}).text;assert.match(output,/Style: Default,Vazirmatn,36,1.5,8,1,&H00FFFFFF/);assert.match(output,/0:00:00.00,0:00:02.00,Default,A/);
});
test('workshop font values cannot inject style fields or new ASS events',()=>{
 const S=env().ctx.GXT.subs;const lines=['[V4+ Styles]','Format: Name, Fontname, Encoding','Style: Default,Arial,1'];const out=S._internal.patchAssStyles(lines,'Vazirmatn,Fake\nDialogue: malicious');assert.equal(out.length,3);assert.equal(out[2].split(',').length,3);assert.doesNotMatch(out[2],/\n/);
});
test('workshop zero-duration editor markers survive export and project restore',()=>{
 const e=env(),S=e.ctx.GXT.subs,W=e.ctx.GXT.workshop;const doc=S.parse('1\n00:00:00,000 --> 00:00:00,000\nMarker\n\n2\n00:00:01,000 --> 00:00:03,000\nHello','a.srt');const p=W.createProject(doc,'a.srt');assert.equal(p.rows.length,1);const restored=W.restore(W.snapshot(p));assert.equal(restored.doc.cues.length,2);const output=S.build(doc,p.rows,['سلام'],{rtl:false}).text;assert.match(output,/Marker/);assert.match(output,/سلام/);
});
(async()=>{const results=[];for(const {name,run} of tests){let timer;try{await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('TEST_TIMEOUT')),6000)})]);results.push({name,status:'pass'});}catch(e){results.push({name,status:'fail',error:String(e.message)});}finally{clearTimeout(timer);}}console.log(JSON.stringify({source:root,total:results.length,passed:results.filter(r=>r.status==='pass').length,results},null,2));process.exitCode=results.some(r=>r.status==='fail')?1:0;})();
