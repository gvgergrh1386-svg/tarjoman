// 3.7.5 workbench contracts. Optional source root supports immutable before/after runs.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
const ctx=vm.createContext({TextDecoder,Uint8Array,Map,Set,Date,Math,Promise,setTimeout,clearTimeout});
for(const file of ['shared/settings.js','shared/subtitles.js','shared/workshop.js']) if(fs.existsSync(path.join(root,file))) vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx);
const S=ctx.GXT.subs,W=ctx.GXT.workshop;
let pass=0,total=0;
async function test(name,fn){total++;try{await fn();pass++;console.log('PASS '+name);}catch(e){console.log('FAIL '+name+': '+e.message);}}
const plain=v=>JSON.parse(JSON.stringify(v));
const makeDoc=(texts)=>({format:'srt',cues:texts.map((text,i)=>({id:String(i+1),text,start:i*2200,end:i*2200+2000}))});
const turn=()=>new Promise(r=>setTimeout(r,0));
(async()=>{
await test('WebVTT header NOTE STYLE REGION identifier and cue settings survive translation',()=>{
 const source='WEBVTT - demo\nLanguage: en\n\nSTYLE\n::cue { color: lime; }\n\nREGION\nid:r\nwidth:40%\n\nNOTE editor note\nprivate\n\nintro\n00:00:00.000 --> 00:00:02.000 align:start region:r\nHello\n';
 const doc=S.parse(source,'a.vtt'),items=S.collectTranslatable(doc).items;
 const out=S.build(doc,items,['سلام'],{rtl:false}).text;
 for(const piece of ['WEBVTT - demo','Language: en','STYLE\n::cue','REGION\nid:r','NOTE editor note\nprivate','intro\n00:00','align:start region:r'])assert.ok(out.includes(piece),piece);
});
await test('case insensitive ASS comments are excluded from translation',()=>{
 const doc=S.parse('[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\ncomment: 0,0:00:00.00,0:00:01.00,Default,Alice,0,0,0,,Editor secret\n','a.ass');
 assert.equal(S.collectTranslatable(doc).items.length,0);
});
await test('malformed formatting tokens keep original cue instead of losing override tags',()=>{
 const doc=makeDoc(['<i>Hello</i>']);const items=S.collectTranslatable(doc).items;
 assert.ok(S.build(doc,items,['سلام'],{rtl:false}).text.includes('<i>Hello</i>'));
});
await test('a sentence broken across three cues remains one adaptive chunk',()=>{
 const p=W.createProject(makeDoc(['When I said','that I needed','your help.','Next sentence.']),'x');
 const chunks=W.planChunks(p.rows,{targetChars:12,maxChars:1000,minRows:1,maxRows:60});
 assert.deepEqual(plain(chunks[0].ids),plain(p.rows.slice(0,3).map(r=>r.id)));
});
await test('scene gaps and speaker changes produce boundaries with ordered IDs',()=>{
 const d=makeDoc(['One.','Two.','Three.']);d.cues[0].actor='Alice';d.cues[1].actor='Bob';d.cues[2].start=20000;d.cues[2].end=23000;
 const p=W.createProject(d,'x'),chunks=W.planChunks(p.rows,{minRows:1});
 assert.equal(chunks.length,3);assert.deepEqual(plain(chunks.flatMap(c=>c.ids)),plain(p.rows.map(r=>r.id)));
});
await test('stable IDs distinguish duplicate source identifiers and texts',()=>{
 const d=makeDoc(['Hello','Hello']);d.cues[0].id='same';d.cues[1].id='same';
 const a=W.createProject(d,'a'),b=W.createProject(d,'a');assert.notEqual(a.rows[0].id,a.rows[1].id);assert.deepEqual(plain(a.rows.map(r=>r.id)),plain(b.rows.map(r=>r.id)));
});
await test('response validation rejects duplicates foreign IDs missing text and lost tokens independently',()=>{
 const p=W.createProject(makeDoc(['<i>A</i>','B','C','D']),'a');
 const ids=p.rows.map(r=>r.id);const v=W.validateEntries(p.rows,[{id:ids[0],text:'الف'},{id:ids[1],text:'ب'},{id:ids[1],text:'دوباره'},{id:ids[2],text:'ج'},{id:'other',text:'x'}]);
 assert.equal(v.accepted.size,1);assert.equal(v.accepted.get(ids[2]),'ج');assert.equal(v.invalid.length,3);assert.equal(v.unexpected,1);
});
await test('partial model response repairs only defective IDs with successful translation context',async()=>{
 const p=W.createProject(makeDoc(['First part','continued.','Third.']),'a'),s=new W.Session(p),calls=[];
 await s.run(async m=>{calls.push(m);return {ok:true,entries:m.cues.slice(0,calls.length===1?2:99).map(c=>({id:c.id,text:'ترجمه'}))};});
 assert.equal(calls.length,2);assert.equal(calls[1].cues.length,1);assert.equal(calls[1].cues[0].id,p.rows[2].id);assert.equal(calls[1].repair,true);assert.ok(calls[1].contextBefore.some(c=>c.translated==='ترجمه'));assert.ok(p.rows.every(r=>r.translation==='ترجمه'));
});
await test('next batch carries bounded previous source AND translated context',async()=>{
 const p=W.createProject(makeDoc(['One.','Two.','Three.']),'a'),s=new W.Session(p),calls=[];
 await s.run(async m=>{calls.push(m);return {ok:true,entries:m.cues.map(c=>({id:c.id,text:'ترجمه '+c.text}))};},{chunkOptions:{targetChars:1,minRows:1,maxRows:1}});
 assert.equal(calls.length,3);assert.equal(calls[1].contextBefore[0].text,'One.');assert.equal(calls[1].contextBefore[0].translated,'ترجمه One.');
});
await test('manual locked edit wins over a pending successful model response',async()=>{
 const p=W.createProject(makeDoc(['Hello.']),'a'),s=new W.Session(p);let resolve;
 const pending=s.run(m=>new Promise(r=>{resolve=()=>r({ok:true,entries:m.cues.map(c=>({id:c.id,text:'قدیمی'}))});}));await turn();
 W.edit(p,p.rows[0].id,'ویرایش دستی');resolve();await pending;assert.equal(p.rows[0].translation,'ویرایش دستی');assert.equal(p.rows[0].locked,true);
});
await test('5000-cue cancellation resolves promptly aborts transport ignores late output and resumes',async()=>{
 const p=W.createProject(makeDoc(Array.from({length:5000},(_,i)=>'Sentence '+i+'.')),'a'),s=new W.Session(p);let resolve;const aborted=[];
 const run=s.run(m=>new Promise(r=>{resolve=()=>r({ok:true,entries:m.cues.map(c=>({id:c.id,text:'کهنه'}))});}),{cancel:id=>aborted.push(id)});await turn();s.cancel();
 await Promise.race([run,new Promise((_,reject)=>setTimeout(()=>reject(Error('cancel hung')),100))]);assert.equal(aborted.length,1);
 const second=s.run(async m=>({ok:true,entries:m.cues.map(c=>({id:c.id,text:'تازه'}))}));resolve();await second;assert.ok(p.rows.every(r=>r.translation==='تازه'));
});
await test('glossary character names and register are included in the scoped request',async()=>{
 const p=W.createProject(makeDoc(['Alice uses API.']),'a');p.rules={glossary:W.parseRules('API = رابط'),characters:W.parseRules('Alice = آلیس'),style:'formal',instructions:''};let msg;
 await new W.Session(p).run(async m=>{msg=m;return {ok:true,entries:[{id:m.cues[0].id,text:'آلیس از رابط استفاده می‌کند.'}]};});
 assert.equal(msg.rules.glossary[0].target,'رابط');assert.equal(msg.rules.characters[0].target,'آلیس');assert.equal(msg.rules.style,'formal');
});
await test('QA identifies duration reading speed missing terms unchanged and invalid formatting',()=>{
 const p=W.createProject(makeDoc(['API','Other.']),'a');p.rules.glossary=W.parseRules('API = رابط');p.rows[0].translation='a'.repeat(100);p.rows[1].translation='Other.';
 const first=W.qa(p.rows[0],p.rules);assert.ok(first.includes('reading-speed'));assert.ok(first.includes('glossary'));assert.ok(W.qa(p.rows[1],p.rules).includes('unchanged'));
});
await test('search replace respects locks is literal and undo restores all affected values',()=>{
 const p=W.createProject(makeDoc(['A','B']),'a');p.rows.forEach(r=>r.translation='x.y');W.edit(p,p.rows[0].id,'locked x.y');
 assert.equal(W.replace(p,'x.','z.'),1);assert.equal(p.rows[0].translation,'locked x.y');assert.equal(p.rows[1].translation,'z.y');W.undo(p);assert.equal(p.rows[1].translation,'x.y');
});
await test('snapshots restore exact manual revisions and reject different source documents',()=>{
 const p=W.createProject(makeDoc(['Hello.']),'a');W.edit(p,p.rows[0].id,'دستی');const snap=W.snapshot(p);const restored=W.restore(snap);
 assert.equal(restored.rows[0].translation,'دستی');assert.equal(restored.rows[0].locked,true);snap.rows[0].id='wrong';assert.throws(()=>W.restore(snap));
});
await test('ASS dialogue preserves layer style speaker timing Comment drawing and tags',()=>{
 const source='[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nComment: 1,0:00:00.00,0:00:02.00,Sign,Editor,0,0,0,,Note\nDialogue: 2,0:00:00.00,0:00:02.00,Sign,,0,0,0,,{\\p1}m 0 0 l 1 1\nDialogue: 3,0:00:02.00,0:00:04.00,Hero,Alice,0,0,0,,{\\i1}Hello{\\i0}';
 const d=S.parse(source),items=S.collectTranslatable(d).items;const out=S.build(d,items,['⟦0⟧سلام⟦1⟧'],{rtl:false}).text;
 assert.equal(out.split('\n')[2],source.split('\n')[2]);assert.equal(out.split('\n')[3],source.split('\n')[3]);assert.ok(out.includes('Dialogue: 3,0:00:02.00,0:00:04.00,Hero,Alice,0,0,0,,{\\i1}سلام{\\i0}'));
});
await test('cancelling synchronously does not dispatch transport after local retirement',async()=>{
 const p=W.createProject(makeDoc(['Hello.']),'a'),s=new W.Session(p);let sent=0;
 const run=s.run(async()=>{sent++;return {ok:false};});s.cancel();await run;assert.equal(sent,0);
});
await test('noncontiguous repair retains validated intervening dialogue as read-only context',async()=>{
 const p=W.createProject(makeDoc(['First','second','third.']),'a');const calls=[];
 await new W.Session(p).run(async m=>{calls.push(m);return {ok:true,entries:(calls.length===1?[m.cues[1]]:m.cues).map(c=>({id:c.id,text:'پاسخ'}))};});
 assert.equal(calls[1].cues.length,2);assert.ok([...calls[1].contextBefore,...calls[1].contextAfter].some(c=>c.id===p.rows[1].id&&c.translated==='پاسخ'));
});
await test('WebVTT inline timestamps are protected formatting and never spoken',()=>{
 const d=S.parse('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello <00:00:01.000>world\n','a.vtt');
 const items=S.collectTranslatable(d).items;assert.equal(items[0].tokens[0],'<00:00:01.000>');
 const out=S.build(d,items,['سلام ⟦0⟧دنیا'],{rtl:false}).text;assert.ok(out.includes('<00:00:01.000>'));
 assert.equal(S.toSpeechSegments(d.cues)[0].text,'Hello world');
});
console.log(`WORKSHOP-REGRESSION SUMMARY ${pass}/${total}`);process.exitCode=pass===total?0:1;
})();
