const fs=require('node:fs');
const path=require('node:path');
const root=__dirname;
fs.mkdirSync(path.join(root,'dist'),{recursive:true});
const core=fs.readFileSync(path.join(root,'core.js'),'utf8');
const main=fs.readFileSync(path.join(root,'main.js'),'utf8').replace("require('./core')",`(()=>{const module={exports:{}};\n${core}\nreturn module.exports;})()`);
fs.writeFileSync(path.join(root,'dist/main.js'),main);
for(const f of ['manifest.json','styles.css'])fs.copyFileSync(path.join(root,f),path.join(root,'dist',f));
console.log('Build completo: dist/main.js, manifest.json, styles.css');
