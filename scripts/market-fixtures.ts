#!/usr/bin/env -S npx tsx
// Snapshot one committed testnet transaction per market event kind, with its resolved
// inputs and block time, into pool-sdk/test/fixtures/market.json for offline tests.
//   npx tsx scripts/market-fixtures.ts
import {ccc} from '@ckb-ccc/core';
import {readFile,writeFile} from 'node:fs/promises';
import {scanMarket} from '../pool-sdk/src/market-scan.js';
import {marketEvents,type MarketEvent,type MarketTx} from '../pool-sdk/src/market.js';
import {ENDPOINTS} from './lib/pool-live.js';

const json=async(path:string)=>JSON.parse(await readFile(new URL(`../${path}`,import.meta.url),'utf8'));
const v1=await json('deployments/testnet.json'),v2=await json('deployments/testnet-v2.json'),pools=(await json('deployments/pool-frontend.json')).deployment;
const sources={orders:[{version:1 as const,codeHash:v1.codeHash},{version:2 as const,codeHash:v2.codeHash}],pools};
const client=new ccc.ClientPublicTestnet({url:ENDPOINTS[0]});
const scan=await scanMarket(client,sources,{maxTransactions:2000});
const label=(e:MarketEvent)=>e.kind==='trade'?(e.venue==='pool'?'pool-swap':`v${e.version}-${e.version===2?(e.final?'final':'partial'):'fill'}-${e.got.asset.kind==='ckb'?'ckb-offer':'udt-offer'}`):e.kind==='cancel'||e.kind==='return'?`v${e.version}-${e.kind}`:`pool-${e.kind}`;
const wanted=new Map<string,ccc.Hex>();
for(const e of [...scan.events].reverse())if(!wanted.has(label(e)))wanted.set(label(e),e.hash);
const route=(await json('deployments/pool-route-joyid.json')).hash,solver=(await json('deployments/lock-v2-campaign.json')).solver.settle.hash;
wanted.set('pool-route',route);wanted.set('solver-match',solver);
wanted.set('solver-multi',(await json('deployments/lock-v2-multi.json')).settle.hash);wanted.set('solver-ring',(await json('deployments/lock-v2-ring.json')).settle.hash);
const fixtures:Record<string,unknown>={};
for(const [name,hash] of [...wanted.entries()].sort()){
 const r=(await client.getTransaction(hash))!,tx=r.transaction;
 const inputs=await Promise.all(tx.inputs.map(async i=>{const p=(await client.getTransaction(i.previousOutput.txHash))!.transaction,k=Number(i.previousOutput.index);
  return {outPoint:i.previousOutput,cellOutput:p.outputs[k]!,outputData:p.outputsData[k]!};}));
 const header=(await client.getHeaderByNumber(r.blockNumber!))!;
 const m:MarketTx={hash,block:r.blockNumber!,time:header.timestamp,tx,inputs:inputs.map(c=>ccc.Cell.from(c))};
 fixtures[name]={hash,block:m.block,time:m.time,tx:ccc.hexFrom(tx.toBytes()),inputs,expected:marketEvents(m,sources).events.map(e=>e.kind)};
}
await writeFile(new URL('../pool-sdk/test/fixtures/market.json',import.meta.url),ccc.stringify({sources,fixtures})+'\n');
console.log('Fixtures:',[...wanted.keys()].sort().join(', '));
process.exit(0);
