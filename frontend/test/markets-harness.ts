// Browser harness for markets.spec.ts: runs the real Markets view module against a fake
// client that serves real committed testnet transactions (pool-sdk/test/fixtures/market.json).
// Inputs' parent transactions are synthesized so each input resolves to its recorded cell.
import {ccc} from '@ckb-ccc/core';
import {createMarkets} from '../src/markets.js';
import type {MarketSources} from '../../pool-sdk/src/market.js';
import {assetKey,type AssetId} from '../../sdk/src/types.js';

interface Fixture {hash:ccc.Hex;block:string;time:string;tx:ccc.Hex;inputs:ccc.CellLike[]}
export function install(raw:{sources:MarketSources;fixtures:Record<string,Fixture>},options:{tip:string;labels:Record<string,string>;book:{offer:'ckb'|ccc.Hex;ask:'ckb'|ccc.Hex;available:string;askAmount:string;offerAmount:string}[];pools:{token:ccc.ScriptLike;x:string;y:string;feeBps:string}[]}){
 const txs=new Map<ccc.Hex,{tx:ccc.Transaction;block:bigint;time:bigint;inputs:ccc.Cell[]}>();
 for(const f of Object.values(raw.fixtures))txs.set(f.hash,{tx:ccc.Transaction.fromBytes(f.tx),block:BigInt(f.block),time:BigInt(f.time),inputs:f.inputs.map(c=>ccc.Cell.from(c))});
 const parents=new Map<ccc.Hex,ccc.Transaction>();
 for(const {inputs} of txs.values())for(const cell of inputs){
  const t=cell.outPoint.txHash;if(txs.has(t))continue;
  const parent=parents.get(t)??ccc.Transaction.from({});parents.set(t,parent);
  const i=Number(cell.outPoint.index);
  while(parent.outputs.length<=i){parent.outputs.push(cell.cellOutput.clone());parent.outputsData.push(cell.outputData);}
  parent.outputs[i]=cell.cellOutput.clone();parent.outputsData[i]=cell.outputData;
 }
 const touches=(entry:{tx:ccc.Transaction;inputs:ccc.Cell[]},codeHash:string,kind:'lock'|'type')=>
  [...entry.inputs.map(c=>c.cellOutput),...entry.tx.outputs].some(o=>kind==='lock'?o.lock.codeHash===codeHash:o.type?.codeHash===codeHash);
 const client={
  async findTransactionsPaged(key:{script:ccc.ScriptLike;scriptType:'lock'|'type';filter?:{blockRange?:[ccc.NumLike,ccc.NumLike]}}){
   const codeHash=ccc.hexFrom(key.script.codeHash),from=key.filter?.blockRange?ccc.numFrom(key.filter.blockRange[0]):0n;
   // Like the indexer: report which inputs and outputs matched the searched script.
   const hit=(o:ccc.CellOutput)=>key.scriptType==='lock'?o.lock.codeHash===codeHash:o.type?.codeHash===codeHash;
   const transactions=[...txs.entries()].filter(([,e])=>e.block>=from&&touches(e,codeHash,key.scriptType)).sort((a,b)=>a[1].block>b[1].block?-1:1)
    .map(([txHash,e])=>({txHash,blockNumber:e.block,txIndex:0n,cells:[...e.inputs.flatMap((c,i)=>hit(c.cellOutput)?[{isInput:true,cellIndex:BigInt(i)}]:[]),...e.tx.outputs.flatMap((o,i)=>hit(o)?[{isInput:false,cellIndex:BigInt(i)}]:[])]}));
   return {transactions,lastCursor:'0x'};
  },
  async getTransaction(hash:ccc.Hex){
   (globalThis as any).marketReads=((globalThis as any).marketReads??0)+1;
   const e=txs.get(hash);if(e)return {transaction:e.tx,status:'committed',blockNumber:e.block};
   const p=parents.get(hash);if(p)return {transaction:p,status:'committed',blockNumber:1n};
   return undefined;
  },
  async getHeaderByNumber(n:bigint){const e=[...txs.values()].find(t=>t.block===BigInt(n));return {timestamp:e?.time??0n};},
  async getTipHeader(){return {timestamp:BigInt(options.tip)};},
 } as unknown as ccc.Client;
 const asset=(a:'ckb'|ccc.Hex,scripts:Map<string,ccc.Script>):AssetId=>a==='ckb'?{kind:'ckb'}:{kind:'udt',script:scripts.get(a)!,scriptHash:a};
 const scripts=new Map<string,ccc.Script>();
 for(const {tx,inputs} of txs.values())for(const o of [...tx.outputs,...inputs.map(c=>c.cellOutput)])if(o.type)scripts.set(o.type.hash(),o.type);
 for(const p of options.pools){const s=ccc.Script.from(p.token);scripts.set(s.hash(),s);}
 const view=createMarkets({
  ready:async()=>{},client:()=>client,network:()=>'0xtest',sources:()=>raw.sources,
  book:()=>options.book.map(b=>({offer:asset(b.offer,scripts),ask:asset(b.ask,scripts),available:BigInt(b.available),askAmount:BigInt(b.askAmount),offerAmount:BigInt(b.offerAmount)})),
  pools:()=>options.pools.map(p=>({token:ccc.Script.from(p.token),x:BigInt(p.x),y:BigInt(p.y),feeBps:BigInt(p.feeBps)})),
  label:a=>a.kind==='ckb'?'CKB':options.labels[assetKey(a)]??`${assetKey(a).slice(0,8)}…`,
  decimals:()=>8,
  explorer:hash=>`https://pudge.explorer.nervos.org/transaction/${hash}`,
 });
 for(const s of document.querySelectorAll<HTMLElement>('main > section.view'))s.hidden=s.id!=='view-markets';
 return view.show();
}
