"use strict";
const COLORS = [
  {id:'amarelo', label:'Amarelo', hex:'#f5ce47'},
  {id:'verde', label:'Verde', hex:'#60cd91'},
  {id:'azul', label:'Azul', hex:'#6cb9f4'},
  {id:'rosa', label:'Rosa', hex:'#f18bb4'},
  {id:'roxo', label:'Roxo', hex:'#b69aee'}
];
const escapeMD = text => String(text).replace(/([\\`*_{}\[\]<>])/g,'\\$1');
const pdfLink = (path,page,label) => `[${escapeMD(label)}](<${encodeURI(path).replace(/#/g,'%23').replace(/\?/g,'%3F')}${page ? '#page='+page : ''}>)`;
function notePath(pdfPath) { return pdfPath.replace(/\.pdf$/i, '')+' — Marcações.md'; }
function rotatePoint(x,y,rotation) {
  switch(((rotation%360)+360)%360) { case 90:return [1-y,x]; case 180:return [1-x,1-y];case 270:return [y,1-x]; default:return [x,y]; }
}
function rotateRect(rect,rotation) {
  const points=[[rect.x,rect.y],[rect.x+rect.w,rect.y],[rect.x,rect.y+rect.h],[rect.x+rect.w,rect.y+rect.h]].map(p=>rotatePoint(...p,rotation));
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  return {x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};
}
function sameSelection(a,b) {
  return a.text.replace(/\s/g,'')===b.text.replace(/\s/g,'') && a.parts.length===b.parts.length && a.parts.every((part,i)=>{
    const other=b.parts[i];
    if(part.page!==other.page)return false;
    if(Number.isInteger(part.offset)&&Number.isInteger(other.offset))return part.offset===other.offset;
    return JSON.stringify(part.rects)===JSON.stringify(other.rects);
  });
}
function renderBlock(doc) {
  const rows=[`<!-- pdf-marcacoes:${doc.id}:start -->`, '## Trechos marcados', '', 'PDF: '+pdfLink(doc.pdfPath,null,doc.pdfPath.split('/').pop()),''];
  for(const h of [...doc.highlights].sort(compareHighlights)) {
    const color=COLORS.find(c=>c.id===h.color)||COLORS[0];
    const pages=[...new Set(h.parts.map(p=>p.page))];
    rows.push(`> [!pdf-${color.id}] ${color.label} · ${pages.map(p=>pdfLink(doc.pdfPath,p,'p. '+p)).join(' · ')}`,
      ...escapeMD(h.text).split('\n').map(line=>'> '+line),`>`, `> Marcado em ${new Date(h.created).toLocaleString('pt-BR')}`,``, `^pdf-${h.id}`, '');
  }
  if(!doc.highlights.length)rows.push('Nenhuma marcação ativa.','');
  rows.push(`<!-- pdf-marcacoes:${doc.id}:end -->`);
  return rows.join('\n');
}
function compareHighlights(a,b){
  const aa=a.parts[0],bb=b.parts[0];if(aa.page!==bb.page)return aa.page-bb.page;
  if(Number.isFinite(aa.offset)&&Number.isFinite(bb.offset)&&aa.offset!==bb.offset)return aa.offset-bb.offset;
  const ar=aa.rects.map(r=>rotateRect(r,aa.readingRotation||0)),br=bb.rects.map(r=>rotateRect(r,bb.readingRotation||0));
  const ay=Math.min(...ar.map(r=>r.y)),by=Math.min(...br.map(r=>r.y));
  // Tiny vertical differences within a text line must not reverse left-to-right order.
  const line=Math.min(...ar.map(r=>r.h),...br.map(r=>r.h))*.5;
  if(Math.abs(ay-by)>Math.max(line,.002))return ay-by;
  return Math.min(...ar.map(r=>r.x))-Math.min(...br.map(r=>r.x))||a.created.localeCompare(b.created);
}
function updateNote(text,doc) {
  const start=`<!-- pdf-marcacoes:${doc.id}:start -->`,end=`<!-- pdf-marcacoes:${doc.id}:end -->`;
  const a=text.indexOf(start),b=text.indexOf(end);
  if(a===-1&&b===-1)throw Error('Bloco automático ausente. A nota foi preservada; use Recuperar nota.');
  if(a<0||b<a||text.indexOf(start,a+start.length)>=0||text.indexOf(end,b+end.length)>=0)throw Error('Bloco automático alterado. A nota foi preservada; use Recuperar nota.');
  return text.slice(0,a)+renderBlock(doc)+text.slice(b+end.length);
}
function newNote(doc) {
  const title=doc.pdfPath.split('/').pop().replace(/\.pdf$/i,'');
  return `---\ntags:\n  - tipo/marcacoes-pdf\npdf_marcacoes_id: ${doc.id}\n---\n\n# ${escapeMD(title)} — Marcações\n\n## Minhas anotações\n\nEscreva seus comentários aqui. Os trechos abaixo são atualizados pelo leitor.\n\n${renderBlock(doc)}\n`;
}
module.exports={COLORS,escapeMD,pdfLink,notePath,rotateRect,sameSelection,compareHighlights,renderBlock,updateNote,newNote};
