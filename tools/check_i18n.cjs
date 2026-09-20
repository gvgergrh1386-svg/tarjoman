'use strict';
// Syntax-aware release guard. Exceptions identify exact text, never whole files.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),acorn=require('acorn'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const catalogs=Object.fromEntries(['fa','en'].map(l=>[l,JSON.parse(read(`locales/${l}.json`))]));
assert.deepEqual(Object.keys(catalogs.fa).sort(),Object.keys(catalogs.en).sort(),'catalog keys differ');
const fields=s=>[...new Set(String(s).match(/\{[A-Za-z]\w*\}/g)||[])].sort();
for(const key of Object.keys(catalogs.en))assert.deepEqual(fields(catalogs.fa[key]),fields(catalogs.en[key]),key);
const allowed=JSON.parse(read('tools/i18n-literals.json')),seen=new Set(),errors=[];
const fingerprint=(file,value)=>file+':'+crypto.createHash('sha256').update(value).digest('hex');
function walk(n,parents,file){
  if(!n||typeof n!=='object')return;
  let value=n.type==='Literal'&&typeof n.value==='string'?n.value:n.type==='TemplateLiteral'?n.quasis.map((q,i)=>(q.value.cooked||'')+(i<n.expressions.length?`{v${i}}`:'')).join(''):null;
  const p=parents.at(-1);
  if(value!==null){
    // CSS comments are source prose, not rendered labels. CSS content remains checked.
    if(n.type==='TemplateLiteral'&&/\{[^}]*[a-z-]+\s*:/i.test(value)&&value.includes(':host'))value=value.replace(/\/\*[\s\S]*?\*\//g,'');
    const uiSink=p?.type==='AssignmentExpression'&&['textContent','innerText','title','placeholder','ariaLabel'].includes(p.left?.property?.name);
    const uiProperty=p?.type==='Property'&&['label','title','placeholder','description','error','hint','note'].includes(p.key?.name);
    if(/[\u0600-\u06ff]/u.test(value)||((uiSink||uiProperty)&&/[A-Za-z]{3}/.test(value))){
      const id=fingerprint(file,value);seen.add(id);if(!allowed[id])errors.push(`${file}:${n.loc.start.line}: unreviewed UI literal ${value.slice(0,70)}`);
    }
  }
  if(n.type==='CallExpression'&&n.callee?.property?.name==='t'&&n.arguments?.[0]?.type==='Literal'){
    const key=n.arguments[0].value;if(typeof key==='string'&&!Object.hasOwn(catalogs.en,key))errors.push(`${file}:${n.loc.start.line}: missing key ${key}`);
  }
  for(const [k,v]of Object.entries(n)){if(['loc','start','end'].includes(k))continue;if(Array.isArray(v))for(const c of v)walk(c,[...parents,n],file);else if(v&&typeof v==='object')walk(v,[...parents,n],file);}
}
for(const folder of ['background','content','shared','popup','pages'])for(const name of fs.readdirSync(path.join(root,folder))){
  if(!name.endsWith('.js')||(folder==='shared'&&name==='settings.js'))continue;
  const file=folder+'/'+name;walk(acorn.parse(read(file),{ecmaVersion:'latest',locations:true}),[],file);
}
for(const file of ['popup/popup.html','pages/subtitles.html']){
  const source=read(file).replace(/<!--[\s\S]*?-->/g,'');
  for(const m of source.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g))if(!catalogs.en[m[1]])errors.push(file+': missing '+m[1]);
  // Every Persian fallback text node must live inside an explicitly marked element.
  for(const m of source.matchAll(/<([\w-]+)([^>]*)>([^<]*[\u0600-\u06ff][^<]*)</g))if(!/data-i18n=/.test(m[2]))errors.push(file+': unmarked text '+m[3].slice(0,70));
}
for(const [id,record]of Object.entries(allowed))if(!record.reason)errors.push('Missing exception reason: '+id);
if(errors.length){console.error(errors.join('\n'));process.exit(1);}
console.log(`PASS i18n static guard: ${Object.keys(catalogs.en).length} paired messages; ${seen.size} reviewed literal exceptions`);
