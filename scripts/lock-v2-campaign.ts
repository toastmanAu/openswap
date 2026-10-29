#!/usr/bin/env -S npx tsx
// Live order lock v2 campaign (docs/research/ORDER_LOCK_V2.md step 6). TESTNET ONLY.
//   npx tsx scripts/lock-v2-campaign.ts [--execute] [--rounds=N] [--seed=N]
// Dry run by default: prints the plan and balances, signs nothing.
//
// Phases, resumable from deployments/lock-v2-campaign.json:
//   fund     the maker gives each taker CKB and TEST2 (one transaction)
//   expiry   the maker places three short-expiry orders in one transaction
//   race     per round: the maker places one partly fillable order (alternately
//            selling TEST2 for CKB and offering CKB for TEST2); both takers build
//            random partial fills of the same cell and send them at once to
//            different endpoints; exactly one may commit; the loser rebuilds on the
//            remainder; the order is then filled to completion
//   solver   two crossing v2 orders from different owners; ReferenceSolverV2 run by
//            taker B matches them (one leg partial) and settles them in one transaction
//   late     after expiry, taker A fills one expired order (soft expiry: still
//            fillable at the maker's price until returned)
//   return   taker B's keeper returns the other two expired orders in one transaction
// Every committed transaction is checked on both endpoints: fills against the
// reference model, returns byte for byte with since = expiry.
// Maker: .local/testnet-split-maker-key. Takers: A = contention key, B = solver key.
import {ccc} from '@ckb-ccc/core';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {CKB,udt,submit,orderKey,createOrdersV2,fillOrdersV2,returnExpiredV2,parseV2,partialRange,decodeTermsV2,expiryAt,expirySeconds,checkFill,tokens,
 amountData,parseAmount,CatalogAssetResolver,PinnedXudtResolver,type AssetId,type BuildContext,type BuiltTransaction,type Deployment,type ModelCell} from '../sdk/src/index.js';
import {ReferenceSolverV2} from '../solver/src/index.js';
import {FileSubmissionJournal} from '../solver/src/journal.js';
import {ENDPOINTS,GENESIS,XUDT} from './lib/pool-live.js';

const args=process.argv.slice(2);
for(const a of args)assert(a==='--execute'||/^--rounds=\d+$/.test(a)||/^--seed=\d+$/.test(a),`Unknown option ${a}`);
const execute=args.includes('--execute');
const option=(name:string,fallback:number)=>Number(args.find(a=>a.startsWith(`--${name}=`))?.split('=')[1]??fallback);
const json=async(path:string)=>JSON.parse(await readFile(new URL(`../${path}`,import.meta.url),'utf8'));
const v2=await json('deployments/testnet-v2.json') as Deployment;
const markets=await json('deployments/pool-markets.json');
const tokenScript=(symbol:string)=>ccc.Script.from(markets.tokens.find((t:{symbol:string})=>t.symbol===symbol).token);
const TEST2_SCRIPT=tokenScript('TEST2'),TEST3_SCRIPT=tokenScript('TEST3');
const TEST2=udt(TEST2_SCRIPT),TEST3=udt(TEST3_SCRIPT);
const UNIT=10n**8n,FEE_RATE=1000n,MAX_FEE=1_000_000n; // 0.01 CKB per transaction
const FUND={ckb:2000n*UNIT,test2:20_000n*UNIT};
const show=(a:bigint)=>ccc.fixedPointToString(a);

// Journal ---------------------------------------------------------------------------
const journalFile=new URL('../deployments/lock-v2-campaign.json',import.meta.url);
type Tx={hash:ccc.Hex;status:string;checks?:unknown;[k:string]:unknown};
interface Round{kind:'sell'|'buy';create?:Tx;order?:ccc.ScriptLike;race?:{a?:Tx;b?:Tx;winner?:'a'|'b';loserOutcome?:string};fills:Tx[];complete?:boolean}
interface Journal{network:'testnet';deployment:ccc.Hex;seed:number;startedAt:string;fund?:Tx;expiry?:Tx&{orders?:ccc.ScriptLike[];expiresAt?:string};
 rounds:Round[];solver?:{orders?:Tx[];settle?:Tx};late?:Tx;returned?:Tx;completedAt?:string}
let journal:Journal;
try{journal=await json('deployments/lock-v2-campaign.json');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
 journal={network:'testnet',deployment:ccc.hexFrom(v2.cellDep.outPoint.txHash),seed:option('seed',61),startedAt:new Date().toISOString(),rounds:[]};}
assert.equal(journal.deployment,ccc.hexFrom(v2.cellDep.outPoint.txHash),'Journal belongs to a different v2 deployment');
const rounds=option('rounds',6);
assert(Number.isInteger(rounds)&&rounds>=2&&rounds<=20,'Rounds must be 2..20');
const save=async()=>{const t=new URL(journalFile.href+'.tmp');await writeFile(t,ccc.stringify(journal)+'\n');await rename(t,journalFile);};

// Seeded randomness (mulberry32), advanced deterministically per use.
let state=journal.seed>>>0;
const random=()=>{state=(state+0x6d2b79f5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
const between=(min:bigint,max:bigint,step:bigint)=>{const n=(max-min)/step;return min+BigInt(Math.floor(random()*Number(n+1n)))*step;};

// Clients and wallets -----------------------------------------------------------------
const clients=ENDPOINTS.map(url=>new ccc.ClientPublicTestnet({url}));
for(const c of clients)assert.equal((await c.getHeaderByNumber(0))?.hash,GENESIS,'Not CKB testnet');
const keyOf=async(name:string)=>(await readFile(new URL(`../.local/${name}`,import.meta.url),'utf8')).trim();
const keys={maker:await keyOf('testnet-split-maker-key'),a:await keyOf('testnet-contention-key'),b:await keyOf('testnet-solver-key')};
const signer=(who:keyof typeof keys,endpoint=0)=>new ccc.SignerCkbPrivateKey(clients[endpoint]!,keys[who]);
const lockOf=async(who:keyof typeof keys)=>(await signer(who).getRecommendedAddressObj()).script;
const locks={maker:await lockOf('maker'),a:await lockOf('a'),b:await lockOf('b')};
assert(new Set(Object.values(locks).map(l=>l.hash())).size===3,'Wallets must differ');
const resolver=(client:ccc.Client)=>new PinnedXudtResolver(new CatalogAssetResolver(client),XUDT.codeHash,XUDT.dep);
const context=(s:ccc.Signer):BuildContext=>({signer:s,deployment:v2,resolver:resolver(s.client),maxFee:MAX_FEE,feeRate:FEE_RATE});
const client=clients[0]!;
const tipSeconds=async()=>(await client.getTipHeader()).timestamp/1000n;

async function balances(){
 const out:Record<string,string>={};
 for(const who of ['maker','a','b'] as const){
  let ckb=0n,test2=0n,test3=0n;
  for await(const c of client.findCells({script:locks[who],scriptType:'lock',scriptSearchMode:'exact'})){
   if(!c.cellOutput.type&&c.outputData==='0x')ckb+=c.cellOutput.capacity;
   else if(c.cellOutput.type?.eq(TEST2_SCRIPT))test2+=parseAmount(c.outputData);
   else if(c.cellOutput.type?.eq(TEST3_SCRIPT))test3+=parseAmount(c.outputData);
  }
  out[who]=`${show(ckb)} CKB, ${show(test2)} TEST2, ${show(test3)} TEST3`;
 }
 return out;
}

// Verification --------------------------------------------------------------------------
const modelCell=(o:ccc.CellOutput,d:ccc.Hex):ModelCell=>({lock:o.lock.hash(),type:o.type?o.type.hash():null,capacity:o.capacity,data:ccc.bytesFrom(d)});
/** Check a committed transaction on both endpoints and summarise every v2 order input. */
async function verify(hash:ccc.Hex,kind:'create'|'fill'|'return'|'fund'){
 const checks=[];
 for(const [n,c] of clients.entries()){
  let response=await c.getTransactionNoCache(hash);
  for(let i=0;i<60&&response?.status!=='committed';i++){await new Promise(r=>setTimeout(r,5000));response=await c.getTransactionNoCache(hash);}
  assert.equal(response?.status,'committed',`${hash} not committed on ${ENDPOINTS[n]}`);
  const tx=response!.transaction,inputs=await Promise.all(tx.inputs.map(i=>i.getCell(c)));
  const outputs=tx.outputs.map((o,i)=>modelCell(o,tx.outputsData[i]!));
  const orders=[];
  for(const [i,cell] of inputs.entries()){
   const lock=cell.cellOutput.lock;if(lock.codeHash!==v2.codeHash||lock.hashType!=='data1')continue;
   const t=decodeTermsV2(lock.args);
   if(kind==='fill'){
    const code=checkFill({owner:t.ownerLock.hash(),capacityRefund:t.capacityRefund,ask:t.askAsset.kind==='udt'?t.askAsset.scriptHash:null,askAmount:t.askAmount,offerAmount:t.offerAmount,minFill:t.minFill},lock.hash(),modelCell(cell.cellOutput,cell.outputData),i,outputs);
    assert.equal(code,0,`Model rejects committed fill ${hash} input ${i} (code ${code})`);
    assert(tx.outputs[i]!.lock.eq(t.ownerLock),'Payment not at the order index');
   }else if(kind==='return'){
    assert(tx.outputs[i]!.lock.eq(t.ownerLock)&&tx.outputs[i]!.capacity>=cell.cellOutput.capacity&&tx.outputsData[i]===cell.outputData&&(tx.outputs[i]!.type?.hash()??null)===(cell.cellOutput.type?.hash()??null),'Recovery output mismatch');
    assert.equal(tx.inputs[i]!.since,t.expiry,'Return since is not the expiry');
   }else throw new Error(`Unexpected order input in ${kind}`);
   const remainder=tx.outputs.findIndex(o=>o.lock.eq(lock));
   orders.push({input:i,remainder:remainder<0?undefined:remainder,spent:!(await c.getCellLive(cell.outPoint,true))});
   assert(orders.at(-1)!.spent,'Order input still live');
  }
  if(kind==='fill'||kind==='return')assert(orders.length>=1,'No order input');
  checks.push({endpoint:ENDPOINTS[n],block:response!.blockNumber?.toString(),fee:show(await tx.getFee(c)),orders});
 }
 assert.equal(checks[0]!.block,checks[1]!.block,'Endpoints disagree on the block');
 return checks;
}
async function send(built:BuiltTransaction,s:ccc.Signer,record:(tx:Tx)=>void,kind:'create'|'fill'|'return'|'fund',extra:Record<string,unknown>={}):Promise<Tx>{
 const hash=await submit(built,s,{beforeBroadcast:async h=>{record({hash:h,status:'sent',...extra});await save();}});
 const tx:Tx={hash,status:'sent',...extra};record(tx);await save();
 tx.checks=await verify(hash,kind);tx.status='verified';record(tx);await save();
 console.log(`  ${kind} ${hash} verified on both endpoints`,ccc.stringify(extra));
 return tx;
}
/** Wait for a recorded transaction from an interrupted run to settle before going on. */
async function settle(tx:Tx|undefined,kind:'create'|'fill'|'return'|'fund'){
 if(!tx||tx.status==='verified')return tx;
 const r=await client.getTransactionNoCache(tx.hash);
 if(r?.status==='rejected'||!r||r.status==='unknown'){tx.status='dropped';await save();return undefined;}
 tx.checks=await verify(tx.hash,kind);tx.status='verified';await save();return tx;
}
async function liveOrder(lock:ccc.ScriptLike){
 // Each taker's client caches what it sent, so confirm every candidate with the node.
 const found=[];for await(const cell of client.findCells({script:lock,scriptType:'lock',scriptSearchMode:'exact'}))if(await client.getCellLiveNoCache(cell.outPoint,false))found.push(cell);
 assert(found.length<=1,'More than one live cell with one order lock');
 return found[0];
}

// Plan ------------------------------------------------------------------------------------
console.log('Campaign plan:',ccc.stringify({execute,seed:journal.seed,rounds,done:journal.rounds.filter(r=>r.complete).length,balances:await balances()}));
if(!execute){console.log('Dry run: nothing signed or sent. Add --execute to run (resumable).');process.exit(0);}

// fund
journal.fund=await settle(journal.fund,'fund');
if(!journal.fund){
 const s=signer('maker'),ctx=context(s);
 const tx=ccc.Transaction.from({});
 for(const who of ['a','b'] as const){tx.addOutput({lock:locks[who],capacity:FUND.ckb},'0x');tx.addOutput({lock:locks[who],type:TEST2_SCRIPT},amountData(FUND.test2));}
 await tokens(tx,ctx);await tx.completeInputsByCapacity(s);await tx.completeFeeBy(s,FEE_RATE);
 const fee=await tx.getFee(client);assert(fee<=MAX_FEE,'Funding fee too high');
 for(const input of tx.inputs)assert((await input.getCell(client)).cellOutput.lock.eq(locks.maker),'Funding input not the maker');
 const extra={to:'a, b',each:`${show(FUND.ckb)} CKB + ${show(FUND.test2)} TEST2`};
 const signed=await s.signTransaction(tx),hash=signed.hash();
 journal.fund={hash,status:'sent',...extra};await save();
 assert.equal(await client.sendTransaction(signed),hash);
 journal.fund.checks=await verify(hash,'fund');journal.fund.status='verified';await save();
 console.log(`  fund ${hash} verified on both endpoints`);
}

// expiry: three short-expiry orders, placed first so the clock runs during the races
journal.expiry=await settle(journal.expiry,'create') as Journal['expiry'];
if(!journal.expiry){
 const s=signer('maker'),at=(await tipSeconds())+180n;
 const built=await createOrdersV2(context(s),{offerAsset:TEST2,askAsset:CKB,expiry:expiryAt(at),lots:[0,1,2].map(()=>({offerAmount:1000n*UNIT,askAmount:95n*UNIT,minFill:250n*UNIT,partialFills:2}))});
 const orders=built.lots.map(l=>l.cell.cellOutput.lock);
 await send(built,s,t=>journal.expiry={...t,orders,expiresAt:new Date(Number(at)*1000).toISOString()},'create',{orders:orders.length,expiresAt:new Date(Number(at)*1000).toISOString()});
}

// race rounds
for(let n=0;n<rounds;n++){
 const round:Round=journal.rounds[n]??{kind:n%2===0?'sell':'buy',fills:[]};journal.rounds[n]=round;
 if(round.complete)continue;
 console.log(`Round ${n+1}/${rounds} (${round.kind})`);
 round.create=await settle(round.create,'create');
 if(!round.create){
  const s=signer('maker');
  const spec=round.kind==='sell'
   ?{offerAsset:TEST2 as AssetId,askAsset:CKB as AssetId,lot:{offerAmount:3000n*UNIT,askAmount:285n*UNIT,minFill:500n*UNIT,partialFills:3}}
   :{offerAsset:CKB as AssetId,askAsset:TEST2 as AssetId,lot:{offerAmount:600n*UNIT,askAmount:7000n*UNIT,minFill:100n*UNIT,partialFills:2}};
  const built=await createOrdersV2(context(s),{...spec,expiry:expiryAt((await tipSeconds())+6n*3600n),lots:[spec.lot]});
  round.order=built.lots[0]!.cell.cellOutput.lock;
  await send(built,s,t=>round.create=t,'create',{offer:show(spec.lot.offerAmount),ask:show(spec.lot.askAmount)});
 }
 const orderLock=ccc.Script.from(round.order!);
 const parsed=async()=>{const cell=await liveOrder(orderLock);return cell&&parseV2(cell,v2,resolver(client));};
 const now=async()=>(await tipSeconds())+300n;
 // Race: both takers build against the same live cell, then send at once to different endpoints.
 if(!round.race?.winner){
  round.race??={};
  for(const k of ['a','b'] as const)round.race[k]=await settle(round.race[k],'fill');
  const settled=(['a','b'] as const).filter(k=>round.race![k]?.status==='verified');
  if(settled.length===0){
   const order=(await parsed())!;assert(order,'Round order missing before the race');
   const range=partialRange(order);assert(range,'Fresh order has no partial range');
   const step=order.offerAsset.kind==='ckb'?UNIT:10n*UNIT;
   const plans=await Promise.all((['a','b'] as const).map(async(who,i)=>{
    const take=between(range.min,range.max,step);
    const s=signer(who,i);
    return {who,s,take,built:await fillOrdersV2(context(s),[{outPoint:order.outPoint,take}],{nowSeconds:await now()})};
   }));
   const started=Date.now();
   const outcomes=await Promise.allSettled(plans.map(p=>submit(p.built,p.s,{beforeBroadcast:async h=>{round.race![p.who]={hash:h,status:'sent',take:show(p.take)};await save();}})));
   for(const [i,o] of outcomes.entries())console.log(`  race ${plans[i]!.who}: take ${show(plans[i]!.take)} → ${o.status==='fulfilled'?'accepted by node':`refused by node (${String((o as PromiseRejectedResult).reason?.message??o).slice(0,120)})`}`);
   round.race.loserOutcome=outcomes.map((o,i)=>`${plans[i]!.who}:${o.status==='fulfilled'?'accepted':'refused'}`).join(' ');
   // Exactly one may commit. Wait for it, then confirm the other is gone.
   let winner:'a'|'b'|undefined;
   for(let i=0;i<120&&!winner;i++){
    for(const p of plans){const h=round.race[p.who]?.hash;if(h&&(await client.getTransactionNoCache(h))?.status==='committed')winner=p.who;}
    if(!winner)await new Promise(r=>setTimeout(r,5000));
   }
   assert(winner,'Neither race transaction committed');
   const loser=winner==='a'?'b':'a';
   const winTx=round.race[winner]!;winTx.checks=await verify(winTx.hash,'fill');winTx.status='verified';winTx.ms=Date.now()-started;
   const lose=round.race[loser];
   if(lose){
    const st=await Promise.all(clients.map(async c=>(await c.getTransactionNoCache(lose.hash))?.status??'unknown'));
    assert(!st.includes('committed'),'Both race transactions committed');
    lose.status=`not committed (${st.join(' / ')})`;
   }
   // CCC caches the outputs of every transaction it sent; the loser's change no longer
   // exists, so forget it before anyone rebuilds.
   for(const c of clients)await c.cache.clear();
   round.race.winner=winner;round.fills.push(winTx);await save();
   console.log(`  race winner ${winner}: ${winTx.hash}; loser ${lose?.status??'not sent'}`);
  }else{round.race.winner=settled[0];round.fills.push(round.race[settled[0]!]!);await save();}
 }
 // Fill the rest: the loser rebuilds on the remainder (partial if allowed), then the winner finishes.
 const loser=round.race!.winner==='a'?'b':'a';
 for(const who of [loser,round.race!.winner!,loser,round.race!.winner!] as const){
  const pending=round.fills.at(-1);if(pending&&pending.status!=='verified'){const ok=await settle(pending,'fill');if(!ok)round.fills.pop();}
  for(const c of clients)await c.cache.clear();
  const order=await parsed();if(!order)break;
  const range=partialRange(order),step=order.offerAsset.kind==='ckb'?UNIT:10n*UNIT;
  const take=range&&who===loser&&round.fills.length<3?between(range.min,range.max,step):order.available;
  const s=signer(who,who==='a'?0:1);
  const built=await fillOrdersV2(context(s),[{outPoint:order.outPoint,take}],{nowSeconds:await now()});
  const plan=built.plans[0]!;
  await send(built,s,t=>{const i=round.fills.findIndex(f=>f.hash===t.hash);if(i<0)round.fills.push(t);else round.fills[i]=t;},'fill',{taker:who,take:show(take),paid:show(plan.paid),final:plan.final});
 }
 assert(!(await liveOrder(orderLock)),'Round order not fully filled');
 round.complete=true;await save();
}

// solver: two crossing v2 orders from different owners, matched by ReferenceSolverV2 (taker B)
journal.solver??={orders:[]};
if(!journal.solver.settle||journal.solver.settle.status!=='verified'){
 journal.solver.orders=(await Promise.all((journal.solver.orders??[]).map(t=>settle(t,'create')))).filter((t):t is Tx=>!!t);
 if(journal.solver.orders.length===0){
  const expiry=expiryAt((await tipSeconds())+6n*3600n);
  // Maker sells 1,000 TEST3 at 2.0 CKB; taker A offers 1,000 CKB for 450 TEST3 (about 2.22 CKB). They cross.
  const sell=await createOrdersV2(context(signer('maker')),{offerAsset:TEST3,askAsset:CKB,expiry,lots:[{offerAmount:1000n*UNIT,askAmount:2000n*UNIT,minFill:100n*UNIT,partialFills:4}]});
  await send(sell,signer('maker'),t=>{journal.solver!.orders![0]=t;},'create',{side:'maker sells TEST3',order:sell.lots[0]!.cell.cellOutput.lock.hash()});
  const buy=await createOrdersV2(context(signer('a')),{offerAsset:CKB,askAsset:TEST3,expiry,lots:[{offerAmount:1000n*UNIT,askAmount:450n*UNIT,minFill:100n*UNIT,partialFills:2}]});
  await send(buy,signer('a'),t=>{journal.solver!.orders![1]=t;},'create',{side:'taker A buys TEST3',order:buy.lots[0]!.cell.cellOutput.lock.hash()});
 }
 const ids=new Set(journal.solver.orders.map(t=>orderKey({outPoint:ccc.OutPoint.from({txHash:t.hash,index:0})})));
 const dir=new URL('../.local/lock-v2-campaign-solver/',import.meta.url);await mkdir(dir,{recursive:true,mode:0o700});
 const solverJournal=new FileSubmissionJournal(dir.pathname,{genesisHash:GENESIS,accountLockHash:locks.b.hash()});
 try{
  const events:unknown[]=[];
  const solver=new ReferenceSolverV2(context(signer('b')),(event,details)=>{events.push({event,details});console.log('  solver',event,ccc.stringify(details));},{journal:solverJournal,acceptOrder:o=>ids.has(orderKey(o))});
  const tx=await solver.tick(true);assert(tx,'Solver found no match');
  const hash=tx.hash();
  journal.solver.settle={hash,status:'sent'};await save();
  journal.solver.settle.checks=await verify(hash,'fill');journal.solver.settle.status='verified';
  journal.solver.settle.events=events;await save();
  console.log(`  solver settlement ${hash} verified on both endpoints`);
 }finally{solverJournal.close();}
}

// late fill and keeper return of the expired orders
const expiredLocks=journal.expiry!.orders!.map(l=>ccc.Script.from(l));
const due=BigInt(Math.floor(Date.parse(journal.expiry!.expiresAt!)/1000));
journal.late=await settle(journal.late,'fill');
if(!journal.late){
 const s=signer('a');
 while((await tipSeconds())<due+120n){console.log('  waiting for expiry (tip time)…');await new Promise(r=>setTimeout(r,30000));}
 const order=await liveOrder(expiredLocks[0]!);assert(order,'Expired order 0 missing');
 const built=await fillOrdersV2(context(s),[{outPoint:order.outPoint}],{nowSeconds:await tipSeconds(),allowExpired:true});
 await send(built,s,t=>journal.late=t,'fill',{note:'filled after expiry at the maker price (soft expiry)',paid:show(built.plans[0]!.paid)});
}
journal.returned=await settle(journal.returned,'return');
if(!journal.returned){
 const s=signer('b');
 while((await tipSeconds())<due+900n){console.log('  waiting for the keeper delay (900 s after expiry, tip time)…');await new Promise(r=>setTimeout(r,30000));}
 const points=[];for(const l of expiredLocks.slice(1)){const c=await liveOrder(l);assert(c,'Expired order missing');points.push(c.outPoint);}
 const built=await returnExpiredV2(context(s),points,(await tipSeconds())-900n);
 await send(built,s,t=>journal.returned=t,'return',{orders:points.length});
}
journal.completedAt=new Date().toISOString();await save();
console.log('Campaign complete.',ccc.stringify({balances:await balances()}));
process.exit(0);
