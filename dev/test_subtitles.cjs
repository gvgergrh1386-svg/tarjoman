// Behavioral regressions; optional source root enables before/after evidence.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const ctx = vm.createContext({ TextDecoder, Uint8Array });
vm.runInContext(fs.readFileSync(path.join(root, 'shared/subtitles.js'), 'utf8'), ctx);
const S = ctx.GXT.subs;
let passed = 0, total = 0;
function check(name, fn) { total++; try { fn(); passed++; console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.message); } }
const cues = [{start:10000,end:12000,text:'late.'},{start:0,end:2000,text:'early.'}];
check('unsorted source cues are spoken in chronological order', () => {
  const before = JSON.stringify(cues);
  assert.equal(S.toSpeechSegments(cues)[0].text, 'early.');
  assert.equal(JSON.stringify(cues), before);
});
check('overlapping cues remain separate when merge is disabled', () => {
  assert.equal(S.toSpeechSegments([{start:0,end:5000,text:'first'},{start:1000,end:2000,text:'second'}], {maxGapMs:-1}).length, 2);
});
check('different simultaneous speakers are not concatenated', () => {
  assert.equal(S.toSpeechSegments([{start:0,end:5000,text:'hello',actor:'Alice'},{start:5000,end:6000,text:'hi',actor:'Bob'}]).length, 2);
});
check('ASS comments and drawings are not spoken', () => {
  const result=S.toSpeechSegments([{start:0,end:1000,text:'private editor note',kind:'Comment'},{start:0,end:1000,text:'{\\p1}m 0 0 l 9 9',kind:'Dialogue'},{start:1000,end:2000,text:'speech',kind:'Dialogue'}]);
  assert.equal(result.length,1); assert.equal(result[0].text,'speech');
});
check('invalid and infinite speech intervals cannot create audio allocations', () => {
  assert.equal(S.toSpeechSegments([{start:2,end:1,text:'reverse'},{start:-1,end:4,text:'negative'},{start:0,end:Infinity,text:'infinite'},{start:0,end:NaN,text:'nan'}]).length,0);
});
check('timestamp parser rejects overflow and malformed numeric components', () => {
  for (const value of ['9'.repeat(310)+':00:00.000','00:61:00.000','00:00:99.000','-01:00:00.000','junk00:00:01.000']) assert.equal(S._internal.parseTime(value),null,value.slice(0,40));
});
check('500 seeded timestamp round trips preserve milliseconds', () => {
  let seed=370;
  for(let i=0;i<500;i++){ seed=(Math.imul(seed,1664525)+1013904223)>>>0;const n=seed%360000000;assert.equal(S._internal.parseTime(S._internal.formatTime(n,'srt')),n); }
});
check('500 seeded permutations preserve every independently spoken cue', () => {
  let seed=37;
  for(let i=0;i<500;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const a=seed%9000;const input=[{start:a,end:a+100,text:'a'},{start:0,end:15000,text:'b'},{start:20000,end:21000,text:'c'}];const result=S.toSpeechSegments(input,{maxGapMs:-1});assert.equal(result.length,3);assert.ok(result.every((s,j)=>j===0||s.start>=result[j-1].start));assert.equal(result.map(s=>s.text).sort().join(','),'a,b,c');}
});
console.log(`SUBTITLE-REGRESSION SUMMARY ${passed}/${total}`);
process.exitCode = passed === total ? 0 : 1;
