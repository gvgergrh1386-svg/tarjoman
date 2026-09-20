'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const tests = [], test = (name, run) => tests.push({name,run});
const deferred = () => {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function environment(fetch) {
  const storage={get:async()=>({}),set:async()=>{}};
  const context=vm.createContext({console, URL, TextDecoder, TextEncoder, Response, AbortController,
    setTimeout, clearTimeout, fetch, chrome:{storage:{local:storage,session:storage}},
    GXT:{prompt:{THINKING_LADDER:[null]},FALLBACK_MODELS:[]}});
  vm.runInContext(fs.readFileSync(path.join(root,'shared/settings.js'),'utf8'),context);
  let source=fs.readFileSync(path.join(root,'background/gemini.js'),'utf8');
  // Expose existing pure cache helpers in the test VM, including the baseline.
  source=source.replace('      ensureCachedContent,','      ensureCachedContent, noteCacheUse, cachedHandleFor, callModel,');
  vm.runInContext(source,context);
  return context.GXT.gemini._internal;
}
const response=(name='cachedContents/fixture')=>new Response(JSON.stringify({name}),{status:200});
test('provider cache: concurrent same prompt creation has one paid request',async()=>{
  const gate=deferred();let calls=0;
  const cache=environment(async()=>{calls++;await gate.promise;return response();});
  const a=cache.ensureCachedContent('key-a','model-a','shared prompt');
  const b=cache.ensureCachedContent('key-a','model-a','shared prompt');
  await new Promise(r=>setImmediate(r));gate.resolve();await Promise.all([a,b]);
  assert.equal(calls,1);
});
test('provider cache: two API keys retain their own reusable handles',async()=>{
  let calls=0;const cache=environment(async()=>response('cachedContents/'+ ++calls));
  const a=await cache.ensureCachedContent('key-a','model-a','same');
  await cache.ensureCachedContent('key-b','model-a','same');
  assert.equal(await cache.ensureCachedContent('key-a','model-a','same'),a);
  assert.equal(calls,2);
});
test('provider cache: reset retires a pending creation',async()=>{
  const gate=deferred();const cache=environment(async()=>{await gate.promise;return response();});
  const creating=cache.ensureCachedContent('key-a','model-a','pending');
  cache.resetCaches();gate.resolve();await creating;
  assert.equal(cache.cacheHandles.size,0);
});
test('provider cache: a short rejected prompt does not disable a different prompt',async()=>{
  let calls=0;const cache=environment(async()=>++calls===1
    ?new Response(JSON.stringify({error:{message:'Cached content too small',status:'INVALID_ARGUMENT'}}),{status:400})
    :response());
  await cache.ensureCachedContent('key-a','model-a','tiny');
  assert.equal(await cache.ensureCachedContent('key-a','model-a','long usable '.repeat(500)),'cachedContents/fixture');
  assert.equal(calls,2);
});
test('provider cache: expired handle can be primed again after reuse',async()=>{
  const cache=environment(async()=>response());
  await cache.ensureCachedContent('key-a','model-a','expired');
  for(const value of cache.cacheHandles.values())value.expiresAt=0;
  // New helper includes key in identity; baseline had only model/systemText.
  const args=cache.noteCacheUse.length===3?['key-a','model-a','expired']:['model-a','expired'];
  let prime=false;for(let i=0;i<cache.CACHE_AFTER_USES;i++)prime=cache.noteCacheUse(...args);
  assert.equal(prime,true);
});
test('provider cache: stopped optional caching cannot publish pending handle',async()=>{
  const gate=deferred();const cache=environment(async()=>{await gate.promise;return response();});
  const creating=cache.ensureCachedContent('key-a','model-a','pending');
  cache.setContextCache(false);gate.resolve();await creating;
  assert.equal(cache.cacheHandles.size,0);
});
test('provider cache: handle and reuse metadata stay bounded',async()=>{
  const cache=environment(async()=>response());
  for(let i=0;i<180;i++){
    await cache.ensureCachedContent('key-a','model-a','prompt-'+i);
    const args=cache.noteCacheUse.length===3?['key-a','model-a','seen-'+i]:['model-a','seen-'+i];
    cache.noteCacheUse(...args);
  }
  assert.ok(cache.cacheHandles.size<=64);assert.ok(cache.cacheSeen.size<=64);
});
test('provider cache: equal 32-bit hashes cannot substitute a different system prompt',async()=>{
  let calls=0;const cache=environment(async()=>response('cachedContents/'+ ++calls));
  const seen=new Map();let pair;
  // Deterministic birthday search against the old public non-cryptographic hash.
  let seed=1;for(let i=0;i<300000&&!pair;i++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const text='Instruction '+seed.toString(36)+' / '+i;
    const hash=cache.hashText(text);if(seen.has(hash))pair=[seen.get(hash),text];else seen.set(hash,text);
  }
  assert.ok(pair,'collision fixture was not found');
  await cache.ensureCachedContent('key-a','model-a',pair[0]);
  await cache.ensureCachedContent('key-a','model-a',pair[1]);
  assert.equal(calls,2);
});
test('provider cache: remotely expired handle retries the same model with full original instruction',async()=>{
  const sent=[];
  const cache=environment(async(url,options)=>{
    const body=JSON.parse(options.body);sent.push({url,body});
    if(url.includes('/cachedContents'))return response('cachedContents/expired-server');
    if(body.cachedContent)return new Response(JSON.stringify({error:{status:'NOT_FOUND',message:'CachedContent not found or expired'}}),{status:404});
    return new Response(JSON.stringify({text:'unchanged quality output'}));
  });
  await cache.ensureCachedContent('key-a','model-a','original full instruction');
  const output=await cache.callModel([], 'key-a','model-a',()=>({systemInstruction:{parts:[{text:'original full instruction'}]},contents:[]}),x=>x,[null],data=>({text:data.text}),{cache:true});
  assert.equal(output,'unchanged quality output');assert.equal(sent.length,3);
  assert.equal(sent[2].body.systemInstruction.parts[0].text,'original full instruction');
  assert.equal(sent[2].body.cachedContent,undefined);assert.ok(sent[2].url.includes('/model-a:'));
});
(async()=>{const results=[];for(const {name,run} of tests){try{await run();results.push({name,ok:true});}catch(e){results.push({name,ok:false,error:e.message});}}
  const passed=results.filter(r=>r.ok).length;console.log(JSON.stringify({source:root,passed,total:results.length,results},null,2));process.exitCode=passed===results.length?0:1;})();
