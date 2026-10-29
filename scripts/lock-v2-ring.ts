#!/usr/bin/env -S npx tsx
// Live three-asset ring settlement (SOLVER.md, matchRing). TESTNET ONLY.
//   npx tsx scripts/lock-v2-ring.ts [--execute]
// Dry run by default: plans the three orders and the ring the solver will find.
// Steps, resumable from deployments/lock-v2-ring.json:
//   ckb     wallet I offers 400 CKB for 4,000 TEST2 (0.1 CKB each; a CKB order holds its own
//           cell storage, so it cannot be much smaller)
//   test2   wallet C offers 6,000 TEST2 for 2,400 TEST3 (0.4 TEST3 each)
//   test3   the maker offers 2,000 TEST3 for 480 CKB (0.24 CKB each)
//   settle  ReferenceSolverV2 run by the solver wallet finds no direct match among the three
//           and settles them as one ring: CKB -> TEST2 -> TEST3 -> CKB
// Ring: I fills whole (4,000 TEST2); C sells 4,000 TEST2 for 1,600 TEST3; the maker sells
// 1,600 TEST3 for 384 CKB; the solver keeps the 16 CKB left over and adds nothing of its own.
// Checked on both endpoints: every order input against the reference model, payments at
// order indexes, per-asset conservation from the cells, solver-only other inputs and outputs.
// I: .local/testnet-pool-issuer-key. Maker: testnet-split-maker-key. C: testnet-contention-key.
// Solver: testnet-solver-key. Keys never printed.
import {ccc} from '@ckb-ccc/core';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {CKB,udt,submit,orderKey,createOrdersV2,decodeTermsV2,expiryAt,checkFill,parseAmount,partialRange,assetKey,
 CatalogAssetResolver,PinnedXudtResolver,type AssetId,type BuildContext,type Deployment,type ModelCell,type OpenSwapOrderV2} from '../sdk/src/index.js';
import {ReferenceSolverV2,matchV2} from '../solver/src/index.js';
import {FileSubmissionJournal} from '../solver/src/journal.js';
import {ENDPOINTS,GENESIS,XUDT} from './lib/pool-live.js';

const execute=process.argv.includes('--execute');
const json=async(path:string)=>JSON.parse(await readFile(new URL(`../${path}`,import.meta.url),'utf8'));
const v2=await json('deployments/testnet-v2.json') as Deployment;
const markets=await json('deployments/pool-markets.json');
const token=(symbol:string)=>ccc.Script.from(markets.tokens.find((t:{symbol:string})=>t.symbol===symbol).token);
const TEST2_SCRIPT=token('TEST2'),TEST3_SCRIPT=token('TEST3'),TEST2=udt(TEST2_SCRIPT),TEST3=udt(TEST3_SCRIPT);
const UNIT=10n**8n,FEE_RATE=1000n,MAX_FEE=1_000_000n;
const show=(a:bigint)=>ccc.fixedPointToString(a);
type Step='ckb'|'test2'|'test3';
const STEPS:{step:Step;wallet:'i'|'maker'|'c';offer:AssetId;ask:AssetId;lot:{offerAmount:bigint;askAmount:bigint;minFill:bigint;partialFills:number}}[]=[
 {step:'ckb',wallet:'i',offer:CKB,ask:TEST2,lot:{offerAmount:400n*UNIT,askAmount:4000n*UNIT,minFill:20n*UNIT,partialFills:2}},
 {step:'test2',wallet:'c',offer:TEST2,ask:TEST3,lot:{offerAmount:6000n*UNIT,askAmount:2400n*UNIT,minFill:100n*UNIT,partialFills:2}},
 {step:'test3',wallet:'maker',offer:TEST3,ask:CKB,lot:{offerAmount:2000n*UNIT,askAmount:480n*UNIT,minFill:100n*UNIT,partialFills:2}},
];

const journalFile=new URL('../deployments/lock-v2-ring.json',import.meta.url);
type Tx={hash:ccc.Hex;status:string;[k:string]:unknown};
interface Journal{network:'testnet';deployment:ccc.Hex;startedAt:string;ckb?:Tx;test2?:Tx;test3?:Tx;settle?:Tx;completedAt?:string}
let journal:Journal;
try{journal=await json('deployments/lock-v2-ring.json');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;journal={network:'testnet',deployment:ccc.hexFrom(v2.cellDep.outPoint.txHash),startedAt:new Date().toISOString()};}
assert.equal(journal.deployment,ccc.hexFrom(v2.cellDep.outPoint.txHash),'Journal belongs to a different v2 deployment');
const save=async()=>{const t=new URL(journalFile.href+'.tmp');await writeFile(t,ccc.stringify(journal)+'\n');await rename(t,journalFile);};

const clients=ENDPOINTS.map(url=>new ccc.ClientPublicTestnet({url}));
for(const c of clients)assert.equal((await c.getHeaderByNumber(0))?.hash,GENESIS,'Not CKB testnet');
const client=clients[0]!;
const key=async(name:string)=>new ccc.SignerCkbPrivateKey(client,(await readFile(new URL(`../.local/${name}`,import.meta.url),'utf8')).trim());
const signers={i:await key('testnet-pool-issuer-key'),maker:await key('testnet-split-maker-key'),c:await key('testnet-contention-key'),solver:await key('testnet-solver-key')};
const lockOf=async(s:ccc.Signer)=>(await s.getRecommendedAddressObj()).script;
const locks={i:await lockOf(signers.i),maker:await lockOf(signers.maker),c:await lockOf(signers.c),solver:await lockOf(signers.solver)};
const resolver=(c:ccc.Client)=>new PinnedXudtResolver(new CatalogAssetResolver(c),XUDT.codeHash,XUDT.dep);
const context=(s:ccc.Signer):BuildContext=>({signer:s,deployment:v2,resolver:resolver(s.client),maxFee:MAX_FEE,feeRate:FEE_RATE});
const tip=async()=>(await client.getTipHeader()).timestamp/1000n;
const nameOf=(a:AssetId)=>a.kind==='ckb'?'CKB':a.script.eq(TEST2_SCRIPT)?'TEST2':'TEST3';

async function committed(hash:ccc.Hex){
 for(const c of clients){
  let r=await c.getTransactionNoCache(hash);
  for(let i=0;i<60&&r?.status!=='committed';i++){await new Promise(x=>setTimeout(x,5000));r=await c.getTransactionNoCache(hash);}
  assert.equal(r?.status,'committed',`${hash} not committed on every endpoint`);
 }
}

// Plan: build each order (unsigned) and show the ring the matcher finds over them.
const now=await tip(),expiry=expiryAt(now+6n*3600n);
const planned:OpenSwapOrderV2[]=[];
for(const [n,s] of STEPS.entries()){
 const built=await createOrdersV2(context(signers[s.wallet]),{offerAsset:s.offer,askAsset:s.ask,expiry,lots:[s.lot]}),lot=built.lots[0]!;
 const outPoint=ccc.OutPoint.from({txHash:`0x${n.toString(16).padStart(64,'0')}`,index:0});
 const cell=ccc.Cell.from({outPoint,cellOutput:lot.cell.cellOutput,outputData:lot.cell.outputData});
 const available=s.offer.kind==='ckb'?lot.capacity-lot.terms.capacityRefund:lot.terms.offerAmount;
 const order={...lot.terms,version:2,outPoint,lock:cell.cellOutput.lock,cell,offerAsset:s.offer,available,supported:true,genesisHash:v2.genesisHash} as OpenSwapOrderV2;
 planned.push(order);
 const range=partialRange(order);
 console.log(s.step,ccc.stringify({wallet:s.wallet,offer:`${show(s.lot.offerAmount)} ${nameOf(s.offer)}`,ask:`${show(s.lot.askAmount)} ${nameOf(s.ask)}`,
  capacity:show(lot.capacity),fee:show(await built.tx.getFee(client)),partial:range?`${show(range.min)}..${show(range.max)}`:'whole only',status:journal[s.step]?.status??'planned'}));
}
const plan=matchV2(planned,{nowSeconds:now});
assert(plan&&(plan as {ring?:boolean}).ring,'The planned orders do not form a profitable ring');
console.log('ring',ccc.stringify({legs:plan.legs.map(l=>({offer:nameOf(l.order.offerAsset),take:show(l.take!),delivered:show(l.delivered),paid:show(l.paid)})),
 solverKeeps:Object.fromEntries([...plan.surplus].map(([k,v])=>[[CKB,TEST2,TEST3].find(a=>assetKey(a)===k)?nameOf([CKB,TEST2,TEST3].find(a=>assetKey(a)===k)!):k,show(v)]))}));
if(!execute){console.log('Dry run: nothing signed or sent. Add --execute to run (resumable).');process.exit(0);}

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

// Settle: the solver sees only these three orders, so nothing else on the book is touched.
const ids=new Set(STEPS.map(s=>orderKey({outPoint:ccc.OutPoint.from({txHash:journal[s.step]!.hash,index:0})})));
if(journal.settle?.status!=='verified'){
 if(!journal.settle){
  const dir=new URL('../.local/lock-v2-ring-solver/',import.meta.url);await mkdir(dir,{recursive:true,mode:0o700});
  const solverJournal=new FileSubmissionJournal(dir.pathname,{genesisHash:GENESIS,accountLockHash:locks.solver.hash()});
  try{
   const events:unknown[]=[];
   const solver=new ReferenceSolverV2(context(signers.solver),(event,details)=>{events.push({event,details});console.log('  solver',event,ccc.stringify(details));},{journal:solverJournal,acceptOrder:o=>ids.has(orderKey(o))});
   const tx=await solver.tick(true);assert(tx,'Solver found no match');
   journal.settle={hash:tx.hash(),status:'sent',events};await save();
  }finally{solverJournal.close();}
 }
 await committed(journal.settle!.hash);
 // Independent checks on both endpoints.
 const checks=[];
 const owners=new Map([[locks.i.hash(),'I'],[locks.maker.hash(),'maker'],[locks.c.hash(),'C']]);
 for(const [n,c] of clients.entries()){
  const r:ccc.ClientTransactionResponse=(await c.getTransactionNoCache(journal.settle!.hash))!,tx:ccc.Transaction=r.transaction,inputs:ccc.Cell[]=await Promise.all(tx.inputs.map(i=>i.getCell(c)));
  const model=(o:ccc.CellOutput,d:ccc.Hex):ModelCell=>({lock:o.lock.hash(),type:o.type?o.type.hash():null,capacity:o.capacity,data:ccc.bytesFrom(d)});
  const outputs=tx.outputs.map((o,i)=>model(o,tx.outputsData[i]!));
  const orderIdx=inputs.flatMap((cell,i)=>cell.cellOutput.lock.codeHash===v2.codeHash?[i]:[]);
  assert.equal(orderIdx.length,3,'All three orders settle together');
  const legs=[];
  for(const i of orderIdx){
   const cell=inputs[i]!,lock=cell.cellOutput.lock,t=decodeTermsV2(lock.args);
   assert(ids.has(orderKey(cell)),'Settlement spent an order outside this run');
   const code=checkFill({owner:t.ownerLock.hash(),capacityRefund:t.capacityRefund,ask:t.askAsset.kind==='udt'?t.askAsset.scriptHash:null,askAmount:t.askAmount,offerAmount:t.offerAmount,minFill:t.minFill},lock.hash(),model(cell.cellOutput,cell.outputData),i,outputs);
   assert.equal(code,0,`Reference model rejects order input ${i} (code ${code})`);
   assert(tx.outputs[i]!.lock.eq(t.ownerLock),`Payment ${i} not at its order index`);
   const rem=tx.outputs.findIndex(o=>o.lock.eq(lock)),pay=tx.outputs[i]!;
   legs.push({input:i,owner:owners.get(t.ownerLock.hash()),offer:cell.cellOutput.type?(cell.cellOutput.type.eq(TEST2_SCRIPT)?'TEST2':'TEST3'):'CKB',
    received:pay.type?`${show(parseAmount(tx.outputsData[i]!))} ${pay.type.eq(TEST2_SCRIPT)?'TEST2':'TEST3'}`:`${show(pay.capacity)} CKB capacity`,
    remainder:rem<0?undefined:{output:rem,left:tx.outputs[rem]!.type?show(parseAmount(tx.outputsData[rem]!)):show(tx.outputs[rem]!.capacity)}});
  }
  // Conservation from the cells: what the orders held covers every payment and remainder.
  const rems=tx.outputs.flatMap((o,k)=>orderIdx.some(i=>inputs[i]!.cellOutput.lock.eq(o.lock))?[k]:[]);
  const makerOuts=[...orderIdx,...rems];
  const sum=(cells:{cellOutput:ccc.CellOutput;outputData:ccc.Hex}[],f:(o:ccc.CellOutput,d:ccc.Hex)=>bigint)=>cells.reduce((s,x)=>s+f(x.cellOutput,x.outputData),0n);
  const amt=(script:ccc.Script)=>(o:ccc.CellOutput,d:ccc.Hex)=>o.type?.eq(script)?parseAmount(d):0n;
  const ins=orderIdx.map(i=>inputs[i]!),outs=makerOuts.map(k=>({cellOutput:tx.outputs[k]!,outputData:tx.outputsData[k]!}));
  const spread={ckb:sum(ins,o=>o.capacity)-sum(outs,o=>o.capacity),test2:sum(ins,amt(TEST2_SCRIPT))-sum(outs,amt(TEST2_SCRIPT)),test3:sum(ins,amt(TEST3_SCRIPT))-sum(outs,amt(TEST3_SCRIPT))};
  for(const [k,v] of Object.entries(spread))assert(v>=0n,`${k} paid to makers exceeds what the orders held`);
  // Everything else belongs to the solver.
  for(const [k,o] of tx.outputs.entries())if(!makerOuts.includes(k))assert(o.lock.eq(locks.solver),`Output ${k} is not the solver's`);
  for(const [k,cell] of inputs.entries())if(!orderIdx.includes(k))assert(cell.cellOutput.lock.eq(locks.solver),`Input ${k} is not the solver's`);
  checks.push({endpoint:ENDPOINTS[n],block:r.blockNumber?.toString(),fee:show(await tx.getFee(c)),legs,
   solverSpread:{ckb:show(spread.ckb),test2:show(spread.test2),test3:show(spread.test3)}});
 }
 assert.equal(checks[0]!.block,checks[1]!.block);
 journal.settle={...journal.settle!,status:'verified',checks};journal.completedAt=new Date().toISOString();await save();
 console.log(ccc.stringify(checks[0]),'\nRing settlement verified on both endpoints.');
}
process.exit(0);
