// functions/_monthly-pdf.js — minimal multi-page PDF writer for the monthly report.
// Ported from Linalysis worker/monthly-report-block.js (MrPdf), extended to N pages.
// Base-14 Helvetica only, filled rectangles + text. No dependencies, runs in Workers.

const HELV_W=[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,1000,333,1000,500,333,944,350,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500];
const HELVB_W=[278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,350,556,350,278,556,500,1000,556,556,333,1000,667,333,1000,350,611,350,350,278,278,500,500,350,556,1000,333,1000,556,333,944,350,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556];
const WINMAP={0x2013:0x96,0x2014:0x97,0x2018:0x91,0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2022:0x95,0x2026:0x85,0x2212:0x2D,0x2248:0x7E,0x00B7:0xB7,0x2192:0xBB};
function winByte(cp){ if(cp<32)return 32; if(cp<127)return cp; if(WINMAP[cp]!=null)return WINMAP[cp]; if(cp>=160&&cp<=255)return cp; return 63; }
function toWin(s){ let o=''; for(const ch of String(s)) o+=String.fromCharCode(winByte(ch.codePointAt(0))); return o; }
export function strWidth(s,bold,size){ const T=bold?HELVB_W:HELV_W; let w=0; for(const ch of String(s)){ const b=winByte(ch.codePointAt(0)); w+=T[b-32]!=null?T[b-32]:500; } return w*size/1000; }
function esc(s){ let o=''; for(const ch of toWin(s)){ if(ch==='('||ch===')'||ch==='\\') o+='\\'; o+=ch; } return o; }
const n2=v=>(Math.round(v*100)/100).toString();
// Trim a string with an ellipsis so it fits maxW.
export function fit(s,bold,size,maxW){ s=String(s||''); if(strWidth(s,bold,size)<=maxW) return s; while(s.length>1&&strWidth(s+'…',bold,size)>maxW) s=s.slice(0,-1); return s+'…'; }

export function Pdf(w,h){ this.w=w; this.h=h; this.pages=[[]]; this.ops=this.pages[0]; this._c=null; }
Pdf.prototype.addPage=function(){ this.ops=[]; this.pages.push(this.ops); this._c=null; };
Pdf.prototype._col=function(c){ const k=c.join(','); if(this._c!==k){ this.ops.push(`${n2(c[0])} ${n2(c[1])} ${n2(c[2])} rg`); this._c=k; } };
Pdf.prototype.rect=function(x,y,w,h,c){ if(w<=0||h<=0)return; this._col(c); this.ops.push(`${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)} re f`); };
Pdf.prototype.line=function(x0,y,x1,c,lw){ this.rect(x0,y,x1-x0,lw||0.5,c); };
Pdf.prototype.box=function(x,y,w,h,fill,rule){ this.rect(x,y,w,h,fill); this.line(x,y,x+w,rule,0.5); this.line(x,y+h-0.5,x+w,rule,0.5); this.rect(x,y,0.5,h,rule); this.rect(x+w-0.5,y,0.5,h,rule); };
Pdf.prototype.text=function(x,y,s,size,bold,c){ if(s==null||s==='')return; this._col(c); this.ops.push(`BT ${bold?'/F2':'/F1'} ${n2(size)} Tf 1 0 0 1 ${n2(x)} ${n2(y)} Tm (${esc(s)}) Tj ET`); this._c=null; };
Pdf.prototype.rtext=function(x,y,s,size,bold,c){ this.text(x-strWidth(s,bold,size),y,s,size,bold,c); };
Pdf.prototype.ctext=function(x,y,s,size,bold,c){ this.text(x-strWidth(s,bold,size)/2,y,s,size,bold,c); };
Pdf.prototype.bytes=function(){
  const objs=[null,'<</Type/Catalog/Pages 2 0 R>>',null,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>'];
  const kids=[];
  for(const ops of this.pages){
    const content=ops.join('\n'); const pi=objs.length, ci=pi+1; kids.push(`${pi} 0 R`);
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${this.w} ${this.h}]/Resources<</Font<</F1 3 0 R/F2 4 0 R>>>>/Contents ${ci} 0 R>>`);
    objs.push(`<</Length ${content.length}>>\nstream\n${content}\nendstream`);
  }
  objs[2]=`<</Type/Pages/Kids[${kids.join(' ')}]/Count ${this.pages.length}>>`;
  let out='%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const off=[];
  for(let i=1;i<objs.length;i++){ off[i]=out.length; out+=`${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref=out.length; let x=`xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for(let i=1;i<objs.length;i++) x+=String(off[i]).padStart(10,'0')+' 00000 n \n';
  out+=x+`trailer\n<</Size ${objs.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  const u8=new Uint8Array(out.length); for(let i=0;i<out.length;i++) u8[i]=out.charCodeAt(i)&0xFF; return u8;
};
Pdf.prototype.base64=function(){ const u8=this.bytes(); let bin=''; for(let i=0;i<u8.length;i++) bin+=String.fromCharCode(u8[i]); return (typeof btoa==='function')?btoa(bin):Buffer.from(u8).toString('base64'); };
