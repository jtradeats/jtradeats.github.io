/* Own heatmap (plan P8.45): the heatmap card's "Live map" source. Reads the Worker's /heat (Finviz layout + colours, passed through as text),
   joins them here, and draws a squarified treemap on one canvas (5,900 tiles for All stocks would be 5,900 DOM nodes). No library, no third-party script (R32, R59).
   Size = market cap (themes: equal), colour = % change, scale +-3 % as on Finviz. Click a group title, or any tile (it opens the outlined group), to zoom into it at any level; Shift+click opens the top-level group; the crumb or Esc goes back. Touch: tap a tile for its pop-out, tap it again to open its group.
   Hover (mouse) shows a pop-out like Finviz's: the group's title, the tile's figures and the group's biggest names; the group is outlined. Industries are titled inside each sector.
   Colours refresh every 60 s while the card is on screen; the layout is read once per map and kept for the session. A failed read keeps the last map and says so. */
const HEAT_URL=WORKER_URL.replace(/\/market$/,'/heat');
const HM={maps:[['all','All stocks'],['sec','S&P 500'],['ndx','Nasdaq 100'],['futures','Futures'],['themes','Themes']],
  base:{},perf:{},err:null,busy:false,at:0,POLL:60000,view:null,rects:null,sel:null,path:[]};
const hmMap=()=>{const m=LS.g(KEY+'heatmap','all');return HM.maps.some(x=>x[0]===m)?m:'all'};
/* the scale: Finviz's seven stops, -3 % to +3 %; no figure = grey */
const HM_STOPS=[[-3,[246,53,56]],[-2,[191,64,69]],[-1,[139,68,78]],[0,[65,69,84]],[1,[53,118,78]],[2,[47,158,79]],[3,[48,204,90]]];
function hmCol(p){
  if(p==null)return'#2a2d36';
  const s=HM_STOPS;if(p<=s[0][0])return'rgb('+s[0][1]+')';if(p>=s[6][0])return'rgb('+s[6][1]+')';
  let i=1;while(p>s[i][0])i++;const a=s[i-1],b=s[i],f=(p-a[0])/(b[0]-a[0]);
  return'rgb('+a[1].map((v,j)=>Math.round(v+(b[1][j]-v)*f))+')';
}
/* layout and colours -> one tree. A group whose name is only digits (the themes map's "1") is not a level, and a root with one child group is skipped. */
function hmMerge(base,perf){
  const pc=(perf&&perf.nodes)||{};let leaves=0,hit=0;
  const walk=n=>{
    if(Array.isArray(n.children)){
      let kids=[];for(const c of n.children){const w=walk(c);if(w.kids&&/^\d+$/.test(w.name))kids=kids.concat(w.kids);else kids.push(w)}
      return{name:n.name,kids,v:kids.reduce((a,k)=>a+k.v,0)};
    }
    leaves++;const p=pc[n.name],has=typeof p==='number';if(has)hit++;
    return{name:n.name,lab:n.displayName||n.name,desc:n.description||'',mem:n.extra||'',v:n.value>0?n.value:0,p:has?p:null};
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
/* groups: depth-first; a group with room gets a 13 px title strip, a leaf is a tile. Returns {tiles, groups} in canvas pixels. */
function hmLayout(node,w,h,base){
  const tiles=[],groups=[];
  const go=(n,x,y,ww,hh,d,path)=>{
    const kids=n.kids.filter(c=>c.v>0).sort((a,b)=>b.v-a.v);
    for(const r of hmSquarify(kids,x,y,ww,hh)){
      const c=r.n;
      if(c.kids){
        const head=d===0?(r.w>52&&r.h>40?13:0):d===1?(r.w>70&&r.h>46?11:0):0;   /* title strips: the groups of the level on screen (13 px) and, one level down, the industries inside a sector (11 px) */
        const pa=path.concat(c.name);groups.push({n:c,x:r.x,y:r.y,w:r.w,h:r.h,head,d,path:pa});   /* path = names from the root: what a click on this group opens */
        go(c,r.x+1,r.y+head+1,r.w-2,r.h-head-2,d+1,pa);
      }else tiles.push(r);
    }
  };
  go(node,0,0,w,h,0,base||[]);return{tiles,groups};
}
HM.fine=!!(window.matchMedia&&matchMedia('(hover:hover) and (pointer:fine)').matches);
/* What a tile is called. Stocks: the ticker. Themes: the display name. Futures: Finviz's own description (6E = EUR, GC = Gold, ES = S&P 500), not the contract code. */
const hmLabel=(n,map)=>map==='themes'?n.lab:map==='futures'?(n.desc||n.name):n.name;
/* Largest font (6.5 to 22 px) at which a tile's label, wrapped on spaces where `wrap`, and its % line fit inside w x h; the % line goes first when space is short.
   emw(text,weight) = the text's width in em. Returns { fs, lines, pct } or null: a tile too small for a readable label stays blank (the pop-out names it). */
function hmFit(emw,txt,pct,w,h,wrap){
  const words=wrap?txt.split(/\s+/).filter(Boolean):[txt],ww=words.map(x=>emw(x,600)),sp=emw(' ',600),pw=pct?emw(pct,400)*.8:0,W=w-4,top=Math.min(22,h*.5);
  for(const withPct of(pct?[true,false]:[false])){
    for(let fs=top;fs>=6.5;fs-=.5){
      if(withPct&&pw*fs>W)continue;
      let lines=[],cur='',cw=0,ok=true;
      for(let i=0;i<words.length;i++){
        const wi=ww[i]*fs;if(wi>W){ok=false;break}
        if(!cur){cur=words[i];cw=wi}else if(cw+sp*fs+wi<=W){cur+=' '+words[i];cw+=sp*fs+wi}else{lines.push(cur);cur=words[i];cw=wi}
      }
      if(!ok)continue;lines.push(cur);
      if(lines.length*fs*1.12+(withPct?fs*.96:0)<=h-3)return{fs,lines,pct:withPct};
    }
  }
  return null;
}
const hmCap=v=>v>=1e6?'$'+(v/1e6).toFixed(2)+'T':v>=1e3?'$'+(v/1e3).toFixed(1)+'B':'$'+Math.round(v)+'M'; /* the layout's values are market cap in $ millions */
const hmPct=p=>{if(p==null)return'no figure';const t=p.toFixed(2);return(+t>0?'+':'')+(+t===0?'0.00':t)+'%'}; /* -0.004 reads 0.00%, not -0.00% */
async function hmPull(part,map,fresh){
  const u=HEAT_URL+'?t='+map+(part==='base'?'&part=base':'')+(fresh?'&fresh=1':'');
  return fj(u,part==='base'?20000:12000);
}
async function hmLoad(fresh){
  if(HM.busy){HM.again=true;return}const map=hmMap();HM.busy=true;
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
function hmPaint(){
  const root=hmRoot();if(!root)return;
  const map=hmMap(),b=HM.base[map],p=HM.perf[map],st=$('.hms',root),cv=$('canvas',root);
  root.querySelectorAll('[data-m]').forEach(x=>x.classList.toggle('on',x.dataset.m===map));
  if(!b||!p){st.textContent=HM.err?'Map not loaded ('+HM.err+'). Try another source.':'loading…';return}
  const m=HM.merged&&HM.merged.key===map+p.at?HM.merged.v:(HM.merged={key:map+p.at,v:hmMerge(b,p.d)}).v;
  if(!m.ok){st.textContent='The map layout and the colours do not match ('+m.hit+' of '+m.leaves+' tickers). Try another source.';return}
  HM.cur=m;
  let node=m.root;for(const nm of HM.path){const c=node.kids&&node.kids.find(k=>k.name===nm);if(!c||!c.kids){HM.path=[];node=m.root;break}node=c}
  const wrap=cv.parentNode,w=wrap.clientWidth,h=wrap.clientHeight;if(w<20||h<20)return;
  const dpr=window.devicePixelRatio||1;cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);cv.style.width=w+'px';cv.style.height=h+'px';const ov=$('.hmo',root);ov.width=cv.width;ov.height=cv.height;ov.style.width=w+'px';ov.style.height=h+'px';hmHover(null);
  const lk=map+'|'+HM.path.join('>')+'|'+w+'x'+h+'|'+p.at;
  const L=HM.lay&&HM.lay.key===lk?HM.lay.L:(HM.lay={key:lk,L:hmLayout(node,w,h,HM.path)}).L;HM.rects=L;
  const g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--surface')||'#1b1b1e';g.fillRect(0,0,w,h);
  g.textBaseline='middle';const ff=getComputedStyle(document.body).fontFamily;
  const mw=HM.mw||(HM.mw=new Map()),emw=(t,wt)=>{const k=wt+t;let v=mw.get(k);if(v===undefined){g.font=wt+' 10px '+ff;v=g.measureText(t).width/10;mw.set(k,v)}return v}; /* text widths are measured once, at 10 px, and scaled */
  for(const r of L.tiles){
    const n=r.n;g.fillStyle=hmCol(n.p);g.fillRect(r.x+.5,r.y+.5,Math.max(0,r.w-1),Math.max(0,r.h-1));
    if(r.w>=16&&r.h>=10){
      const pc=n.p==null?'\u2014':hmPct(n.p),f=hmFit(emw,hmLabel(n,map),pc,r.w,r.h,map!=='all'&&map!=='sec'&&map!=='ndx');
      if(f){
        const lh=f.fs*1.12,ph=f.pct?f.fs*.96:0,bh=f.lines.length*lh+ph,cx=r.x+r.w/2;let y=r.y+(r.h-bh)/2+lh/2;
        g.fillStyle='#fff';g.textAlign='center';g.font='600 '+f.fs+'px '+ff;
        for(const ln of f.lines){g.fillText(ln,cx,y,r.w-2);y+=lh}
        if(f.pct){g.font='400 '+f.fs*.8+'px '+ff;g.fillText(pc,cx,y-lh/2+ph/2+lh*.08,r.w-2)}
      }
    }
  }
  for(const q of L.groups){ /* outline, and the title strip where there is room */
    g.strokeStyle='rgba(0,0,0,.55)';g.lineWidth=q.d?1:2;g.strokeRect(q.x+.5,q.y+.5,q.w-1,q.h-1);
    if(q.head){const top=q.d===0;g.fillStyle=top?'rgba(18,18,20,.82)':'rgba(18,18,20,.62)';g.fillRect(q.x+1,q.y+1,q.w-2,q.head-1);g.fillStyle=top?'#d8d8d4':'#c9c9c3';g.textAlign='left';
      g.font=(top?'600 10px ':'600 8.5px ')+ff;g.fillText(top?q.n.name:q.n.name.toUpperCase(),q.x+4,q.y+q.head/2+.5,q.w-8)}
  }
  const age=Math.round((Date.now()-p.at)/60000);
  const crumb=['<button class="hmc" data-c="-1">'+HM.maps.find(x=>x[0]===map)[1]+'</button>'].concat(HM.path.map((nm,i)=>'<button class="hmc" data-c="'+i+'">'+esc(nm)+'</button>')).join(' › ');
  $('.hmb',root).innerHTML=crumb;
  $('.hmn',root).textContent=HM.maps.find(x=>x[0]===map)[1]+' · 1-day performance · colours fetched '+new Date(p.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  st.textContent=HM.sel?HM.sel:(HM.err?'Not updated ('+HM.err+'); showing the last map, '+AGO(Date.now()-p.at)+' old':(HM.fine?'hover for figures · click a title or tile to open it · Esc goes back':'tap a tile for its figures, tap again to open it')+(age>=2?' · colours '+AGO(Date.now()-p.at)+' old':''));
}
function hmHit(x,y){const L=HM.rects;if(!L)return null;
  for(const r of L.tiles)if(x>=r.x&&x<r.x+r.w&&y>=r.y&&y<r.y+r.h)return r;return null}
const hmIn=(q,x,y)=>x>=q.x&&x<q.x+q.w&&y>=q.y&&y<q.y+q.h;
/* outline the hovered group on the overlay canvas (cheap: the map itself is not redrawn) and show its pop-out */
function hmHover(pt){
  const root=hmRoot();if(!root)return;
  const ov=$('.hmo',root),tip=$('.hmtip',root),g=ov.getContext('2d'),dpr=window.devicePixelRatio||1;
  g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,ov.width,ov.height);
  const t=pt&&hmHit(pt.x,pt.y);
  if(!t){tip.hidden=true;HM.hov=null;return}
  const gs=HM.rects.groups.filter(q=>hmIn(q,pt.x,pt.y)),inner=gs[gs.length-1],top=gs[0];  /* groups come outer first, so the last match is the innermost */
  if(inner){g.strokeStyle='#f5d94a';g.lineWidth=2;g.strokeRect(inner.x+1,inner.y+1,inner.w-2,inner.h-2)}
  g.strokeStyle='#fff';g.lineWidth=1.5;g.strokeRect(t.x+.5,t.y+.5,t.w-1,t.h-1);
  const mp=hmMap(),n=t.n,themes=mp==='themes',stock=mp==='all'||mp==='sec'||mp==='ndx',lab=k=>hmLabel(k,mp),colr=p=>p==null?'var(--t3)':p>=0?'#5fbf86':'#e08080';
  const rows=(inner?inner.n.kids.filter(k=>!k.kids).slice().sort((a,b)=>stock?b.v-a.v:Math.abs(b.p||0)-Math.abs(a.p||0)).slice(0,8):[n]);   /* stocks: the biggest names; futures: the biggest movers (their sizes are fixed weights) */
  const title=top&&inner&&top!==inner?top.n.name+' – '+inner.n.name:(inner?inner.n.name:'');
  tip.innerHTML='<div class="hmth">'+esc(title)+'</div>'
    +'<div class="hmtm"><b>'+esc(lab(n))+'</b><span style="color:'+colr(n.p)+'">'+hmPct(n.p)+'</span></div>'
    +'<div class="hmts">'+esc(stock?(n.desc||''):themes?(n.desc||''):n.name)+(stock?' · cap '+hmCap(n.v):'')+(themes&&n.mem?' · '+esc(n.mem.split(',').slice(0,10).join(' ')):'')+'</div>'
    +(themes?'':'<div class="hmtl'+(stock?'':' nc')+'">'+rows.map(k=>'<div'+(k===n?' class="me"':'')+'><span>'+esc(stock?k.name:lab(k))+'</span><span class="c">'+(stock?hmCap(k.v):'')+'</span><span style="color:'+colr(k.p)+'">'+hmPct(k.p)+'</span></div>').join('')+'</div>');
  tip.hidden=false;
  const W=ov.clientWidth,H=ov.clientHeight,tw=tip.offsetWidth,th=tip.offsetHeight;
  tip.style.left=Math.max(4,Math.min(W-tw-4,pt.x+16>W-tw-4?pt.x-tw-16:pt.x+16))+'px';
  tip.style.top=Math.max(4,Math.min(H-th-4,pt.y+16))+'px';
  HM.hov=t;
}
function hmOpen(path){HM.path=path.slice();HM.sel=null;HM.selTile=null;hmPaint()}
function hmTileLine(n){const mp=hmMap();return mp==='themes'?n.lab+' · '+n.desc+' · '+hmPct(n.p)+(n.mem?' · '+n.mem.split(',').slice(0,12).join(' '):''):mp==='futures'?hmLabel(n,mp)+' ('+n.name+') · '+hmPct(n.p):n.name+' · '+(n.desc||'')+' · '+hmPct(n.p)+' · cap '+hmCap(n.v)}
function hmOwn(el){
  el.innerHTML='<div class="hm"><div class="hmt"><div class="seg">'+HM.maps.map(m=>'<button class="pbtn" data-m="'+m[0]+'">'+m[1]+'</button>').join('')+'</div></div><div class="hmb"></div><div class="hmw"><canvas></canvas><canvas class="hmo"></canvas><div class="hmtip" hidden></div></div><div class="hms"></div><div class="hmf"><span class="hmn"></span><span class="hmg">'+HM_STOPS.map(s=>'<i style="background:rgb('+s[1]+')">'+(s[0]>0?'+':s[0]<0?'−':'')+Math.abs(s[0])+'%</i>').join('')+'</span></div></div>';
  HM.el=el;HM.path=[];HM.sel=null;const root=$('.hm',el),cv=$('canvas',root);
  root.addEventListener('click',e=>{
    const mb=e.target.closest('[data-m]');if(mb){LS.s(KEY+'heatmap',mb.dataset.m);HM.path=[];HM.sel=null;hmPaint();hmLoad(false);return}
    const cb=e.target.closest('[data-c]');if(cb){HM.path=HM.path.slice(0,+cb.dataset.c+1);HM.sel=null;hmPaint()}
  });
  cv.addEventListener('click',e=>{
    const b=cv.getBoundingClientRect(),x=e.clientX-b.left,y=e.clientY-b.top,L=HM.rects;if(!L)return;
    const gs=L.groups.filter(q=>hmIn(q,x,y)),hd=gs.slice().reverse().find(q=>q.head&&y<q.y+q.head);
    if(hd){hmOpen(hd.path);return}                                  /* a title strip opens its own group, at any level */
    const t=hmHit(x,y);if(!t){HM.selTile=null;hmHover(null);return}
    const target=e.shiftKey?gs[0]:gs[gs.length-1];                  /* the outlined (innermost) group; none when the view is already one group of tiles */
    if(!target){HM.sel=hmTileLine(t.n);HM.selTile=null;hmPaint();hmHover({x,y});return}
    if(HM.fine||HM.selTile===t.n){hmOpen(target.path);return}
    HM.selTile=t.n;HM.sel=hmLabel(t.n,hmMap())+' · '+hmPct(t.n.p)+' · tap again to open '+target.n.name;hmPaint();hmHover({x,y});   /* touch: first tap = pop-out */
  });
  cv.addEventListener('pointermove',e=>{if(e.pointerType!=='mouse')return;const b=cv.getBoundingClientRect();hmHover({x:e.clientX-b.left,y:e.clientY-b.top})});
  cv.addEventListener('pointerleave',()=>hmHover(null));
  if(!HM.keyed){HM.keyed=true;window.addEventListener('keydown',e=>{if(e.key==='Escape'&&hmRoot()&&HM.path.length){HM.path.pop();HM.sel=null;hmPaint()}})}
  if(window.ResizeObserver){let t;new ResizeObserver(()=>{clearTimeout(t);t=setTimeout(hmPaint,80)}).observe($('.hmw',root))}
  const p=HM.perf[hmMap()];hmPaint();
  if(!p||Date.now()-p.at>HM.POLL)hmLoad(false);
  if(!HM.timer)HM.timer=setInterval(()=>{if(hmVisible())hmLoad(false)},HM.POLL);
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&hmVisible()){const p=HM.perf[hmMap()];if(!p||Date.now()-p.at>HM.POLL)hmLoad(false)}});
