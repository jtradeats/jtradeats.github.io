/* Own heatmap (plan P8.45): the heatmap card's "Live map" source. Reads the Worker's /heat (Finviz layout + colours, passed through as text),
   joins them here, and draws a squarified treemap on one canvas (5,900 tiles for All stocks would be 5,900 DOM nodes). No library, no third-party script (R32, R59).
   Size = market cap (themes: equal), colour = % change, scale +-3 % as on Finviz. Click a sector (or industry) to zoom, the crumb or Esc to go back; tap a tile for its line.
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
function hmLayout(node,w,h){
  const tiles=[],groups=[];
  const go=(n,x,y,ww,hh,d)=>{
    const kids=n.kids.filter(c=>c.v>0).sort((a,b)=>b.v-a.v);
    for(const r of hmSquarify(kids,x,y,ww,hh)){
      const c=r.n;
      if(c.kids){
        const head=d===0&&r.w>52&&r.h>40?13:0;   /* a title strip only on the groups of the level on screen; the levels below keep a 1 px frame */
        groups.push({n:c,x:r.x,y:r.y,w:r.w,h:r.h,head,d});
        go(c,r.x+1,r.y+head+1,r.w-2,r.h-head-2,d+1);
      }else tiles.push(r);
    }
  };
  go(node,0,0,w,h,0);return{tiles,groups};
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
  }catch(e){HM.err=String(e.message||e)}
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
  const dpr=window.devicePixelRatio||1;cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);cv.style.width=w+'px';cv.style.height=h+'px';
  const L=hmLayout(node,w,h);HM.rects=L;
  const g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--surface')||'#1b1b1e';g.fillRect(0,0,w,h);
  g.textBaseline='middle';const ff=getComputedStyle(document.body).fontFamily;
  for(const r of L.tiles){
    const n=r.n;g.fillStyle=hmCol(n.p);g.fillRect(r.x+.5,r.y+.5,Math.max(0,r.w-1),Math.max(0,r.h-1));
    if(r.w>30&&r.h>17){
      const txt=map==='themes'?n.lab:n.name,fs=Math.max(8,Math.min(22,r.w/(txt.length*.62+.8),r.h/2.6));
      if(fs>=8&&txt.length*fs*.55<r.w){
        g.fillStyle='#fff';g.textAlign='center';g.font='600 '+fs+'px '+ff;
        const cx=r.x+r.w/2,cy=r.y+r.h/2,two=r.h>fs*2.3;
        g.fillText(txt,cx,two?cy-fs*.55:cy);
        if(two){g.font='400 '+Math.max(8,fs*.8)+'px '+ff;g.fillText(hmPct(n.p).replace('no figure','—'),cx,cy+fs*.6)}
      }
    }
  }
  for(const q of L.groups){ /* outline, and the title strip where there is room */
    g.strokeStyle='rgba(0,0,0,.55)';g.lineWidth=q.d?1:2;g.strokeRect(q.x+.5,q.y+.5,q.w-1,q.h-1);
    if(q.head){g.fillStyle='rgba(18,18,20,.82)';g.fillRect(q.x+1,q.y+1,q.w-2,q.head-1);g.fillStyle='#d8d8d4';g.textAlign='left';g.font='600 10px '+getComputedStyle(document.body).fontFamily;
      g.fillText(q.n.name,q.x+4,q.y+7.5,q.w-8)}
  }
  const age=Math.round((Date.now()-p.at)/60000);
  const crumb=['<button class="hmc" data-c="-1">'+HM.maps.find(x=>x[0]===map)[1]+'</button>'].concat(HM.path.map((nm,i)=>'<button class="hmc" data-c="'+i+'">'+esc(nm)+'</button>')).join(' › ');
  $('.hmb',root).innerHTML=crumb;
  st.textContent=HM.sel?HM.sel:(HM.err?'Not updated ('+HM.err+'); showing the last map, '+AGO(Date.now()-p.at)+' old':(map==='futures'||map==='themes'?'':'tap a tile for its figures')+(age>=2?' · colours '+AGO(Date.now()-p.at)+' old':''));
}
function hmHit(x,y){const L=HM.rects;if(!L)return null;
  for(const r of L.tiles)if(x>=r.x&&x<r.x+r.w&&y>=r.y&&y<r.y+r.h)return r;return null}
function hmOwn(el){
  el.innerHTML='<div class="hm"><div class="hmt"><div class="seg">'+HM.maps.map(m=>'<button class="pbtn" data-m="'+m[0]+'">'+m[1]+'</button>').join('')+'</div></div><div class="hmb"></div><div class="hmw"><canvas></canvas></div><div class="hms"></div></div>';
  HM.el=el;HM.path=[];HM.sel=null;const root=$('.hm',el),cv=$('canvas',root);
  root.addEventListener('click',e=>{
    const mb=e.target.closest('[data-m]');if(mb){LS.s(KEY+'heatmap',mb.dataset.m);HM.path=[];HM.sel=null;hmPaint();hmLoad(false);return}
    const cb=e.target.closest('[data-c]');if(cb){HM.path=HM.path.slice(0,+cb.dataset.c+1);HM.sel=null;hmPaint()}
  });
  cv.addEventListener('click',e=>{
    const b=cv.getBoundingClientRect(),x=e.clientX-b.left,y=e.clientY-b.top,t=hmHit(x,y);
    HM.sel=null;
    if(t){
      const top=(HM.rects.groups.find(q=>q.d===0&&x>=q.x&&x<q.x+q.w&&y>=q.y&&y<q.y+q.h))||null;
      if(top&&top.n.kids.some(k=>k.kids)){HM.path.push(top.n.name);hmPaint();return}   /* a group with a level below it opens; an industry or a plain group shows the tile */
      const n=t.n;
      HM.sel=hmMap()==='themes'?n.lab+' · '+n.desc+' · '+hmPct(n.p)+(n.mem?' · '+n.mem.split(',').slice(0,12).join(' '):''):n.name+' · '+(n.desc||'')+' · '+hmPct(n.p)+' · cap '+hmCap(n.v);
    }
    hmPaint();
  });
  if(!HM.keyed){HM.keyed=true;window.addEventListener('keydown',e=>{if(e.key==='Escape'&&hmRoot()&&HM.path.length){HM.path.pop();HM.sel=null;hmPaint()}})}
  if(window.ResizeObserver){let t;new ResizeObserver(()=>{clearTimeout(t);t=setTimeout(hmPaint,80)}).observe($('.hmw',root))}
  const p=HM.perf[hmMap()];hmPaint();
  if(!p||Date.now()-p.at>HM.POLL)hmLoad(false);
  if(!HM.timer)HM.timer=setInterval(()=>{if(hmVisible())hmLoad(false)},HM.POLL);
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&hmVisible()){const p=HM.perf[hmMap()];if(!p||Date.now()-p.at>HM.POLL)hmLoad(false)}});
