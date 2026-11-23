const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const core=require('./core');
test('mesmo trecho após zoom usa página e posição, distinguindo ocorrências repetidas',()=>{
  const make=(text,page,offset,w)=>({text,parts:[{page,offset,rects:[{x:.2,y:.3,w,h:.04}]}]});
  const saved=make('Outra palavra',1,12,.4);
  assert.ok(core.sameSelection(saved,make('Outra\npalavra',1,12,.42)));
  assert.ok(!core.sameSelection(saved,make('Outra palavra',1,40,.4)));
  assert.ok(!core.sameSelection(saved,make('Outra palavra',2,12,.4)));
});
const doc={schema:1,id:'abc',pdfPath:'Livros/Teste.pdf',notePath:null,highlights:[{id:'h1',text:'ὁ λόγος\nTexto com [[link]] e *aspas*.',color:'verde',created:'2026-11-09T12:00:00Z',parts:[{page:2,rects:[{x:.1,y:.1,w:.3,h:.03}]}]}]};
test('cinco cores distintas',()=>{assert.equal(new Set(core.COLORS.map(c=>c.hex)).size,5);});
test('rotação preserva posição após volta',()=>{for(const r of [0,90,180,270]){const a={x:.1,y:.2,w:.3,h:.04};const b=core.rotateRect(core.rotateRect(a,r),-r);for(const k of Object.keys(a))assert.ok(Math.abs(a[k]-b[k])<1e-10);}});
test('nota automática não altera comentários nem duplica trechos',()=>{const text=core.newNote(doc)+'\nComentário manual\n';const updated=core.updateNote(text,doc);assert.equal(updated,text);assert.equal(updated.match(/\^pdf-h1/g).length,1);assert.ok(updated.includes('ὁ λόγος'));assert.ok(updated.endsWith('Comentário manual\n'));});
test('bloco editado manualmente falha sem apagar conteúdo',()=>{assert.throws(()=>core.updateNote('Minha nota',doc));assert.throws(()=>core.updateNote(core.newNote(doc).replace(':end',':quebrado'),doc));});
test('nota fica ao lado do livro',()=>assert.equal(core.notePath('Atlas/Livros/Teste.PDF'),'Atlas/Livros/Teste — Marcações.md'));
function setup(requestUrl){
 class TFile{constructor(path){this.path=path;this.name=path.split('/').pop();this.extension=path.split('.').pop();}}
 const files=new Map(),texts=new Map();const api={Plugin:class{},Notice:class{},Modal:class{},PluginSettingTab:class{},Setting:class{},TFile,normalizePath:x=>x};
 api.requestUrl=requestUrl;
 const ctx={module:{exports:{}},require:id=>id==='obsidian'?api:core,console,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,URLSearchParams};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),ctx);
 const p=new ctx.module.exports();p.docs=new Map();p.sessions=new Map();p.writing=new Set();p.chain=Promise.resolve();
 const create=async(path,text)=>{if(files.has(path))throw Error('exists');const f=new TFile(path);files.set(path,f);texts.set(path,text);return f;};
 p.app={vault:{getFiles:()=>[...files.values()],getAbstractFileByPath:path=>files.get(path),create,createFolder:async path=>files.set(path,{path}),read:async f=>texts.get(f.path),process:async(f,fn)=>{texts.set(f.path,fn(texts.get(f.path)));}},fileManager:{renameFile:async(f,path)=>{files.delete(f.path);const text=texts.get(f.path);texts.delete(f.path);f.path=path;files.set(path,f);texts.set(path,text);}}};
 p.app.workspace={getLeavesOfType:()=>[]};return {p,files,texts,create};
}
test('tradução envia somente a seleção, reutiliza a consulta e permite repetir após falha',async()=>{
 const calls=[];
 const {p}=setup(async({url})=>{
   calls.push(new URL(url));
   if(calls.length===1)return {status:429,headers:{'Retry-After':'180'}};
   return {status:200,json:[[['livros '],['e línguas']]]};
 });
 p.translations=new Map();
 const source='books & languages';
 const before=Date.now();
 await assert.rejects(p.translate(source),error=>error.retryAt>=before+180000);
 await assert.rejects(p.translate('another word'),error=>error.retryAt===p.googleRetryAt);
 assert.equal(calls.length,1);
 p.googleRetryAt=Date.now()-1;
 const results=await Promise.all([p.translate(source),p.translate(source)]);
 assert.deepEqual(results,['livros e línguas','livros e línguas']);
 assert.equal(calls.length,2);
 assert.deepEqual(Object.fromEntries(calls[1].searchParams),{client:'gtx',sl:'auto',tl:'pt',dt:'t',q:source});
 p.googleRetryAt=Date.now()+60000;
 assert.equal(await p.translate(source),'livros e línguas');
 assert.equal(calls.length,2);
});
test('respeita data de nova tentativa e aumenta pausa quando o servidor omite o prazo',async()=>{
 const date=new Date(Date.now()+360000).toUTCString();
 const {p}=setup(async()=>({status:429,headers:{'retry-after':date}}));p.translations=new Map();
 await assert.rejects(p.translate('one'),error=>error.retryAt===Date.parse(date));
 const {p:limited}=setup(async()=>({status:429}));limited.translations=new Map();
 await assert.rejects(limited.translate('one'));
 assert.equal(limited.googleBackoff,60000);
 limited.googleRetryAt=0;
 await assert.rejects(limited.translate('two'));
 assert.equal(limited.googleBackoff,120000);
});
test('criação, repetição, cinco cores, remoção e reabertura do armazenamento',async()=>{
 const {p,create,files,texts}=setup();await create(doc.pdfPath,'pdf-original');
 const sel={text:doc.highlights[0].text,parts:doc.highlights[0].parts};
 await p.record(doc.pdfPath,sel,'amarelo');await p.record(doc.pdfPath,sel,'rosa');
 assert.equal(p.find(doc.pdfPath).highlights.length,1);assert.equal(p.find(doc.pdfPath).highlights[0].color,'rosa');
 for(const c of core.COLORS)await p.record(doc.pdfPath,{...sel,text:c.id},c.id);
 const record=p.find(doc.pdfPath);assert.equal(record.highlights.length,6);
 const note=record.notePath;texts.set(note,texts.get(note)+'\nMinha observação\n');
 const previous=record.highlights[0];
 await p.recolor(doc.pdfPath,previous.id,'roxo');
 p.docs.clear();await p.loadRecords();
 const edited=p.find(doc.pdfPath).highlights;
 assert.equal(edited.length,6);assert.equal(edited[0].id,previous.id);
 assert.equal(edited[0].text,previous.text);assert.equal(edited[0].color,'roxo');
 assert.ok(texts.get(note).includes('[!pdf-roxo]'));assert.ok(texts.get(note).endsWith('Minha observação\n'));
 await p.remove(doc.pdfPath,record.highlights[0].id);assert.equal(p.find(doc.pdfPath).highlights.length,5);assert.ok(texts.get(note).endsWith('Minha observação\n'));
 p.docs.clear();await p.loadRecords();assert.equal(p.find(doc.pdfPath).highlights.length,5);assert.equal(texts.get(doc.pdfPath),'pdf-original');
});
test('colisão de nome preserva nota existente e reutiliza nota própria',async()=>{
 const {p,create,texts}=setup();await create(doc.pdfPath,'pdf');await create(core.notePath(doc.pdfPath),'nota anterior');
 await p.record(doc.pdfPath,{text:'nova',parts:doc.highlights[0].parts},'azul');const path=p.find(doc.pdfPath).notePath;
 assert.equal(path,'Livros/Teste — Marcações (2).md');assert.equal(texts.get(core.notePath(doc.pdfPath)),'nota anterior');
 await p.record(doc.pdfPath,{text:'segunda',parts:doc.highlights[0].parts},'verde');assert.equal(p.find(doc.pdfPath).notePath,path);
});
test('falha na nota mantém marcação e permite recuperação sem sobrescrever',async()=>{
 const {p,create,texts}=setup();await create(doc.pdfPath,'pdf');await p.record(doc.pdfPath,{text:'um',parts:doc.highlights[0].parts},'azul');
 const path=p.find(doc.pdfPath).notePath;texts.set(path,'anotações sem bloco');
 await assert.rejects(p.record(doc.pdfPath,{text:'dois',parts:doc.highlights[0].parts},'verde'));
 assert.equal(p.find(doc.pdfPath).highlights.length,2);assert.equal(texts.get(path),'anotações sem bloco');
 await p.syncNote(p.find(doc.pdfPath),true);assert.notEqual(p.find(doc.pdfPath).notePath,path);assert.equal(texts.get(path),'anotações sem bloco');
});
test('renomear PDF move a nota e mantém os trechos',async()=>{
 const {p,create}=setup();const file=await create(doc.pdfPath,'pdf');await p.record(doc.pdfPath,{text:'um',parts:doc.highlights[0].parts},'azul');
 await p.app.fileManager.renameFile(file,'Livros/Outro.pdf');await p.renamed(file,doc.pdfPath);
 assert.equal(p.find('Livros/Outro.pdf').notePath,'Livros/Outro — Marcações.md');assert.equal(p.find('Livros/Outro.pdf').highlights.length,1);
});
test('ordena pelo texto do PDF mesmo com retângulos de PDF rotacionado',()=>{
 const a=structuredClone(doc.highlights[0]),b=structuredClone(a);
 a.parts[0].offset=100;b.parts[0].offset=10;a.parts[0].rects[0].y=.1;b.parts[0].rects[0].y=.9;
 assert.ok(core.compareHighlights(a,b)>0);
});
test('trechos da mesma linha seguem da esquerda para a direita',()=>{
 const a=structuredClone(doc.highlights[0]),b=structuredClone(a);
 a.parts[0].rects=[{x:.7,y:.10001,w:.1,h:.02}];b.parts[0].rects=[{x:.1,y:.101,w:.1,h:.02}];
 assert.ok(core.compareHighlights(a,b)>0);
});
test('inicialização aguarda a lista de arquivos do cofre ficar pronta',async()=>{
 const {p,create}=setup();const stored=await create('Sistema/Marcações de PDF/Dados/abc.json',JSON.stringify(doc));
 const getFiles=p.app.vault.getFiles;p.app.vault.getFiles=()=>[];
 let ready;global.window={setInterval:()=>0};
 p.loadData=async()=>({});p.addSettingTab=()=>{};p.addCommand=()=>{};p.registerEvent=()=>{};p.registerInterval=()=>{};
 p.app.workspace.on=()=>({});p.app.workspace.onLayoutReady=cb=>ready=cb;p.app.vault.on=()=>({});
 // The VM uses its own globals; supply the same timer interface there.
 const source=fs.readFileSync(__dirname+'/main.js','utf8');
 const api={Plugin:class{},Notice:class{},Modal:class{},PluginSettingTab:class{},Setting:class{},TFile:stored.constructor,normalizePath:x=>x};
 const ctx={module:{exports:{}},require:id=>id==='obsidian'?api:core,window:{setInterval:()=>0},console};vm.runInNewContext(source,ctx);
 const cold=new ctx.module.exports();Object.assign(cold,{app:p.app,loadData:p.loadData,addSettingTab:p.addSettingTab,addCommand:p.addCommand,registerEvent:p.registerEvent,registerInterval:p.registerInterval});
 await cold.onload();assert.equal(cold.docs.size,0);assert.equal(cold.recordsReady,false);
 p.app.vault.getFiles=getFiles;ready();await cold.chain;
 assert.equal(cold.docs.size,1);assert.equal(cold.recordsReady,true);
});
