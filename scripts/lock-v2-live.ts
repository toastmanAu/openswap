#!/usr/bin/env -S npx tsx
// Live order lock v2 run (docs/research/ORDER_LOCK_V2.md step 6). TESTNET ONLY.
//   status                 show the journal
//   run <step> [--execute] build one step (dry run by default), then send it once and
//                          verify it on both endpoints
// Steps, in order: createB (short expiry), createA, createC, fillA1 (partial),
// fillA2 (final), fillC1 (partial CKB offer), cancelC (maker cancels the remainder),
// returnB (the v2 keeper returns B after expiry).
// Maker: .local/testnet-split-maker-key. Taker and keeper: .local/testnet-contention-key.
// Keys are never printed. Journal: deployments/lock-v2-live.json.
import {ccc} from '@ckb-ccc/core';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {CKB,udt,submit,orderKey,createOrdersV2,fillOrdersV2,cancelOrdersV2,parseV2,decodeTermsV2,expiryAt,expirySeconds,checkFill,
 CatalogAssetResolver,PinnedXudtResolver,type BuildContext,type BuiltTransaction,type Deployment,type ModelCell} from '../sdk/src/index.js';
import {ReferenceSolverV2} from '../solver/src/index.js';
import {FileSubmissionJournal} from '../solver/src/journal.js';
import {ENDPOINTS,FEE_RATE,GENESIS,MAX_FEE,XUDT} from './lib/pool-live.js';

const json=async(path:string)=>JSON.parse(await readFile(new URL(`../${path}`,import.meta.url),'utf8'));
const v2=await json('deployments/testnet-v2.json') as Deployment;
const v1=await json('deployments/testnet.json') as Deployment;
const markets=await json('deployments/pool-markets.json');
const token=(symbol:string)=>ccc.Script.from(markets.tokens.find((t:{symbol:string})=>t.symbol===symbol).token);
const TEST2=udt(token('TEST2')),TEST3=udt(token('TEST3'));
const UNIT=10n**8n;
const journalFile=new URL('../deployments/lock-v2-live.json',import.meta.url);
const STEPS=['createB','createA','createC','fillA1','fillA2','fillC1','cancelC','returnB'] as const;
type Step=typeof STEPS[number];
type Journal={network:'testnet';deployment:ccc.Hex;steps:Partial<Record<Step,Record<string,unknown>&{status:string;hash?:ccc.Hex}>>};

const readJournal=async():Promise<Journal>=>readFile(journalFile,'utf8').then(JSON.parse,(e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return {network:'testnet',deployment:v2.cellDep.outPoint.txHash,steps:{}};throw e;});
const saveJournal=(j:Journal)=>writeFile(journalFile,ccc.stringify(j)+'\n');
const open=(url:string)=>new ccc.ClientPublicTestnet({url});
const resolver=(client:ccc.Client)=>new PinnedXudtResolver(new CatalogAssetResolver(client),XUDT.codeHash,XUDT.dep);
const key=async(client:ccc.Client,name:string)=>new ccc.SignerCkbPrivateKey(client,(await readFile(new URL(`../.local/${name}`,import.meta.url),'utf8')).trim());
const context=(signer:ccc.Signer,deployment=v2):BuildContext=>({signer,deployment,resolver:resolver(signer.client),maxFee:MAX_FEE,feeRate:FEE_RATE});
const tipSeconds=async(client:ccc.Client)=>(await client.getTipHeader()).timestamp/1000n;
/** The live cell currently holding an order with this exact lock (orders keep identical args across partial fills). */
async function liveOrder(client:ccc.Client,lock:ccc.ScriptLike){
 const found=[];for await(const cell of client.findCells({script:lock,scriptType:'lock',scriptSearchMode:'exact'}))found.push(cell);
 assert.equal(found.length,1,`Expected exactly one live order cell, found ${found.length}`);
 return found[0]!;
}
const show=(a:bigint)=>ccc.fixedPointToString(a);

const [command,stepName,...flags]=process.argv.slice(2);
const execute=flags.includes('--execute');
const journal=await readJournal();
assert.equal(journal.deployment,v2.cellDep.outPoint.txHash,'Journal belongs to a different v2 deployment');

if(command==='status'){console.log(ccc.stringify(journal));process.exit(0);}
assert(command==='run'&&STEPS.includes(stepName as Step),`Usage: lock-v2-live.ts status | run <${STEPS.join('|')}> [--execute]`);
const step=stepName as Step;
for(const earlier of STEPS.slice(0,STEPS.indexOf(step)))if(earlier!=='returnB')assert.equal(journal.steps[earlier]?.status,'verified',`Run ${earlier} first`);
assert(!journal.steps[step],`${step} is already recorded (${journal.steps[step]?.status}); inspect the journal, do not send twice`);

const client=open(ENDPOINTS[0]);
assert.equal((await client.getHeaderByNumber(0))?.hash,GENESIS,'Not CKB testnet');
const maker=await key(client,'testnet-split-maker-key'),taker=await key(client,'testnet-contention-key');
const makerLock=(await maker.getRecommendedAddressObj()).script,takerLock=(await taker.getRecommendedAddressObj()).script;
assert(!makerLock.eq(takerLock),'Maker and taker must differ');
const now=await tipSeconds(client);
const orderLockOf=(s:Step)=>{const r=journal.steps[s];assert(r?.orderLock,`${s} has no order lock`);return ccc.Script.from(r.orderLock as ccc.ScriptLike);};

let built:BuiltTransaction,signer:ccc.Signer,summary:Record<string,unknown>={};
let send:(()=>Promise<ccc.Hex>)|undefined;
switch(step){
 case 'createB':case 'createA':case 'createC':{
  const spec={
   createB:{offerAsset:TEST3,askAsset:CKB,expiry:expiryAt(now+120n),lot:{offerAmount:100n*UNIT,askAmount:50n*UNIT,minFill:100n*UNIT,partialFills:0}},
   createA:{offerAsset:TEST2,askAsset:CKB,expiry:expiryAt(now+6n*3600n),lot:{offerAmount:1000n*UNIT,askAmount:300n*UNIT,minFill:250n*UNIT,partialFills:2}},
   createC:{offerAsset:CKB,askAsset:TEST2,expiry:expiryAt(now+6n*3600n),lot:{offerAmount:400n*UNIT,askAmount:1000n*UNIT,minFill:100n*UNIT,partialFills:2}},
  }[step];
  signer=maker;
  const created=await createOrdersV2(context(maker),{offerAsset:spec.offerAsset,askAsset:spec.askAsset,expiry:spec.expiry,lots:[spec.lot]});
  built=created;
  const lot=created.lots[0]!;
  summary={orderLock:lot.cell.cellOutput.lock,capacity:show(lot.capacity),offer:show(spec.lot.offerAmount),ask:show(spec.lot.askAmount),minFill:show(lot.terms.minFill),
   capacityRefund:show(lot.terms.capacityRefund),expiresAt:new Date(Number(expirySeconds(spec.expiry)!)*1000).toISOString()};
  break;
 }
 case 'fillA1':case 'fillA2':case 'fillC1':{
  const order=await liveOrder(client,orderLockOf(step==='fillC1'?'createC':'createA'));
  const take={fillA1:400n*UNIT,fillA2:undefined,fillC1:100n*UNIT}[step];
  signer=taker;
  const filled=await fillOrdersV2(context(taker),[{outPoint:order.outPoint,take}],{v1,nowSeconds:now+300n});
  built=filled;
  const plan=filled.plans[0]!;
  summary={order:orderKey({outPoint:order.outPoint}),taken:show(plan.taken),paid:show(plan.paid),final:plan.final,remainderCapacity:plan.remainder&&show(plan.remainder.cellOutput.capacity)};
  break;
 }
 case 'cancelC':{
  const order=await liveOrder(client,orderLockOf('createC'));
  signer=maker;
  built=await cancelOrdersV2(context(maker),[order.outPoint]);
  summary={order:orderKey({outPoint:order.outPoint}),capacity:show(order.cellOutput.capacity)};
  break;
 }
 case 'returnB':{
  const order=await liveOrder(client,orderLockOf('createB'));
  const due=expirySeconds(decodeTermsV2(order.cellOutput.lock.args).expiry)!+900n;
  if(now<due){console.log(`B is returnable by the keeper in about ${due-now} s (tip time).`);process.exit(0);}
  signer=taker;
  const dir=new URL('../.local/lock-v2-keeper/',import.meta.url);await mkdir(dir,{recursive:true,mode:0o700});
  const solverJournal=new FileSubmissionJournal(dir.pathname,{genesisHash:GENESIS,accountLockHash:takerLock.hash()});
  const keeper=new ReferenceSolverV2(context(taker),(event,details)=>console.log(event,ccc.stringify(details)),{journal:solverJournal,acceptOrder:o=>orderKey(o)===orderKey({outPoint:order.outPoint})});
  const preview=await keeper.returnExpired(false);
  assert(preview,'Keeper found nothing to return');
  summary={order:orderKey({outPoint:order.outPoint}),capacity:show(order.cellOutput.capacity)};
  built={tx:preview} as BuiltTransaction;
  send=async()=>{const tx=await keeper.returnExpired(true);assert(tx,'Keeper did not send');return tx.hash();};
  break;
 }
}
const fee=await built!.tx.getFee(client);
console.log(ccc.stringify({step,signer:(signer! as ccc.Signer)===maker?'maker':'taker',inputs:built!.tx.inputs.length,outputs:built!.tx.outputs.length,fee:show(fee),...summary}));
if(!execute){console.log('Dry run: nothing signed or sent. Add --execute to send once.');process.exit(0);}

journal.steps[step]={status:'building',...summary};await saveJournal(journal);
const hash=send?await send():await submit(built!,signer!,{beforeBroadcast:async(h)=>{journal.steps[step]={...journal.steps[step]!,status:'sent',hash:h};await saveJournal(journal);}});
journal.steps[step]={...journal.steps[step]!,status:'sent',hash};await saveJournal(journal);
console.log(`${step} TX HASH:`,hash);
await client.waitTransaction(hash,1,900_000);

// Independent verification on both endpoints: rerun the reference model on the committed
// transaction for every v2 order input, and check returns and cancels byte for byte.
const checks=[];
for(const url of ENDPOINTS){
 const c=open(url);
 const response=await c.getTransactionNoCache(hash);assert.equal(response?.status,'committed',`${step} not committed on ${url}`);
 const tx=response!.transaction,inputs=await Promise.all(tx.inputs.map(i=>i.getCell(c)));
 const model=(o:ccc.CellOutput,d:ccc.Hex):ModelCell=>({lock:o.lock.hash(),type:o.type?o.type.hash():null,capacity:o.capacity,data:ccc.bytesFrom(d)});
 const outputs=tx.outputs.map((o,i)=>model(o,tx.outputsData[i]!));
 const orders=[];
 for(const [i,cell] of inputs.entries()){
  const lock=cell.cellOutput.lock;if(lock.codeHash!==v2.codeHash||lock.hashType!=='data1')continue;
  const t=decodeTermsV2(lock.args);
  if(step.startsWith('fill')){
   const code=checkFill({owner:t.ownerLock.hash(),capacityRefund:t.capacityRefund,ask:t.askAsset.kind==='udt'?t.askAsset.scriptHash:null,askAmount:t.askAmount,offerAmount:t.offerAmount,minFill:t.minFill},lock.hash(),model(cell.cellOutput,cell.outputData),i,outputs);
   assert.equal(code,0,`Model rejects committed fill at input ${i} (code ${code})`);
   assert(tx.outputs[i]!.lock.eq(t.ownerLock),'Payment is not at the order index');
  }else if(step==='returnB'||step==='cancelC'){
   assert(tx.outputs[i]!.lock.eq(t.ownerLock)&&tx.outputs[i]!.capacity>=cell.cellOutput.capacity&&tx.outputsData[i]===cell.outputData&&(tx.outputs[i]!.type?.hash()??null)===(cell.cellOutput.type?.hash()??null),'Recovery output mismatch');
   assert(!tx.outputs.some(o=>o.lock.eq(lock)),'Order recreated');
   if(step==='returnB')assert.equal(tx.inputs[i]!.since,t.expiry,'Return input since is not the expiry');
   else assert(inputs.some((p,j)=>j!==i&&p.cellOutput.lock.eq(t.ownerLock)),'Cancel has no owner proof input');
  }
  const order=await parseV2(cell,v2,resolver(c));
  orders.push({input:i,offer:show(order.available),stillLive:!!(await c.getCellLive(cell.outPoint,true))});
 }
 if(step.startsWith('create')){
  const cell=await c.getCellLive({txHash:hash,index:0},true);assert(cell,'Order not live');
  const order=await parseV2(cell,v2,resolver(c));
  assert(order.supported&&order.ownerLock.eq(makerLock)&&order.lock.eq(orderLockOf(step)),'Created order mismatch');
  orders.push({output:0,offer:show(order.available),minFill:show(order.minFill)});
 }
 assert(orders.length>=1&&orders.every(o=>!('stillLive' in o)||!o.stillLive),'Order input still live');
 checks.push({url,blockNumber:response!.blockNumber?.toString(),fee:show(await tx.getFee(c)),orders});
}
journal.steps[step]={...journal.steps[step]!,status:'verified',hash,checks};await saveJournal(journal);
console.log(ccc.stringify(checks),`\n${step} verified on both endpoints.`);
process.exit(0);
