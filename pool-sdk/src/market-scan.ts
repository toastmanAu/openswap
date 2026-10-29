// Bounded chain reader for market data: finds transactions that touch an order lock
// or a pool state type (indexer prefix search), resolves their inputs and block
// times, and extracts events with market.ts. Newest first; stops at maxTransactions.
import {ccc} from '@ckb-ccc/core';
import {marketEvents,type MarketEvent,type MarketSources,type MarketTx,type Skipped} from './market.js';

export type MarketClient=Pick<ccc.Client,'findTransactionsPaged'|'getTransaction'|'getHeaderByNumber'>;
export interface MarketScanOptions {
 /** Newest transactions to read across all sources (default 500, at most 5,000). */
 maxTransactions?:number;
 /** Skip transactions at or below this block (incremental refresh). */
 afterBlock?:bigint;
 concurrency?:number;
 signal?:AbortSignal;
}
export interface MarketScan {events:MarketEvent[];skipped:Skipped[];transactions:number;newestBlock?:bigint;truncated:boolean}

async function pool<T,R>(items:readonly T[],limit:number,work:(item:T)=>Promise<R>,signal?:AbortSignal):Promise<R[]>{
 const out=new Array<R>(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(next<items.length){signal?.throwIfAborted();const i=next++;out[i]=await work(items[i]!);}
 }));
 return out;
}

export async function scanMarket(client:MarketClient,sources:MarketSources,options:MarketScanOptions={}):Promise<MarketScan>{
 const max=options.maxTransactions??500,limit=options.concurrency??8;
 if(!Number.isSafeInteger(max)||max<1||max>5000)throw new Error('maxTransactions must be 1..5000');
 const scripts:{script:ccc.ScriptLike;scriptType:'lock'|'type'}[]=sources.orders.map(o=>({script:{codeHash:o.codeHash,hashType:'data1',args:'0x'},scriptType:'lock'}));
 if(sources.pools)scripts.push({script:{codeHash:sources.pools.codeHash,hashType:'data1',args:'0x'},scriptType:'type'});
 // Newest first per source; merge by block and keep the newest `max` overall.
 const found=new Map<ccc.Hex,bigint>();let truncated=false;
 for(const s of scripts){
  let cursor:string|undefined,count=0;
  do{
   options.signal?.throwIfAborted();
   const page=await client.findTransactionsPaged({...s,scriptSearchMode:'prefix',groupByTransaction:true,filter:options.afterBlock===undefined?undefined:{blockRange:[options.afterBlock+1n,(1n<<63n)]}},'desc',100,cursor);
   for(const t of page.transactions){found.set(t.txHash,t.blockNumber);count++;}
   cursor=page.transactions.length===100&&count<max?page.lastCursor:undefined;
   if(page.transactions.length===100&&count>=max)truncated=true;
  }while(cursor);
 }
 const hashes=[...found.entries()].sort((a,b)=>a[1]===b[1]?a[0].localeCompare(b[0]):a[1]>b[1]?-1:1);
 if(hashes.length>max)truncated=true;
 const selected=hashes.slice(0,max);
 const txs=new Map<ccc.Hex,ccc.Transaction>(),headers=new Map<bigint,Promise<bigint>>();
 const getTx=async(hash:ccc.Hex)=>{
  const cached=txs.get(hash);if(cached)return cached;
  const r=await client.getTransaction(hash);if(!r)throw new Error(`Transaction ${hash} not found`);
  txs.set(hash,r.transaction);return r.transaction;
 };
 const time=(block:bigint)=>{let h=headers.get(block);if(!h){h=client.getHeaderByNumber(block).then(x=>{if(!x)throw new Error(`Header ${block} not found`);return x.timestamp;});headers.set(block,h);}return h;};
 const resolved=await pool(selected,limit,async([hash,block]):Promise<MarketTx>=>{
  const tx=await getTx(hash);
  const inputs=await Promise.all(tx.inputs.map(async input=>{
   const prev=await getTx(input.previousOutput.txHash),index=Number(input.previousOutput.index);
   return ccc.Cell.from({outPoint:input.previousOutput,cellOutput:prev.outputs[index]!,outputData:prev.outputsData[index]!});
  }));
  return {hash,block,time:await time(block),tx,inputs};
 },options.signal);
 const events:MarketEvent[]=[],skipped:Skipped[]=[];
 for(const m of resolved){const r=marketEvents(m,sources);events.push(...r.events);skipped.push(...r.skipped);}
 return {events,skipped,transactions:resolved.length,newestBlock:selected[0]?.[1],truncated};
}
