'use strict';
const assert = require('node:assert/strict');
const {worker, environment, deferred, tick, until, configured, item, translated, send} = require('./fixtures-376.cjs');
const {fixture} = require('./audio-fixture-376.cjs');
const tests=[]; const test=(name,run)=>tests.push({name,run});
const post=(id,ctx='',text='The same original post.')=>({...item(id,text,ctx),contentId:'x:1234567890'});

test('X stable post survives changed conversation context, language metadata and memory batch',async()=>{
 const e=await worker();let calls=0;e.ctx.GXT.openai.translateBatch=async g=>{calls++;return translated(g)};
 const a=await send(e,[post('timeline')]);const b=await send(e,[{...post('detail','in reply to parent'),lang:'auto',author:'Alice (@alice)'}]);
 assert.equal(b.results.detail.t,a.results.timeline.t);assert.equal(calls,1);
});
test('X overlapping batches share each stable post once',async()=>{
 const e=await worker(),gate=deferred(),seen=[];e.ctx.GXT.openai.translateBatch=async g=>{seen.push(...g.map(x=>x.text));await gate.promise;return translated(g)};
 const a=send(e,[post('a'),{...post('b','','another post'),contentId:'x:2'}]);
 await until(()=>seen.length>0);const b=send(e,[post('c','other context'),{...post('d','','third post'),contentId:'x:3'}]);
 await tick();await new Promise(r=>setTimeout(r,30));gate.resolve();const out=await Promise.all([a,b]);
 assert.equal(seen.filter(x=>x==='The same original post.').length,1);assert.equal(out[0].results.a.t,out[1].results.c.t);
});
test('X stable cache remains available without a configured key',async()=>{
 const e=await worker();e.ctx.GXT.openai.translateBatch=async g=>translated(g);await send(e,[post('a')]);
 e.ctx.GXT.getOpenaiKey=async()=>'';e.ctx.GXT.openai.translateBatch=async()=>{throw Error('cached content reached provider')};
 assert.equal((await send(e,[post('b','changed context')])).results.b.ok,true);
});
test('zero original volume is continuous across caption gaps and seek',()=>{
 const f=fixture();f.engine.configure({...f.settings,ytDubDuck:0});f.engine.start('caption');
 assert.equal(f.video.volume,0);f.video.emit('seeking');f.video.emit('seeked');assert.equal(f.video.volume,0);
 f.engine.stop();assert.equal(f.video.volume,.8);
});
test('zero original volume is continuous across YouTube Live gaps',()=>{
 const f=fixture();f.engine.configure({...f.settings,ytLiveDuck:0});f.engine.start('live');assert.equal(f.originalGain(),0);
 f.speech();f.advance(1000);assert.equal(f.originalGain(),0);f.video.emit('seeking');assert.equal(f.originalGain(),0);
 f.engine.stop();assert.equal(f.originalGain(),1);
});
test('natural end retains queued Live audio and accepts final response until drained',()=>{
 const f=fixture();f.engine.start('live');f.speech();const port=f.ports[0];const first=[...f.engine._test.liveSources][0];
 f.video.ended=true;f.video.paused=true;f.video.emit('pause');f.video.emit('ended');f.engine.update();
 assert.equal(first.stopped,false);assert.ok(port.sent.some(x=>x.t==='end'));f.speech();
 port.emit({t:'state',state:'drained'});assert.equal(f.engine.stats().running,true);
 for(const source of [...f.engine._test.liveSources])source.onended();assert.equal(f.engine.stats().running,false);
});
test('capture waits for an asynchronous audio track while media keeps playing',()=>{
 const f=fixture({config:{captureMode:'stream'}}),listeners=new Map(),tracks=[];
 const stream={getTracks:()=>tracks,getAudioTracks:()=>tracks,addEventListener:(t,fn)=>listeners.set(t,fn),removeEventListener:t=>listeners.delete(t)};
 f.video.captureStream=()=>stream;f.engine.start('live');assert.equal(f.engine.stats().running,true);assert.equal(f.video.paused,false);
 tracks.push(f.track());listeners.get('addtrack')?.({track:tracks[0]});assert.equal(f.ports.length,1);assert.equal(f.streamSources,1);
 f.engine.stop();assert.equal(listeners.size,0);
});
test('caption EOF waits for translation then synthesis and plays all clips in order',async()=>{
 const pending=[];const f=fixture({config:{send:m=>new Promise(resolve=>pending.push({m,resolve}))}});
 f.engine.start('caption');f.engine.setUpstreamPending(true);f.engine.setSegments([{id:'one',start:0,end:1000,text:'first'}]);f.engine.update();
 f.video.currentTime=1;f.video.ended=true;f.video.paused=true;f.video.emit('pause');f.video.emit('ended');
 assert.equal(f.engine.stats().draining,true);assert.equal(f.engine.stats().running,true);
 f.engine.setUpstreamPending(false);f.engine.setSegments([{id:'one',start:0,end:1000,text:'first'},{id:'two',start:500,end:1000,text:'second'}]);
 pending[0].resolve({ok:true,data:'AAAA'});await tick();await tick();assert.equal(f.engine._test.scheduled.size,1);
 pending[1].resolve({ok:true,data:'AAAA'});await tick();await tick();const clips=[...f.engine._test.scheduled.values()];
 assert.equal(clips.length,2);assert.ok(clips[1].at>=clips[0].end);clips[0].source.onended();assert.equal(f.engine.stats().running,true);
 clips[1].source.onended();assert.equal(f.engine.stats().running,false);
});
test('seek during Live drain retires server audio from the old position',()=>{
 const f=fixture();f.engine.start('live');const old=f.ports[0];f.speech();f.video.ended=true;f.video.paused=true;f.video.emit('ended');
 f.video.ended=false;f.video.seeking=true;f.video.emit('seeking');old.emit({t:'audio',data:'AAAA'});assert.equal(f.engine._test.liveSources.size,0);
 f.video.seeking=false;f.video.paused=false;f.video.emit('seeked');assert.equal(f.ports.length,2);old.emit({t:'state',state:'drained'});assert.equal(f.engine.stats().running,true);f.engine.stop();
});

test('caption EOF never resurrects a late translation from before a seek',()=>{
 const pending=[];const f=fixture({config:{send:m=>new Promise(resolve=>pending.push({m,resolve}))}});
 f.engine.start('caption');f.engine.setUpstreamPending(true);
 f.video.currentTime=100;f.video.seeking=true;f.video.emit('seeking');f.video.seeking=false;f.video.emit('seeked');
 f.video.currentTime=101;f.video.ended=true;f.video.paused=true;f.video.emit('ended');
 f.engine.setUpstreamPending(false);f.engine.setSegments([{id:'stale-before-seek',start:0,end:1000,text:'obsolete earlier position'}]);
 assert.equal(pending.length,0);assert.equal(f.engine.stats().running,false);
});
test('X forced refresh cannot be overwritten by an older response',async()=>{
 const e=await worker(),gates=[deferred(),deferred()];let calls=0;
 e.ctx.GXT.openai.translateBatch=async g=>{const n=calls++;await gates[n].promise;return {map:new Map([[0,{t:n?'new':'old',sl:'en'}]]),model:'model-a'}};
 const old=send(e,[post('old')]);await until(()=>calls===1);const fresh=send(e,[{...post('fresh'),force:true}]);await until(()=>calls===2);
 gates[1].resolve();await fresh;gates[0].resolve();await old;assert.equal((await send(e,[post('cached')])).results.cached.t,'new');
});
test('X source edits do not collide while legacy entries migrate without a provider call',async()=>{
 const e=await worker();let calls=0;e.ctx.GXT.openai.translateBatch=async g=>{calls++;return translated(g)};
 const s=await e.ctx.GXT.getSettings();const key=await e.ctx.GXT.cache.keyFor(JSON.stringify(['The same original post.','Alice','']),'en',e.ctx.GXT.cacheNamespace(s));
 await e.ctx.GXT.cache.setMany([[key,{t:'legacy translation',sl:'en'}]]);
 assert.equal((await send(e,[post('a')])).results.a.t,'legacy translation');assert.equal(calls,0);assert.ok(e.state[key]);
 assert.equal((await send(e,[post('b','','edited original')])).results.b.ok,true);assert.equal(calls,1);
});
test('a hot cache hit does not wait behind an unrelated disk write',async()=>{
 const e=await worker();await e.ctx.GXT.cache.setMany([['t:hot',{t:'cached'}]]);
 const original=e.storage.set,entered=deferred(),gate=deferred();e.storage.set=async patch=>{if(patch['t:cold']){entered.resolve();await gate.promise;}return original(patch);};
 const writing=e.ctx.GXT.cache.setMany([['t:cold',{t:'new'}]]);await entered.promise;
 try{const result=await Promise.race([e.ctx.GXT.cache.getMany(['t:hot']),new Promise((_,reject)=>setTimeout(()=>reject(Error('hot cache blocked on unrelated write')),50))]);assert.equal(result['t:hot'].t,'cached');}
 finally{gate.resolve();await writing;}
});
test('diagnostics count logical requests, shared work and cache reuse without source content',async()=>{
 const e=await worker(),gate=deferred();let calls=0;e.ctx.GXT.openai.translateBatch=async g=>{calls++;await gate.promise;return translated(g)};
 const pending=Array.from({length:20},(_,i)=>send(e,[post('p'+i)]));await until(()=>calls===1);await new Promise(r=>setTimeout(r,20));gate.resolve();await Promise.all(pending);await send(e,[post('cached','new view')]);
 const stats=await e.ctx.auditHandlers.GET_STATS();assert.equal(stats.diagnostics.tweet.requests,21);assert.equal(stats.diagnostics.tweet.shared,19);assert.equal(stats.diagnostics.tweet.cacheHits,1);assert.equal(stats.diagnostics.tweet.pending,0);assert.equal(calls,1);
 assert.ok(!JSON.stringify(stats.diagnostics).includes('original post'));
});
test('manually selected unavailable Live model is never silently substituted',async()=>{
 const sockets=[];class Socket{constructor(){this.readyState=1;sockets.push(this)}send(){}close(){}}
 const e=environment({}, {WebSocket:Socket});e.ctx.GXT={};e.load('background/live.js');const states=[];
 const s=e.ctx.GXT.live.createSession({apiKeys:['test'],model:'my-live-choice',onState:x=>states.push(x)});s.start();sockets[0].onclose({code:1008});
 assert.equal(sockets.length,1);assert.equal(states.at(-1).state,'error');assert.equal(states.at(-1).model,'my-live-choice');s.stop();
});
test('Live sends end marker after buffered handshake audio and drains on final turn',async()=>{
 const sockets=[];class Socket{constructor(){this.readyState=1;this.sent=[];sockets.push(this)}send(s){this.sent.push(JSON.parse(s))}close(){this.readyState=3}}
 const e=environment({}, {WebSocket:Socket});e.ctx.GXT={};e.load('background/live.js');const states=[];
 const s=e.ctx.GXT.live.createSession({apiKeys:['test'],onState:x=>states.push(x.state)});s.start();s.push('AAAA');
 assert.equal(typeof s.endInput,'function');s.endInput();await sockets[0].onmessage({data:JSON.stringify({setupComplete:{}})});
 const packets=sockets[0].sent;assert.equal(packets[0].realtimeInput.audio.data,'AAAA');assert.equal(packets[1].realtimeInput.audioStreamEnd,true);
 assert.ok(!states.includes('drained'));await sockets[0].onmessage({data:JSON.stringify({serverContent:{turnComplete:true}})});
 assert.ok(states.includes('drained'));s.stop();
});

test('Live backpressure reports overflow instead of silently discarding accepted audio',()=>{
 class Socket{constructor(){this.readyState=1}send(){}close(){this.readyState=3}}
 const e=environment({}, {WebSocket:Socket});e.ctx.GXT={};e.load('background/live.js');const states=[];
 const s=e.ctx.GXT.live.createSession({apiKeys:['test'],onState:x=>states.push(x)});s.start();for(let i=0;i<41;i++)s.push('AAAA');
 assert.equal(states.at(-1).state,'error');assert.equal(states.at(-1).error.code,'BUFFER_FULL');assert.equal(s.state().buffered,0);s.endInput();assert.ok(!states.some(x=>x.state==='drained'));s.stop();
});
(async()=>{const results=[];for(const t of tests){let timer;try{await Promise.race([t.run(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('TEST_TIMEOUT')),4000)})]);results.push({name:t.name,status:'pass'});}catch(e){results.push({name:t.name,status:'fail',error:e.message});}finally{clearTimeout(timer);}}const report={total:results.length,passed:results.filter(x=>x.status==='pass').length,results};console.log(JSON.stringify(report,null,2));process.exitCode=report.passed===report.total?0:1;})();
