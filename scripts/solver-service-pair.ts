#!/usr/bin/env -S npx tsx
// Live check that the always-on solver service (scripts/solver-service.ts --execute)
// settles a crossing pair on its own. TESTNET ONLY. This script never runs a solver:
// it places two crossing TEST2/TEST3 orders and waits for the service to spend them.
//   npx tsx scripts/solver-service-pair.ts [--execute]
// Dry run by default: shows the orders, the wallets' balances and the match the service
// will find. Steps, resumable from deployments/solver-service-pair.json:
//   sell   the maker offers 1,000 TEST3 for 2,000 TEST2 (2 TEST2 each)
//   buy    wallet C offers 1,800 TEST2 for 800 TEST3 (2.25 TEST2 each)
//   settle wait for the service's settlement (read from .local/solver-service/events.jsonl),
//          then check it with scripts/solver-service-verify.ts
// Maker: .local/testnet-split-maker-key. C: testnet-contention-key. Keys never printed.
import {ccc} from '@ckb-ccc/core';
import {readFile,rename,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {udt,submit,orderKey,createOrdersV2,expiryAt,partialRange,parseAmount,
 CatalogAssetResolver,PinnedXudtResolver,type AssetId,type BuildContext,type Deployment,type OpenSwapOrderV2} from '../sdk/src/index.js';
import {matchV2} from '../solver/src/index.js';
import {ENDPOINTS,GENESIS,XUDT} from './lib/pool-live.js';

const execute=process.argv.includes('--execute');
const root=new URL('../',import.meta.url);
const json=async(path:string)=>JSON.parse(await readFile(new URL(path,root),'utf8'));
const v2=await json('deployments/testnet-v2.json') as Deployment;
const markets=await json('deployments/pool-markets.json');
const token=(symbol:string)=>ccc.Script.from(markets.tokens.find((t:{symbol:string})=>t.symbol===symbol).token);
const TEST2_SCRIPT=token('TEST2'),TEST3_SCRIPT=token('TEST3'),TEST2=udt(TEST2_SCRIPT),TEST3=udt(TEST3_SCRIPT);
const UNIT=10n**8n,FEE_RATE=1000n,MAX_FEE=1_000_000n;
const show=(a:bigint)=>ccc.fixedPointToString(a);
const nameOf=(a:AssetId)=>a.kind==='ckb'?'CKB':a.script.eq(TEST2_SCRIPT)?'TEST2':'TEST3';
type Step='sell'|'buy';
const STEPS:{step:Step;wallet:'maker'|'c';offer:AssetId;ask:AssetId;lot:{offerAmount:bigint;askAmount:bigint;minFill:bigint;partialFills:number}}[]=[
 {step:'sell',wallet:'maker',offer:TEST3,ask:TEST2,lot:{offerAmount:1000n*UNIT,askAmount:2000n*UNIT,minFill:100n*UNIT,partialFills:2}},
 {step:'buy',wallet:'c',offer:TEST2,ask:TEST3,lot:{offerAmount:1800n*UNIT,askAmount:800n*UNIT,minFill:100n*UNIT,partialFills:2}},
];

const file=new URL('deployments/solver-service-pair.json',root);
type Tx={hash:ccc.Hex;status:string;[k:string]:unknown};
interface Journal{network:'testnet';deployment:ccc.Hex;startedAt:string;expiry?:string;sell?:Tx;buy?:Tx;settle?:Tx;completedAt?:string}
let journal:Journal;
try{journal=await json('deployments/solver-service-pair.json');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;journal={network:'testnet',deployment:ccc.hexFrom(v2.cellDep.outPoint.txHash),startedAt:new Date().toISOString()};}
assert.equal(journal.deployment,ccc.hexFrom(v2.cellDep.outPoint.txHash),'Journal belongs to a different v2 deployment');
const save=async()=>{const t=new URL(file.href+'.tmp');await writeFile(t,ccc.stringify(journal)+'\n');await rename(t,file);};

const clients=ENDPOINTS.map(url=>new ccc.ClientPublicTestnet({url}));
for(const c of clients)assert.equal((await c.getHeaderByNumber(0))?.hash,GENESIS,'Not CKB testnet');
const client=clients[0]!;
const key=async(name:string)=>new ccc.SignerCkbPrivateKey(client,(await readFile(new URL(`.local/${name}`,root),'utf8')).trim());
const signers={maker:await key('testnet-split-maker-key'),c:await key('testnet-contention-key')};
const resolver=new PinnedXudtResolver(new CatalogAssetResolver(client),XUDT.codeHash,XUDT.dep);
const context=(s:ccc.Signer):BuildContext=>({signer:s,deployment:v2,resolver,maxFee:MAX_FEE,feeRate:FEE_RATE});
const tip=async()=>(await client.getTipHeader()).timestamp/1000n;
async function balance(s:ccc.Signer,script:ccc.Script){
 const lock=(await s.getRecommendedAddressObj()).script;let sum=0n;
 for await(const cell of client.findCellsByLock(lock,script,true))sum+=parseAmount(cell.outputData);
 return sum;
}
async function committed(hash:ccc.Hex){
 for(const c of clients){
  let r=await c.getTransactionNoCache(hash);
  for(let i=0;i<60&&r?.status!=='committed';i++){await new Promise(x=>setTimeout(x,5000));r=await c.getTransactionNoCache(hash);}
  assert.equal(r?.status,'committed',`${hash} not committed on every endpoint`);
 }
}

// Plan: balances, both orders (unsigned) and the match over them.
for(const [w,s] of Object.entries(signers))console.log('wallet',w,ccc.stringify({ckb:show(await s.getBalance()),test2:show(await balance(s,TEST2_SCRIPT)),test3:show(await balance(s,TEST3_SCRIPT))}));
const now=await tip(),expiry=journal.expiry?BigInt(journal.expiry):expiryAt(now+2n*3600n);
const planned:OpenSwapOrderV2[]=[];
for(const [n,s] of STEPS.entries()){
 const built=await createOrdersV2(context(signers[s.wallet]),{offerAsset:s.offer,askAsset:s.ask,expiry,lots:[s.lot]}),lot=built.lots[0]!;
 const outPoint=ccc.OutPoint.from({txHash:`0x${n.toString(16).padStart(64,'0')}`,index:0});
 const cell=ccc.Cell.from({outPoint,cellOutput:lot.cell.cellOutput,outputData:lot.cell.outputData});
 const order={...lot.terms,version:2,outPoint,lock:cell.cellOutput.lock,cell,offerAsset:s.offer,available:lot.terms.offerAmount,supported:true,genesisHash:v2.genesisHash} as OpenSwapOrderV2;
 planned.push(order);
 const range=partialRange(order);
 console.log(s.step,ccc.stringify({wallet:s.wallet,offer:`${show(s.lot.offerAmount)} ${nameOf(s.offer)}`,ask:`${show(s.lot.askAmount)} ${nameOf(s.ask)}`,
  capacity:show(lot.capacity),fee:show(await built.tx.getFee(client)),partial:range?`${show(range.min)}..${show(range.max)}`:'whole only',status:journal[s.step]?.status??'planned'}));
}
const plan=matchV2(planned,{nowSeconds:now});
assert(plan&&!('ring' in plan),'The planned orders do not cross');
console.log('match',ccc.stringify({legs:plan.legs.map(l=>({offer:nameOf(l.order.offerAsset),take:show(l.take!),delivered:show(l.delivered),paid:show(l.paid)})),
 solverKeeps:Object.fromEntries([...plan.surplus].map(([k,v])=>[k===`udt:${TEST2_SCRIPT.hash()}`||k.includes(TEST2_SCRIPT.hash())?'TEST2':'TEST3',show(v)]))}));
if(!execute){console.log('Dry run: nothing signed or sent. Add --execute to place both orders (resumable); the running service settles them.');process.exit(0);}

journal.expiry=expiry.toString();await save();
for(const s of STEPS){
 if(journal[s.step]?.status==='verified')continue;
 if(!journal[s.step]){
  const built=await createOrdersV2(context(signers[s.wallet]),{offerAsset:s.offer,askAsset:s.ask,expiry,lots:[s.lot]});
  const hash=await submit(built,signers[s.wallet],{beforeBroadcast:async h=>{journal[s.step]={hash:h,status:'sent',wallet:s.wallet};await save();}});
  journal[s.step]={hash,status:'sent',wallet:s.wallet};
 }
 await committed(journal[s.step]!.hash);journal[s.step]!.status='verified';await save();
 console.log(`  ${s.step} ${journal[s.step]!.hash} committed on both endpoints`);
}

// Wait for the service: a settlement it submitted that spends both order cells.
const ids=new Set(STEPS.map(s=>orderKey({outPoint:ccc.OutPoint.from({txHash:journal[s.step]!.hash,index:0})})));
if(!journal.settle){
 const events=new URL('.local/solver-service/events.jsonl',root);
 for(let i=0;i<120&&!journal.settle;i++){
  const lines=(await readFile(events,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
  for(const e of lines.filter(e=>e.event==='settlement_submitted')){
   const tx=(await client.getTransactionNoCache(e.details.txHash))?.transaction;
   const spent=tx?.inputs.map(x=>orderKey({outPoint:x.previousOutput}))??[];
   if([...ids].every(id=>spent.includes(id))){journal.settle={hash:e.details.txHash,status:'sent',submittedAt:e.at};await save();break;}
  }
  if(!journal.settle)await new Promise(x=>setTimeout(x,5000));
 }
 assert(journal.settle,'The service did not settle the pair within 10 minutes; is it running with --execute?');
}
await committed(journal.settle.hash);journal.settle.status='committed';journal.completedAt=new Date().toISOString();await save();
console.log(`Service settled the pair: ${journal.settle.hash}. Check it: npx tsx scripts/solver-service-verify.ts ${journal.settle.hash}`);
process.exit(0);
