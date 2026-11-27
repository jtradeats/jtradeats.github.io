/* Own heatmap (plan P8.45): the five sources of the heatmap card (All stocks, S&P 500, Nasdaq 100, Futures, Themes) are live maps. Reads the Worker's /heat (Finviz layout + colours,
   passed through as text), joins them here and draws a squarified treemap on one canvas (5,900 tiles for All stocks would be 5,900 DOM nodes). No library, no third-party script (R32, R59).
   Size = market cap (futures and themes: Finviz's own weights), colour = % change, scale +-3 %.
   At a glance: every tile is labelled at the largest font that fits (never wrapped, 6 px minimum; tall narrow tiles are turned on their side; big stock tiles add the company name),
   every sector/industry title carries its average move (long titles shorten only as far as the width needs: Info, Infra, Div., SW, Digi...), and the row above the map gives the view's average move and advancers / decliners.
   Hover (mouse) pops out Finviz-style figures and outlines the group. Click a title, or a tile (it opens the outlined group), to zoom in at any level; Shift+click opens the top-level
   group; the crumb or Esc goes back. Touch: tap a tile for its pop-out, tap it again to open its group.
   Colours refresh every 60 s while the card is on screen; the layout is read once per map and kept for the session. A failed read keeps the last map and says so.
   Light and dark have their own palettes (light follows the page's soft greens and reds). */
const HEAT_URL=WORKER_URL.replace(/\/market$/,'/heat');
const HM={names:{all:'All stocks',sec:'S&P 500',ndx:'Nasdaq 100',futures:'Futures',themes:'Themes'},base:{},perf:{},err:null,busy:false,POLL:60000,path:[],map:'all',sel:null,selTile:null,rects:null};
const hmStock=m=>m==='all'||m==='sec'||m==='ndx';
const hmDark=()=>typeof dark==='function'?dark():true;
const HM_PAL={
  dark:{stops:[[-3,[246,53,56]],[-2,[191,64,69]],[-1,[139,68,78]],[0,[65,69,84]],[1,[53,118,78]],[2,[47,158,79]],[3,[48,204,90]]],nil:[42,45,54],
    bg:null,h0:'rgba(18,18,20,.82)',h0t:'#d8d8d4',h1:'rgba(18,18,20,.62)',h1t:'#c9c9c3',line:'rgba(0,0,0,.55)',hov:'#f5d94a',hovt:'#fff',up:'#5fbf86',dn:'#e08080',ink:'#fff'},
  light:{stops:[[-3,[194,87,87]],[-2,[213,133,133]],[-1,[230,184,184]],[0,[231,230,225]],[1,[185,216,195]],[2,[130,188,154]],[3,[78,146,105]]],nil:[233,232,228],
    bg:'#ffffff',h0:'#ecebe6',h0t:'#4a4945',h1:'#f3f2ee',h1t:'#76746d',line:'#ffffff',hov:'#c28a12',hovt:'#1c1c1a',up:'#3f7d58',dn:'#b05555',ink:'#1c1c1a'}};
const hmPal=()=>HM_PAL[hmDark()?'dark':'light'];
function hmRGB(p){
  const P=hmPal(),s=P.stops;if(p==null)return P.nil;
  if(p<=s[0][0])return s[0][1];if(p>=s[6][0])return s[6][1];
  let i=1;while(p>s[i][0])i++;const a=s[i-1],b=s[i],f=(p-a[0])/(b[0]-a[0]);
  return a[1].map((v,j)=>Math.round(v+(b[1][j]-v)*f));
}
const hmInk=c=>.299*c[0]+.587*c[1]+.114*c[2]>150?'#1c1c1a':'#fff';   /* dark text on a light tile, white on a dark one */
/* layout and colours -> one tree, with each group's weighted sum, so a title can show its average move. A group whose name is only digits (the themes map's "1") is not a level,
   and a root with one child group is skipped. eq = weight every leaf 1 (futures, themes: their sizes are display weights, not caps). */
function hmMerge(base,perf,eq){
  const pc=(perf&&perf.nodes)||{};let leaves=0,hit=0;
  const walk=n=>{
    if(Array.isArray(n.children)){
      let kids=[];for(const c of n.children){const w=walk(c);if(w.kids&&/^\d+$/.test(w.name))kids=kids.concat(w.kids);else kids.push(w)}
      const o={name:n.name,kids,v:0,sp:0,sw:0,up:0,dn:0,fl:0};
      for(const k of kids){o.v+=k.v;o.sp+=k.sp;o.sw+=k.sw;o.up+=k.up;o.dn+=k.dn;o.fl+=k.fl}
      return o;
    }
    leaves++;const p=pc[n.name],has=typeof p==='number';if(has)hit++;
    const v=n.value>0?n.value:0,w=eq?1:v;
    return{name:n.name,lab:n.displayName||n.name,desc:n.description||'',mem:n.extra||'',v,p:has?p:null,
      sp:has?p*w:0,sw:has?w:0,up:has&&p>=.005?1:0,dn:has&&p<=-.005?1:0,fl:has&&Math.abs(p)<.005?1:0};
  };
  let root=walk(base);while(root.kids&&root.kids.length===1&&root.kids[0].kids)root=root.kids[0];
  return{root,leaves,hit,ok:leaves>0&&hit/leaves>=.8};
}
/* squarified treemap (Bruls, Huizing, van Wijk): rows along the shorter side, a row grows while its worst aspect ratio improves */
function hmSquarify(ns,x,y,w,h){
  const out=[];let tot=0;for(const n of ns)tot+=n.v;if(!(tot>0)||w<1||h<1)return out;
  const k=w*h/tot;let i=0;
  while(i<ns.length){
    const side=Math.min(w,h);let s=0,mn=Infinity,mx=0,j=i,best=Infinity;
    for(;j<ns.length;j++){
      const a=ns[j].v*k;if(!(a>0))break;
      const s2=s+a,mn2=Math.min(mn,a),mx2=Math.max(mx,a),worst=Math.max(side*side*mx2/(s2*s2),s2*s2/(side*side*mn2));
      if(j>i&&worst>best)break;best=worst;s=s2;mn=mn2;mx=mx2;
    }
    if(j===i)break;
    const th=s/side;let p=0;
    for(let q=i;q<j;q++){const a=ns[q].v*k,len=a/th;
      out.push(w>=h?{n:ns[q],x,y:y+p,w:th,h:len}:{n:ns[q],x:x+p,y,w:len,h:th});p+=len}
    if(w>=h){x+=th;w-=th}else{y+=th;h-=th}
    i=j;
  }
  return out;
}
/* groups: depth-first; a group with room gets a title strip, a leaf is a tile. Each group keeps its path from the root (what a click on it opens). `base` = the path of the node on screen. */
function hmLayout(node,w,h,base){
  const tiles=[],groups=[];
  const go=(n,x,y,ww,hh,d,path)=>{
    const kids=n.kids.filter(c=>c.v>0).sort((a,b)=>b.v-a.v);
    for(const r of hmSquarify(kids,x,y,ww,hh)){
      const c=r.n;
      if(c.kids){
        const head=d===0?(r.w>52&&r.h>40?14:0):d===1?(r.w>70&&r.h>46?12:0):0;   /* title strips: the groups of the level on screen (14 px), and one level down the industries inside a sector (12 px) */
        const pa=path.concat(c.name);groups.push({n:c,x:r.x,y:r.y,w:r.w,h:r.h,head,d,path:pa});
        go(c,r.x+1,r.y+head+1,r.w-2,r.h-head-2,d+1,pa);
      }else tiles.push(r);
    }
  };
  go(node,0,0,w,h,0,base||[]);return{tiles,groups};
}
HM.fine=!!(window.matchMedia&&matchMedia('(hover:hover) and (pointer:fine)').matches);
/* What a tile is called. Stocks: the ticker. Themes: the display name. Futures: Finviz's own description (6E = EUR, GC = Gold, ES = S&P 500), not the contract code. */
const hmLabel=(n,map)=>map==='themes'?n.lab:map==='futures'?(n.desc||n.name):n.name;
const hmShort=d=>d.replace(/[\s,]*\b(Inc|Corp|Corporation|Co|Company|Ltd|Limited|Plc|PLC|Holdings|Group|N\.V|S\.A|AG|SE)\b\.?/g,'').replace(/(\s+(&|and))+\s*$/i,'').replace(/\s+/g,' ').trim();   /* 'JPMorgan Chase & Co' -> 'JPMorgan Chase', 'Eli Lilly and Company' -> 'Eli Lilly' */
/* Largest font at which a tile's label never leaves the tile. Text widths scale with the font, so this is closed-form: the ticker (and the % line, 0.8 x the font) must fit the width, both lines the height.
   emw(text,weight) = the text's width in em. The % line needs a font of 7.5 px or more (it is drawn at 0.8 x); without it the ticker alone may go down to 6 px. A big tile adds the company name.
   Returns { fs, pct, nfs } or null: a tile too small for a readable label stays blank (the pop-out names it). Nothing is wrapped. */
function hmFit(emw,txt,pct,w,h,name){
  const W=w-4,H=h-3;if(W<5||H<5)return null;
  const tw=emw(txt,600);if(!(tw>0))return null;
  const cap=Math.min(26,W/tw);
  if(pct){
    const pw=emw(pct,400)*.8,fs=Math.min(cap,pw>0?W/pw:cap,H/2.08);
    if(fs>=7.5){
      let nfs=0;
      if(name){const nw=emw(name,400),f=Math.min(fs*.5,12,nw>0?W/nw:12);if(f>=6.5&&fs*2.08+f*1.25<=H)nfs=f}
      return{fs,pct:true,nfs};
    }
  }
  const fs=Math.min(cap,H/1.12);
  return fs>=6?{fs,pct:false,nfs:0}:null;
}
function hmDrawLabel(g,ff,f,txt,pc,name,cx,cy,maxW,ink){
  const bh=f.fs*1.12+(f.pct?f.fs*.96:0)+(f.nfs?f.nfs*1.25:0),y0=cy-bh/2;
  g.fillStyle=ink;g.textAlign='center';
  g.font=(f.fs>=9?'600 ':'500 ')+f.fs+'px '+ff;g.fillText(txt,cx,y0+f.fs*.56,maxW);
  if(f.pct){g.font='400 '+f.fs*.8+'px '+ff;g.fillText(pc,cx,y0+f.fs*1.12+f.fs*.48,maxW)}
  if(f.nfs){g.globalAlpha=.8;g.font='400 '+f.nfs+'px '+ff;g.fillText(name,cx,y0+f.fs*2.08+f.nfs*.625,maxW);g.globalAlpha=1}
}
const hmCap=v=>v>=1e6?'$'+(v/1e6).toFixed(2)+'T':v>=1e3?'$'+(v/1e3).toFixed(1)+'B':'$'+Math.round(v)+'M'; /* the layout's values are market cap in $ millions */
const hmPct=p=>{if(p==null)return'no figure';const t=p.toFixed(2);return(+t>0?'+':'')+(+t===0?'0.00':t)+'%'}; /* -0.004 reads 0.00%, not -0.00% */
const hmAvg=n=>n.sw>0?n.sp/n.sw:null;
async function hmPull(part,map,fresh){
  const u=HEAT_URL+'?t='+map+(part==='base'?'&part=base':'')+(fresh?'&fresh=1':'');
  return fj(u,part==='base'?20000:12000);
}
async function hmLoad(fresh){
  if(HM.busy){HM.again=true;return}const map=HM.map;HM.busy=true;
  try{
    if(!HM.base[map])HM.base[map]=await hmPull('base',map,false);
    const perf=await hmPull('perf',map,fresh);
    if(!perf||!perf.nodes)throw new Error('bad payload');
    HM.perf[map]={d:perf,at:Date.now()};HM.err=null;
  }catch(e){const m=String(e.message||e);HM.err=m==='404'?'the Worker has no /heat route: deploy the index.js that has it':m}
  HM.busy=false;hmPaint();
  if(HM.again){HM.again=false;hmLoad(false)}
}
HM.load=hmLoad;
function hmRoot(){return HM.el&&HM.el.isConnected?$('.hm',HM.el):null}
function hmVisible(){return !document.hidden&&tab==='heat'&&!!hmRoot()&&!HM.el.closest('.card.closed')}
/* Title abbreviations. A title is only shortened when it does not fit: level 0 = the full name, level 1 = the plain ones (Info, Infra, Div., Mfrs, Equip., Tech, Biotech...),
   level 2 = adds the short forms (SW, Digi, Svcs, Cons., Fin., Semis...); if even that does not fit it ends in an ellipsis. Nothing is ever squeezed. Phrases go before words.
   Each entry: [text, level-1 form, level-2 form]; null = unchanged at that level. Wide screens never get past level 0, so the full names show there. */
const HM_ABBR=[
  ['Information Technology','IT','IT'],['Artificial Intelligence',null,'AI'],['Virtual & Augmented Reality',null,'VR & AR'],['Internet of Things',null,'IoT'],
  ['Oil & Gas',null,'O&G'],['Property & Casualty',null,'P&C'],['Electric Vehicles',null,'EVs'],
  ['Internet Content & Information',null,'Internet & Info'],['Information','Info','Info'],['Infrastructure','Infra','Infra'],['Diversified','Div.','Div.'],['Manufacturers','Mfrs','Mfrs'],['Manufacturing','Mfg','Mfg'],
  ['Equipment','Equip.','Equip.'],['Management','Mgmt','Mgmt'],['International','Intl','Intl'],['Distribution','Distrib.','Distrib.'],['Applications','Apps','Apps'],['Application','App','App'],
  ['Technology','Tech','Tech'],['Telecommunications','Telecom','Telecom'],['Biotechnology','Biotech','Biotech'],['Pharmaceuticals','Pharma','Pharma'],
  ['Residential','Resid.','Resid.'],['Regulated','Reg.','Reg.'],['Independent','Indep.','Indep.'],['Integrated','Integr.','Integr.'],
  ['Software',null,'SW'],['Digital',null,'Digi'],['Services',null,'Svcs'],['Communications',null,'Comms'],['Communication',null,'Comm'],['Consumer',null,'Cons.'],
  ['Semiconductors',null,'Semis'],['Semiconductor',null,'Semi'],['Electronics',null,'Elec.'],['Electronic',null,'Elec.'],['Financial',null,'Fin.'],['Healthcare',null,'Health'],
  ['Industrials',null,'Indust.'],['Industrial',null,'Indust.'],['Materials',null,'Matls'],['Products',null,'Prod.'],['Aerospace',null,'Aero'],['Defense',null,'Def.'],['Defensive',null,'Def.'],
  ['Specialty',null,'Spec.'],['General',null,'Gen.'],['Alcoholic',null,'Alc.'],['Personal',null,'Pers.'],['Education',null,'Edu.'],['Environmental',null,'Env.'],
  ['Transportation',null,'Transp.'],['Cyclical',null,'Cycl.'],['Utilities',null,'Utils'],['Entertainment',null,'Ent.'],['Commodities',null,'Commod.'],['Sustainability',null,'Sustain.']
].map(e=>[new RegExp('\\b'+e[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','g'),e[1],e[2]]);
const hmAbMemo=new Map();
function hmAbbr(name,lv){
  if(!lv)return name;const k=lv+'|'+name;let v=hmAbMemo.get(k);if(v!==undefined)return v;
  v=name;for(const[re,l1,l2]of HM_ABBR){const r=lv>=2?(l2||l1):l1;if(r)v=v.replace(re,r)}
  hmAbMemo.set(k,v);return v;
}
/* the first level at which the title fits `room` px (the canvas font is already set), or null */
function hmHeadText(g,name,upper,room){
  for(let lv=0;lv<=2;lv++){const t=upper?hmAbbr(name,lv).toUpperCase():hmAbbr(name,lv);if(g.measureText(t).width<=room)return t}
  return null;
}
function hmEllipsis(g,t,room){
  if(g.measureText(t).width<=room)return t;
  while(t.length>2&&g.measureText(t+'\u2026').width>room)t=t.slice(0,-1);
  const i=t.search(/\s\S*$/),w=(i>=4?t.slice(0,i):t).replace(/[\s&\-]+$/,'');   /* prefer a cut at a word; if that leaves under 4 letters, cut inside the word */
  const r=w.length>=4?w:t.replace(/[\s&\-]+$/,'');return r.length>2?r+'\u2026':'';
}
const hmSign=v=>v==null?'':v>=0?'hmu':'hmd';
function hmStats(n,stock){
  const a=hmAvg(n);if(a==null)return'';
  return(stock?'cap-weighted ':'average ')+'<b class="'+hmSign(a)+'">'+hmPct(a)+'</b><span class="hmx"><i class="hmu">\u25B2 '+n.up+'</i><i class="hmd">\u25BC '+n.dn+'</i>'+(n.fl?'<i>\u25A0 '+n.fl+'</i>':'')+'</span>';
}
function hmPaint(){
  const root=hmRoot();if(!root)return;
  const map=HM.map,stock=hmStock(map),b=HM.base[map],p=HM.perf[map],st=$('.hms',root),cv=$('canvas',root),P=hmPal();
  if(!b||!p){st.textContent=HM.err?'Map not loaded ('+HM.err+')':'loading\u2026';return}
  const m=HM.merged&&HM.merged.key===map+p.at?HM.merged.v:(HM.merged={key:map+p.at,v:hmMerge(b,p.d,!stock)}).v;
  if(!m.ok){st.textContent='The map layout and the colours do not match ('+m.hit+' of '+m.leaves+' tickers). Try another source.';return}
  let node=m.root;for(const nm of HM.path){const c=node.kids&&node.kids.find(k=>k.name===nm);if(!c||!c.kids){HM.path=[];node=m.root;break}node=c}
  const wrap=cv.parentNode,w=wrap.clientWidth,h=wrap.clientHeight;if(w<20||h<20)return;
  const dpr=window.devicePixelRatio||1;cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);cv.style.width=w+'px';cv.style.height=h+'px';
  const ov=$('.hmo',root);ov.width=cv.width;ov.height=cv.height;ov.style.width=w+'px';ov.style.height=h+'px';hmHover(null);
  const lk=map+'|'+HM.path.join('>')+'|'+w+'x'+h+'|'+p.at+'|'+(hmDark()?'d':'l');
  const L=HM.lay&&HM.lay.key===lk?HM.lay.L:(HM.lay={key:lk,L:hmLayout(node,w,h,HM.path)}).L;HM.rects=L;
  const g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle=P.bg||getComputedStyle(document.documentElement).getPropertyValue('--surface')||'#1b1b1e';g.fillRect(0,0,w,h);
  g.textBaseline='middle';const ff=getComputedStyle(document.body).fontFamily;
  const mw=HM.mw||(HM.mw=new Map()),emw=(t,wt)=>{const k=wt+t;let v=mw.get(k);if(v===undefined){g.font=wt+' 10px '+ff;v=g.measureText(t).width/10;mw.set(k,v)}return v}; /* widths measured once at 10 px, then scaled */
  for(const r of L.tiles){
    const n=r.n,rgb=hmRGB(n.p);g.fillStyle='rgb('+rgb+')';g.fillRect(r.x+.5,r.y+.5,Math.max(0,r.w-1),Math.max(0,r.h-1));
    if(r.w<10||r.h<10)continue;
    const txt=hmLabel(n,map),pc=n.p==null?'\u2014':hmPct(n.p),nm=stock&&r.w>=90&&r.h>=70?hmShort(n.desc):'';
    let f=hmFit(emw,txt,pc,r.w,r.h,nm),rot=false;
    if(!f&&r.h>r.w*1.25){f=hmFit(emw,txt,pc,r.h,r.w,'');rot=!!f}   /* a tall narrow tile: turn the label on its side */
    if(!f)continue;
    const cx=r.x+r.w/2,cy=r.y+r.h/2,ink=hmInk(rgb);
    if(rot){g.save();g.translate(cx,cy);g.rotate(-Math.PI/2);hmDrawLabel(g,ff,f,txt,pc,'',0,0,r.h-2,ink);g.restore()}
    else hmDrawLabel(g,ff,f,txt,pc,nm,cx,cy,r.w-2,ink);
  }
  for(const q of L.groups){ /* outline, and the title strip (name left, average move right) where there is room */
    g.strokeStyle=P.line;g.lineWidth=q.d?1:2;g.strokeRect(q.x+.5,q.y+.5,q.w-1,q.h-1);
    if(q.head){
      const top=q.d===0,fs=top?10:8.5,a=hmAvg(q.n),pc=a==null?'':hmPct(a);
      g.fillStyle=top?P.h0:P.h1;g.fillRect(q.x+1,q.y+1,q.w-2,q.head-1);g.textBaseline='middle';
      const up=!top,nf='600 '+fs+'px '+ff,pf='500 '+fs+'px '+ff,ty=q.y+q.head/2+.5;
      let nmS=null,usePct=false,pw=0;
      if(pc){g.font=pf;pw=g.measureText(pc).width;g.font=nf;nmS=hmHeadText(g,q.n.name,up,q.w-8-pw-8);usePct=!!nmS}   /* name and average move together, shortening the name as needed */
      if(!nmS){g.font=nf;const l2=hmAbbr(q.n.name,2);nmS=hmHeadText(g,q.n.name,up,q.w-8)||hmEllipsis(g,up?l2.toUpperCase():l2,q.w-8)}   /* else the name alone, else its short form cut with an ellipsis */
      if(usePct){g.font=pf;g.textAlign='right';g.fillStyle=a>=0?P.up:P.dn;g.fillText(pc,q.x+q.w-4,ty)}
      g.font=nf;g.textAlign='left';g.fillStyle=top?P.h0t:P.h1t;g.fillText(nmS,q.x+4,ty);
    }
  }
  const crumb=HM.path.length?['<button class="hmc" data-c="-1">'+HM.names[map]+'</button>'].concat(HM.path.map((nm,i)=>'<button class="hmc" data-c="'+i+'">'+esc(nm)+'</button>')).join(' \u203A '):'';
  $('.hmb',root).innerHTML='<span class="hmcr">'+crumb+'</span><span class="hmst">'+hmStats(node,stock)+'</span>';
  const age=Date.now()-p.at;
  $('.hmn',root).textContent='1-day performance \u00B7 updated '+new Date(p.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+(age>=120000?' ('+AGO(age)+' old)':'')+' \u00B7 data: Finviz';
  st.textContent=HM.sel?HM.sel:(HM.err?'Not updated ('+HM.err+'); showing the last map':'');
}
function hmHit(x,y){const L=HM.rects;if(!L)return null;
  for(const r of L.tiles)if(x>=r.x&&x<r.x+r.w&&y>=r.y&&y<r.y+r.h)return r;return null}
const hmIn=(q,x,y)=>x>=q.x&&x<q.x+q.w&&y>=q.y&&y<q.y+q.h;
/* outline the hovered group on the overlay canvas (cheap: the map itself is not redrawn) and show its pop-out; over a title strip the pop-out sums up that group */
function hmHover(pt){
  const root=hmRoot();if(!root)return;
  const ov=$('.hmo',root),tip=$('.hmtip',root),g=ov.getContext('2d'),dpr=window.devicePixelRatio||1,P=hmPal();
  g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,ov.width,ov.height);
  const mp=HM.map,stock=hmStock(mp),themes=mp==='themes',colr=p=>p==null?'var(--t3)':p>=0?P.up:P.dn,lab=k=>hmLabel(k,mp);
  const place=()=>{const W=ov.clientWidth,H=ov.clientHeight,tw=tip.offsetWidth,th=tip.offsetHeight;
    tip.style.left=Math.max(4,Math.min(W-tw-4,pt.x+16>W-tw-4?pt.x-tw-16:pt.x+16))+'px';tip.style.top=Math.max(4,Math.min(H-th-4,pt.y+16))+'px'};
  const t=pt&&hmHit(pt.x,pt.y);
  if(!pt){tip.hidden=true;HM.hov=null;return}
  const gs=HM.rects?HM.rects.groups.filter(q=>hmIn(q,pt.x,pt.y)):[];
  if(!t){
    const hd=gs.slice().reverse().find(q=>q.head&&pt.y<q.y+q.head);
    if(!hd){tip.hidden=true;HM.hov=null;return}
    g.strokeStyle=P.hov;g.lineWidth=2;g.strokeRect(hd.x+1,hd.y+1,hd.w-2,hd.h-2);
    tip.innerHTML='<div class="hmth">'+esc(hd.path.join(' \u2013 '))+'</div><div class="hmst2">'+hmStats(hd.n,stock)+'</div><div class="hmts">click to open</div>';
    tip.hidden=false;place();HM.hov=null;return;
  }
  const inner=gs[gs.length-1],top=gs[0];  /* groups come outer first, so the last match is the innermost */
  if(inner){g.strokeStyle=P.hov;g.lineWidth=2;g.strokeRect(inner.x+1,inner.y+1,inner.w-2,inner.h-2)}
  g.strokeStyle=P.hovt;g.lineWidth=1.5;g.strokeRect(t.x+.5,t.y+.5,t.w-1,t.h-1);
  const n=t.n,rows=(inner?inner.n.kids.filter(k=>!k.kids).slice().sort((a,b)=>stock?b.v-a.v:Math.abs(b.p||0)-Math.abs(a.p||0)).slice(0,8):[n]);   /* stocks: the biggest names; futures: the biggest movers (their sizes are fixed weights) */
  const title=top&&inner&&top!==inner?top.n.name+' \u2013 '+inner.n.name:(inner?inner.n.name:'');
  tip.innerHTML='<div class="hmth">'+esc(title)+'</div>'
    +'<div class="hmtm"><b>'+esc(lab(n))+'</b><span style="color:'+colr(n.p)+'">'+hmPct(n.p)+'</span></div>'
    +'<div class="hmts">'+esc(stock?(n.desc||''):themes?(n.desc||''):n.name)+(stock?' \u00B7 cap '+hmCap(n.v):'')+(themes&&n.mem?' \u00B7 '+esc(n.mem.split(',').slice(0,10).join(' ')):'')+'</div>'
    +(themes?'':'<div class="hmtl'+(stock?'':' nc')+'">'+rows.map(k=>'<div'+(k===n?' class="me"':'')+'><span>'+esc(stock?k.name:lab(k))+'</span><span class="c">'+(stock?hmCap(k.v):'')+'</span><span style="color:'+colr(k.p)+'">'+hmPct(k.p)+'</span></div>').join('')+'</div>');
  tip.hidden=false;place();HM.hov=t;
}
function hmHome(){HM.path=[];HM.sel=null;HM.selTile=null}   /* the quick exit: clicking the map's own button in the card header while zoomed in goes back to the overview */
function hmOpen(path){HM.path=path.slice();HM.sel=null;HM.selTile=null;hmPaint()}
function hmTileLine(n){const mp=HM.map;return mp==='themes'?n.lab+' \u00B7 '+n.desc+' \u00B7 '+hmPct(n.p)+(n.mem?' \u00B7 '+n.mem.split(',').slice(0,12).join(' '):''):mp==='futures'?hmLabel(n,mp)+' ('+n.name+') \u00B7 '+hmPct(n.p):n.name+' \u00B7 '+(n.desc||'')+' \u00B7 '+hmPct(n.p)+' \u00B7 cap '+hmCap(n.v)}
function hmLegend(){return hmPal().stops.map(s=>'<i style="background:rgb('+s[1]+');color:'+hmInk(s[1])+'">'+(s[0]>0?'+':s[0]<0?'\u2212':'')+Math.abs(s[0])+'%</i>').join('')}
/* one source of the heatmap card = one map: the card's own source buttons choose it, so there is no second picker in the body */
function hmOwn(el,map){
  if(HM.map!==map){HM.path=[];HM.sel=null;HM.selTile=null;HM.map=map}
  el.innerHTML='<div class="hm"><div class="hmb"></div><div class="hmw"><canvas></canvas><canvas class="hmo"></canvas><div class="hmtip" hidden></div></div><div class="hms"></div><div class="hmf"><span class="hmn"></span><span class="hmg">'+hmLegend()+'</span></div></div>';
  HM.el=el;const root=$('.hm',el),cv=$('canvas',root);
  root.addEventListener('click',e=>{const cb=e.target.closest('[data-c]');if(cb){HM.path=HM.path.slice(0,+cb.dataset.c+1);HM.sel=null;HM.selTile=null;hmPaint()}});
  cv.addEventListener('click',e=>{
    const b=cv.getBoundingClientRect(),x=e.clientX-b.left,y=e.clientY-b.top,L=HM.rects;if(!L)return;
    const gs=L.groups.filter(q=>hmIn(q,x,y)),hd=gs.slice().reverse().find(q=>q.head&&y<q.y+q.head);
    if(hd){hmOpen(hd.path);return}                                  /* a title strip opens its own group, at any level */
    const t=hmHit(x,y);if(!t){HM.selTile=null;hmHover(null);return}
    const target=e.shiftKey?gs[0]:gs[gs.length-1];                  /* the outlined (innermost) group; none when the view is already one group of tiles */
    if(!target){HM.sel=hmTileLine(t.n);HM.selTile=null;hmPaint();hmHover({x,y});return}
    if(HM.fine||HM.selTile===t.n){hmOpen(target.path);return}
    HM.selTile=t.n;HM.sel=hmLabel(t.n,HM.map)+' \u00B7 '+hmPct(t.n.p)+' \u00B7 tap again to open '+target.n.name;hmPaint();hmHover({x,y});   /* touch: first tap = pop-out */
  });
  cv.addEventListener('pointermove',e=>{if(e.pointerType!=='mouse')return;const b=cv.getBoundingClientRect();hmHover({x:e.clientX-b.left,y:e.clientY-b.top})});
  cv.addEventListener('pointerleave',()=>hmHover(null));
  if(!HM.keyed){HM.keyed=true;window.addEventListener('keydown',e=>{if(e.key==='Escape'&&hmRoot()&&HM.path.length){HM.path.pop();HM.sel=null;HM.selTile=null;hmPaint()}})}
  if(window.ResizeObserver){let t;new ResizeObserver(()=>{clearTimeout(t);t=setTimeout(hmPaint,80)}).observe($('.hmw',root))}
  const p=HM.perf[map];hmPaint();
  if(!p||Date.now()-p.at>HM.POLL)hmLoad(false);
  if(!HM.timer)HM.timer=setInterval(()=>{if(hmVisible())hmLoad(false)},HM.POLL);
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&hmVisible()){const p=HM.perf[HM.map];if(!p||Date.now()-p.at>HM.POLL)hmLoad(false)}});
