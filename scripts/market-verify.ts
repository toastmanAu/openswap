#!/usr/bin/env -S npx tsx
// Read-only: scan live testnet market history (pool-sdk/src/market-scan.ts) through
// both endpoints and check every extracted event against what the live runs
// recorded independently (lock-v2-live, lock-v2-campaign, lock-v2-joyid,
// pool-route-joyid). Exits non-zero on any disagreement.
//   npx tsx scripts/market-verify.ts
import {ccc} from '@ckb-ccc/core';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {MarketScanner} from '../pool-sdk/src/market-scan.js';
import {print,type MarketEvent,type Trade} from '../pool-sdk/src/market.js';
import {ENDPOINTS,GENESIS} from './lib/pool-live.js';

const json=async(path:string)=>JSON.parse(await readFile(new URL(`../${path}`,import.meta.url),'utf8'));
const v1=await json('deployments/testnet.json'),v2=await json('deployments/testnet-v2.json'),pools=(await json('deployments/pool-frontend.json')).deployment;
const sources={orders:[{version:1 as const,codeHash:v1.codeHash},{version:2 as const,codeHash:v2.codeHash}],pools};
const units=(s:string)=>ccc.fixedPointFrom(s);

// Independently recorded expectations: order fills as (taken offer, paid ask) per transaction.
type Fill={hash:string;taken?:bigint;paid?:bigint;final?:boolean};
const fills:Fill[]=[],closes:{hash:string;kind:'cancel'|'return';count:number}[]=[];
const live=await json('deployments/lock-v2-live.json');
for(const [name,step] of Object.entries<any>(live.steps)){
 if(name.startsWith('fill'))fills.push({hash:step.hash,taken:units(step.taken),paid:units(step.paid),final:step.final});
 if(name==='cancelC')closes.push({hash:step.hash,kind:'cancel',count:1});
 if(name==='returnB')closes.push({hash:step.hash,kind:'return',count:1});
}
const campaign=await json('deployments/lock-v2-campaign.json');
for(const r of campaign.rounds){
 for(const f of r.fills)fills.push({hash:f.hash,taken:units(f.take),paid:f.paid===undefined?undefined:units(f.paid),final:f.final});
}
fills.push({hash:campaign.late.hash,taken:1000n*10n**8n,paid:units(campaign.late.paid),final:true});
closes.push({hash:campaign.returned.hash,kind:'return',count:2});
const joyid=await json('deployments/lock-v2-joyid.json');
fills.push({hash:joyid.tx,taken:units(joyid.results[0].taken),paid:units(joyid.results[0].paid),final:false});
const route=(await json('deployments/pool-route-joyid.json'));

const results:Record<string,unknown>[]=[];
for(const url of ENDPOINTS){
 const client=new ccc.ClientPublicTestnet({url});
 assert.equal((await client.getHeaderByNumber(0))?.hash,GENESIS,`${url} is not CKB testnet`);
 const t0=Date.now();
 const scanner=new MarketScanner(client,sources);
 const scan=await scanner.scan({maxTransactions:2000});
 const ms=Date.now()-t0;
 // A refresh with the same scanner reads only the last REORG_MARGIN blocks and must agree.
 const t1=Date.now(),again=await scanner.scan({maxTransactions:2000}),refreshMs=Date.now()-t1;
 assert.equal(again.refresh.mode,'incremental');
 assert.equal(ccc.stringify(again.events.map(e=>[e.hash,e.kind]).sort()),ccc.stringify(scan.events.map(e=>[e.hash,e.kind]).sort()),'Incremental refresh changed the events');
 const byHash=new Map<string,MarketEvent[]>();for(const e of scan.events)byHash.set(e.hash,[...(byHash.get(e.hash)??[]),e]);
 const trades=(h:string)=>(byHash.get(h)??[]).filter((e):e is Trade=>e.kind==='trade');
 let checked=0;
 for(const f of fills){
  const t=trades(f.hash).filter(t=>t.venue==='order');
  assert.equal(t.length,1,`${f.hash}: expected one order fill, got ${t.length}`);
  if(f.taken!==undefined)assert.equal(t[0]!.got.amount,f.taken,`${f.hash}: taken`);
  if(f.paid!==undefined)assert.equal(t[0]!.gave.amount,f.paid,`${f.hash}: paid`);
  if(f.final!==undefined)assert.equal(t[0]!.final,f.final,`${f.hash}: final`);
  checked++;
 }
 for(const c of closes){
  const e=(byHash.get(c.hash)??[]).filter(e=>e.kind===c.kind);
  assert.equal(e.length,c.count,`${c.hash}: expected ${c.count} ${c.kind}`);checked++;
 }
 // Solver settlement: two order fills that net out, the solver keeping the CKB spread.
 const settle=trades(campaign.solver.settle.hash);
 assert.equal(settle.length,2,'Solver settlement should be two order fills');
 const [test3Sold,ckbSold]=[settle.find(t=>t.got.asset.kind==='udt')!,settle.find(t=>t.got.asset.kind==='ckb')!];
 assert.equal(test3Sold.got.amount,450n*10n**8n);assert.equal(test3Sold.gave.amount,900n*10n**8n);
 assert.equal(ckbSold.got.amount,1000n*10n**8n);assert.equal(ckbSold.gave.amount,450n*10n**8n);checked++;
 // Multi-order settlement (scripts/lock-v2-multi.ts): three sells filled whole, one buy partly.
 const multi=await json('deployments/lock-v2-multi.json').catch(()=>undefined);
 if(multi?.settle?.status==='verified'){
  const legs=trades(multi.settle.hash);
  assert.equal(legs.length,4,'Multi-order settlement should be four order fills');
  const sells=legs.filter(t=>t.got.asset.kind==='udt').sort((x,y)=>x.gave.amount<y.gave.amount?-1:1);
  assert.deepEqual(sells.map(t=>[t.got.amount,t.gave.amount,t.final]),[[2000n,180n],[2000n,184n],[2000n,188n]].map(([g,p])=>[g!*10n**8n,p!*10n**8n,true]));
  const buy=legs.find(t=>t.got.asset.kind==='ckb')!;
  assert.deepEqual([buy.got.amount,buy.gave.amount,buy.final],[552n*10n**8n,5520n*10n**8n,false]);
  checked++;
 }
 // JoyID two-pool route: TEST2 → CKB in pool 1, CKB → TEST3 in pool 2, hop conserved.
 const hops=trades(route.hash).filter(t=>t.venue==='pool');
 assert.equal(hops.length,2,'Route should be two pool swaps');
 const sell=hops.find(t=>t.got.asset.kind==='ckb')!,buy=hops.find(t=>t.gave.asset.kind==='ckb')!;
 assert.equal(sell.gave.amount,BigInt(route.paid),'Route paid');assert.equal(buy.got.amount,BigInt(route.received),'Route received');
 assert.equal(sell.got.amount,BigInt(route.hop),'Hop out');assert.equal(buy.gave.amount,BigInt(route.hop),'Hop in');checked++;
 const kinds:Record<string,number>={};for(const e of scan.events){const k=e.kind==='trade'?`trade:${e.venue}`:e.kind;kinds[k]=(kinds[k]??0)+1;}
 const markets:Record<string,number>={};for(const e of scan.events)if(e.kind==='trade'){const p=print(e).pair.key;markets[p]=(markets[p]??0)+1;}
 results.push({url,ms,reads:{transactions:scan.refresh.transactionsRead,headers:scan.refresh.headersRead},refresh:{ms:refreshMs,...again.refresh},transactions:scan.transactions,truncated:scan.truncated,events:kinds,markets:Object.keys(markets).length,skipped:scan.skipped,checked});
}
const comparable=(r:Record<string,unknown>)=>({...r,url:'',ms:0,refresh:undefined,reads:undefined});
assert.deepEqual(comparable(results[0]!),comparable(results[1]!),'Endpoints disagree');
console.log(ccc.stringify(results));
assert.equal((results[0]!.skipped as unknown[]).length,0,'Some events could not be interpreted');
console.log('Market extraction agrees with every recorded fill, close, solver match and route on both endpoints.');
process.exit(0);
