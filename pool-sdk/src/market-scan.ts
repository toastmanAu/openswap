// Bounded chain reader for market data: finds transactions that touch an order lock
// or a pool state type (indexer prefix search), resolves the inputs that matter and
// block times, and extracts events with market.ts. Newest first; stops at maxTransactions.
//
// Only inputs the indexer matched (order cells, pool state cells) have their parent
// transaction fetched; other inputs are resolved only when that parent is already
// at hand, which covers the pool reserves (they share the state cell's parent).
// Wallet funding inputs are never fetched. A MarketScanner keeps its caches and last
// result, so a refresh reads only blocks after the last one seen (minus a reorg margin).
import {ccc} from '@ckb-ccc/core';
import {marketEvents,type MarketEvent,type MarketSources,type MarketTx,type Skipped} from './market.js';
import {CKB,udt,type AssetId} from '../../sdk/src/types.js';

export type MarketClient=Pick<ccc.Client,'findTransactionsPaged'|'getTransaction'|'getHeaderByNumber'>;
export interface MarketScanOptions {
 /** Newest transactions to keep across all sources (default 500, at most 5,000). */
 maxTransactions?:number;
 concurrency?:number;
 signal?:AbortSignal;
}
export interface MarketScan {
 events:MarketEvent[];skipped:Skipped[];transactions:number;newestBlock?:bigint;truncated:boolean;
 /** What this call read: a full scan or blocks after `from`, and the RPC reads it made. */
 refresh:{mode:'full'|'incremental';from?:bigint;transactionsRead:number;headersRead:number;newTransactions:number};
}
/** Blocks re-read on each refresh, so a shallow reorg replaces what it changed. */
export const REORG_MARGIN=24n;

async function pool<T,R>(items:readonly T[],limit:number,work:(item:T)=>Promise<R>,signal?:AbortSignal):Promise<R[]>{
 const out=new Array<R>(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(next<items.length){signal?.throwIfAborted();const i=next++;out[i]=await work(items[i]!);}
 }));
 return out;
}
interface Found {block:bigint;inputs:Set<number>}
interface Kept {block:bigint;events:MarketEvent[];skipped:Skipped[]}

export class MarketScanner {
 private readonly txs=new Map<ccc.Hex,Promise<ccc.Transaction>>();
 private readonly headers=new Map<bigint,Promise<bigint>>();
 private kept=new Map<ccc.Hex,Kept>();
 private newest?:bigint;private truncated=false;
 private reads={transactions:0,headers:0};
 constructor(private readonly client:MarketClient,private readonly sources:MarketSources){}

 private getTx(hash:ccc.Hex){
  let p=this.txs.get(hash);
  if(!p){this.reads.transactions++;p=this.client.getTransaction(hash).then(r=>{if(!r)throw new Error(`Transaction ${hash} not found`);return r.transaction;});
   p.catch(()=>this.txs.delete(hash));this.txs.set(hash,p);}
  return p;
 }
 private time(block:bigint){
  let h=this.headers.get(block);
  if(!h){this.reads.headers++;h=this.client.getHeaderByNumber(block).then(x=>{if(!x)throw new Error(`Header ${block} not found`);return x.timestamp;});
   h.catch(()=>this.headers.delete(block));this.headers.set(block,h);}
  return h;
 }
 /** Transactions after `after` (or all), newest first, with the input indexes the indexer matched. */
 private async discover(max:number,after:bigint|undefined,signal?:AbortSignal){
  const scripts:{script:ccc.ScriptLike;scriptType:'lock'|'type'}[]=this.sources.orders.map(o=>({script:{codeHash:o.codeHash,hashType:'data1',args:'0x'},scriptType:'lock'}));
  if(this.sources.pools)scripts.push({script:{codeHash:this.sources.pools.codeHash,hashType:'data1',args:'0x'},scriptType:'type'});
  const found=new Map<ccc.Hex,Found>();let truncated=false;
  for(const s of scripts){
   let cursor:string|undefined,count=0;
   do{
    signal?.throwIfAborted();
    const page=await this.client.findTransactionsPaged({...s,scriptSearchMode:'prefix',groupByTransaction:true,filter:after===undefined?undefined:{blockRange:[after+1n,1n<<63n]}},'desc',100,cursor);
    for(const t of page.transactions){
     const f=found.get(t.txHash)??{block:t.blockNumber,inputs:new Set<number>()};found.set(t.txHash,f);
     for(const c of t.cells)if(c.isInput)f.inputs.add(Number(c.cellIndex));
     count++;
    }
    const full=page.transactions.length===100;
    if(full&&count>=max)truncated=true;
    cursor=full&&count<max?page.lastCursor:undefined;
   }while(cursor);
  }
  const sorted=[...found.entries()].sort((a,b)=>a[1].block===b[1].block?a[0].localeCompare(b[0]):a[1].block>b[1].block?-1:1);
  if(sorted.length>max)truncated=true;
  return {selected:sorted.slice(0,max),truncated};
 }
 private async resolve(hash:ccc.Hex,f:Found):Promise<MarketTx>{
  const tx=await this.getTx(hash);
  const inputs:(ccc.Cell|undefined)[]=new Array(tx.inputs.length).fill(undefined);
  const cellFrom=(i:number,parent:ccc.Transaction)=>{const p=tx.inputs[i]!.previousOutput,k=Number(p.index);
   const o=parent.outputs[k];if(!o)throw new Error(`Parent ${p.txHash} has no output ${k}`);
   return ccc.Cell.from({outPoint:p,cellOutput:o,outputData:parent.outputsData[k]!});};
  await Promise.all([...f.inputs].map(async i=>{if(i<tx.inputs.length)inputs[i]=cellFrom(i,await this.getTx(tx.inputs[i]!.previousOutput.txHash));}));
  // Siblings from a parent already fetched (pool reserves next to their state cell).
  const fetched=new Set([...f.inputs].map(i=>tx.inputs[i]?.previousOutput.txHash));
  for(const [i,input] of tx.inputs.entries())if(!inputs[i]&&fetched.has(input.previousOutput.txHash))inputs[i]=cellFrom(i,await this.getTx(input.previousOutput.txHash));
  return {hash,block:f.block,time:await this.time(f.block),tx,inputs};
 }

 /** Settled history for storage; undefined before the first scan. */
 snapshot():MarketSnapshot|undefined{
  if(this.newest===undefined)return undefined;
  const stable=this.newest-REORG_MARGIN;
  return {version:1,sources:fingerprint(this.sources),newest:stable.toString(),
   entries:[...this.kept].filter(([,k])=>k.block<=stable).map(([h,k])=>[h,{block:k.block.toString(),events:k.events.map(eventOut),skipped:k.skipped}])};
 }
 /** Adopt a stored snapshot for these sources; returns false (and keeps nothing) if it is
  * for other sources or malformed. The next scan then reads only blocks after it. */
 restore(raw:unknown):boolean{
  try{
   const s=raw as MarketSnapshot;
   if(!s||s.version!==1||s.sources!==fingerprint(this.sources)||!Array.isArray(s.entries)||s.entries.length>5000)return false;
   const kept=new Map<ccc.Hex,Kept>(),newest=big(s.newest);
   for(const [h,k] of s.entries){
    const block=big(k.block);if(block>newest)return false;
    const skipped=(k.skipped??[]).map(x=>({hash:hex(x.hash),input:Number(x.input),reason:String(x.reason).slice(0,500)}));
    kept.set(hex(h),{block,events:k.events.map(eventIn),skipped});
   }
   this.kept=kept;this.newest=newest;this.truncated=false;return true;
  }catch{return false;}
 }

 async scan(options:MarketScanOptions={}):Promise<MarketScan>{
  const max=options.maxTransactions??500,limit=options.concurrency??8;
  if(!Number.isSafeInteger(max)||max<1||max>5000)throw new Error('maxTransactions must be 1..5000');
  const before={...this.reads};
  const from=this.newest===undefined?undefined:this.newest>REORG_MARGIN?this.newest-REORG_MARGIN:0n;
  const {selected,truncated}=await this.discover(max,from,options.signal);
  // Too much new history for an incremental merge to be complete: start over.
  const full=from===undefined||truncated;
  const rows=full&&from!==undefined?(await this.discover(max,undefined,options.signal)):{selected,truncated};
  const resolved=await pool(rows.selected,limit,([hash,f])=>this.resolve(hash,f),options.signal);
  const next=full?new Map<ccc.Hex,Kept>():new Map([...this.kept].filter(([,k])=>k.block<=from!));
  for(const m of resolved){const r=marketEvents(m,this.sources);next.set(m.hash,{block:m.block,events:r.events,skipped:r.skipped});}
  // Keep the newest `max` transactions overall.
  const ordered=[...next.entries()].sort((a,b)=>a[1].block===b[1].block?a[0].localeCompare(b[0]):a[1].block>b[1].block?-1:1);
  this.kept=new Map(ordered.slice(0,max));
  this.truncated=full?rows.truncated:this.truncated||ordered.length>max;
  this.newest=ordered[0]?.[1].block??this.newest;
  const kept=[...this.kept.values()];
  return {events:kept.flatMap(k=>k.events),skipped:kept.flatMap(k=>k.skipped),transactions:kept.length,newestBlock:this.newest,truncated:this.truncated,
   refresh:{mode:full?'full':'incremental',from:full?undefined:from,transactionsRead:this.reads.transactions-before.transactions,headersRead:this.reads.headers-before.headers,newTransactions:resolved.length}};
 }
}

// Snapshots ------------------------------------------------------------------------------
/** JSON-safe copy of a scanner's settled history (blocks at least REORG_MARGIN below the
 * newest), so a returning visitor only reads what is new. Plain data; restore validates it. */
export interface MarketSnapshot {version:1;sources:string;newest:string;entries:[string,{block:string;events:unknown[];skipped:Skipped[]}][]}
const fingerprint=(s:MarketSources)=>[...s.orders.map(o=>`${o.version}:${o.codeHash}`).sort(),s.pools?`pool:${s.pools.codeHash}`:''].join(',');
const assetOut=(a:AssetId)=>a.kind==='ckb'?'ckb':{codeHash:a.script.codeHash,hashType:a.script.hashType,args:a.script.args};
const assetIn=(a:unknown):AssetId=>{if(a==='ckb')return CKB;const s=ccc.Script.from(a as ccc.ScriptLike);return udt(s);};
const hex=(v:unknown)=>{if(typeof v!=='string'||!/^0x[0-9a-f]{64}$/.test(v))throw new Error('Bad hash');return v as ccc.Hex;};
const big=(v:unknown)=>{if(typeof v!=='string'||!/^\d{1,40}$/.test(v))throw new Error('Bad number');return BigInt(v);};
function eventOut(e:MarketEvent):unknown{
 const base={kind:e.kind,hash:e.hash,block:e.block.toString(),time:e.time.toString(),source:e.source};
 if(e.kind==='trade')return {...base,venue:e.venue,version:e.version,final:e.final,got:{asset:assetOut(e.got.asset),amount:e.got.amount.toString()},gave:{asset:assetOut(e.gave.asset),amount:e.gave.amount.toString()}};
 if(e.kind==='deposit'||e.kind==='withdraw'||e.kind==='create')return {...base,token:{codeHash:e.token.codeHash,hashType:e.token.hashType,args:e.token.args},ckb:e.ckb.toString(),tokenAmount:e.tokenAmount.toString()};
 return {...base,version:(e as Extract<MarketEvent,{kind:'cancel'|'return'}>).version};
}
function eventIn(raw:unknown):MarketEvent{
 const r=raw as Record<string,any>;
 const base={hash:hex(r.hash),block:big(r.block),time:big(r.time),source:String(r.source)};
 if(r.kind==='trade'){
  if(r.venue!=='order'&&r.venue!=='pool')throw new Error('Bad venue');
  return {kind:'trade',...base,venue:r.venue,version:r.version===1||r.version===2?r.version:undefined,final:typeof r.final==='boolean'?r.final:undefined,
   got:{asset:assetIn(r.got.asset),amount:big(r.got.amount)},gave:{asset:assetIn(r.gave.asset),amount:big(r.gave.amount)}};
 }
 if(r.kind==='cancel'||r.kind==='return'){if(r.version!==1&&r.version!==2)throw new Error('Bad version');return {kind:r.kind,...base,version:r.version};}
 if(r.kind==='deposit'||r.kind==='withdraw'||r.kind==='create')return {kind:r.kind,...base,token:ccc.Script.from(r.token),ckb:big(r.ckb),tokenAmount:big(r.tokenAmount)};
 throw new Error('Bad event kind');
}

/** One-off full scan. */
export function scanMarket(client:MarketClient,sources:MarketSources,options:MarketScanOptions={}):Promise<MarketScan>{
 return new MarketScanner(client,sources).scan(options);
}
