'use strict';
const assert=require('node:assert/strict');
const {environment,worker,tick,until,deferred,translated,item,send}=require('./fixtures-376.cjs');
const tests=[],test=(name,run)=>tests.push({name,run});
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers});
const answer=()=>json({candidates:[{content:{parts:[{text:'{"t":[{"i":0,"t":"ترجمه معتبر"}]}'}]},finishReason:'STOP'}]});
function gemini(transport) {
  let now=Date.parse('2026-09-23T10:00:00Z'),seq=0;const timers=new Map(),calls=[];
  class ClockDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const clock={now:()=>now,advance(ms){now+=ms;for(const [id,t]of [...timers])if(t.at<=now){timers.delete(id);t.fn();}},
    async settle(p,max=3000){let done=false,result,failure;p.then(v=>{done=true;result=v;},e=>{done=true;failure=e;});
      for(let n=0;n<max&&!done;n++){for(let i=0;i<8;i++)await tick();if(done)break;const next=Math.min(...[...timers.values()].map(t=>t.at));if(Number.isFinite(next))clock.advance(Math.max(0,next-now));}
      assert.ok(done,'virtual operation never settled');if(failure)throw failure;return result;},timers};
  const e=environment({}, {Date:ClockDate,setTimeout:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async(url,opts)=>{calls.push({url,key:opts.headers['x-goog-api-key'],at:now,body:opts.body&&JSON.parse(opts.body)});return transport(url,opts,calls.length);}});
  for(const file of ['shared/settings.js','background/abort.js','background/prompt.js','background/gemini.js'])e.load(file);
  const g=e.ctx.GXT.gemini;
  return {...e,g,clock,calls,run:(signal,keys=['synthetic-key'],extra)=>g.translateTexts(['Original source'],{keys,model:'gemini-3.8-flash',signal,extra})};
}
test('120 consecutive temporary failures recover on the same selected model',async()=>{
  const e=gemini((u,o,n)=>n<=120?json({error:{message:'Temporarily overloaded'}},503):answer());
  const result=await e.clock.settle(e.run());assert.equal(result.list[0],'ترجمه معتبر');assert.equal(e.calls.length,121);
  assert.ok(e.calls.every(c=>c.url.includes('/gemini-3.8-flash:')));
  assert.ok(e.calls.every((c,i)=>!i||c.at-e.calls[i-1].at>=1500));assert.equal(e.g._internal.activeOperations.size,0);assert.equal(e.clock.timers.size,0);
});
test('all limited keys wait until the nearest RetryInfo deadline and resume',async()=>{
  const e=gemini((u,o,n)=>n<=2?json({error:{details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:n===1?'65s':'110s'}]}},429):answer());
  await e.clock.settle(e.run(undefined,['first','second']));
  assert.deepEqual(e.calls.map(c=>c.key),['first','second','first']);assert.ok(e.calls[2].at-e.calls[0].at>=65000);
});

test('a project with explicitly zero quota does not prevent another key from succeeding',async()=>{
  const e=gemini((u,o,n)=>n===1?json({error:{details:[{'@type':'google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerDayPerProject',quotaValue:'0'}]}]}},429):answer());
  await e.clock.settle(e.run(undefined,['unavailable-project','available-project']));assert.equal(e.calls.length,2);
});
test('daily quota without numeric limit resumes at Pacific midnight',async()=>{
  const e=gemini((u,o,n)=>n===1?json({error:{details:[{'@type':'google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerDayPerProject'}]}]}},429):answer());
  const reset=e.ctx.GXT.pacificDayAndReset(new Date(e.clock.now())).resetTs;
  await e.clock.settle(e.run(),10000);assert.equal(e.calls.length,2);assert.ok(e.calls[1].at>=reset);
});
test('cancellation during an all-key cooldown makes no further requests',async()=>{
  const e=gemini(()=>json({error:{}},429,{'Retry-After':'3600'})),c=new AbortController(),p=e.run(c.signal);
  p.catch(()=>{});await until(()=>e.calls.length===1);await tick();c.abort();await assert.rejects(e.clock.settle(p),{code:'CANCELLED'});
  e.clock.advance(7200000);await tick();assert.equal(e.calls.length,1);assert.equal(e.clock.timers.size,0);
});
test('timeout extends the measured deadline and retries without fallback',async()=>{
  const e=gemini((u,o,n)=>n===1?new Promise((r,j)=>o.signal.addEventListener('abort',()=>j(Error('deadline')),{once:true})):answer());
  await e.clock.settle(e.run());assert.equal(e.calls.length,2);assert.ok(e.calls[1].at-e.calls[0].at>=120000);
  assert.ok(e.g._internal.timeoutFor('/models/gemini-3.8-flash:generateContent')>120000);
});
test('adaptive deadlines reflect observations and remain bounded',()=>{
  const e=gemini(answer);e.g._internal.latency.set('gemini-3.8-flash',{samples:[10000,20000,90000,100000,110000],timeouts:0});
  assert.equal(e.g._internal.timeoutFor('/models/gemini-3.8-flash:generateContent'),215000);
  e.g._internal.latency.get('gemini-3.8-flash').timeouts=2;
  assert.equal(e.g._internal.timeoutFor('/models/gemini-3.8-flash:generateContent'),240000);
});
for(const [status,code]of [[400,'INVALID_ARGUMENT'],[401,'BAD_KEY'],[403,'PERMISSION_DENIED'],[404,'MODEL_NOT_FOUND']])test(`HTTP ${status} ends permanently without changing the model`,async()=>{
  const e=gemini(()=>json({error:{message:'Permanent failure'}},status));await assert.rejects(e.clock.settle(e.run()),{code});assert.equal(e.calls.length,1);
});
test('an explicit zero quota is actionable, not an endless temporary wait',async()=>{
  const e=gemini(()=>json({error:{details:[{'@type':'google.rpc.QuotaFailure',violations:[{quotaId:'NoPlan',quotaValue:'0'}]}]}},429));
  await assert.rejects(e.clock.settle(e.run()),{code:'QUOTA_UNAVAILABLE'});assert.equal(e.calls.length,1);
});
test('bad keys are parked and denied model permissions do not invalidate other models',async()=>{
  const e=gemini((u,o)=>o.headers['x-goog-api-key']==='bad'?json({error:{message:'API key not valid'}},400):o.headers['x-goog-api-key']==='denied'?json({error:{message:'Model access denied'}},403):answer());
  await e.clock.settle(e.run(undefined,['bad','denied','good']));assert.equal(e.calls.length,3);assert.equal(e.g._internal.keyState.get('bad').invalid,true);assert.notEqual(e.g._internal.keyState.get('denied')?.invalid,true);
});
test('HTTP and RPC retry delays are honored for server errors and timeout stays distinct',()=>{
  const e=gemini(answer),classify=e.g._internal.classifyHttpError;
  const result=classify(503,{error:{details:[{'@type':'google.rpc.RetryInfo',retryDelay:{seconds:'75',nanos:500000000}}]}},new Headers({'Retry-After':'45'}));
  assert.equal(result.retryAfterMs,75500);assert.equal(result.code,'SERVER');
  for(const status of [408,504]){const err=classify(status,{});assert.equal(err.code,'TIMEOUT');assert.equal(err.retriable,true);}
});
for(const reason of ['SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII','IMAGE_SAFETY','IMAGE_PROHIBITED_CONTENT','IMAGE_RECITATION','LANGUAGE','ESCALATION','PUP_LIMITED_DISABLED'])test(`candidate ${reason} remains a content failure, including partial text`,async()=>{
  const e=gemini(()=>json({candidates:[{content:{parts:[{text:'{"t":[{"i":0,"t":"partial"}]}'}]},finishReason:reason,safetyRatings:[{category:'HARM_CATEGORY_DANGEROUS_CONTENT',probability:'HIGH',blocked:true}]}]}));
  await assert.rejects(e.clock.settle(e.run()),error=>error.code==='BLOCKED'&&error.blockReason===reason&&error.safetyRatings[0].blocked&&error.raw.includes(reason));assert.equal(e.calls.length,1);
});
test('prompt safety feedback and selected safety threshold are retained',async()=>{
  const e=gemini(()=>json({promptFeedback:{blockReason:'SAFETY',blockReasonMessage:'Content policy',safetyRatings:[{category:'HARM_CATEGORY_HARASSMENT',blocked:true}]}}));
  await assert.rejects(e.clock.settle(e.run(undefined,undefined,{geminiSafety:'BLOCK_ONLY_HIGH'})),{code:'BLOCKED'});
  assert.equal(e.calls[0].body.safetySettings.length,4);assert.ok(e.calls[0].body.safetySettings.every(s=>s.threshold==='BLOCK_ONLY_HIGH'));
});
test('unreadable HTTP responses recover even after repeated proxy truncation',async()=>{
  const e=gemini((u,o,n)=>n<=12?new Response('not JSON',{status:200}):answer());await e.clock.settle(e.run());assert.equal(e.calls.length,13);
});

test('valid envelopes with repeatedly unusable model output fail with a format diagnosis',async()=>{
  const e=gemini(()=>json({candidates:[{content:{parts:[{text:'not the requested translation format'}]},finishReason:'STOP'}]}));
  await assert.rejects(e.clock.settle(e.run()),{code:'BAD_RESPONSE',retriable:false});assert.equal(e.calls.length,4);
});
test('per-key leases prevent overlapping requests and release queued cancellation',async()=>{
  const gate=deferred();let active=0,max=0;const e=gemini(async()=>{active++;max=Math.max(max,active);await gate.promise;active--;return answer();});
  const one=e.run(),c=new AbortController(),two=e.run(c.signal);two.catch(()=>{});await until(()=>e.calls.length===1);c.abort();await assert.rejects(two,{code:'CANCELLED'});
  gate.resolve();await one;assert.equal(max,1);assert.equal(e.calls.length,1);assert.equal(e.g._internal.activeKeys.size,0);
});

test('an unrelated destination edit does not cancel an owned selected-model request',async()=>{
  const gate=deferred(),e=gemini(async()=>{await gate.promise;return answer();});
  await e.ctx.GXT.setSettings({xTargetLang:'fa'});const result=e.run();await until(()=>e.calls.length===1);
  await e.ctx.GXT.setSettings({targetLang:'ja'});gate.resolve();assert.equal((await result).list[0],'ترجمه معتبر');
});
test('shared work is still deduplicated after the old two-minute expiry',async()=>{
  let now=0;class D extends Date {static now(){return now;}}
  const e=environment({}, {Date:D});for(const f of ['shared/settings.js','background/abort.js','background/cache.js'])e.load(f);
  const gate=deferred();let calls=0;const fn=()=>{calls++;return gate.promise;};
  const one=e.ctx.GXT.cache.coalesce('same',fn);await tick();now=600000;
  const two=e.ctx.GXT.cache.coalesce('same',fn);await tick();gate.resolve('ok');await Promise.all([one,two]);assert.equal(calls,1);
});
function port(e,name='gxt-x-translation') {
  const listeners=[],disconnect=[],messages=[];
  const p={name,sender:{id:'test-extension',tab:{id:1}},onMessage:{addListener:fn=>listeners.push(fn)},onDisconnect:{addListener:fn=>disconnect.push(fn)},postMessage:m=>messages.push(m),disconnect:()=>disconnect.forEach(fn=>fn())};
  e.events.connect.forEach(fn=>fn(p));return {...p,messages,send:m=>listeners.forEach(fn=>fn(m))};
}
const stable=id=>({...item(id,'A stable pinned source.'),contentId:'x:pinned'});
test('two X tabs share a pending post; cancelling one keeps the other alive',async()=>{
  const e=await worker(),gate=deferred();let calls=0,signal;
  e.ctx.GXT.openai.translateBatch=async(group,cfg)=>{calls++;signal=cfg.signal;await gate.promise;return translated(group);};
  const a=port(e),b=port(e);a.send({items:[stable('a')]});b.send({items:[stable('b')]});await until(()=>calls===1);await tick();a.disconnect();await tick();assert.equal(signal.aborted,false);
  gate.resolve();await until(()=>b.messages.length);assert.equal(b.messages[0].results.b.ok,true);assert.equal(a.messages.length,0);assert.equal(calls,1);
});
test('last X owner cancellation aborts provider and prevents stale cache writes',async()=>{
  const e=await worker(),gate=deferred();let signal;
  e.ctx.GXT.openai.translateBatch=async(group,cfg)=>{signal=cfg.signal;await gate.promise;return translated(group);};
  const a=port(e);a.send({items:[stable('a')]});await until(()=>signal);a.send({t:'cancel',id:'a'});await tick();assert.equal(signal.aborted,true);gate.resolve();await tick();await tick();assert.equal(Object.keys(e.state).filter(k=>k.startsWith('t:')).length,0);
});
test('cancelling one item in an X batch preserves the other item',async()=>{
  const e=await worker(),gate=deferred();let signal;
  e.ctx.GXT.openai.translateBatch=async(group,cfg)=>{signal=cfg.signal;await gate.promise;return translated(group);};
  const a=port(e);a.send({items:[stable('a'),{...stable('b'),contentId:'x:new',text:'A new source.'}]});await until(()=>signal);a.send({t:'cancel',id:'a'});await tick();assert.equal(signal.aborted,false);
  gate.resolve();await until(()=>a.messages.length);assert.equal(a.messages[0].results.b.ok,true);assert.equal(a.messages[0].results.a.code,'CANCELLED');assert.equal(Object.keys(e.state).filter(k=>k.startsWith('t:')).length,1);
});
test('fifty new profile posts do not invalidate a pinned post after worker restart',async()=>{
  const e=await worker();let sources=[];e.ctx.GXT.openai.translateBatch=async group=>{sources.push(...group.map(i=>i.text));return translated(group);};await send(e,[stable('pin')]);
  const restarted=await worker(e.state);restarted.ctx.GXT.openai.translateBatch=e.ctx.GXT.openai.translateBatch;
  for(let n=0;n<50;n++)await send(restarted,[{...stable('pin'+n),ctx:'neighbor '+n},{...stable('new'+n),contentId:'x:new'+n,text:'Unique new source '+n}]);
  assert.equal(sources.filter(s=>s==='A stable pinned source.').length,1);assert.equal(sources.length,51);
});

test('an explicit X destination keeps pending work and durable cache through other destination edits',async()=>{
  const e=await worker(),gate=deferred();await e.ctx.GXT.setSettings({xTargetLang:'fa'});let calls=0;
  e.ctx.GXT.openai.translateBatch=async group=>{calls++;await gate.promise;return translated(group);};
  const one=send(e,[stable('before')]);await until(()=>calls===1);await e.ctx.GXT.setSettings({targetLang:'ja',pageTargetLang:'de'});
  const two=send(e,[stable('after')]);await tick();gate.resolve();await Promise.all([one,two]);assert.equal(calls,1);
  await send(e,[stable('cached')]);assert.equal(calls,1);assert.equal(Object.keys(e.state).filter(k=>k.startsWith('t:')).length,1);
});
test('safety output setting changes the cache namespace; appearance does not',async()=>{
  const e=await worker(),g=e.ctx.GXT,s={...g.DEFAULTS,provider:'gemini'};
  assert.notEqual(g.cacheNamespace(s),g.cacheNamespace({...s,geminiSafety:'BLOCK_NONE'}));assert.equal(g.cacheNamespace(s),g.cacheNamespace({...s,font:'other'}));
});
test('automatic memory learning preserves a pin cache while a manual correction invalidates it',async()=>{
  const e=await worker();await e.ctx.GXT.setSettings({memoryEnabled:true});let calls=0;
  e.ctx.GXT.openai.translateBatch=async group=>{calls++;return translated(group);};
  await send(e,[stable('first')]);await e.ctx.GXT.memory.remember([{source:'NASA NASA',target:'ناسا ناسا'}]);await send(e,[stable('learned')]);assert.equal(calls,1);
  await e.ctx.GXT.memory.pin('stable','ثابت');await send(e,[stable('corrected')]);assert.equal(calls,2);
  await e.ctx.GXT.memory.forget('stable');await send(e,[stable('unpin')]);assert.equal(calls,2,'original compatible cache was not reused');
});
test('closing the real X action port cancels a composer request',async()=>{
  const e=await worker(),gate=deferred();let signal;
  e.ctx.GXT.openai.composeEnglish=async cfg=>{signal=cfg.signal;await gate.promise;return{text:'translated draft'};};
  const p=port(e,'gxt-x-action');p.send({type:'TRANSLATE_COMPOSE',text:'پیش‌نویس'});await until(()=>signal);p.disconnect();await tick();assert.equal(signal.aborted,true);gate.resolve();await tick();assert.equal(p.messages.length,0);
});

test('legacy manual memory corrections have an identity before their first edit',async()=>{
  const e=environment({transMemory:{terms:{nasa:{s:'NASA',t:'ناسا',pinned:true}},count:1}});e.load('shared/settings.js');e.load('shared/memory.js');
  const before=await e.ctx.GXT.getSettings();assert.equal(before.memoryCorrections.length,64);
  await e.ctx.GXT.memory.forget('NASA');const after=await e.ctx.GXT.getSettings();assert.equal(after.memoryCorrections,'');
  assert.notEqual(e.ctx.GXT.cacheNamespace(before),e.ctx.GXT.cacheNamespace(after));
});

test('complete settings snapshots remain writable through the real mutation protocol',async()=>{
  const e=environment();e.load('shared/settings.js');const snapshot=await e.ctx.GXT.getSettings();let patch;
  e.ctx.document={};e.ctx.chrome.runtime.sendMessage=async message=>{patch=message.patch;return{ok:true};};
  await e.ctx.GXT.setSettings(snapshot);assert.equal(Object.hasOwn(patch,'memoryCorrections'),false);assert.equal(patch.model,snapshot.model);
});

test('closing X read-aloud cancels Gemini synthesis and releases its speech queue',async()=>{
  const e=await worker();await e.ctx.GXT.setSettings({ttsEnabled:true,ttsEngine:'gemini'});await e.ctx.GXT.setApiKeys(['synthetic-key']);
  let signal;e.ctx.GXT.gemini.synthesize=async cfg=>{signal=cfg.signal;return e.ctx.GXT.abort.wait(new Promise(()=>{}),signal);};
  const p=port(e,'gxt-x-action');p.send({type:'TTS_SPEAK',text:'خواندن یک پست'});await until(()=>signal);p.disconnect();await tick();
  assert.equal(signal.aborted,true);assert.equal(e.ctx.GXT.tts._internal.limiter.active,0);assert.equal(p.messages.length,0);
});

test('cancelling speech while its limiter is full retires the queued request',async()=>{
  const e=gemini(()=>answer());e.load('background/tts.js');const gate=deferred(),l=e.ctx.GXT.tts._internal.limiter;l.max=1;
  const one=l.run(()=>gate.promise),c=new AbortController();let ran=false;
  const two=l.run(()=>{ran=true;},c.signal);two.catch(()=>{});await tick();c.abort();await assert.rejects(two,{code:'CANCELLED'});
  assert.equal(l.waiters.length,0);gate.resolve();await one;assert.equal(ran,false);assert.equal(l.active,0);
});
test('streamed content safety preserves the terminal reason and never returns partial output',async()=>{
  const e=gemini(()=>new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:'partial'}]},finishReason:'SAFETY',safetyRatings:[{blocked:true}]}]})+'\n\n',{headers:{'Content-Type':'text/event-stream'}}));
  const p=e.g.summarize({keys:['synthetic-key'],model:'gemini-3.8-flash',text:'Source',onDelta:()=>{}});
  await assert.rejects(e.clock.settle(p),error=>error.code==='BLOCKED'&&error.finishReason==='SAFETY');assert.equal(e.calls.length,1);
});
test('stream ending after a final frame without blank newline is read fully',async()=>{
  const e=gemini(()=>new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:'Final answer'}]},finishReason:'STOP'}]})));
  const result=await e.clock.settle(e.g.summarize({keys:['synthetic-key'],model:'gemini-3.8-flash',text:'Source',onDelta:()=>{}}));assert.equal(result.text,'Final answer');assert.equal(e.calls.length,1);
});

test('a permanent error inside an SSE envelope is not retried as broken transport',async()=>{
  const e=gemini(()=>new Response('data: '+JSON.stringify({error:{code:400,status:'INVALID_ARGUMENT',message:'Unsupported parameter'}})+'\n\n'));
  await assert.rejects(e.clock.settle(e.g.summarize({keys:['synthetic-key'],model:'gemini-3.8-flash',text:'Source',onDelta:()=>{}})),{code:'INVALID_ARGUMENT'});assert.equal(e.calls.length,1);
});

test('unexpected tool output is diagnosed rather than accepted as a partial translation',async()=>{
  const e=gemini(()=>json({candidates:[{content:{parts:[{text:'partial'}]},finishReason:'UNEXPECTED_TOOL_CALL'}]}));
  await assert.rejects(e.clock.settle(e.run()),{code:'BAD_RESPONSE',finishReason:'UNEXPECTED_TOOL_CALL'});assert.equal(e.calls.length,4);
});
(async()=>{let passed=0;const results=[];for(const t of tests){try{await t.run();passed++;results.push({name:t.name,ok:true});}catch(error){results.push({name:t.name,ok:false,error:String(error.stack||error)});}}
console.log(JSON.stringify({passed,total:tests.length,results},null,2));process.exitCode=passed===tests.length?0:1;})();
