import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ccc} from '@ckb-ccc/core';
import {MarketScanner,REORG_MARGIN,type MarketClient} from '../src/market-scan.js';
import {marketEvents,type MarketSources} from '../src/market.js';

// A fake indexer and node over the real fixture transactions. Parent transactions are
// synthesized so every input resolves to its recorded cell; reads are counted.
const raw=JSON.parse(readFileSync(new URL('./fixtures/market.json',import.meta.url),'utf8'));
const sources=raw.sources as MarketSources;
interface Entry {hash:ccc.Hex;block:bigint;time:bigint;tx:ccc.Transaction;inputs:ccc.Cell[]}
const entries:Entry[]=Object.values<any>(raw.fixtures).map(f=>({hash:f.hash,block:BigInt(f.block),time:BigInt(f.time),tx:ccc.Transaction.fromBytes(f.tx),inputs:f.inputs.map((c:ccc.CellLike)=>ccc.Cell.from(c))}));
function chain(visible:Entry[]=entries){
 const txs=new Map(visible.map(e=>[e.hash,e])),parents=new Map<ccc.Hex,ccc.Transaction>();
 for(const e of entries)for(const cell of e.inputs){
  if(txs.has(cell.outPoint.txHash))continue;
  const p=parents.get(cell.outPoint.txHash)??ccc.Transaction.from({});parents.set(cell.outPoint.txHash,p);
  const i=Number(cell.outPoint.index);while(p.outputs.length<=i){p.outputs.push(cell.cellOutput.clone());p.outputsData.push(cell.outputData);}
  p.outputs[i]=cell.cellOutput.clone();p.outputsData[i]=cell.outputData;
 }
 const reads={tx:new Map<string,number>(),headers:0,pages:0};
 const matches=(cell:ccc.CellOutput,codeHash:string,type:'lock'|'type')=>type==='lock'?cell.lock.codeHash===codeHash:cell.type?.codeHash===codeHash;
 const client:MarketClient={
  async findTransactionsPaged(key:any,_order:any,_limit:any,_after:any){
   reads.pages++;
   const code=ccc.hexFrom(key.script.codeHash),from=key.filter?.blockRange?BigInt(key.filter.blockRange[0]):0n;
   const transactions=[...txs.values()].filter(e=>e.block>=from).flatMap(e=>{
    const cells=[...e.inputs.flatMap((c,i)=>matches(c.cellOutput,code,key.scriptType)?[{isInput:true,cellIndex:BigInt(i)}]:[]),
     ...e.tx.outputs.flatMap((o,i)=>matches(o,code,key.scriptType)?[{isInput:false,cellIndex:BigInt(i)}]:[])];
    return cells.length?[{txHash:e.hash,blockNumber:e.block,txIndex:0n,cells}]:[];
   }).sort((a,b)=>a.blockNumber>b.blockNumber?-1:1);
   return {transactions,lastCursor:'0x'} as any;
  },
  async getTransaction(hash:ccc.HexLike){
   const h=ccc.hexFrom(hash);reads.tx.set(h,(reads.tx.get(h)??0)+1);
   const e=txs.get(h)??entries.find(x=>x.hash===h);if(e)return {transaction:e.tx,status:'committed',blockNumber:e.block} as any;
   const p=parents.get(h);return p?{transaction:p,status:'committed',blockNumber:1n} as any:undefined;
  },
  async getHeaderByNumber(n:ccc.NumLike){reads.headers++;const e=entries.find(x=>x.block===ccc.numFrom(n));return {timestamp:e?.time??0n} as any;},
 };
 return {client,reads};
}
const expected=(list:Entry[])=>list.flatMap(e=>marketEvents(e,sources).events);
const key=(events:{hash:string;kind:string;source:string}[])=>events.map(e=>`${e.hash}:${e.kind}:${e.source}`).sort();

test('a full scan reads only order and pool parents, never wallet funding',async()=>{
 const {client,reads}=chain(),scan=await new MarketScanner(client,sources).scan({maxTransactions:100});
 assert.equal(scan.refresh.mode,'full');assert.equal(scan.transactions,entries.length);
 assert.deepEqual(key(scan.events),key(expected(entries)));assert.deepEqual(scan.skipped,[]);
 const relevant=new Set(entries.flatMap(e=>e.inputs.filter(c=>sources.orders.some(o=>o.codeHash===c.cellOutput.lock.codeHash)||c.cellOutput.type?.codeHash===sources.pools!.codeHash).map(c=>c.outPoint.txHash)));
 for(const h of reads.tx.keys())assert(entries.some(e=>e.hash===h)||relevant.has(h as ccc.Hex),`fetched an unrelated parent ${h}`);
 for(const n of reads.tx.values())assert.equal(n,1,'each transaction read once');
 assert.equal(reads.headers,new Set(entries.map(e=>e.block)).size);
});

test('snapshot and restore: a returning visitor reads only recent blocks, with identical results',async()=>{
 const first=chain(),scanner=new MarketScanner(first.client,sources),full=await scanner.scan();
 const snap=JSON.parse(JSON.stringify(scanner.snapshot()));
 const newest=entries.reduce((m,e)=>e.block>m?e.block:m,0n);
 assert.equal(BigInt(snap.newest),newest-REORG_MARGIN);
 assert(snap.entries.every(([,k]:[string,{block:string}])=>BigInt(k.block)<=newest-REORG_MARGIN),'only settled blocks are stored');
 const second=chain(),restored=new MarketScanner(second.client,sources);
 assert.equal(restored.restore(snap),true);
 const again=await restored.scan();
 assert.equal(again.refresh.mode,'incremental');
 assert.deepEqual(key(again.events),key(full.events));
 const recent=entries.filter(e=>e.block>newest-2n*REORG_MARGIN).length;
 assert.equal(again.refresh.newTransactions,recent,'re-reads the unsettled window only');
 assert(second.reads.tx.size<first.reads.tx.size);
 // Deep equality of restored events, including assets and amounts.
 const canon=(events:unknown[])=>events.map(e=>JSON.stringify(e,(_k,v)=>typeof v==='bigint'?v.toString():v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a.localeCompare(b))):v)).sort();
 assert.deepEqual(canon(again.events),canon(full.events));
});

test('restore refuses snapshots for other sources or with malformed entries',async()=>{
 const {client}=chain(),scanner=new MarketScanner(client,sources);await scanner.scan();
 const snap=JSON.parse(JSON.stringify(scanner.snapshot()));
 const other={...sources,orders:sources.orders.slice(0,1)};
 assert.equal(new MarketScanner(client,other).restore(snap),false);
 for(const tamper of [
  (s:any)=>{s.version=2;},
  (s:any)=>{s.entries[0][0]='0x1234';},
  (s:any)=>{s.entries[0][1].block=(BigInt(s.newest)+1n).toString();},
  (s:any)=>{s.entries.find(([,k]:any)=>k.events.length)[1].events[0].kind='mint';},
  (s:any)=>{s.entries.find(([,k]:any)=>k.events.length)[1].events[0].block='-1';},
 ]){const copy=JSON.parse(JSON.stringify(snap));tamper(copy);const fresh=new MarketScanner(client,sources);assert.equal(fresh.restore(copy),false);assert.equal((await fresh.scan()).refresh.mode,'full','a refused snapshot leaves a full scan');}
 assert.equal(new MarketScanner(client,sources).restore(null),false);
});

test('a refresh drops a transaction that a reorg removed from the recent window',async()=>{
 const newest=entries.reduce((m,e)=>e.block>m?e.block:m,0n),gone=entries.find(e=>e.block===newest)!;
 let visible=entries;
 const make=()=>chain(visible);
 let current=make();
 const scanner=new MarketScanner({findTransactionsPaged:(...a:any[])=>(current.client.findTransactionsPaged as any)(...a),getTransaction:h=>current.client.getTransaction(h),getHeaderByNumber:n=>current.client.getHeaderByNumber(n)} as MarketClient,sources);
 const before=await scanner.scan();
 assert(before.events.some(e=>e.hash===gone.hash));
 visible=entries.filter(e=>e!==gone);current=make();
 const after=await scanner.scan();
 assert.equal(after.refresh.mode,'incremental');
 assert(!after.events.some(e=>e.hash===gone.hash),'the reorged transaction is gone');
 assert.deepEqual(key(after.events),key(expected(visible)));
});
