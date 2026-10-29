// Market summaries for display: per-market stats, candles and depth. Trade amounts
// stay exact in Print; prices here are display-unit floats (quote per base), which
// is all a chart or a stats row needs. Time is block time, never the host clock.
import {assetKey,type AssetId} from '../../sdk/src/types.js';
import type {Pair,Print} from './market.js';

export type Decimals=(asset:AssetId)=>number;
const units=(n:bigint,d:number)=>Number(n)/10**d;
const byTime=(prints:readonly Print[])=>[...prints].sort((a,b)=>a.trade.time!==b.trade.time?(a.trade.time<b.trade.time?-1:1):a.trade.block!==b.trade.block?(a.trade.block<b.trade.block?-1:1):a.trade.hash.localeCompare(b.trade.hash));
export const priceOf=(p:Pick<Print,'pair'|'base'|'quote'>,decimals:Decimals)=>units(p.quote,decimals(p.pair.quote))/units(p.base,decimals(p.pair.base));

export interface MarketStats {
 pair:Pair;trades:number;
 last?:{price:number;time:bigint;hash:string};
 /** Over the 24 h before `now` (block time). */
 day:{trades:number;open?:number;high?:number;low?:number;change?:number;base:number;quote:number};
}
/** Prints newest first or in any order; `now` is a block timestamp in ms. */
export function marketStats(prints:readonly Print[],decimals:Decimals,now:bigint):Map<string,MarketStats>{
 const out=new Map<string,MarketStats>(),from=now-86_400_000n;
 const sorted=byTime(prints);
 for(const p of sorted){
  const s=out.get(p.pair.key)??{pair:p.pair,trades:0,day:{trades:0,base:0,quote:0}};out.set(p.pair.key,s);
  const price=priceOf(p,decimals);s.trades++;
  // The 24 h change compares with the last price before the window when there is one.
  if(p.trade.time<from){s.last={price,time:p.trade.time,hash:p.trade.hash};continue;}
  s.day.open??=s.last?.price??price;
  s.day.high=Math.max(s.day.high??price,price);s.day.low=Math.min(s.day.low??price,price);
  s.day.trades++;s.day.base+=units(p.base,decimals(p.pair.base));s.day.quote+=units(p.quote,decimals(p.pair.quote));
  s.last={price,time:p.trade.time,hash:p.trade.hash};
 }
 for(const s of out.values())if(s.day.open!==undefined&&s.last)s.day.change=(s.last.price-s.day.open)/s.day.open;
 return out;
}

export interface Candle {start:bigint;open:number;high:number;low:number;close:number;base:number;trades:number}
/** `count` buckets of `bucketMs` ending at `now`. Empty buckets repeat the previous close
 * with zero volume; buckets before the first trade are omitted. */
export function candles(prints:readonly Print[],decimals:Decimals,bucketMs:bigint,count:number,now:bigint):Candle[]{
 if(bucketMs<=0n||!Number.isSafeInteger(count)||count<1||count>2000)throw new Error('Invalid candle range');
 const end=now-(now%bucketMs)+bucketMs,start=end-bucketMs*BigInt(count);
 const sorted=byTime(prints);
 let prev:number|undefined;
 for(const p of sorted)if(p.trade.time<start)prev=priceOf(p,decimals);
 const inRange=sorted.filter(p=>p.trade.time>=start&&p.trade.time<end),out:Candle[]=[];let i=0;
 for(let b=start;b<end;b+=bucketMs){
  let candle:Candle|undefined;
  while(i<inRange.length&&inRange[i]!.trade.time<b+bucketMs){
   const p=inRange[i++]!,price=priceOf(p,decimals);
   candle??={start:b,open:price,high:price,low:price,close:price,base:0,trades:0};
   candle.high=Math.max(candle.high,price);candle.low=Math.min(candle.low,price);candle.close=price;
   candle.base+=units(p.base,decimals(p.pair.base));candle.trades++;
  }
  candle??=prev===undefined?undefined:{start:b,open:prev,high:prev,low:prev,close:prev,base:0,trades:0};
  if(candle){out.push(candle);prev=candle.close;}
 }
 return out;
}

/** An open order in display terms: offer and ask assets with their amounts still on offer. */
export interface BookEntry {offer:AssetId;ask:AssetId;/** Offer still available. */available:bigint;/** Price terms: askAmount per offerAmount. */askAmount:bigint;offerAmount:bigint}
/** A constant-product CKB pool: x CKB (quote), y token (base), fee in bps. */
export interface PoolCurve {token:AssetId;ckb:AssetId;x:bigint;y:bigint;feeBps:bigint}
export interface DepthPoint {price:number;/** Cumulative base available at this price or better. */base:number}
export interface Depth {mid?:number;bids:DepthPoint[];asks:DepthPoint[]}

/** Cumulative depth on a price grid of `steps` points each side, out to ±`range` of mid.
 * Asks: base offered at price ≤ p (orders selling base; pool sells base until its marginal
 * buy price reaches p). Bids: base wanted at price ≥ p, likewise. */
export function depth(pair:Pair,book:readonly BookEntry[],pools:readonly PoolCurve[],decimals:Decimals,options:{steps?:number;range?:number}={}):Depth{
 const steps=options.steps??40,range=options.range??0.5;
 const db=decimals(pair.base),dq=decimals(pair.quote),bk=assetKey(pair.base),qk=assetKey(pair.quote);
 const asks:{price:number;base:number}[]=[],bids:{price:number;base:number}[]=[];
 for(const o of book){
  if(o.available<=0n||o.offerAmount<=0n||o.askAmount<=0n)continue;
  const off=assetKey(o.offer),ask=assetKey(o.ask);
  if(off===bk&&ask===qk)asks.push({price:units(o.askAmount,dq)/units(o.offerAmount,db),base:units(o.available,db)});
  else if(off===qk&&ask===bk){const price=units(o.offerAmount,dq)/units(o.askAmount,db);bids.push({price,base:units(o.available,dq)/price});}
 }
 const curves=pools.filter(p=>assetKey(p.token)===bk&&assetKey(p.ckb)===qk&&p.x>0n&&p.y>0n).map(p=>({x:units(p.x,dq),y:units(p.y,db),f:Number(p.feeBps)/10_000}));
 const bestAsk=Math.min(...asks.map(a=>a.price),...curves.map(c=>c.x/c.y/(1-c.f)));
 const bestBid=Math.max(...bids.map(b=>b.price),...curves.map(c=>c.x/c.y*(1-c.f)));
 const mid=Number.isFinite(bestAsk)&&Number.isFinite(bestBid)?(bestAsk+bestBid)/2:Number.isFinite(bestAsk)?bestAsk:Number.isFinite(bestBid)?bestBid:undefined;
 if(mid===undefined)return {bids:[],asks:[]};
 // Base the pools sell before their marginal price (fee included) rises to p, or buy before it falls to p.
 const poolAsk=(p:number)=>curves.reduce((s,c)=>{const y=Math.sqrt(c.x*c.y/(p*(1-c.f)));return s+Math.max(0,c.y-y);},0);
 const poolBid=(p:number)=>curves.reduce((s,c)=>{const y=Math.sqrt(c.x*c.y*(1-c.f)/p);return s+Math.max(0,y-c.y);},0);
 const grid=(sign:1|-1)=>Array.from({length:steps+1},(_,i)=>mid*(1+sign*range*i/steps));
 return {mid,
  asks:grid(1).map(p=>({price:p,base:asks.filter(a=>a.price<=p).reduce((s,a)=>s+a.base,0)+poolAsk(p)})),
  bids:grid(-1).map(p=>({price:p,base:bids.filter(b=>b.price>=p).reduce((s,b)=>s+b.base,0)+poolBid(p)}))};
}
