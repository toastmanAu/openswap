// Markets view: trades, prices and depth read from the chain (pool-sdk market-scan),
// with no server. Charts are plain SVG; every value a tooltip shows is also in the
// trades list or the table view. Labels come from chain data, so text is only ever
// set with textContent.
import {ccc} from '@ckb-ccc/core';
import {MarketScanner,type MarketScan} from '../../pool-sdk/src/market-scan.js';
import {print,type MarketSources,type Print} from '../../pool-sdk/src/market.js';
import {comparePrints,depth,marketStats,priceOf,type BookEntry,type Depth,type MarketStats,type PoolCurve} from '../../pool-sdk/src/market-stats.js';
import {assetKey,CKB,udt,type AssetId} from '../../sdk/src/types.js';

export interface MarketsEnv {
 /** Resolves once the deployments (pools, order lock v2) the sources depend on are loaded. */
 ready():Promise<void>;
 client():ccc.Client;
 /** Genesis hash; saved history is kept per network. */
 network():string;
 sources():MarketSources|undefined;
 /** Open, fillable orders (expired ones excluded by the caller). */
 book():BookEntry[];
 pools():{token:ccc.Script;x:bigint;y:bigint;feeBps:bigint}[];
 label(asset:AssetId):string;
 decimals(asset:AssetId):number;
 explorer(hash:string):string;
}
type Range='day'|'week'|'all';
const RANGES:Record<Range,{label:string;ms:bigint|undefined}>={day:{label:'24 h',ms:86_400_000n},week:{label:'7 days',ms:604_800_000n},all:{label:'All',ms:undefined}};
const SVG='http://www.w3.org/2000/svg';
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls?:string)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const svg=(tag:string,attrs:Record<string,string|number>)=>{const e=document.createElementNS(SVG,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));return e;};
const num=(n:number,digits=6)=>Number.isFinite(n)?n.toLocaleString(undefined,{maximumSignificantDigits:digits}):'–';
const pct=(n:number|undefined)=>n===undefined?'–':`${n>=0?'+':''}${(n*100).toFixed(2)}%`;
const when=(ms:bigint)=>new Date(Number(ms)).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
function ticks(min:number,max:number,count:number):number[]{
 if(!(max>min))return [min];
 const step=10**Math.floor(Math.log10((max-min)/count)),nice=[1,2,5,10].map(m=>m*step).find(s=>(max-min)/s<=count)!;
 const out=[];for(let v=Math.ceil(min/nice)*nice;v<=max+nice*1e-9;v+=nice)out.push(Number(v.toPrecision(12)));return out;
}

export function createMarkets(env:MarketsEnv){
 let prints:Print[]=[],stats=new Map<string,MarketStats>(),now=0n,selected:string|undefined,range:Range='week',loading:Promise<void>|undefined,loadedAt=0;
 let scanner:MarketScanner|undefined,timer:number|undefined;
 const storageKey=()=>`toastdex-market-history:${env.network()}`;
 /** Saved history is a per-browser convenience: any failure just means a full scan. */
 const restore=(s:MarketScanner)=>{try{const raw=localStorage.getItem(storageKey());return raw?s.restore(JSON.parse(raw)):false;}catch{return false;}};
 const save=(s:MarketScanner)=>{try{const snap=s.snapshot();if(snap){const json=JSON.stringify(snap);if(json.length<4_000_000)localStorage.setItem(storageKey(),json);}}catch{/* storage full or blocked */}};
 const decimals=(a:AssetId)=>env.decimals(a);
 const pairLabel=(s:MarketStats)=>`${env.label(s.pair.base)} / ${env.label(s.pair.quote)}`;

 async function load(){
  el('markets-status').textContent='Loading deployments…';
  await env.ready();
  const sources=env.sources();
  if(!sources){el('markets-status').textContent='Market history is unavailable: no order or pool deployment is configured for this network.';return;}
  el('markets-status').textContent='Reading trades from the chain…';
  el('markets-root').classList.add('stale');
  try{
   const client=env.client();
   // 16 parallel reads halve a first visit against 8 on the public nodes (measured
   // 2026-10-29); higher would be faster but heavier on shared endpoints.
   let restored=false;
   if(!scanner){scanner=new MarketScanner(client,sources);restored=restore(scanner);}
   const current=scanner;
   const [scan,tip]=await Promise.all([current.scan({maxTransactions:1000,concurrency:16}),client.getTipHeader()]);
   if(scanner!==current)return;
   save(current);
   now=tip.timestamp;
   prints=scan.events.flatMap(e=>e.kind==='trade'?[print(e)]:[]);
   stats=marketStats(prints,decimals,now);
   if(!selected||!stats.has(selected))selected=[...stats.values()].sort((a,b)=>b.day.quote-a.day.quote||b.trades-a.trades)[0]?.pair.key;
   loadedAt=Date.now();
   const skipped=scan.skipped.length?` · ${scan.skipped.length} event${scan.skipped.length===1?'':'s'} not understood and skipped`:'';
   el('markets-status').textContent=`${prints.length} trades in ${stats.size} markets from the newest ${scan.transactions} OpenSwap transactions${scan.truncated?' (older history not loaded)':''}${skipped}. ${updated(scan,restored)} Prices use block time; 24 h figures end at the chain tip.`;
   render();
  }catch(error){el('markets-status').textContent=`Could not read market history: ${error instanceof Error?error.message:String(error)}`;throw error;}
  finally{el('markets-root').classList.remove('stale');}
 }
 function updated(scan:MarketScan,restored:boolean){
  const r=scan.refresh,at=new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  if(r.mode==='full')return `Read in full at ${at}.`;
  return `${restored?'Saved history in this browser, plus':'Updated at '+at+':'} ${r.newTransactions} recent transaction${r.newTransactions===1?'':'s'} re-read${restored?` at ${at}`:''}.`;
 }
 function refresh(){loading??=load().catch(()=>{}).finally(()=>{loading=undefined;});return loading;}
 /** Load on open; while the tab stays open, refresh every 30 s (each refresh reads only recent blocks). */
 function show(){
  if(timer===undefined)timer=window.setInterval(()=>{if(el('view-markets').hidden){window.clearInterval(timer);timer=undefined;return;}void refresh();},30_000);
  return Date.now()-loadedAt>10_000?refresh():Promise.resolve();
 }

 function render(){renderList();renderDetail();}
 function renderList(){
  const root=el('markets-list');root.replaceChildren();
  if(!stats.size){root.append(node('p','No trades yet.'));return;}
  const table=node('table','', 'market-table'),head=node('tr');
  for(const h of ['Market','Last price','24 h change','24 h volume','Trades'])head.append(node('th',h));
  table.append(node('thead'));table.tHead!.append(head);const body=node('tbody');table.append(body);
  for(const s of [...stats.values()].sort((a,b)=>b.day.quote-a.day.quote||b.trades-a.trades)){
   const row=node('tr');row.tabIndex=0;row.setAttribute('aria-selected',String(s.pair.key===selected));
   row.append(node('td',pairLabel(s)),node('td',s.last?`${num(s.last.price)} ${env.label(s.pair.quote)}`:'–'),node('td',pct(s.day.change),s.day.change===undefined?'':s.day.change>=0?'up':'down'),
    node('td',`${num(s.day.quote,4)} ${env.label(s.pair.quote)}`),node('td',String(s.trades)));
   const pick=()=>{selected=s.pair.key;render();};row.onclick=pick;row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick();}};
   body.append(row);
  }
  root.append(table);
 }

 function inRange(){
  const ms=RANGES[range].ms;
  return prints.filter(p=>p.pair.key===selected&&(ms===undefined||p.trade.time>=now-ms)).sort(comparePrints);
 }
 function renderDetail(){
  const s=selected?stats.get(selected):undefined;
  el('market-detail').hidden=!s;if(!s)return;
  el('market-title').textContent=pairLabel(s);
  for(const b of document.querySelectorAll<HTMLButtonElement>('[data-market-range]'))b.setAttribute('aria-pressed',String(b.dataset.marketRange===range));
  const q=env.label(s.pair.quote),b=env.label(s.pair.base);
  const tiles=el('market-stats');tiles.replaceChildren();
  for(const [name,value,note] of [
   ['Last price',s.last?num(s.last.price):'–',`${q} per ${b}`],
   ['24 h change',pct(s.day.change),s.day.open===undefined?'no trades in 24 h':`from ${num(s.day.open)}`],
   ['24 h range',s.day.low===undefined?'–':`${num(s.day.low,4)} – ${num(s.day.high!,4)}`,q],
   ['24 h volume',num(s.day.quote,5),`${q} · ${num(s.day.base,5)} ${b}`],
  ] as const){const t=node('div','','stat');t.append(node('span',name,'stat-name'),node('strong',value),node('span',note,'stat-note'));tiles.append(t);}
  const points=inRange();
  priceChart(el('price-chart'),points,s);
  const d=depth(s.pair,env.book(),curves(s),decimals,{steps:40,range:0.5});
  depthChart(el('depth-chart'),d,s);
  tradeList(points,s);depthTable(d,s);
 }
 function curves(s:MarketStats):PoolCurve[]{
  return env.pools().map(p=>({token:udt(p.token),ckb:CKB,x:p.x,y:p.y,feeBps:p.feeBps})).filter(p=>assetKey(p.token)===assetKey(s.pair.base)&&s.pair.quote.kind==='ckb');
 }

 // Price over time: one series (no legend; the heading names it), crosshair + tooltip.
 function priceChart(root:HTMLElement,points:Print[],s:MarketStats){
  root.replaceChildren();
  if(!points.length){root.append(node('p',`No trades in the last ${RANGES[range].label}.`));return;}
  const W=Math.max(root.clientWidth||640,280),H=220,L=64,R=16,T=12,B=28;
  const xs=points.map(p=>Number(p.trade.time)),ys=points.map(p=>priceOf(p,decimals));
  let [x0,x1]=[Math.min(...xs),Math.max(...xs)];if(x1===x0){x0-=3_600_000;x1+=3_600_000;}
  let [y0,y1]=[Math.min(...ys),Math.max(...ys)];const pad=(y1-y0||y1*0.1||1)*0.15;y0=Math.max(0,y0-pad);y1+=pad;
  const X=(v:number)=>L+(v-x0)/(x1-x0)*(W-L-R),Y=(v:number)=>T+(1-(v-y0)/(y1-y0))*(H-T-B);
  const chart=svg('svg',{viewBox:`0 0 ${W} ${H}`,width:'100%',role:'img','aria-label':`Price of ${env.label(s.pair.base)} in ${env.label(s.pair.quote)}, ${points.length} trades`,tabindex:0});
  for(const t of ticks(y0,y1,4)){chart.append(svg('line',{x1:L,x2:W-R,y1:Y(t),y2:Y(t),class:'grid'}));const lbl=svg('text',{x:L-8,y:Y(t)+4,'text-anchor':'end',class:'tick'});lbl.textContent=num(t,4);chart.append(lbl);}
  for(const t of ticks(x0,x1,4)){const lbl=svg('text',{x:X(t),y:H-8,'text-anchor':'middle',class:'tick'});lbl.textContent=new Date(t).toLocaleString(undefined,x1-x0>2*86_400_000?{month:'short',day:'numeric'}:{hour:'2-digit',minute:'2-digit'});chart.append(lbl);}
  chart.append(svg('line',{x1:L,x2:W-R,y1:H-B,y2:H-B,class:'axis'}));
  // Step line: the price holds until the next trade.
  let d=`M${X(xs[0]!)},${Y(ys[0]!)}`;for(let i=1;i<xs.length;i++)d+=`H${X(xs[i]!)}V${Y(ys[i]!)}`;
  chart.append(svg('path',{d,class:'price-line'}));
  const last=points.length-1;
  chart.append(svg('circle',{cx:X(xs[last]!),cy:Y(ys[last]!),r:4,class:'price-dot'}));
  const end=svg('text',{x:Math.min(X(xs[last]!),W-R-4),y:Y(ys[last]!)-10,'text-anchor':'end',class:'direct-label'});end.textContent=num(ys[last]!);chart.append(end);
  crosshair(chart,root,W,H,L,R,T,B,points.map((p,i)=>({x:X(xs[i]!),y:Y(ys[i]!),rows:[[num(ys[i]!),`${env.label(s.pair.quote)} per ${env.label(s.pair.base)}`],[`${p.side==='buy'?'Buy':'Sell'} ${num(Number(p.base)/10**decimals(p.pair.base))} ${env.label(p.pair.base)}`,p.trade.venue==='pool'?'pool':'order'],[when(p.trade.time),'']] as [string,string][]})),'price-line');
  root.append(chart);
 }
 // Depth: two series (bids, asks) with a legend and direct labels.
 function depthChart(root:HTMLElement,d:Depth,s:MarketStats){
  root.replaceChildren();
  if(d.mid===undefined){root.append(node('p','No open orders or pools for this market.'));return;}
  const W=Math.max(root.clientWidth||640,280),H=220,L=64,R=16,T=12,B=28;
  const all=[...d.bids,...d.asks],x0=Math.min(...all.map(p=>p.price)),x1=Math.max(...all.map(p=>p.price)),y1=Math.max(...all.map(p=>p.base),1e-12)*1.1;
  const X=(v:number)=>L+(v-x0)/(x1-x0)*(W-L-R),Y=(v:number)=>T+(1-v/y1)*(H-T-B);
  const chart=svg('svg',{viewBox:`0 0 ${W} ${H}`,width:'100%',role:'img','aria-label':`Depth for ${pairLabel(s)} around ${num(d.mid)}`,tabindex:0});
  for(const t of ticks(0,y1,4)){chart.append(svg('line',{x1:L,x2:W-R,y1:Y(t),y2:Y(t),class:'grid'}));const lbl=svg('text',{x:L-8,y:Y(t)+4,'text-anchor':'end',class:'tick'});lbl.textContent=num(t,4);chart.append(lbl);}
  for(const t of ticks(x0,x1,W<480?4:7)){const lbl=svg('text',{x:X(t),y:H-8,'text-anchor':'middle',class:'tick'});lbl.textContent=num(t,4);chart.append(lbl);}
  chart.append(svg('line',{x1:L,x2:W-R,y1:H-B,y2:H-B,class:'axis'}));
  for(const [side,pts,cls] of [['Bids',[...d.bids].reverse(),'bids'],['Asks',d.asks,'asks']] as const){
   const line=pts.map((p,i)=>`${i?'L':'M'}${X(p.price)},${Y(p.base)}`).join('');
   chart.append(svg('path',{d:`${line}L${X(pts.at(-1)!.price)},${Y(0)}L${X(pts[0]!.price)},${Y(0)}Z`,class:`depth-area ${cls}`}),svg('path',{d:line,class:`depth-line ${cls}`}));
   const edge=cls==='bids'?pts[0]!:pts.at(-1)!,lbl=svg('text',{x:X(edge.price)+(cls==='bids'?4:-4),y:Math.max(Y(edge.base)-8,T+10),'text-anchor':cls==='bids'?'start':'end',class:'direct-label'});lbl.textContent=side;chart.append(lbl);
  }
  chart.append(svg('line',{x1:X(d.mid),x2:X(d.mid),y1:T,y2:H-B,class:'mid'}));
  const xsAll=[...d.bids].reverse().concat(d.asks);
  crosshair(chart,root,W,H,L,R,T,B,xsAll.map(p=>({x:X(p.price),y:Y(p.base),rows:[[num(p.base),`${env.label(s.pair.base)} ${p.price<d.mid!?'wanted at or above':'offered at or below'}`],[num(p.price),`${env.label(s.pair.quote)} per ${env.label(s.pair.base)}`]] as [string,string][]})),undefined);
  root.append(chart);
 }
 /** Vertical hairline that snaps to the nearest point; same readout on keyboard focus (arrow keys). */
 function crosshair(chart:SVGElement,root:HTMLElement,W:number,H:number,L:number,R:number,T:number,B:number,points:{x:number;y:number;rows:[string,string][]}[],cls:string|undefined){
  const hair=svg('line',{y1:T,y2:H-B,class:'crosshair',visibility:'hidden'}),dot=svg('circle',{r:4,class:cls==='price-line'?'price-dot':'hover-dot',visibility:'hidden'});
  const hit=svg('rect',{x:L,y:T,width:W-L-R,height:H-T-B,fill:'transparent'});chart.append(hair,dot,hit);
  const tip=node('div','','chart-tip');tip.hidden=true;root.style.position='relative';root.append(tip);
  let at=-1;
  const showAt=(i:number)=>{
   at=Math.max(0,Math.min(points.length-1,i));const p=points[at]!;
   for(const e of [hair])e.setAttribute('x1',String(p.x)),e.setAttribute('x2',String(p.x));
   dot.setAttribute('cx',String(p.x));dot.setAttribute('cy',String(p.y));hair.setAttribute('visibility','visible');dot.setAttribute('visibility','visible');
   tip.replaceChildren(...p.rows.map(([v,l])=>{const r=node('div');r.append(node('strong',v),document.createTextNode(l?` ${l}`:''));return r;}));
   tip.hidden=false;const scale=root.clientWidth/W;tip.style.left=`${Math.min(p.x*scale+12,root.clientWidth-180)}px`;tip.style.top='8px';
  };
  const hide=()=>{hair.setAttribute('visibility','hidden');dot.setAttribute('visibility','hidden');tip.hidden=true;};
  hit.addEventListener('pointermove',e=>{const box=chart.getBoundingClientRect(),x=(e.clientX-box.left)*W/box.width;let best=0;points.forEach((p,i)=>{if(Math.abs(p.x-x)<=Math.abs(points[best]!.x-x))best=i;});showAt(best);});
  // Points sharing an x (one block) resolve to the newest; leaving resets keyboard focus to the newest.
  hit.addEventListener('pointerleave',()=>{hide();at=-1;});
  chart.addEventListener('focus',()=>showAt(at<0?points.length-1:at));chart.addEventListener('blur',hide);
  chart.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();showAt(at+(e.key==='ArrowLeft'?-1:1));}});
 }
 function tradeList(points:Print[],s:MarketStats){
  const root=el('market-trades');root.replaceChildren();
  if(!points.length){root.append(node('p','No trades in this range.'));return;}
  const table=node('table','','market-table trades'),head=node('tr');
  for(const h of ['Time (block)','Side','Price',env.label(s.pair.base),env.label(s.pair.quote),'Venue','Transaction'])head.append(node('th',h));
  table.append(node('thead'));table.tHead!.append(head);const body=node('tbody');table.append(body);
  for(const p of [...points].reverse().slice(0,200)){
   const row=node('tr'),t=p.trade,link=node('a',`${t.hash.slice(0,10)}…`);link.href=env.explorer(t.hash);link.target='_blank';link.rel='noopener noreferrer';
   const venue=t.venue==='pool'?'Pool':`Order v${t.version}${t.version===2?t.final?' (final)':' (partial)':''}`;
   const cell=node('td');cell.append(link);
   row.append(node('td',when(t.time)),node('td',p.side==='buy'?'Buy':'Sell',p.side==='buy'?'up':'down'),node('td',num(priceOf(p,decimals))),
    node('td',num(Number(p.base)/10**decimals(p.pair.base),8)),node('td',num(Number(p.quote)/10**decimals(p.pair.quote),8)),node('td',venue),cell);
   body.append(row);
  }
  root.append(table);
  if(points.length>200)root.append(node('p',`Showing the newest 200 of ${points.length} trades in this range.`));
 }
 function depthTable(d:Depth,s:MarketStats){
  const root=el('depth-table');root.replaceChildren();
  if(d.mid===undefined)return;
  const table=node('table','','market-table'),head=node('tr');
  for(const h of ['Side',`Price (${env.label(s.pair.quote)})`,`Cumulative ${env.label(s.pair.base)}`])head.append(node('th',h));
  table.append(node('thead'));table.tHead!.append(head);const body=node('tbody');table.append(body);
  for(const [side,pts] of [['Bid',d.bids],['Ask',d.asks]] as const)for(const p of pts.filter((_,i)=>i%5===0))
   {const row=node('tr');row.append(node('td',side),node('td',num(p.price)),node('td',num(p.base)));body.append(row);}
  root.append(table);
 }

 for(const b of document.querySelectorAll<HTMLButtonElement>('[data-market-range]'))b.onclick=()=>{range=b.dataset.marketRange as Range;renderDetail();};
 el('markets-refresh').onclick=()=>{void refresh();};
 let resize:number|undefined;window.addEventListener('resize',()=>{clearTimeout(resize);resize=window.setTimeout(()=>{if(!el('view-markets').hidden)renderDetail();},150);});
 return {show,bookChanged:()=>{if(stats.size&&!el('view-markets').hidden)renderDetail();},reset:()=>{prints=[];stats=new Map();selected=undefined;loadedAt=0;scanner=undefined;}};
}
