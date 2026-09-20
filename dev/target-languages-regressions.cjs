'use strict';
const assert=require('node:assert/strict');
const {worker,configured,item,send,deferred,until}=require('./fixtures-376.cjs');
const tests=[],test=(name,run)=>tests.push({name,run});
const setup=patch=>worker({...configured,settings:{...configured.settings,localeVersion:1,uiLanguage:'en',...patch}});

test('arbitrary language tags validate, survive backup and keep scope independence',async()=>{
 const e=await setup({}),G=e.ctx.GXT;
 for(const code of [...G.TARGET_LANGUAGES,'sr-Latn','zh-Hant','fr-CA'])assert.equal(G.validTarget(code),true,code);
 for(const code of ['auto','inherit','English','en;alert(1)','../fr','',null])assert.equal(G.validTarget(code),false,String(code));
 await G.setSettings({targetLang:'fr',xTargetLang:'ja',pageTargetLang:'ar',ytTargetLang:'hi',fileTargetLang:'pt-BR'});
 const s=await G.getSettings();assert.equal(G.forScope(s,'x').targetLang,'ja');assert.equal(G.forScope(s,'page').targetLang,'ar');assert.equal(G.forScope(s,'image').targetLang,'fr');assert.equal(G.youtubeSettings(s).ytTargetLang,'hi');
 const other=await setup({});await other.ctx.GXT.importBackup(await G.exportBackup(),{mode:'replace'});assert.equal((await other.ctx.GXT.getSettings()).fileTargetLang,'pt-BR');
 for(const [code,dir] of [['fr','ltr'],['ja','ltr'],['ar','rtl'],['he','rtl'],['ur','rtl'],['hi','ltr']])assert.equal(G.targetDirection(code),dir);
 assert.equal(G.normalizeSettings({targetLang:'not a language',xTargetLang:'not a language',ytTargetLang:'auto'}).xTargetLang,'inherit');
});
test('all AI task prompts name the selected language and preserve explicit prompt overrides',async()=>{
 const e=await setup({}),G=e.ctx.GXT;
 for(const targetLang of ['fr','ja','ar','he','hi','pt-BR']){
  const name=G.targetName(targetLang),extra={targetLang};
  for(const id of ['tweet','image','summary','compose','dubCompress'])assert.ok(G.prompt.resolveSystem(id,extra).includes(name),id+targetLang);
  assert.ok(G.prompt.reviewSystem(extra).includes(name));
  for(const kind of ['page','selection','subtitle','youtube-manual'])assert.ok(G.prompt.buildGenericSystemPrompt(kind,G.prompt.nowContext(),extra).includes(name),kind);
  assert.equal(G.prompt.buildGenericSystemPrompt('page',null,{...extra,overrides:{generic:'MY CUSTOM PROMPT'}}),'MY CUSTOM PROMPT');
 }
});
test('X handles Persian and Japanese sources with a French destination and separate cache',async()=>{
 const e=await setup({xTargetLang:'fr'}),G=e.ctx.GXT;let calls=0;
 G.openai.translateBatch=async(group,cfg)=>{calls++;assert.equal(cfg.extra.targetLang,'fr');assert.ok(!cfg.extra.memory);return {map:new Map(group.map((_,i)=>[i,{t:'Bonjour',sl:'auto'}])),model:'model-a'};};
 const posts=[{...item('fa','یک جمله فارسی'),lang:'fa',contentId:'x:11111'},{...item('ja','日本語の文章'),lang:'ja',contentId:'x:22222'}];
 const a=await send(e,posts);assert.equal(a.results.fa.t,'Bonjour');assert.equal(a.results.ja.t,'Bonjour');
 await G.setSettings({uiLanguage:'fa'});await send(e,posts);assert.equal(calls,1);
 G.openai.translateBatch=async(group,cfg)=>{calls++;assert.equal(cfg.extra.targetLang,'ar');return {map:new Map(group.map((_,i)=>[i,{t:'مرحبا',sl:'auto'}])),model:'model-a'};};
 await G.setSettings({xTargetLang:'ar'});assert.equal((await send(e,posts)).results.fa.t,'مرحبا');assert.equal(calls,2);
});
test('page, selection, web video, file and YouTube route independent targets',async()=>{
 const e=await setup({targetLang:'de',pageTargetLang:'fr',webTargetLang:'ja',fileTargetLang:'ar',ytTargetLang:'hi'}),G=e.ctx.GXT;
 G.openai.translateTexts=async(texts,cfg)=>({list:texts.map(()=>cfg.extra.targetLang),model:'model-a'});
 for(const [request,want] of [[{kind:'page'},'fr'],[{kind:'selection'},'fr'],[{kind:'subtitle',source:'web-video'},'ja'],[{kind:'subtitle',source:'file'},'ar'],[{kind:'subtitle',source:'youtube'},'hi']]){
  const r=await e.ctx.auditHandlers.TRANSLATE_TEXTS({...request,texts:['متن آزمایشی / 日本語']});assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.list[0],want,JSON.stringify(request));
 }
});
test('summary, composer, review and dubbing preserve selected targets',async()=>{
 const e=await setup({summaryTargetLang:'ja',composeTargetLang:'ar',xTargetLang:'fr',webTargetLang:'de'}),G=e.ctx.GXT;
 for(const fn of ['summarize','composeEnglish','reviewText','compressForDub'])G.openai[fn]=async cfg=>({text:cfg.extra.targetLang,model:'model-a'});
 assert.equal((await e.ctx.auditHandlers.TRANSLATE_SUMMARY({text:'A passage'})).t,'ja');
 assert.equal((await e.ctx.auditHandlers.TRANSLATE_COMPOSE({text:'A draft'})).t,'ar');
 assert.equal((await e.ctx.auditHandlers.REVIEW_TEXT({text:'A translation',source:'A source'})).text,'fr');
 assert.equal((await e.ctx.auditHandlers.DUB_COMPRESS({text:'A long spoken line that exceeds the available character budget.',budget:10,targetLang:'he'})).t,'he');
});
test('workshop project target overrides file target without changing settings',async()=>{
 const e=await setup({fileTargetLang:'fr'}),G=e.ctx.GXT;let target;
 G.openai.translateWorkshop=async(payload,cfg)=>{target=cfg.extra.targetLang;return {entries:payload.cues.map(c=>({id:c.id,text:'結果'})),invalid:false};};
 const request={requestId:'target-1',projectId:'p',cues:[{id:'c1',text:'A sentence',start:0,end:1000}],contextBefore:[],contextAfter:[],rules:{glossary:[],characters:[],style:'natural'},translation:{targetLang:'ja'}};
 const r=await e.ctx.auditHandlers.TRANSLATE_WORKSHOP(request);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(target,'ja');assert.equal((await G.getSettings()).fileTargetLang,'fr');
});
test('scope A to B to A retires old in-flight X writes',async()=>{
 const e=await setup({xTargetLang:'fr'}),G=e.ctx.GXT,gates=[deferred(),deferred()];let calls=0;
 G.openai.translateBatch=async()=>{const n=calls++;await gates[n].promise;return {map:new Map([[0,{t:n?'NEW':'OLD',sl:'en'}]]),model:'model-a'};};
 const post={...item('a'),contentId:'x:333333'};const first=send(e,[post]);await until(()=>calls===1);
 await G.setSettings({xTargetLang:'ja'});await G.setSettings({xTargetLang:'fr'});
 const second=send(e,[post]);await until(()=>calls===2);gates[1].resolve();await second;gates[0].resolve();await first;
 assert.equal((await send(e,[post])).results.a.t,'NEW');assert.equal(calls,2);
});
test('bridge manga requests carry explicit destination while UI locale stays separate',async()=>{
 const e=await setup({mangaTargetLang:'ja',bridgeEnabled:true,bridgeToken:'TEST_ONLY_TOKEN'}),G=e.ctx.GXT,seen=[];
 e.ctx.fetch=async(url,opts)=>{seen.push(JSON.parse(opts.body));return new Response(JSON.stringify({ok:true,job:'fixture'}),{headers:{'content-type':'application/json'}});};
 const s=await G.getSettings();await G.bridge.manga(s,{image:'fixture',name:'fixture.png'});await G.bridge.mangaStart(s,{pages:[],concurrency:2});
 assert.equal(seen.length,2);for(const body of seen){assert.equal(body.targetLang,'ja');assert.equal(body.direction,'ltr');}
});
test('image target reaches its own provider and classic MT uses automatic source detection',async()=>{
 const e=await setup({imageTargetLang:'ja'}),G=e.ctx.GXT;
 e.ctx.fetch=async()=>new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png'}});
 G.openai.translateImage=async cfg=>{assert.equal(cfg.extra.targetLang,'ja');return {text:'画像の翻訳',model:'model-a'};};
 assert.equal((await e.ctx.auditHandlers.TRANSLATE_IMAGE({url:'https://fixture.example/image.png'})).t,'画像の翻訳');
 e.ctx.fetch=async url=>{const u=new URL(url);assert.equal(u.searchParams.get('sl'),'auto');assert.equal(u.searchParams.get('tl'),'ja');return new Response(JSON.stringify([[['訳文','source']],null,'fa']));};
 assert.equal((await G.mt.translateTexts(['متن فارسی'],{engine:'google',targetLang:'ja'})).list[0],'訳文');
});
(async()=>{let failed=0;for(const {name,run}of tests){try{await run();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}console.log(`${tests.length-failed}/${tests.length} target language regressions`);process.exitCode=failed?1:0;})();
