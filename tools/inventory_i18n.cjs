// Developer inventory: syntax-aware; never edits content translation prompts.
const fs = require('node:fs'), path = require('node:path'), acorn = require('acorn');
const root = path.resolve(__dirname, '..');
const out = [];
function walk(node, parents, file, source) {
  if (!node || typeof node !== 'object') return;
  const parent = parents.at(-1);
  if (node.type === 'Literal' && typeof node.value === 'string' && /[\u0600-\u06ff]/u.test(node.value)) {
    out.push({file, line:node.loc.start.line, start:node.start,end:node.end,type:'literal',value:node.value,
      context:parents.slice(-4).map(n=> n.id?.name || n.key?.name || n.type).join('.'), parent:parent?.type});
  }
  if (node.type === 'TemplateLiteral' && node.quasis.some(n=>/[\u0600-\u06ff]/u.test(n.value.cooked || ''))) {
    out.push({file,line:node.loc.start.line,start:node.start,end:node.end,type:'template',
      value:node.quasis.map((q,i)=>(q.value.cooked || '')+(i<node.expressions.length?`{v${i}}`:'')).join(''),
      context:parents.slice(-4).map(n=>n.id?.name || n.key?.name || n.type).join('.'),
      expressions:node.expressions.map(n=>({start:n.start,end:n.end,source:source.slice(n.start,n.end)}))});
  }
  for (const [k,v] of Object.entries(node)) {
    if (['start','end','loc'].includes(k)) continue;
    if(Array.isArray(v)) for(const n of v) walk(n,[...parents,node],file,source);
    else if(v && typeof v==='object') walk(v,[...parents,node],file,source);
  }
}
for(const folder of ['shared','content','background','popup','pages']) for(const name of fs.readdirSync(path.join(root,folder))) {
  if(!name.endsWith('.js'))continue;
  if(folder==='shared'&&name==='settings.js')continue; // generated catalog bundle
  const file=`${folder}/${name}`,source=fs.readFileSync(path.join(root,file),'utf8');
  walk(acorn.parse(source,{ecmaVersion:'latest',locations:true}),[],file,source);
}
fs.mkdirSync(path.join(root,'.audit/3.7.7'),{recursive:true});
fs.writeFileSync(path.join(root,'.audit/3.7.7/string-inventory.json'),JSON.stringify(out,null,2));
console.log(JSON.stringify(Object.fromEntries([...new Set(out.map(x=>x.file))].map(f=>[f,out.filter(x=>x.file===f).length])),null,2));
