"use strict";
const {Plugin, Notice, Modal, Menu, Platform, PluginSettingTab, Setting, TFile, normalizePath, requestUrl}=require('obsidian');
const {COLORS,notePath,rotateRect,sameSelection,newNote,updateNote}=require('./core');
const DATA='Sistema/Marcações de PDF/Dados';
const uuid=()=>crypto.randomUUID().replace(/-/g,'');
const clone=x=>JSON.parse(JSON.stringify(x));
const round=n=>Math.round(n*100000)/100000;
function element(parent,tag,cls,text) {
  const el=parent.ownerDocument.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;parent.appendChild(el);return el;
}
class GoogleRateLimit extends Error {
  constructor(until){super('Consultas ao Google temporariamente limitadas.');this.retryAt=until;}
}
class PDFMarcacoes extends Plugin {
  async onload() {
    this.settings=Object.assign({color:'amarelo',automatic:false,translateWords:true},await this.loadData());
    this.translations=new Map();
    this.docs=new Map(); this.sessions=new Map();this.chain=Promise.resolve();this.stopped=false;
    this.writing=new Set();this.recordsReady=false;
    this.addSettingTab(new Options(this.app,this));
    this.addCommand({id:'open-note',name:'Abrir nota do PDF atual',callback:()=>this.active(s=>this.openNote(s.path))});
    this.addCommand({id:'mark-selection',name:'Marcar seleção com a cor atual',callback:()=>this.active(s=>s.commit(this.settings.color))});
    this.addCommand({id:'manage',name:'Ver e remover marcações do PDF atual',callback:()=>this.active(s=>new Highlights(this.app,this,s.path).open())});
    this.addCommand({id:'retry-notes',name:'Atualizar notas pendentes',callback:()=>this.run(async()=>{for(const doc of this.docs.values())await this.syncNote(doc);new Notice('Notas de marcações atualizadas.');})});
    this.registerEvent(this.app.workspace.on('layout-change',()=>this.refresh()));
    this.registerEvent(this.app.workspace.on('file-open',()=>this.refresh()));
    this.registerEvent(this.app.vault.on('rename',(file,old)=>this.fire(()=>this.renamed(file,old))));
    this.registerEvent(this.app.vault.on('modify',file=>{
      if(file.path.startsWith(DATA+'/')&&file.extension==='json'&&!this.writing.has(file.path))this.fire(async()=>{await this.readRecord(file);this.paint();});
    }));
    this.registerEvent(this.app.vault.on('create',file=>{
      if(file.path.startsWith(DATA+'/')&&file.extension==='json'&&!this.writing.has(file.path))this.fire(async()=>{await this.readRecord(file);this.paint();});
    }));
    // At cold startup getFiles() may still be empty until the vault/layout is ready.
    this.app.workspace.onLayoutReady(()=>this.fire(async()=>{await this.loadRecords();this.recordsReady=true;this.paint();this.refresh();}));
    this.registerInterval(window.setInterval(()=>this.refresh(),1500));
  }
  onunload(){this.stopped=true;for(const s of this.sessions.values())s.destroy();this.sessions.clear();}
  run(fn){const job=this.chain.then(fn);this.chain=job.catch(e=>{console.error('PDF Marcações',e);new Notice('PDF Marcações: '+e.message,9000);});return job;}
  fire(fn){void this.run(fn).catch(()=>{});}
  async translate(text){
    if(this.translations.has(text))return this.translations.get(text);
    if(Date.now()<this.googleRetryAt)throw new GoogleRateLimit(this.googleRetryAt);
    const params=new URLSearchParams({client:'gtx',sl:'auto',tl:'pt',dt:'t',q:text});
    const result=requestUrl({url:'https://translate.googleapis.com/translate_a/single?'+params,throw:false}).then(response=>{
      if(response.status===429){
        const header=Object.entries(response.headers||{}).find(([name])=>name.toLowerCase()==='retry-after')?.[1]?.trim();
        const now=Date.now();
        const delay=/^\d+$/.test(header)?Number(header)*1000:Date.parse(header)-now;
        const wait=Number.isFinite(delay)&&delay>0?delay:Math.min((this.googleBackoff||30000)*2,900000);
        this.googleBackoff=wait;
        this.googleRetryAt=Math.max(this.googleRetryAt||0,now+wait);
        throw new GoogleRateLimit(this.googleRetryAt);
      }
      if(response.status!==200)throw Error('Falha na consulta.');
      const segments=response.json?.[0];
      const translation=Array.isArray(segments)&&segments.map(segment=>typeof segment?.[0]==='string'?segment[0]:'').join('').trim();
      if(!translation)throw Error('Resposta vazia.');
      if(!(Date.now()<this.googleRetryAt))this.googleBackoff=0;
      return translation;
    });
    if(this.translations.size>=100)this.translations.delete(this.translations.keys().next().value);
    this.translations.set(text,result);
    try{return await result;}catch(error){
      if(this.translations.get(text)===result)this.translations.delete(text);
      throw error;
    }
  }
  async loadRecords(){for(const f of this.app.vault.getFiles().filter(f=>f.path.startsWith(DATA+'/')&&f.extension==='json'))await this.readRecord(f);}
  async readRecord(f){
    try {const d=JSON.parse(await this.app.vault.read(f));if(d.schema===1&&typeof d.id==='string'&&typeof d.pdfPath==='string'&&Array.isArray(d.highlights))this.docs.set(d.id,d);}
    catch(e){console.error('PDF Marcações: não foi possível ler '+f.path,e);new Notice('Não foi possível ler marcações: '+f.name);}
  }
  find(path){return [...this.docs.values()].find(d=>d.pdfPath===path);}
  async folders(path){let prefix='';for(const part of path.split('/')){prefix=prefix?prefix+'/'+part:part;if(!this.app.vault.getAbstractFileByPath(prefix))await this.app.vault.createFolder(prefix);}}
  async persist(doc){
    await this.folders(DATA);const path=DATA+'/'+doc.id+'.json';this.writing.add(path);
    try{const file=this.app.vault.getAbstractFileByPath(path),text=JSON.stringify(doc,null,2);if(file)await this.app.vault.process(file,()=>text);else await this.app.vault.create(path,text);this.docs.set(doc.id,doc);}
    finally{this.writing.delete(path);}
  }
  async syncNote(doc, recover=false){
    let f=doc.notePath&&this.app.vault.getAbstractFileByPath(doc.notePath);
    if(f&&!recover){
      await this.app.vault.process(f,text=>updateNote(text,doc));return f;
    }
    const base=notePath(doc.pdfPath);let chosen=base,n=2;
    while(this.app.vault.getAbstractFileByPath(chosen))chosen=base.replace(/\.md$/,` (${n++}).md`);
    const copy={...doc,notePath:chosen};
    // Persist the chosen path first: a failed create can safely retry without losing highlights.
    await this.persist(copy);
    f=await this.app.vault.create(chosen,newNote(copy));return f;
  }
  async record(path,selection,color){
    if(!this.recordsReady){await this.loadRecords();this.recordsReady=true;}
    if(!COLORS.some(c=>c.id===color))throw Error('Cor inválida.');
    const pdf=this.app.vault.getAbstractFileByPath(path);
    if(!(pdf instanceof TFile)||pdf.extension.toLowerCase()!=='pdf')throw Error('O PDF não está mais disponível.');
    let doc=clone(this.find(path)||{schema:1,id:uuid(),pdfPath:path,notePath:null,highlights:[]});
    const found=doc.highlights.find(h=>sameSelection(h,selection));
    if(found)found.color=color;
    else doc.highlights.push({...clone(selection),id:uuid(),color,created:new Date().toISOString()});
    await this.persist(doc);this.paint();
    await this.syncNote(doc);return this.find(path);
  }
  async remove(path,id){const doc=clone(this.find(path));doc.highlights=doc.highlights.filter(h=>h.id!==id);await this.persist(doc);this.paint();await this.syncNote(doc);}
  async recolor(path,id,color){
    const current=this.find(path);
    if(!current||!COLORS.some(c=>c.id===color))return;
    const doc=clone(current),highlight=doc.highlights.find(h=>h.id===id);
    if(!highlight)return;
    highlight.color=color;
    await this.persist(doc);this.paint();await this.syncNote(doc);
  }
  async openNote(path){
    return this.run(async()=>{const doc=this.find(path);if(!doc){new Notice('Faça a primeira marcação para criar a nota.');return;}const file=await this.syncNote(doc);await this.app.workspace.getLeaf('split').openFile(file);});
  }
  async renamed(file,old){
    for(const original of [...this.docs.values()]){
      const doc=clone(original);let changed=false;
      if(doc.pdfPath===old||doc.pdfPath.startsWith(old+'/')){doc.pdfPath=file.path+doc.pdfPath.slice(old.length);changed=true;}
      if(doc.notePath&&(doc.notePath===old||doc.notePath.startsWith(old+'/'))){doc.notePath=file.path+doc.notePath.slice(old.length);changed=true;}
      if(changed){
        // Move an owned note alongside its PDF. Do not take over a conflicting name.
        if(doc.pdfPath!==original.pdfPath&&doc.notePath===original.notePath){
          const note=this.app.vault.getAbstractFileByPath(doc.notePath||'');let destination=notePath(doc.pdfPath),i=2;
          while(this.app.vault.getAbstractFileByPath(destination)&&destination!==doc.notePath)destination=notePath(doc.pdfPath).replace(/\.md$/,` (${i++}).md`);
          if(note&&note.path!==destination){await this.app.fileManager.renameFile(note,destination);doc.notePath=destination;}
        }
        await this.persist(doc);await this.syncNote(doc);
      }
    }
    this.refresh();this.paint();
  }
  active(fn){const leaf=this.app.workspace.getMostRecentLeaf();const s=this.sessions.get(leaf);if(!s){new Notice('Abra um PDF no leitor nativo do Obsidian.');return;}Promise.resolve(fn(s)).catch(e=>console.error(e));}
  refresh(){
    if(this.stopped||!this.recordsReady)return;
    const leaves=new Set(this.app.workspace.getLeavesOfType('pdf'));
    for(const [leaf,s]of this.sessions)if(!leaves.has(leaf)||leaf.view.file?.path!==s.path){s.destroy();this.sessions.delete(leaf);}
    for(const leaf of leaves)if(!this.sessions.has(leaf)&&leaf.view.file?.extension.toLowerCase()==='pdf')this.sessions.set(leaf,new PDFSession(this,leaf));
    for(const s of this.sessions.values())s.paint();
  }
  paint(){for(const s of this.sessions.values())s.paint(true);}
}
class PDFSession {
  constructor(plugin,leaf){
    this.plugin=plugin;this.leaf=leaf;this.root=leaf.view.contentEl;this.path=leaf.view.file.path;this.doc=this.root.ownerDocument;this.pending=null;this.cleanups=[];
    this.bar=element(this.root,'div','pdfm-toolbar');this.bar.hidden=true;this.bar.setAttribute('role','toolbar');this.bar.setAttribute('aria-label','Marcações de PDF');
    this.title=element(this.bar,'span','pdfm-title','Marcações');
    this.auto=element(this.bar,'button','pdfm-auto');this.auto.addEventListener('click',()=>{plugin.settings.automatic=!plugin.settings.automatic;void plugin.saveData(plugin.settings);for(const s of plugin.sessions.values())s.updateButtons();});
    const note=element(this.bar,'button','', 'Abrir nota');note.addEventListener('click',()=>void plugin.openNote(this.path).catch(()=>{}));
    const manage=element(this.bar,'button','','Marcações salvas');manage.addEventListener('click',()=>new Highlights(plugin.app,plugin,this.path).open());
    this.status=element(this.bar,'span','pdfm-status','Selecione texto e use o botão direito para escolher a cor.');this.status.setAttribute('role','status');
    this.updateButtons();
    this.touchMode=!!Platform?.isMobile;
    this.onPointerUp=e=>{
      if(this.bar.contains(e.target)||e.button>0)return;
      if(e.pointerType==='touch')this.touchMode=true;
      if(this.touchMode){
        const tap=this.tapStart;this.tapStart=null;
        if(tap&&tap.id===e.pointerId&&e.timeStamp-tap.time<450&&Math.hypot(e.clientX-tap.x,e.clientY-tap.y)<9){
          const hits=tap.hits.length?tap.hits:this.markedAt(e);
          if(hits.length){this.showTouchEditor(hits);return;}
        }
        this.scheduleTouchPalette();
      }
      else this.captureAndAuto(e);
    };
    this.onKey=e=>{if(e.key==='Shift' || (e.shiftKey&&e.key.startsWith('Arrow')))this.captureAndAuto();};
    this.root.addEventListener('pointerup',this.onPointerUp,true);this.root.addEventListener('keyup',this.onKey);
    this.onDismiss=e=>{
      if(this.palette?.contains(e.target))return;
      this.pressedSelection=null;
      clearTimeout(this.captureTimer);
      if(this.root.contains(e.target)){
        if(e.pointerType==='touch')this.touchMode=true;
        else if(e.pointerType==='mouse')this.touchMode=false;
        if(this.touchMode&&!this.bar.contains(e.target)){
          if(this.editing)this.hidePalette();
          this.touchClickHandled=true;
          this.tapStart=e.isPrimary!==false
            ?{id:e.pointerId,x:e.clientX,y:e.clientY,time:e.timeStamp,hits:this.markedAt(e)}:null;
          return;
        }
      }
      this.hidePalette();
    };
    this.onSelectionChange=()=>{if(this.touchMode)this.scheduleTouchPalette();};
    this.doc.addEventListener('selectionchange',this.onSelectionChange);
    this.cancelTap=()=>{this.tapStart=null;};
    // Some WebViews hand the pointer stream to native text selection before pointerup.
    this.onTouchStart=e=>{
      const t=e.touches[0];
      this.nativeTap=null;
      if(e.touches.length!==1||this.bar.contains(e.target))return;
      this.touchMode=true;
      this.touchSelecting=true;
      clearTimeout(this.wordTimer);
      const hits=this.markedAt({target:e.target,clientX:t.clientX,clientY:t.clientY});
      if(hits.length)this.nativeTap={id:t.identifier,x:t.clientX,y:t.clientY,time:e.timeStamp,hits};
    };
    this.onTouchMove=e=>{
      const tap=this.nativeTap,t=e.touches[0];
      if(tap&&(e.touches.length!==1||Math.hypot(t.clientX-tap.x,t.clientY-tap.y)>=9))this.nativeTap=null;
    };
    this.onTouchEnd=e=>{
      if(this.touchSelecting&&!e.touches.length){
        this.touchSelecting=false;
        this.scheduleTouchPalette();
      }
      const tap=this.nativeTap;this.nativeTap=null;
      if(!tap||this.editing||e.touches.length||e.timeStamp-tap.time>=450)return;
      const t=Array.from(e.changedTouches).find(t=>t.identifier===tap.id);
      if(t&&Math.hypot(t.clientX-tap.x,t.clientY-tap.y)<9)this.showTouchEditor(tap.hits);
    };
    this.cancelNativeTap=()=>{this.nativeTap=null;};
    this.touchListeners={touchstart:this.onTouchStart,touchmove:this.onTouchMove,touchend:this.onTouchEnd,touchcancel:e=>{
      this.cancelNativeTap();this.touchSelecting=!!e.touches.length;this.scheduleTouchPalette();
    }};
    for(const [type,listener] of Object.entries(this.touchListeners))this.root.addEventListener(type,listener,{capture:true,passive:true});
    this.onPointerMove=e=>{
      const tap=this.tapStart;
      if(tap&&e.pointerId===tap.id&&Math.hypot(e.clientX-tap.x,e.clientY-tap.y)>=9)this.cancelTap();
    };
    this.onClick=e=>{
      if(this.bar.contains(e.target)||!this.touchMode)return;
      const handled=this.touchClickHandled;this.touchClickHandled=false;
      if(handled||!e.detail)return;
      const hits=this.markedAt(e);
      if(hits.length)this.showTouchEditor(hits);
    };
    this.root.addEventListener('pointermove',this.onPointerMove,true);
    this.root.addEventListener('click',this.onClick,true);
    this.root.addEventListener('pointercancel',this.cancelTap);
    this.onEscape=e=>{if(e.key==='Escape'){clearTimeout(this.captureTimer);this.hidePalette();}};
    this.onScroll=()=>{this.cancelTap();this.cancelNativeTap();if(!this.touchMode)this.hidePalette();};
    this.doc.addEventListener('pointerdown',this.onDismiss,true);this.doc.addEventListener('keydown',this.onEscape);this.root.addEventListener('scroll',this.onScroll,true);
    this.onContext=e=>{
      if(this.bar.contains(e.target)||!e.target.closest?.('.pdfViewer .page'))return;
      clearTimeout(this.captureTimer);
      const isMouseButton=e.pointerType==='mouse'&&e.button===2;
      if(!isMouseButton&&(this.touchMode||e.pointerType==='touch'||e.sourceCapabilities?.firesTouchEvents)){
        this.touchMode=true;
        // Leave the native selection and its drag handles under the WebView's control.
        e.stopImmediatePropagation();
        this.scheduleTouchPalette();
        return;
      }
      e.preventDefault();e.stopImmediatePropagation();
      const hits=this.markedAt(e);
      if(hits.length){this.editMarks(hits,e);return;}
      const selection=this.capture();
      const menu=new Menu();
      this.hidePalette();
      if(selection)menu.addItem(item=>item.setTitle('Copiar').setIcon('copy').onClick(()=>void this.copySelection(selection)));
      if(selection)this.addTranslateMenuItem(menu,selection,e);
      for(const color of COLORS){
        menu.addItem(item=>{
          item.setTitle((selection?'Marcar em ':'Usar cor: ')+color.label).setIcon('highlighter').setChecked(color.id===this.plugin.settings.color).onClick(()=>{
            this.plugin.settings.color=color.id;void this.plugin.saveData(this.plugin.settings);
            for(const session of this.plugin.sessions.values())session.updateButtons();
            if(selection)void this.commit(color.id,selection);
          });
          const icon=item.dom?.querySelector('.menu-item-icon');if(icon)icon.style.color=color.hex;
        });
      }
      this.openMenu(menu,e);
    };
    this.root.addEventListener('contextmenu',this.onContext,true);
    const Win=this.doc.defaultView;
    this.observer=new Win.MutationObserver(m=>{if(m.some(x=>!x.target.closest?.('.pdfm-toolbar,.pdfm-layer')))this.schedulePaint();});
    this.observer.observe(this.root,{childList:true,subtree:true,attributes:true,attributeFilter:['data-page-number','data-main-rotation','style']});
    this.resize=new Win.ResizeObserver(()=>this.schedulePaint());this.resize.observe(this.root);
    this.paint();
  }
  hidePalette(){clearTimeout(this.wordTimer);this.lookup=null;this.palette?.remove();this.palette=null;this.editing=false;this.bar.classList.remove('pdfm-selecting');this.pressedSelection=null;}
  markedAt(event){
    const page=event.target.closest?.('.pdfViewer .page')||
      this.doc.elementsFromPoint(event.clientX,event.clientY).map(el=>el.closest('.pdfViewer .page')).find(el=>el&&this.root.contains(el));
    if(!page||!this.root.contains(page))return [];
    const ids=new Set();
    for(const mark of page.querySelectorAll('.pdfm-mark')){
      const r=mark.getBoundingClientRect();
      if(event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom)ids.add(mark.dataset.highlightId);
    }
    return (this.plugin.find(this.path)?.highlights||[]).filter(h=>ids.has(h.id));
  }
  showTouchEditor(hits){
    clearTimeout(this.captureTimer);this.hidePalette();this.pending=null;
    this.editing=true;
    const box=element(this.bar,'div','pdfm-palette pdfm-edit');
    this.palette=box;this.bar.classList.add('pdfm-selecting');
    box.setAttribute('role','toolbar');box.setAttribute('aria-label','Editar marcação salva');
    let selected=hits[hits.length-1];
    if(hits.length>1){
      const list=element(box,'select','pdfm-overlaps');list.setAttribute('aria-label','Escolher marcação sobreposta');
      for(const [i,h] of hits.entries()){
        const color=COLORS.find(c=>c.id===h.color);
        const option=element(list,'option','',(i+1)+' · '+(color?.label||'')+' · '+h.text.slice(0,40));
        option.value=h.id;
      }
      list.value=selected.id;list.onchange=()=>{selected=hits[list.selectedIndex];refresh();this.updateLookup(selected.text,false);};
    }else element(box,'span','pdfm-edit-label','Trocar cor');
    const apply=action=>{
      if(this.palette!==box)return;
      const id=selected.id;
      this.doc.getSelection()?.removeAllRanges();this.hidePalette();
      this.plugin.fire(()=>action(id));
    };
    const buttons=COLORS.map(color=>{
      const button=element(box,'button','pdfm-swatch');
      button.style.setProperty('--pdfm-color',color.hex);
      button.title='Trocar cor para '+color.label;button.setAttribute('aria-label',button.title);
      button.onclick=()=>apply(id=>this.plugin.recolor(this.path,id,color.id));
      return button;
    });
    const refresh=()=>buttons.forEach((button,i)=>button.setAttribute('aria-pressed',String(COLORS[i].id===selected.color)));
    refresh();
    const del=element(box,'button','','Excluir');
    del.setAttribute('aria-label','Excluir marcação');
    del.onclick=()=>apply(id=>this.plugin.remove(this.path,id));
    this.addLookup(box,()=>selected.text);
    this.updateLookup(selected.text,false);
  }
  openMenu(menu,event){
    this.activeMenu?.hide();this.activeMenu=menu;
    menu.onHide(()=>{if(this.activeMenu===menu)this.activeMenu=null;});
    menu.showAtMouseEvent(event);
  }
  addTranslateMenuItem(menu,selection,event,label=''){
    menu.addItem(item=>item.setTitle('Traduzir para português'+label).setIcon('languages').onClick(()=>{
      menu.hide();this.touchMode=false;
      this.showPalette(selection,{x:event.clientX,y:event.clientY});
      void this.runLookup(this.lookup);
    }));
  }
  editMarks(hits,event){
    clearTimeout(this.captureTimer);this.hidePalette();this.pending=null;
    const menu=new Menu();
    for(const [i,h] of hits.entries()){
      if(i)menu.addSeparator();
      const label=hits.length>1?' · '+h.text.replace(/\s+/g,' ').slice(0,55):'';
      for(const c of COLORS){
        menu.addItem(item=>item.setTitle('Trocar cor para '+c.label+label).setIcon('highlighter').setChecked(h.color===c.id)
          .onClick(()=>this.plugin.fire(()=>this.plugin.recolor(this.path,h.id,c.id))));
      }
      menu.addItem(item=>item.setTitle('Excluir marcação'+label).setIcon('trash-2')
        .onClick(()=>this.plugin.fire(()=>this.plugin.remove(this.path,h.id))));
      this.addTranslateMenuItem(menu,h,event,label);
    }
    this.openMenu(menu,event);
  }
  scheduleTouchPalette(){
    clearTimeout(this.captureTimer);
    this.captureTimer=setTimeout(()=>{
      if(this.activeMenu||this.editing)return;
      const sel=this.doc.getSelection();
      const inViewer=node=>(node?.nodeType===1?node:node?.parentElement)?.closest('.pdfViewer');
      const viewer=inViewer(sel?.anchorNode);
      if(sel&&!sel.isCollapsed&&viewer&&this.root.contains(viewer)&&inViewer(sel.focusNode)===viewer){
        const range=this.capture();
        const hits=range&&(this.plugin.find(this.path)?.highlights||[]).filter(h=>sameSelection(h,range));
        if(hits?.length&&!this.tapStart)this.showTouchEditor(hits);
        else if(this.palette?.parentNode!==this.bar)this.showPalette(null,null,true);
        if(!this.editing)this.updateLookup(range?.text,true);
      }else if(!this.pressedSelection){
        this.pending=null;
        this.hidePalette();
      }
    },70);
  }
  async copySelection(selection){
    try{await this.doc.defaultView.navigator.clipboard.writeText(selection.text);this.status.textContent='Texto copiado.';this.hidePalette();}
    catch(e){new Notice('Não foi possível copiar o texto. Use Ctrl+C com a seleção ativa.');}
  }
  addLookup(box,getText){
    box.classList.add('pdfm-with-translation');
    const button=element(box,'button','pdfm-translate','Traduzir');
    button.title='Traduzir para português com o Google';
    const output=element(box,'div','pdfm-translation');
    output.setAttribute('role','status');output.hidden=true;
    this.lookup={button,output,text:null};
    button.onclick=()=>{
      if(this.palette!==box)return;
      this.updateLookup(getText(),false);
      void this.runLookup(this.lookup);
    };
  }
  updateLookup(raw,automatic){
    const text=raw?.trim()||'';
    if(!this.lookup)return;
    clearTimeout(this.wordTimer);
    if(text!==this.lookup.text){
      const {button,output}=this.lookup;
      this.lookup={button,output,text};
      output.hidden=true;output.textContent='';button.disabled=!text;
    }
    const lookup=this.lookup;
    if(automatic&&!lookup.started&&!this.touchSelecting&&this.plugin.settings.translateWords&&text&&text.length<=100&&!/\s/u.test(text)){
      this.wordTimer=setTimeout(()=>void this.runLookup(lookup),this.touchMode?1000:650);
    }
  }
  async runLookup(lookup){
    if(!lookup?.text||this.lookup!==lookup||lookup.running)return;
    clearTimeout(this.wordTimer);
    const {text,button,output}=lookup;
    output.hidden=false;
    if(text.length>1200){output.textContent='Selecione um trecho de até 1.200 caracteres para traduzir.';return;}
    output.textContent='Traduzindo…';lookup.running=true;lookup.started=true;button.disabled=true;
    try{
      const translated=await this.plugin.translate(text);
      if(this.lookup===lookup)output.textContent=translated;
    }catch(error){
      if(this.lookup===lookup){
        if(error.retryAt){
          const minutes=Math.max(1,Math.ceil((error.retryAt-Date.now())/60000));
          output.textContent='Consulta no leitor em pausa por cerca de '+minutes+' min. ';
          const link=element(output,'a','external-link','Abrir no Google Tradutor');
          link.href='https://translate.google.com/?'+new URLSearchParams({sl:'auto',tl:'pt',text,op:'translate'});
          link.target='_blank';link.rel='noopener noreferrer';
        }else output.textContent='Google Tradutor indisponível. Confira a conexão e toque em Traduzir para tentar novamente.';
      }
    }finally{
      lookup.running=false;
      if(this.lookup===lookup){
        button.disabled=false;
        const box=output.parentElement;
        if(box?.parentElement===this.doc.body){
          const rect=box.getBoundingClientRect();
          if(rect.bottom>this.doc.defaultView.innerHeight)box.style.top=Math.max(4,this.doc.defaultView.innerHeight-rect.height-4)+'px';
        }
      }
    }
  }
  showPalette(selection,position,docked=false){
    if(this.destroyed||this.activeMenu||(this.touchMode&&!docked))return;
    this.hidePalette();const box=element(docked?this.bar:this.doc.body,'div','pdfm-palette');this.palette=box;
    box.setAttribute('role','toolbar');box.setAttribute('aria-label','Marcar ou copiar seleção');
    if(docked)this.bar.classList.add('pdfm-selecting');
    const pick=()=>this.palette!==box?null:docked?(this.capture()||this.pressedSelection):selection;
    box.addEventListener('pointerdown',e=>{
      if(docked)this.pressedSelection=this.capture();
      e.preventDefault();
    });
    box.addEventListener('pointercancel',()=>{this.pressedSelection=null;if(docked)this.scheduleTouchPalette();});
    for(const color of COLORS){const b=element(box,'button','pdfm-swatch');b.style.setProperty('--pdfm-color',color.hex);b.title='Marcar em '+color.label;b.setAttribute('aria-label',b.title);
      b.onclick=()=>{const chosen=pick();if(!chosen)return;this.plugin.settings.color=color.id;void this.plugin.saveData(this.plugin.settings);for(const s of this.plugin.sessions.values())s.updateButtons();void this.commit(color.id,chosen);};
    }
    const copy=element(box,'button','pdfm-copy','Copiar');copy.onclick=()=>{const chosen=pick();if(chosen)void this.copySelection(chosen);};
    this.addLookup(box,()=>pick()?.text);
    this.updateLookup((selection||this.capture())?.text,true);
    if(docked)return;
    const rect=this.doc.getSelection()?.rangeCount?this.doc.getSelection().getRangeAt(0).getBoundingClientRect():null;
    const x=position?.x??rect?.left??20,y=position?.y??rect?.bottom??20,win=this.doc.defaultView;
    box.style.left=Math.max(6,Math.min(x,win.innerWidth-box.offsetWidth-6))+'px';
    box.style.top=Math.max(6,y+10+box.offsetHeight>win.innerHeight?y-box.offsetHeight-10:y+10)+'px';
  }
  updateButtons(){const color=COLORS.find(c=>c.id===this.plugin.settings.color)||COLORS[0];this.title.style.setProperty('--pdfm-color',color.hex);this.title.title='Cor atual: '+color.label+'. Escolha as cores com o botão direito no PDF.';this.auto.textContent=this.plugin.settings.automatic?'Automático: ligado':'Automático: desligado';this.auto.setAttribute('aria-pressed',String(this.plugin.settings.automatic));}
  rotation(page){
    const host=this.leaf.view.viewer?.child?.pdfViewer;
    const viewer=host?.pdfViewer||host;
    const pv=viewer?.getPageView?.(Number(page.dataset.pageNumber)-1);
    const raw=pv?.viewport?.rotation ?? page.querySelector('.textLayer')?.dataset.mainRotation ?? 0;
    return Number(raw)||0;
  }
  capture(){
    const sel=this.doc.getSelection();if(!sel||sel.isCollapsed||!sel.rangeCount)return null;
    const range=sel.getRangeAt(0);
    if(!this.root.contains(range.startContainer)||!this.root.contains(range.endContainer))return null;
    const parts=[];const texts=[];
    for(const page of this.root.querySelectorAll('.pdfViewer .page[data-page-number]')){
      const layer=page.querySelector('.textLayer');if(!layer||!range.intersectsNode(layer))continue;
      const local=this.doc.createRange();local.selectNodeContents(layer);
      if(layer.contains(range.startContainer))local.setStart(range.startContainer,range.startOffset);
      if(layer.contains(range.endContainer))local.setEnd(range.endContainer,range.endOffset);
      const fragment=local.cloneContents();
      for(const br of fragment.querySelectorAll('br'))br.replaceWith(this.doc.createTextNode('\n'));
      const text=fragment.textContent.replace(/\u00a0/g,' ').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();if(!text)continue;
      const bound=page.getBoundingClientRect();if(!bound.width||!bound.height)continue;
      let rects=Array.from(local.getClientRects()).filter(r=>r.width>.5&&r.height>.5).map(r=>({x:Math.max(0,(r.left-bound.left)/bound.width),y:Math.max(0,(r.top-bound.top)/bound.height),w:Math.min(r.width/bound.width,1),h:Math.min(r.height/bound.height,1)}));
      // Browser ranges return both inline span and text rectangles; keep each visible rectangle once.
      rects=rects.filter((r,i,all)=>!all.slice(0,i).some(a=>Math.abs(a.x-r.x)<.0001&&Math.abs(a.y-r.y)<.0001&&Math.abs(a.w-r.w)<.0001&&Math.abs(a.h-r.h)<.0001));
      const rotation=this.rotation(page);rects=rects.map(r=>{const p=rotateRect(r,-rotation);return Object.fromEntries(Object.entries(p).map(([k,v])=>[k,round(v)]));});
      const prefix=this.doc.createRange();prefix.selectNodeContents(layer);prefix.setEnd(local.startContainer,local.startOffset);
      const offset=prefix.toString().replace(/\s/g,'').length;
      const host=this.leaf.view.viewer?.child?.pdfViewer;
      const pv=(host?.pdfViewer||host)?.getPageView?.(Number(page.dataset.pageNumber)-1);
      if(rects.length){parts.push({page:Number(page.dataset.pageNumber),rects,offset,readingRotation:pv?.pdfPage?.rotate||0});texts.push(text);}
    }
    return parts.length?{text:texts.join('\n\n'),parts}:null;
  }
  captureAndAuto(event){
    if(this.touchMode){this.scheduleTouchPalette();return;}
    const position=event?{x:event.clientX,y:event.clientY}:null;
    clearTimeout(this.captureTimer);this.captureTimer=setTimeout(()=>{const picked=this.capture();this.pending=picked;if(picked){this.status.textContent='Seleção pronta. Escolha uma cor ou copie o texto.';if(this.plugin.settings.automatic)void this.commit(this.plugin.settings.color).then(()=>this.showPalette(picked,position));else this.showPalette(picked,position);}else this.hidePalette();},30);
  }
  commit(color,selected){
    const selection=selected||this.capture()||this.pending;if(!selection){this.status.textContent='Cor escolhida. Selecione texto no PDF.';return Promise.resolve();}
    this.hidePalette();
    this.pending=null;this.doc.getSelection()?.removeAllRanges();this.status.textContent='Salvando…';
    return this.plugin.run(async()=>{await this.plugin.record(this.path,selection,color);this.status.textContent='Marcação e nota salvas.';}).catch(()=>{this.pending=selection;this.status.textContent='Falha ao salvar. Tente novamente; dados já gravados são preservados.';});
  }
  schedulePaint(){if(this.frame)return;this.frame=this.doc.defaultView.requestAnimationFrame(()=>{this.frame=null;this.paint();});}
  paint(force=false){
    const toolbarRight=this.root.querySelector('.pdf-toolbar:not(.pdf-findbar) .pdf-toolbar-right');
    if(toolbarRight){
      if(this.bar.parentElement!==toolbarRight)toolbarRight.appendChild(this.bar);
      this.bar.classList.remove('pdfm-mobile-toolbar');
      this.bar.hidden=false;
    }else{
      // Mobile uses a different PDF reader layout and has no desktop toolbar.
      // Keep the same actions available immediately above the document.
      if(this.bar.parentElement!==this.root)this.root.prepend(this.bar);
      this.bar.classList.add('pdfm-mobile-toolbar');
      this.bar.hidden=false;
    }
    const record=this.plugin.find(this.path);const signature=JSON.stringify(record?.highlights||[]);
    this.upgradeReadingOrder(record);
    for(const page of this.root.querySelectorAll('.pdfViewer .page[data-page-number]')){
      const rotation=this.rotation(page);const key=signature+':'+rotation;let layer=page.querySelector(':scope > .pdfm-layer');
      if(layer&&layer.pdfmKey===key&&!force)continue;
      if(!layer){layer=element(page,'div','pdfm-layer');layer.setAttribute('aria-hidden','true');}layer.replaceChildren();layer.pdfmKey=key;
      for(const h of record?.highlights||[])for(const part of h.parts)if(part.page===Number(page.dataset.pageNumber))for(const raw of part.rects){
        const rect=rotateRect(raw,rotation);const mark=element(layer,'span','pdfm-mark');mark.dataset.highlightId=h.id;const c=COLORS.find(c=>c.id===h.color)||COLORS[0];
        Object.assign(mark.style,{left:rect.x*100+'%',top:rect.y*100+'%',width:rect.w*100+'%',height:rect.h*100+'%',backgroundColor:c.hex});
      }
    }
  }
  upgradeReadingOrder(record){
    if(!record||this.upgrading)return;
    const updates=[];
    for(const h of record.highlights){
      const part=h.parts[0];if(Number.isFinite(part.offset))continue;
      const page=this.root.querySelector(`.page[data-page-number="${Number(part.page)}"]`),layer=page?.querySelector('.textLayer');
      if(!layer?.textContent)continue;
      const haystack=layer.textContent.replace(/\s/g,''),needle=h.text.replace(/\s/g,'');
      // Only migrate a uniquely identified selection; never guess or change saved text/geometry.
      const offset=haystack.indexOf(needle);
      if(offset>=0&&haystack.indexOf(needle,offset+1)<0)updates.push({id:h.id,offset});
    }
    if(!updates.length)return;
    this.upgrading=true;
    this.plugin.fire(async()=>{
      try{const latest=clone(this.plugin.find(this.path));for(const u of updates){const h=latest.highlights.find(h=>h.id===u.id);if(h)h.parts[0].offset=u.offset;}
        await this.plugin.persist(latest);await this.plugin.syncNote(latest);
      }finally{this.upgrading=false;}
    });
  }
  destroy(){this.destroyed=true;for(const [type,listener] of Object.entries(this.touchListeners))this.root.removeEventListener(type,listener,true);this.activeMenu?.hide();this.root.removeEventListener('pointercancel',this.cancelTap);this.root.removeEventListener('pointermove',this.onPointerMove,true);this.root.removeEventListener('click',this.onClick,true);this.hidePalette();this.doc.removeEventListener('selectionchange',this.onSelectionChange);this.doc.removeEventListener('pointerdown',this.onDismiss,true);this.doc.removeEventListener('keydown',this.onEscape);this.root.removeEventListener('scroll',this.onScroll,true);this.root.removeEventListener('pointerup',this.onPointerUp,true);this.root.removeEventListener('keyup',this.onKey);this.root.removeEventListener('contextmenu',this.onContext,true);this.observer.disconnect();this.resize.disconnect();clearTimeout(this.captureTimer);if(this.frame)this.doc.defaultView.cancelAnimationFrame(this.frame);this.bar.remove();for(const x of this.root.querySelectorAll('.pdfm-layer'))x.remove();}
}
class Highlights extends Modal {
  constructor(app,plugin,path){super(app);this.plugin=plugin;this.path=path;}
  onOpen(){this.render();}
  render(){
    this.contentEl.empty();element(this.contentEl,'h2','','Marcações salvas');
    const doc=this.plugin.find(this.path);
    if(!doc){element(this.contentEl,'p','','Nenhuma marcação neste PDF.');return;}
    const recover=element(this.contentEl,'button','','Recuperar nota');recover.title='Cria uma nova cópia da nota sem sobrescrever a anterior.';recover.onclick=()=>this.plugin.fire(async()=>{await this.plugin.syncNote(doc,true);new Notice('Nota recuperada em um novo arquivo.');});
    for(const h of doc.highlights){
      const row=element(this.contentEl,'div','pdfm-row');const c=COLORS.find(c=>c.id===h.color)||COLORS[0];
      element(row,'strong','',c.label+' · p. '+h.parts.map(p=>p.page).join(', '));element(row,'p','',h.text);
      const del=element(row,'button','','Remover marcação');del.onclick=()=>{del.disabled=true;this.plugin.fire(async()=>{await this.plugin.remove(this.path,h.id);this.render();});};
    }
  }
  onClose(){this.contentEl.empty();}
}
class Options extends PluginSettingTab {
  constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
  display(){
    this.containerEl.empty();element(this.containerEl,'h2','','PDF Marcações');
    new Setting(this.containerEl).setName('Traduzir palavras ao selecionar').setDesc('Envia a palavra selecionada ao Google Tradutor e mostra a tradução em português. Para frases, use o botão Traduzir.').addToggle(t=>t.setValue(this.plugin.settings.translateWords).onChange(async value=>{
      this.plugin.settings.translateWords=value;
      for(const session of this.plugin.sessions.values())session.hidePalette();
      await this.plugin.saveData(this.plugin.settings);
    }));
    element(this.containerEl,'p','','Abra um PDF no leitor nativo. Selecione texto e clique com o botão direito para escolher uma das cinco cores. A nota é criada ao lado do livro, somente na primeira marcação.');
    new Setting(this.containerEl).setName('Marcar ao selecionar').setDesc('Com mouse ou teclado, salva a seleção com a cor escolhida. Por toque, ajuste as alças e confirme numa cor. Toque breve em uma marcação salva para editar.').addToggle(t=>t.setValue(this.plugin.settings.automatic).onChange(async v=>{this.plugin.settings.automatic=v;await this.plugin.saveData(this.plugin.settings);for(const s of this.plugin.sessions.values())s.updateButtons();}));
    element(this.containerEl,'p','','As cores aparecem neste leitor. O PDF original não é alterado. Os trechos ficam em Markdown; as posições ficam em Sistema/Marcações de PDF/Dados. PDFs de imagem precisam de OCR prévio para selecionar texto.');
  }
}
module.exports=PDFMarcacoes;
module.exports.PDFSession=PDFSession;
