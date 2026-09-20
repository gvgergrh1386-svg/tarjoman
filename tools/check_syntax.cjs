const fs=require('node:fs'),path=require('node:path'),acorn=require('acorn');
const root=path.resolve(__dirname,'..'),list=JSON.parse(fs.readFileSync(path.join(root,'tools/public-files.json'),'utf8')).source;let count=0;
for(const name of list){const s=fs.readFileSync(path.join(root,name),'utf8');if(/\.(?:js|cjs)$/.test(name)){acorn.parse(s,{ecmaVersion:'latest',allowHashBang:true});count++;}else if(name.endsWith('.html'))for(const m of s.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){if(/\bsrc\s*=/.test(m[1])||/application\/json/.test(m[1]))continue;try{acorn.parse(m[2],{ecmaVersion:'latest'});count++;}catch(e){throw new Error(name+': '+e.message);}}}
console.log('PASS syntax: '+count+' JavaScript sources/inline scripts');
