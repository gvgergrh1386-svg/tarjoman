'use strict';
const assert=require('node:assert/strict');
const {worker,until,tick,deferred,translated,item,send}=require('./fixtures-376.cjs');
const tests=[],test=(name,run)=>tests.push({name,run});
const post=(id,text='An unchanged pinned source.')=>({...item(id,text),contentId:'x:'+text});
function port(e) {
  const listeners=[],disconnect=[],messages=[];
  const p={name:'gxt-x-translation',sender:{id:'test-extension',tab:{id:1}},
    onMessage:{addListener:fn=>listeners.push(fn)},onDisconnect:{addListener:fn=>disconnect.push(fn)},
    postMessage:m=>messages.push(m),disconnect:()=>disconnect.forEach(fn=>fn())};
  e.events.connect.forEach(fn=>fn(p));return {...p,messages,send:m=>listeners.forEach(fn=>fn(m))};
}
const resultFor=(p,id)=>p.messages.find(m=>m.t==='result'&&m.id===id)?.result || p.messages.find(m=>m.results?.[id])?.results[id];

test('a disk-cached pin is delivered while the new post in its batch is still translating',async()=>{
  const first=await worker();first.ctx.GXT.openai.translateBatch=async group=>translated(group);
  await send(first,[post('seed')]);
  const e=await worker(first.state),gate=deferred(),sources=[];
  e.ctx.GXT.openai.translateBatch=async group=>{sources.push(...group.map(x=>x.text));await gate.promise;return translated(group);};
  const p=port(e);p.send({stream:true,items:[post('pin'),post('new','A genuinely new source.')]});
  try {
    await until(()=>sources.length===1);
    await until(()=>resultFor(p,'pin'),500);
    assert.equal(resultFor(p,'pin').cached,true);
    assert.equal(resultFor(p,'new'),undefined);
    assert.deepEqual(sources,['A genuinely new source.']);
    assert.ok(!p.messages.some(m=>m.t==='pending'&&m.id==='pin'),'a cache hit was labelled as translating');
  } finally {gate.resolve();await tick();}
});

test('a shared pin completes independently of a slow neighbor in another tab',async()=>{
  const e=await worker(),pin=deferred(),fresh=deferred();let calls=0;
  await e.ctx.GXT.setSettings({batchSize:1});
  e.ctx.GXT.openai.translateBatch=async group=>{calls++;await (group[0].text==='An unchanged pinned source.'?pin.promise:fresh.promise);return translated(group);};
  const a=port(e),b=port(e);
  a.send({stream:true,items:[post('first')]});
  b.send({stream:true,items:[post('shared'),post('new','A slow new post.')]});
  try {
    await until(()=>calls===2);pin.resolve();
    await until(()=>resultFor(a,'first'));
    await until(()=>resultFor(b,'shared'),500);
    assert.equal(resultFor(b,'shared').ok,true);assert.equal(resultFor(b,'new'),undefined);assert.equal(calls,2);
  } finally {pin.resolve();fresh.resolve();await tick();}
});

test('a legacy cached pin is delivered before a new post and migrated without provider work',async()=>{
  const e=await worker(),gate=deferred(),sources=[],pin=post('legacy');
  const settings=await e.ctx.GXT.getSettings();
  const key=await e.ctx.GXT.cache.keyFor(JSON.stringify([pin.text,pin.author,'']),'en',e.ctx.GXT.cacheNamespace(settings));
  await e.ctx.GXT.cache.setMany([[key,{t:'ترجمهٔ قبلی',sl:'en'}]]);
  e.ctx.GXT.openai.translateBatch=async group=>{sources.push(...group.map(x=>x.text));await gate.promise;return translated(group);};
  const p=port(e);p.send({stream:true,items:[pin,post('new','A new source beside legacy cache.')]});
  try {
    await until(()=>sources.length===1);await until(()=>resultFor(p,'legacy'));
    assert.equal(resultFor(p,'legacy').t,'ترجمهٔ قبلی');assert.equal(resultFor(p,'legacy').cached,true);
    assert.ok(!p.messages.some(m=>m.t==='pending'&&m.id==='legacy'));
    assert.deepEqual(sources,['A new source beside legacy cache.']);
  } finally {gate.resolve();await tick();}
});

test('a completed provider group is delivered before a different group finishes',async()=>{
  const e=await worker(),slow=deferred();await e.ctx.GXT.setSettings({batchSize:1});
  e.ctx.GXT.openai.translateBatch=async group=>{if(group[0].text==='Slow group source.')await slow.promise;return translated(group);};
  const p=port(e);p.send({stream:true,items:[post('fast','Fast group source.'),post('slow','Slow group source.')]});
  try {
    await until(()=>resultFor(p,'fast'));assert.equal(resultFor(p,'fast').ok,true);assert.equal(resultFor(p,'slow'),undefined);
    assert.equal(p.messages.filter(m=>m.t==='result'&&m.id==='fast').length,1);
  } finally {slow.resolve();await tick();}
});

(async()=>{let passed=0;for(const {name,run}of tests){try{await run();passed++;console.log('PASS '+name);}catch(error){console.error('FAIL '+name+'\n'+error.stack);}}
console.log(`${passed}/${tests.length} X refresh regressions passed`);process.exitCode=passed===tests.length?0:1;})();
