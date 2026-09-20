'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const tests=[],test=(name,fn)=>tests.push({name,fn});
function environment(seed={},languages=['en-US']) {
  const data=structuredClone(seed),listeners=[];
  const local={get:async keys=>Object.fromEntries((keys==null?Object.keys(data):Array.isArray(keys)?keys:[keys]).filter(k=>k in data).map(k=>[k,structuredClone(data[k])])),set:async patch=>{
    const changes={};for(const [k,v] of Object.entries(patch)){changes[k]={oldValue:data[k],newValue:structuredClone(v)};data[k]=structuredClone(v);}for(const fn of listeners)fn(changes,'local');
  },remove:async key=>{delete data[key];}};
  const ctx=vm.createContext({console,Intl,Date,URL,TextEncoder,TextDecoder,setTimeout,clearTimeout,navigator:{languages,language:languages[0]},chrome:{storage:{local,onChanged:{addListener:fn=>listeners.push(fn)}},runtime:{getManifest:()=>({version:'3.7.7'})}}});
  vm.runInContext(read('shared/settings.js'),ctx);return {G:ctx.GXT,data,ctx};
}
const plain=v=>JSON.parse(JSON.stringify(v));
test('fresh browser language: Persian, English, manual priority and unsupported fallback',async()=>{
  for(const [languages,want] of [[['fa-IR'],'fa'],[['en-US'],'en'],[['de-DE','fa'],'fa'],[['fr-FR'],'en']]){
    const {G}=environment({},languages);const s=await G.getSettings();assert.equal(s.uiLanguage,'auto');assert.equal(s.targetLang,'fa');assert.equal(G.i18n.language(),'en'===want?'en':'fa');
    G.i18n.configure({...s,uiLanguage:'en'});assert.equal(G.i18n.language(),'en');G.i18n.configure({...s,uiLanguage:'fa'});assert.equal(G.i18n.direction(),'rtl');
  }
});
test('legacy migration preserves every unrelated setting and storage record',async()=>{
  const old={uiTheme:'paper',uiAccent:'rose',ttsModel:'fixture-model',ytPosX:27,ytPosY:18,webVideoCaptionPosition:{x:23,y:46,manual:true},customPrompt:'keep',unknownFutureSetting:17};
  const seed={settings:old,apiKeys:['TEST_ONLY_KEY'],openaiApiKey:'TEST_ONLY_OPENAI',transMemory:{terms:{moon:{s:'Moon',t:'ماه'}}},projectFixture:{id:'test-only'}};
  const {G,data}=environment(seed);const s=await G.getSettings();for(const [k,v] of Object.entries(old))assert.deepEqual(plain(s[k]),v);
  assert.equal(s.uiLanguage,'fa');assert.equal(s.calendar,'persian');assert.equal(s.numberingSystem,'arabext');assert.equal(s.timeZone,'Asia/Tehran');assert.deepEqual(data,seed,'read must not mutate storage');
  await G.migrateLocaleInstall('update');assert.equal(data.settings.localeVersion,1);for(const k of Object.keys(seed).filter(k=>k!=='settings'))assert.deepEqual(data[k],seed[k]);
  const migrated=structuredClone(data);await G.migrateLocaleInstall('update');assert.deepEqual(data,migrated);
});
test('upgrade with keys but no settings remains Persian; fresh install stays automatic',async()=>{
  const old=environment({apiKeys:['TEST_ONLY_KEY']});await old.G.migrateLocaleInstall('update');assert.equal((await old.G.getSettings()).uiLanguage,'fa');
  const fresh=environment();await fresh.G.migrateLocaleInstall('install');assert.equal((await fresh.G.getSettings()).uiLanguage,'auto');
});
test('parallel migration and setting writes keep both values',async()=>{
  const {G}=environment({settings:{uiTheme:'paper'}});await Promise.all([G.migrateLocaleInstall('update'),G.setSettings({ttsRate:1.4}),G.setSettings({uiAccent:'rose'})]);const s=await G.getSettings();assert.equal(s.uiLanguage,'fa');assert.equal(s.ttsRate,1.4);assert.equal(s.uiAccent,'rose');
});
test('manual selection and locale survive restart and backup round trip',async()=>{
  const {G,data}=environment();await G.setSettings({uiLanguage:'en',targetLang:'fa',regionLocale:'fa-IR',calendar:'persian',bridgeToken:'TEST_ONLY_TOKEN'});
  assert.equal((await environment(data,['fa']).G.getSettings()).uiLanguage,'en');
  const backup=await G.exportBackup();assert.equal(backup.settings.localeVersion,1);assert.equal(backup.settings.bridgeToken,undefined);
  const dest=environment();await dest.G.importBackup(backup,{mode:'replace'});assert.equal((await dest.G.getSettings()).uiLanguage,'en');assert.equal((await dest.G.getSettings()).regionLocale,'fa-IR');
  const fresh=environment();const auto=await fresh.G.exportBackup();await dest.G.importBackup(auto,{mode:'replace'});assert.equal((await dest.G.getSettings()).uiLanguage,'auto');
});
test('UI and region never change existing translation cache namespace or provider model',async()=>{
  const {G}=environment({settings:{provider:'gemini',model:'original-model',customPrompt:'keep'}});const s=await G.getSettings(),before=G.cacheNamespace(s);
  assert.equal(before,G.cacheNamespace({...s,uiLanguage:'en',calendar:'gregory',timeZone:'UTC',regionLocale:'en-US',numberingSystem:'latn'}));
  assert.notEqual(before,G.cacheNamespace({...s,targetLang:'en'}));assert.notEqual(before,G.cacheNamespace({...s,translationRegion:'source'}));
  const {G:baseline}=environment();const oldctx=vm.createContext({chrome:{storage:{local:{get:async()=>({})}}},Intl,console});
  assert.equal(G.cacheNamespace({...G.DEFAULTS,targetLang:'fa'}),G.modelCacheId(G.DEFAULTS));assert.equal(baseline.DEFAULTS.model,G.DEFAULTS.model);
});
test('regional numbers, calendar, time, relative time and week start are independent of UI',()=>{
  const {G}=environment();const f=G.i18n,instant='2024-03-20T00:00:00Z';
  f.configure({uiLanguage:'en',regionLocale:'fa-IR',calendar:'persian',numberingSystem:'arabext',hourCycle:'h23',timeZone:'Asia/Tehran',weekStart:'sat'});
  assert.match(f.number(1234.5),/[۰-۹]/);assert.match(f.date(instant),/۱۴۰۳/);assert.match(f.time(instant),/۰۳:۳۰/);assert.equal(f.weekStart(),'sat');assert.ok(f.relative(-1,'day'));
  f.configure({uiLanguage:'fa',regionLocale:'en-US',calendar:'gregory',numberingSystem:'latn',hourCycle:'h12',timeZone:'UTC',weekStart:'auto'});
  assert.equal(f.number(1234.5),'1,234.5');assert.match(f.date(instant),/2024/);assert.match(f.time(instant),/AM/);assert.equal(f.relative(-1,'day'),'yesterday');assert.equal(f.weekStart(),'sun');assert.equal(f.direction(),'rtl');
  assert.equal(G.isSettingValue('timeZone','Mars/Invalid'),false);assert.equal(G.isSettingValue('uiLanguage','xx'),false);assert.equal(G.isSettingValue('timeZone','UTC'),true);
});
test('catalog parity, placeholders and trusted HTML structure are identical',()=>{
  const fa=JSON.parse(read('locales/fa.json')),en=JSON.parse(read('locales/en.json'));
  assert.deepEqual(Object.keys(fa).sort(),Object.keys(en).sort());assert.ok(Object.keys(en).length>1400);
  const fields=s=>[...new Set(String(s).match(/\{[A-Za-z]\w*\}/g)||[])].sort();
  const tags=s=>(String(s).match(/<\/?[a-zA-Z][^>]*>/g)||[]).map(t=>t.replace(/(title|placeholder|aria-label)="[^"]*"/g,'$1=""')).sort();
  for(const k of Object.keys(fa)){assert.ok(en[k],k);assert.deepEqual(fields(en[k]),fields(fa[k]),k);assert.deepEqual(tags(en[k]),tags(fa[k]),k);}
  for(const lang of ['fa','en'])assert.ok(JSON.parse(read(`_locales/${lang}/messages.json`)).extensionName.message);
  const bridge=JSON.parse(read('bridge/messages.json'));for(const [k,v] of Object.entries(bridge)){assert.ok(v.fa&&v.en,k);assert.deepEqual(fields(v.fa),fields(v.en),k);}
});
test('missing keys fail loudly; plurals, substitution and escaped HTML are safe',()=>{
  const {G}=environment();G.catalogs.en.test_plural={one:'{count} file',other:'{count} files'};G.catalogs.fa.test_plural={one:'{count} پرونده',other:'{count} پرونده'};
  G.i18n.configure({uiLanguage:'en'});assert.equal(G.i18n.t('test_plural',{count:2}),'2 files');assert.equal(G.i18n.t('test_plural',{count:1}),'1 file');assert.throws(()=>G.i18n.t('test_missing'));
  G.catalogs.en.test_escape='Value: {value}';assert.equal(G.i18n.html('test_escape',{value:'<img src=x onerror="x">'}),'Value: &lt;img src=x onerror=&quot;x&quot;&gt;');
});
test('hot UI bindings update labels but never overwrite a user edit or detached node',()=>{
  const {G}=environment(),el={textContent:'',isConnected:true};const key='shared_settings_REGISTERS_1';G.i18n.configure({uiLanguage:'fa'});G.i18n.bind(el,'textContent',()=>G.i18n.t(key));assert.equal(el.textContent,G.catalogs.fa[key]);G.i18n.configure({uiLanguage:'en'});assert.equal(el.textContent,G.catalogs.en[key]);
  el.textContent='USER EDIT';G.i18n.configure({uiLanguage:'fa'});assert.equal(el.textContent,'USER EDIT');
  const detached={textContent:'',isConnected:true};G.i18n.bind(detached,'textContent',()=>G.i18n.t(key));detached.isConnected=false;G.i18n.configure({uiLanguage:'en'});assert.equal(detached.textContent,G.catalogs.fa[key]);
});
test('English content prompts stay English with Persian UI, Persian prompts retain Iran behavior',()=>{
  const {G,ctx}=environment();vm.runInContext(read('background/prompt.js'),ctx);G.i18n.configure({uiLanguage:'fa'});
  const en=G.prompt.buildGenericSystemPrompt('page',G.prompt.nowContext(),{targetLang:'en'});assert.match(en,/English/);assert.doesNotMatch(en,/into Persian/i);
  const fa=G.prompt.buildGenericSystemPrompt('page',G.prompt.nowContext(),null);G.i18n.configure({uiLanguage:'en'});assert.equal(G.prompt.buildGenericSystemPrompt('page',G.prompt.nowContext(),null),fa);assert.match(fa,/Persian/);
});
test('worker preserves content cache across UI switches and isolates explicit targets',async()=>{
  const {worker}=require('./fixtures-376.cjs');const e=await worker({settings:{localeVersion:1,uiLanguage:'fa',targetLang:'en',provider:'openai',openaiBaseUrl:'https://fixture.example/v1',openaiModel:'test-model',qualityMode:false,memoryEnabled:true},transMemory:{terms:{nasa:{s:'NASA',t:'ناسا',n:3,pinned:true}},count:1}});
  const initialMemory=JSON.stringify(e.state.transMemory);let calls=0;
  e.ctx.GXT.openai.translateTexts=async(texts,cfg)=>{calls++;if(cfg.extra?.targetLang==='en'){assert.ok(!cfg.extra.memory);return {list:texts.map(()=> 'English result NASA'),model:'test-model'};}return {list:texts.map(()=> 'نتیجهٔ فارسی ناسا'),model:'test-model'};};
  const request={texts:['NASA source text.'],kind:'page'};
  assert.equal((await e.ctx.auditHandlers.TRANSLATE_TEXTS(request)).list[0],'English result NASA');
  await e.ctx.GXT.setSettings({uiLanguage:'en',regionLocale:'en-US'});assert.equal((await e.ctx.auditHandlers.TRANSLATE_TEXTS(request)).list[0],'English result NASA');assert.equal(calls,1);assert.equal(JSON.stringify(e.state.transMemory),initialMemory);
  await e.ctx.GXT.setSettings({targetLang:'fa'});assert.equal((await e.ctx.auditHandlers.TRANSLATE_TEXTS(request)).list[0],'نتیجهٔ فارسی ناسا');assert.equal(calls,2);
});
(async()=>{let failed=0;for(const {name,fn} of tests){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}console.log(`${tests.length-failed}/${tests.length} i18n regressions`);process.exitCode=failed?1:0;})();
