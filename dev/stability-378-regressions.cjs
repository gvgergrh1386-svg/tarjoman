'use strict';
// Synthetic provider responses; never reads real accounts or API credentials.
const assert = require('node:assert/strict');
const {environment, worker, deferred, tick, until, item, translated, send} = require('./fixtures-376.cjs');
const tests = [], test = (name, run) => tests.push({name, run});
const json = (value, status=200, headers={}) => new Response(JSON.stringify(value), {status, headers});
const answer = text => json({candidates:[{content:{parts:[{text}]},finishReason:'STOP'}]});
function gemini(fetch) {
  const e = environment({}, {fetch, setTimeout:(fn, ms, ...args)=>setTimeout(fn, ms < 30000 ? 1 : ms, ...args)});
  for (const file of ['shared/settings.js','background/abort.js','background/prompt.js','background/gemini.js']) e.load(file);
  return e;
}
test('rotation reaches key 25 after cooling, network and invalid keys', async()=>{
  const keys=Array.from({length:25},(_,i)=>'synthetic-'+i), sent=[];
  const e=gemini(async(url,opts)=>{
    const key=opts.headers['x-goog-api-key'];sent.push(key);
    if(key===keys[2]) throw new TypeError('Synthetic network failure');
    if(key!==keys[24]) return json({error:{message:'API key not valid',status:'INVALID_ARGUMENT'}},400);
    return answer('{"t":["0⟫ترجمه معتبر"]}');
  });
  const g=e.ctx.GXT;
  for(const key of keys.slice(0,2))g.gemini._internal.keyState.set(key,{cooldowns:{'gemini-3.8-flash':Date.now()+3600000}});
  const r=await g.gemini.translateTexts(['Valid source sentence'],{keys,model:'gemini-3.8-flash',kind:'page'});
  assert.equal(r.list[0],'ترجمه معتبر');assert.ok(sent.includes(keys[24]));
  assert.equal(g.gemini._internal.keyState.get(keys[2])?.invalid,undefined);
});
test('daily request quota without a numeric limit remains daily',()=>{
  const {ctx}=gemini(()=>{});
  const err=ctx.GXT.gemini._internal.classifyHttpError(429,{error:{details:[{'@type':'google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerDayPerProject'}]}]}});
  assert.equal(err.quotaScope,'day');assert.equal(err.dailyLimit,undefined);
});
test('daily token quota is not a daily request count',()=>{
  const {ctx}=gemini(()=>{});
  const err=ctx.GXT.gemini._internal.classifyHttpError(429,{error:{details:[{'@type':'google.rpc.QuotaFailure',violations:[{quotaId:'GenerateInputTokensPerDayPerProject',quotaValue:'90000'}]}]}});
  assert.equal(err.quotaScope,'day');assert.equal(err.dailyLimit,undefined);
});
test('Retry-After is honored for temporary server failures',()=>{
  const {ctx}=gemini(()=>{});
  const err=ctx.GXT.gemini._internal.classifyHttpError(503,{error:{message:'Unavailable'}},new Headers({'Retry-After':'45'}));
  assert.ok(err.retryAfterMs>=45000);
});
test('model permission denial tries the next key without marking a valid key globally invalid',async()=>{
  const {ctx}=gemini(async(url,opts)=>opts.headers['x-goog-api-key']==='restricted'
    ?json({error:{message:'Permission denied for model',status:'PERMISSION_DENIED'}},403)
    :answer('{"t":[{"i":0,"t":"ترجمه"}]}'));
  const g=ctx.GXT;assert.equal((await g.gemini.translateTexts(['Source'],{keys:['restricted','allowed'],model:'gemini-3.8-flash'})).list[0],'ترجمه');
  assert.equal(g.gemini._internal.keyState.get('restricted')?.invalid,undefined);
});
test('mixed network and quota failures remain cancellable while waiting',async()=>{
  let calls=0;const {ctx}=gemini(async(url,opts)=>{calls++;if(opts.headers['x-goog-api-key']==='network')throw Error('Synthetic network');return json({error:{details:[{'@type':'google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerDayPerProject'}]}]}},429);});
  const c=new AbortController(),p=ctx.GXT.gemini.translateTexts(['Source'],{keys:['network','limited'],model:'gemini-3.8-flash',signal:c.signal});p.catch(()=>{});
  await until(()=>calls===2);c.abort();await assert.rejects(p,{code:'CANCELLED'});assert.equal(calls,2);
});
test('unknown and current model thinking capabilities do not inherit all levels',()=>{
  const {ctx}=gemini(()=>{}),g=ctx.GXT;
  assert.deepEqual(Array.from(g.geminiThinkingCapabilities('gemini-3.8-flash').levels),['low','medium','high']);
  assert.ok(g.geminiThinkingCapabilities('gemini-3.6-flash').levels.includes('minimal'));
  assert.deepEqual(Array.from(g.geminiThinkingCapabilities('gemini-future-flash').levels),[]);
  assert.equal(g.resolveModelTuning({provider:'gemini',modelTuning:{'gemini-3.8-flash':{thinkingLevel:'minimal'}}},'gemini-3.8-flash').thinkingLevel,null);
});
test('invalid stored thinking is never sent to Gemini',async()=>{
  const sent=[];const {ctx}=gemini(async(url,opts)=>{sent.push(JSON.parse(opts.body));return answer('{"t":["0⟫ترجمه معتبر"]}');});
  await ctx.GXT.gemini.translateTexts(['Valid source'],{keys:['synthetic'],model:'gemini-3.8-flash',kind:'page',extra:{thinkingLevel:'minimal'}});
  assert.notEqual(sent[0].generationConfig.thinkingConfig?.thinkingLevel,'minimal');assert.equal(sent.length,1);
});
test('unrelated invalid request does not walk the thinking ladder',async()=>{
  let count=0;const {ctx}=gemini(async()=>{count++;return json({error:{message:'Invalid response schema',status:'INVALID_ARGUMENT'}},400);});
  await assert.rejects(ctx.GXT.gemini.translateTexts(['Source'],{keys:['synthetic'],model:'gemini-3.8-flash',extra:{thinkingLevel:'high'}}));
  assert.equal(count,1);
});
test('indexed generic response never guesses a duplicate or out-of-range identity',()=>{
  const {ctx}=gemini(()=>{}),p=ctx.GXT.prompt;
  assert.throws(()=>p.parseGenericTranslations('{"t":["0⟫first","0⟫second"]}',2));
  assert.throws(()=>p.parseGenericTranslations('{"t":["9⟫wrong"]}',1));
});
test('duplicate tweet IDs cannot silently overwrite a result',()=>{
  const {ctx}=gemini(()=>{});
  assert.throws(()=>ctx.GXT.prompt.parseTranslations('{"r":[{"i":0,"t":"first"},{"i":0,"t":"second"}]}',['Source']));
});
test('quota view has no guessed capacity or multiplied project quota',()=>{
  const {ctx}=gemini(()=>{}),g=ctx.GXT;
  const unknown=g.quotaSummary({keys:['a','b'],model:'gemini-3.8-flash'});
  assert.equal(unknown.limit,0);assert.equal(unknown.limitSource,'none');
  const measured=g.quotaSummary({keys:['a','b'],model:'gemini-3.8-flash',usage:{a:{limit:20},b:{limit:20}}});
  assert.equal(measured.limit,0);assert.equal(measured.sharedProjectRisk,true);
});
test('stored quota discards old inferred caps and does not seed another project',async()=>{
  const e=await worker(),g=e.ctx.GXT;await g.setSettings({provider:'gemini',model:'gemini-3.8-flash'});await g.setApiKeys(['old','reported','unknown']);
  await e.storage.set({stats:{learnedDailyLimit:1500,learnedDailyLimitModel:'gemini-3.8-flash'},keyUsage:{day:g.pacificDayAndReset().dayKey,models:{'gemini-3.8-flash':{old:{calls:8,limit:1500},reported:{calls:12,limit:20,limitSource:'provider'}}}}});
  const q=(await e.ctx.auditHandlers.GET_STATS()).quota;
  assert.equal(q.perKey[0].limit,0);assert.equal(q.perKey[0].calls,8);assert.equal(q.perKey[1].limit,20);assert.equal(q.perKey[2].limit,0);assert.equal(q.limit,0);
});

test('a real daily-quota response persists only the reported request cap',async()=>{
  const e=await worker({settings:{provider:'gemini',model:'gemini-3.8-flash',memoryEnabled:false},apiKeys:['synthetic']},{fetch:async()=>json({error:{details:[{'@type':'google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerDayPerProject',quotaValue:'20'}]}]}},429)});
  const c=new AbortController(),p=e.ctx.GXT.gemini.translateTexts(['Source'],{keys:['synthetic'],model:'gemini-3.8-flash',signal:c.signal});p.catch(()=>{});
  await until(()=>e.state.keyUsage?.models?.['gemini-3.8-flash']?.synthetic?.exhausted);
  c.abort();await assert.rejects(p,{code:'CANCELLED'});
  const q=(await e.ctx.auditHandlers.GET_STATS()).quota;assert.equal(q.limit,20);assert.equal(q.state,'exhausted');assert.equal(q.perKey[0].measured,true);
});

test('a warm X translation survives worker restart without contacting a provider',async()=>{
  const e=await worker();e.ctx.GXT.openai.translateBatch=async group=>translated(group);
  const input={...item('first','Source with no quantities'),contentId:'status:42'};await send(e,[input]);
  const restarted=await worker(e.state);let calls=0;restarted.ctx.GXT.openai.translateBatch=async()=>{calls++;throw Error('cache should satisfy this');};
  const r=await send(restarted,[{...input,id:'return'}]);assert.equal(r.results.return.ok,true);assert.equal(calls,0);
});

test('an artifact in a persisted X cache is repaired instead of shown again',async()=>{
  const e=await worker();e.ctx.GXT.openai.translateBatch=async group=>translated(group);
  const input={...item('first','Source with no quantities'),contentId:'status:43'};await send(e,[input]);
  for(const key of Object.keys(e.state).filter(k=>k.startsWith('t:')))e.state[key].t='ترجمه %34 خراب';
  const restarted=await worker(e.state);let calls=0;restarted.ctx.GXT.openai.translateBatch=async group=>{calls++;return translated(group);};
  const r=await send(restarted,[{...input,id:'return'}]);assert.equal(calls,1);assert.equal(r.results.return.t.includes('%34'),false);
});

test('cancelling one shared subscriber leaves the other alive',async()=>{
  const e=environment();e.load('shared/settings.js');e.load('background/abort.js');e.load('background/cache.js');
  const gate=deferred(),a=new AbortController(),b=new AbortController();let signal,calls=0;
  const produce=s=>{calls++;signal=s;return gate.promise;};
  const one=e.ctx.GXT.cache.coalesce('shared',produce,{signal:a.signal});
  const two=e.ctx.GXT.cache.coalesce('shared',produce,{signal:b.signal});
  await tick();a.abort();
  assert.equal(await Promise.race([one.then(()=> 'resolved',err=>err.code),tick().then(()=> 'pending')]),'CANCELLED');
  assert.equal(signal.aborted,false);gate.resolve('ok');assert.equal(await two,'ok');assert.equal(calls,1);
});
test('last shared cancellation aborts the producer and lets a fresh request start',async()=>{
  const e=environment();e.load('shared/settings.js');e.load('background/abort.js');e.load('background/cache.js');
  const gate=deferred(),c=new AbortController();let signal;
  const old=e.ctx.GXT.cache.coalesce('one',s=>{signal=s;return gate.promise;},{signal:c.signal});
  old.catch(()=>{});await tick();c.abort();await tick();assert.equal(signal.aborted,true);
  assert.equal(await e.ctx.GXT.cache.coalesce('one',()=> 'fresh'),'fresh');gate.resolve('late');
});
test('cancelled Gemini limiter wait never starts a fetch',async()=>{
  let calls=0;const {ctx}=gemini(async()=>{calls++;return answer('{"t":["0⟫ترجمه معتبر"]}');});
  const c=new AbortController(),g=ctx.GXT.gemini;g._internal.limiter.active=2;
  const p=g.translateTexts(['Valid source'],{keys:['synthetic'],model:'gemini-3.8-flash',kind:'page',signal:c.signal});p.catch(()=>{});
  await tick();c.abort();g._internal.limiter.active=0;for(const wake of g._internal.limiter.waiters.splice(0))wake();
  await assert.rejects(p,{code:'CANCELLED'});assert.equal(calls,0);
});
test('stopping during Retry-After prevents retries and key rotation',async()=>{
  let calls=0;const {ctx}=gemini(async()=>{calls++;return json({error:{message:'Unavailable'}},503,{'Retry-After':'45'});});
  const c=new AbortController(),p=ctx.GXT.gemini.translateTexts(['Source'],{keys:['first','second'],model:'gemini-3.8-flash',signal:c.signal});p.catch(()=>{});
  await until(()=>calls===1);await tick();c.abort();await assert.rejects(p,{code:'CANCELLED'});assert.equal(calls,1);
});
for(const provider of ['openai','mt'])test('cancelled '+provider+' queue is released before occupied slots finish',async()=>{
  const gate=deferred();let calls=0;const count=provider==='openai'?2:8;
  const e=environment({}, {fetch:async()=>{calls++;await gate.promise;return provider==='openai'?json({choices:[{message:{content:'{"t":[{"i":0,"t":"ترجمه"}]}'}}]}):json([[['ترجمه','source']],null,'en']);}});
  for(const path of ['shared/settings.js','background/abort.js','background/prompt.js','background/'+provider+'.js'])e.load(path);
  const cfg=provider==='openai'?{baseUrl:'https://synthetic.example/v1',model:'synthetic',key:'synthetic'}:{engine:'google'};
  const api=e.ctx.GXT[provider],running=Array.from({length:count},()=>api.translateTexts(['Source'],cfg));await until(()=>calls===count);
  const c=new AbortController(),pending=api.translateTexts(['Queued'],{...cfg,signal:c.signal});pending.catch(()=>{});await tick();c.abort();
  let cancelled=false;pending.catch(error=>{cancelled=error.code==='CANCELLED';});await tick();assert.equal(cancelled,true);assert.equal(calls,count);
  gate.resolve();await Promise.all(running);await assert.rejects(pending,{code:'CANCELLED'});assert.equal(calls,count);
});
test('screenshot selection rejects a mutated inline ID but keeps original symbols',()=>{
  const {ctx}=gemini(()=>{}),p=ctx.GXT.prompt;
  const source='This was easily its best season so far. Everything it was trying to deliver—from the comedy and ecchi to even the drama—felt at its best this season.';
  assert.throws(()=>p.parseGenericTranslations(JSON.stringify({t:['0↔این بدون شک بهترین فصل آن بود.']}),1,[source],'selection'));
  const valid=p.parseGenericTranslations(JSON.stringify({t:[{i:0,t:'این بدون شک بهترین فصل آن بود.'}]}),1,[source],'selection');
  assert.equal(valid[0],'این بدون شک بهترین فصل آن بود.');
  assert.equal(p.translationInvariant('0↔ a relation','0↔ یک رابطه','selection'),true);
});
test('screenshot tweet rejects invented rate quantities rather than deleting them',()=>{
  const {ctx}=gemini(()=>{}),p=ctx.GXT.prompt;
  const source='didn’t believe mushoku tensei author heavily drinking so ended up traumatized by the newest episode';
  for(const mark of ['%','‰','٪']) assert.throws(()=>p.parseTranslations(JSON.stringify({r:[{i:0,t:'باورم نمی‌شد نویسنده این‌قدر الکل مصرف می‌کند؛ بعد از دیدن '+mark+'34 جدیدترین قسمت شوکه شدم'}]}),[source]));
  assert.equal(p.translationInvariant('Humidity is 34%','رطوبت ۳۴٪ است','tweet'),true);
  assert.equal(p.translationInvariant('Thirty four percent voted','۳۴٪ رأی دادند','tweet'),true);
});
test('generic wire separates IDs from text and handles shuffled structured rows',()=>{
  const {ctx}=gemini(()=>{}),p=ctx.GXT.prompt;
  const payload=p.buildGenericPayload(['first','second']);
  assert.equal(payload.items[0].text,'first');assert.equal(payload.items[0].i,0);
  assert.deepEqual(Array.from(p.parseGenericTranslations('{"t":[{"i":1,"t":"دوم"},{"i":0,"t":"اول"}]}',2)),['اول','دوم']);
  assert.throws(()=>p.parseGenericTranslations('{"t":[{"i":0,"t":"الف"},{"i":0,"t":"ب"}]}',2));
});
test('literal source numbers and separators survive both new and legacy output formats',()=>{
  const {ctx}=gemini(()=>{}),p=ctx.GXT.prompt,source='0⟫ relation';
  assert.equal(p.parseGenericTranslations('{"t":[{"i":0,"t":"0⟫ رابطه"}]}',1,[source],'selection')[0],'0⟫ رابطه');
  assert.equal(p.parseGenericTranslations('{"t":["0⟫0⟫ رابطه"]}',1,[source],'selection')[0],'0⟫ رابطه');
});
function pagePort(e) {
  const messages=[],onMessage=[],onDisconnect=[];
  const port={name:'gxt-page-translation',sender:{id:'test-extension',tab:{id:1},frameId:0},
    onMessage:{addListener:fn=>onMessage.push(fn)},onDisconnect:{addListener:fn=>onDisconnect.push(fn)},
    postMessage:value=>messages.push(value),disconnect:()=>onDisconnect.forEach(fn=>fn())};
  for(const fn of e.events.connect)fn(port);
  return {...port,messages,send:message=>onMessage.forEach(fn=>fn(message))};
}
test('page disconnect aborts its provider and prevents remaining groups and holes retries',async()=>{
  const e=await worker(),gate=deferred();let calls=0,signal;
  e.ctx.GXT.openai.translateTexts=async(texts,cfg)=>{calls++;signal=cfg.signal;await gate.promise;return {list:texts.map(()=>null),model:'model-a'};};
  const port=pagePort(e);port.send({texts:Array.from({length:40},(_,i)=>'Source '+i+' x'.repeat(400))});
  await until(()=>calls===1);port.disconnect();await tick();assert.equal(signal.aborted,true);
  gate.resolve();await tick();await tick();assert.equal(calls,1);assert.equal(port.messages.length,0);
});
test('two page owners share work and stopping one does not cancel the other',async()=>{
  const e=await worker(),gate=deferred();let calls=0,signal;
  e.ctx.GXT.openai.translateTexts=async(texts,cfg)=>{calls++;signal=cfg.signal;await gate.promise;return {list:['ترجمه'],model:'model-a'};};
  const a=pagePort(e),b=pagePort(e);a.send({texts:['Shared source']});b.send({texts:['Shared source']});
  await until(()=>calls===1);await tick();a.disconnect();await tick();assert.equal(signal.aborted,false);
  gate.resolve();await until(()=>b.messages.length===1);assert.equal(calls,1);assert.equal(b.messages[0].list[0],'ترجمه');assert.equal(a.messages.length,0);
  b.disconnect();
});
test('stopping during optional review discards the late result and cache write',async()=>{
  const e=await worker();await e.ctx.GXT.setSettings({qualityMode:true});const gate=deferred();let signal,reviews=0;
  e.ctx.GXT.openai.translateTexts=async()=>({list:['پیش‌نویس'],model:'model-a'});
  e.ctx.GXT.openai.reviewTexts=async(texts,sources,cfg)=>{reviews++;signal=cfg.signal;await gate.promise;return{list:['بازبینی دیرهنگام']};};
  const port=pagePort(e);port.send({texts:['Review source']});await until(()=>reviews===1);port.disconnect();await tick();assert.equal(signal.aborted,true);
  gate.resolve();await tick();await tick();assert.equal(port.messages.length,0);assert.equal(Object.keys(e.state).filter(k=>k.startsWith('t:')).length,0);
});
(async()=>{const results=[];for(const {name,run} of tests){try{await run();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:String(error.stack||error)});}}
  console.log(JSON.stringify({passed:results.filter(x=>x.ok).length,total:results.length,results},null,2));process.exitCode=results.some(x=>!x.ok)?1:0;})();
