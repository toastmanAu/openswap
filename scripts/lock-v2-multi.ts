#!/usr/bin/env -S npx tsx
// Live multi-order solver settlement (SOLVER.md, matchBook). TESTNET ONLY.
//   npx tsx scripts/lock-v2-multi.ts [--execute]
// Dry run by default. Steps, resumable from deployments/lock-v2-multi.json:
//   sells   the maker places three TEST2-for-CKB orders (0.090, 0.092, 0.094 CKB each)
//   buy     taker A offers 1,200 CKB for TEST2 at 0.10 CKB each (fills partly)
//   settle  ReferenceSolverV2 run by taker B matches the four orders and settles them
//           in one journaled transaction
// The settlement is checked on both endpoints: every order input against the reference
// model, payments at order indexes, and per-asset conservation from the cells (order
// inputs cover every payment and remainder; the solver adds no tokens or capacity).
// Maker: .local/testnet-split-maker-key. A: contention key. B: solver key. Keys never printed.
import {ccc} from '@ckb-ccc/core';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {CKB,udt,submit,orderKey,createOrdersV2,decodeTermsV2,expiryAt,checkFill,parseAmount,
 CatalogAssetResolver,PinnedXudtResolver,type BuildContext,type Deployment,type ModelCell} from '../sdk/src/index.js';
import {ReferenceSolverV2} from '../solver/src/index.js';
import {FileSubmissionJournal} from '../solver/src/journal.js';
import {ENDPOINTS,GENESIS,XUDT} from './lib/pool-live.js';

const execute=process.argv.includes('--execute');
const json=async(path:string)=>JSON.parse(await readFile(new URL(`../${path}`,import.meta.url),'utf8'));
const v2=await json('deployments/testnet-v2.json') as Deployment;
const markets=await json('deployments/pool-markets.json');
const TEST2_SCRIPT=ccc.Script.from(markets.tokens.find((t:{symbol:string})=>t.symbol==='TEST2').token),TEST2=udt(TEST2_SCRIPT);
const UNIT=10n**8n,FEE_RATE=1000n,MAX_FEE=1_000_000n;
const show=(a:bigint)=>ccc.fixedPointToString(a);
const SELLS=[90n,92n,94n].map(milli=>({offerAmount:2000n*UNIT,askAmount:2000n*milli*UNIT/1000n,minFill:250n*UNIT,partialFills:2}));
const BUY={offerAmount:1200n*UNIT,askAmount:12000n*UNIT,minFill:50n*UNIT,partialFills:2};

const journalFile=new URL('../deployments/lock-v2-multi.json',import.meta.url);
type Tx={hash:ccc.Hex;status:string;[k:string]:unknown};
interface Journal{network:'testnet';deployment:ccc.Hex;startedAt:string;sells?:Tx;buy?:Tx;settle?:Tx;completedAt?:string}
let journal:Journal;
try{journal=await json('deployments/lock-v2-multi.json');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;journal={network:'testnet',deployment:ccc.hexFrom(v2.cellDep.outPoint.txHash),startedAt:new Date().toISOString()};}
assert.equal(journal.deployment,ccc.hexFrom(v2.cellDep.outPoint.txHash),'Journal belongs to a different v2 deployment');
const save=async()=>{const t=new URL(journalFile.href+'.tmp');await writeFile(t,ccc.stringify(journal)+'\n');await rename(t,journalFile);};

const clients=ENDPOINTS.map(url=>new ccc.ClientPublicTestnet({url}));
for(const c of clients)assert.equal((await c.getHeaderByNumber(0))?.hash,GENESIS,'Not CKB testnet');
const client=clients[0]!;
const key=async(name:string)=>new ccc.SignerCkbPrivateKey(client,(await readFile(new URL(`../.local/${name}`,import.meta.url),'utf8')).trim());
const maker=await key('testnet-split-maker-key'),a=await key('testnet-contention-key'),b=await key('testnet-solver-key');
const lockOf=async(s:ccc.Signer)=>(await s.getRecommendedAddressObj()).script;
const locks={maker:await lockOf(maker),a:await lockOf(a),b:await lockOf(b)};
const resolver=(c:ccc.Client)=>new PinnedXudtResolver(new CatalogAssetResolver(c),XUDT.codeHash,XUDT.dep);
const context=(s:ccc.Signer):BuildContext=>({signer:s,deployment:v2,resolver:resolver(s.client),maxFee:MAX_FEE,feeRate:FEE_RATE});
const tip=async()=>(await client.getTipHeader()).timestamp/1000n;

async function committed(hash:ccc.Hex){
 for(const c of clients){
  let r=await c.getTransactionNoCache(hash);
  for(let i=0;i<60&&r?.status!=='committed';i++){await new Promise(x=>setTimeout(x,5000));r=await c.getTransactionNoCache(hash);}
  assert.equal(r?.status,'committed',`${hash} not committed on every endpoint`);
 }
}
async function place(step:'sells'|'buy',build:()=>Promise<Awaited<ReturnType<typeof createOrdersV2>>>,s:ccc.Signer){
 if(journal[step]?.status==='verified')return;
 if(journal[step]){await committed(journal[step]!.hash);journal[step]!.status='verified';await save();return;}
 const built=await build();
 console.log(step,ccc.stringify({orders:built.lots.length,fee:show(await built.tx.getFee(client)),capacity:built.lots.map(l=>show(l.capacity))}));
 if(!execute)return;
 const hash=await submit(built,s,{beforeBroadcast:async h=>{journal[step]={hash:h,status:'sent',orders:built.lots.length};await save();}});
 await committed(hash);journal[step]={hash,status:'verified',orders:built.lots.length};await save();
 console.log(`  ${step} ${hash} committed on both endpoints`);
}

const expiry=expiryAt((await tip())+6n*3600n);
await place('sells',()=>createOrdersV2(context(maker),{offerAsset:TEST2,askAsset:CKB,expiry,lots:SELLS}),maker);
await place('buy',()=>createOrdersV2(context(a),{offerAsset:CKB,askAsset:TEST2,expiry,lots:[BUY]}),a);
if(!execute){console.log('Dry run: nothing signed or sent. Add --execute to run (resumable).');process.exit(0);}

// Settle: the solver sees only these four orders, so nothing else on the book is touched.
const ids=new Set([...[0,1,2].map(index=>orderKey({outPoint:ccc.OutPoint.from({txHash:journal.sells!.hash,index})})),orderKey({outPoint:ccc.OutPoint.from({txHash:journal.buy!.hash,index:0})})]);
if(journal.settle?.status!=='verified'){
 if(!journal.settle){
  const dir=new URL('../.local/lock-v2-multi-solver/',import.meta.url);await mkdir(dir,{recursive:true,mode:0o700});
  const solverJournal=new FileSubmissionJournal(dir.pathname,{genesisHash:GENESIS,accountLockHash:locks.b.hash()});
  try{
   const events:unknown[]=[];
   const solver=new ReferenceSolverV2(context(b),(event,details)=>{events.push({event,details});console.log('  solver',event,ccc.stringify(details));},{journal:solverJournal,acceptOrder:o=>ids.has(orderKey(o))});
   const tx=await solver.tick(true);assert(tx,'Solver found no match');
   journal.settle={hash:tx.hash(),status:'sent',events};await save();
  }finally{solverJournal.close();}
 }
 await committed(journal.settle!.hash);
 // Independent checks on both endpoints.
 const checks=[];
 for(const [n,c] of clients.entries()){
  const r:ccc.ClientTransactionResponse=(await c.getTransactionNoCache(journal.settle!.hash))!,tx:ccc.Transaction=r.transaction,inputs:ccc.Cell[]=await Promise.all(tx.inputs.map(i=>i.getCell(c)));
  const model=(o:ccc.CellOutput,d:ccc.Hex):ModelCell=>({lock:o.lock.hash(),type:o.type?o.type.hash():null,capacity:o.capacity,data:ccc.bytesFrom(d)});
  const outputs=tx.outputs.map((o,i)=>model(o,tx.outputsData[i]!));
  const legs=[];let orderCap=0n,orderTest2=0n;
  const orderIdx=inputs.flatMap((cell,i)=>cell.cellOutput.lock.codeHash===v2.codeHash?[i]:[]);
  for(const i of orderIdx){
   const cell=inputs[i]!,lock=cell.cellOutput.lock,t=decodeTermsV2(lock.args);
   assert(ids.has(orderKey(cell)),'Settlement spent an order outside this run');
   const code=checkFill({owner:t.ownerLock.hash(),capacityRefund:t.capacityRefund,ask:t.askAsset.kind==='udt'?t.askAsset.scriptHash:null,askAmount:t.askAmount,offerAmount:t.offerAmount,minFill:t.minFill},lock.hash(),model(cell.cellOutput,cell.outputData),i,outputs);
   assert.equal(code,0,`Reference model rejects order input ${i} (code ${code})`);
   assert(tx.outputs[i]!.lock.eq(t.ownerLock),`Payment ${i} not at its order index`);
   orderCap+=cell.cellOutput.capacity;if(cell.cellOutput.type?.eq(TEST2_SCRIPT))orderTest2+=parseAmount(cell.outputData);
   const rem=tx.outputs.findIndex(o=>o.lock.eq(lock));
   legs.push({input:i,owner:t.ownerLock.eq(locks.maker)?'maker':'A',offer:cell.cellOutput.type?'TEST2':'CKB',remainder:rem<0?undefined:rem});
  }
  assert.equal(orderIdx.length,4,'All four orders settle together');
  // Conservation from the cells: what the orders held covers every payment and remainder.
  const paidOut=orderIdx.map(i=>tx.outputs[i]!);
  const rems=tx.outputs.flatMap((o,k)=>orderIdx.some(i=>inputs[i]!.cellOutput.lock.eq(o.lock))?[k]:[]);
  const outCap=[...orderIdx,...rems].reduce((s,k)=>s+tx.outputs[k]!.capacity,0n);
  const outTest2=[...orderIdx,...rems].reduce((s,k)=>s+(tx.outputs[k]!.type?.eq(TEST2_SCRIPT)?parseAmount(tx.outputsData[k]!):0n),0n);
  assert(orderCap>=outCap,'Capacity paid to makers exceeds what the orders held');
  assert(orderTest2>=outTest2,'TEST2 paid to makers exceeds what the orders held');
  // Everything else belongs to the solver.
  for(const [k,o] of tx.outputs.entries())if(!orderIdx.includes(k)&&!rems.includes(k))assert(o.lock.eq(locks.b),`Output ${k} is not the solver's`);
  for(const [k,cell] of inputs.entries())if(!orderIdx.includes(k))assert(cell.cellOutput.lock.eq(locks.b),`Input ${k} is not the solver's`);
  checks.push({endpoint:ENDPOINTS[n],block:r.blockNumber?.toString(),fee:show(await tx.getFee(c)),legs,paymentsAtIndexes:paidOut.length,
   solverSpread:{ckb:show(orderCap-outCap),test2:show(orderTest2-outTest2)}});
 }
 assert.equal(checks[0]!.block,checks[1]!.block);
 journal.settle={...journal.settle!,status:'verified',checks};journal.completedAt=new Date().toISOString();await save();
 console.log(ccc.stringify(checks[0]),'\nMulti-order settlement verified on both endpoints.');
}
process.exit(0);
