import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ccc} from '@ckb-ccc/core';
import {writeLE} from '../../sdk/src/codec.js';
import {fundPoolTransaction,PoolFundingReservations,type FundingOptions} from '../src/funding.js';
import {parsePool,pointKey,type PoolClient,type PoolDeployment} from '../src/pools.js';
import {XUDT_CODE_HASH} from '../src/codec.js';
import {reviewPoolTransaction} from '../src/review.js';

const hash=(n:number)=>`0x${n.toString(16).padStart(2,'0').repeat(32)}` as ccc.Hex;
const dep=(n:number)=>({outPoint:{txHash:hash(n),index:0},depType:'code' as const});
const request={parameters:{feeBps:30n,lockedShares:1000n,backing:{state:34_000_000_000n,ckb:8_000_000_000n,token:16_000_000_000n}},x:10n**12n,y:4n*10n**12n,minShares:1n,tokenOwner:hash(7)};
function fixture(){
 const lock=ccc.Script.from({codeHash:hash(8),hashType:'type',args:'0x0001'});
 const token=ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:hash(7)});
 const cell=(n:number,capacity:bigint,data:ccc.Hex='0x',type?:ccc.Script)=>ccc.Cell.from({outPoint:dep(n).outPoint,cellOutput:{capacity,lock:lock.clone(),type:type?.clone()},outputData:data});
 const asset=cell(10,20_000_000_000n,ccc.hexFrom(writeLE(request.y,16)),token);
 const cash=cell(11,2n*10n**12n),small=cell(12,100_000_000_000n);
 const deployment:PoolDeployment={genesisHash:hash(1),codeHash:ccc.hashCkb('0x1234'),poolDep:dep(3),tokenDep:dep(4)};
 const cells=new Map([asset,cash,small,cell(3,10n**14n,'0x1234'),cell(4,10n**14n,ccc.hexFrom(readFileSync(new URL('../../tests/fixtures/xudt',import.meta.url))))].map(c=>[pointKey(c.outPoint),c]));
 let page=[small,asset,cash],cursor='0x01',reads=0;
 const client={getHeaderByNumberNoCache:async()=>({hash:deployment.genesisHash}),getCellLiveNoCache:async(p:ccc.OutPointLike)=>{reads++;return cells.get(pointKey(p))?.clone();},findCellsPagedNoCache:async()=>({cells:page.map(c=>c.clone()),lastCursor:cursor})} as unknown as PoolClient;
 const wallet={lock,change:lock,deps:[dep(9)],witness:{kind:'joyid' as const},feeRate:1000n,maxFee:10000n};
 const reservations=new PoolFundingReservations();
 const run=(options:Partial<FundingOptions>={})=>fundPoolTransaction(client,deployment,wallet,{ckb:lock,token:lock,lp:lock},{kind:'create',request},{reservations,...options});
 return {asset,cash,small,cell,token,lock,cells,client,deployment,wallet,reservations,run,setPage:(p:ccc.Cell[],c='0x01')=>{page=p;cursor=c;},reads:()=>reads};
}

test('funding selects required assets then largest plain capacity and reserves exact inputs',async()=>{
 const f=fixture();
 const foreign=f.cell(13,10n**14n,'0x',ccc.Script.from({...f.token,args:hash(88)}));
 f.setPage([f.small,foreign,f.cash,f.asset]);
 const result=await f.run();
 assert.deepEqual(result.funding.map(c=>pointKey(c.outPoint)),[f.asset,f.cash].map(c=>pointKey(c.outPoint)));
 assert.equal(result.scanComplete,true);assert.equal(result.scannedCandidates,4);
 result.built.assertIntegrity(result.built.transaction);
 for(const c of result.funding)assert.ok(f.reservations.has(f.deployment.genesisHash,c.outPoint));
 await assert.rejects(f.run(),{code:'INSUFFICIENT'});
 result.release();result.release();
 const again=await f.run();again.release();
});

test('funding retries capacity only; fee caps and stale or malformed candidates fail closed',async()=>{
 for(const mode of ['fee','stale','amount','owner','duplicate'] as const){
  const f=fixture();
  if(mode==='fee')f.wallet.maxFee=1n;
  if(mode==='stale')f.cells.delete(pointKey(f.cash.outPoint));
  if(mode==='amount')f.asset.outputData='0x01';
  if(mode==='owner')f.asset.cellOutput.lock.args='0xff';
  if(mode==='duplicate'){const copy=f.asset.clone();copy.cellOutput.capacity+=1n;f.setPage([f.asset,copy,f.cash]);}
  await assert.rejects(f.run(),mode==='fee'?{code:'FEE'}:/.+/);
  assert.equal(f.reservations.has(f.deployment.genesisHash,f.asset.outPoint),false);
 }
});

test('funding distinguishes bounded searches from exhausted balances and enforces input limits',async()=>{
 const empty=fixture();empty.setPage([]);await assert.rejects(empty.run(),{code:'INSUFFICIENT'});
 const bounded=fixture();bounded.setPage([bounded.small]);await assert.rejects(bounded.run({pageSize:1,maxPages:1}),{code:'LIMIT'});
 const inputs=fixture();await assert.rejects(inputs.run({maxInputs:1}),{code:'LIMIT'});
 const cursor=fixture();cursor.setPage([cursor.small]);await assert.rejects(cursor.run({pageSize:1,maxPages:3}),/cursor did not advance/);
 const oversized=fixture();await assert.rejects(oversized.run({pageSize:1}),/oversized/);
 const invalid=fixture();await assert.rejects(invalid.run({maxCandidates:0}),{code:'INVALID'});assert.equal(invalid.reads(),0);
});

test('reservations are atomic, network-scoped and old releases cannot clear newer claims',()=>{
 const r=new PoolFundingReservations(),a=dep(10).outPoint,b=dep(11).outPoint;
 const release=r.claim(hash(1),[a]);
 assert.throws(()=>r.claim(hash(1),[b,a]),{code:'RESERVED'});assert.equal(r.has(hash(1),b),false);
 const other=r.claim(hash(2),[a]);release();const newer=r.claim(hash(1),[a]);release();assert.ok(r.has(hash(1),a));newer();other();
});

test('freshness failures and deadline cancellation release claims',async()=>{
 for(const mode of ['failure','timeout'] as const){
  const f=fixture(),read=f.client.getCellLiveNoCache.bind(f.client);
  f.client.getCellLiveNoCache=async(...args)=>{
   if(f.reservations.has(f.deployment.genesisHash,f.asset.outPoint)){
    if(mode==='failure')throw new Error('freshness failed');
    return new Promise(()=>{});
   }
   return read(...args);
  };
  await assert.rejects(f.run({timeoutMs:100}),/.+/);
  // The outer deadline may settle immediately before the inner cleanup.
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.reservations.has(f.deployment.genesisHash,f.asset.outPoint),false);
  assert.equal(f.reservations.has(f.deployment.genesisHash,f.cash.outPoint),false);
 }
});

test('selector funds creation, both swaps, deposit, full withdrawal and re-entry from exact successors',async()=>{
 const f=fixture();
 // Retain token change for the later deposit; creation-only fixtures fund Y exactly.
 f.asset.outputData=ccc.hexFrom(writeLE(request.y*2n,16));
 let funded=await f.run();
 const recipients={ckb:f.lock,token:f.lock,lp:f.lock};
 for(const kind of ['xToY','yToX','deposit','withdraw','deposit'] as const){
  const tx=funded.built.transaction,index=funded.built.stateOutputIndex;
  for(const input of tx.inputs)f.cells.delete(pointKey(input.previousOutput));
  const outputs=tx.outputs.map((cellOutput,i)=>ccc.Cell.from({outPoint:{txHash:tx.hash(),index:i},cellOutput:cellOutput.clone(),outputData:tx.outputsData[i]!}));
  for(const cell of outputs)f.cells.set(pointKey(cell.outPoint),cell);
  funded.release();
  const pool=parsePool(f.deployment,outputs[index]!,outputs[index+1]!,outputs[index+2]!);
  f.setPage([...f.cells.values()].filter(c=>c.cellOutput.lock.eq(f.lock)&&![hash(3),hash(4)].includes(c.outPoint.txHash)));
  const action=kind==='deposit'?{kind:'deposit' as const,maxX:10_000_000_000n,maxY:40_000_000_000n,minShares:1n}:kind==='withdraw'?{kind:'withdraw' as const,shares:pool.accounting.totalShares-pool.accounting.lockedShares,minX:1n,minY:1n}:{kind:'swap' as const,direction:kind,amountIn:10_000_000_000n,minOut:1n};
  funded=await fundPoolTransaction(f.client,f.deployment,f.wallet,recipients,{kind:'transition',pool,action},{reservations:f.reservations});
  const review=reviewPoolTransaction(f.deployment,{...f.wallet,funding:funded.funding},recipients,{kind:'transition',pool,action},funded.built.transaction);
  assert.deepEqual(review.summary.action,action);
  assert.deepEqual(review.summary.flows,funded.built.result.flows);
  await review.assertFresh(f.client);
  funded.built.assertIntegrity();
  for(const input of funded.built.transaction.inputs)assert.ok(f.reservations.has(f.deployment.genesisHash,input.previousOutput));
  if(kind==='withdraw')assert.equal(funded.built.result.next.totalShares,pool.accounting.lockedShares);
  else assert.ok(funded.built.result.next.totalShares>pool.accounting.lockedShares);
 }
 funded.release();
});

test('concurrent selectors cannot return overlapping funding and losing selection cannot clear the winner',async()=>{
 const f=fixture();
 const outcomes=await Promise.allSettled([f.run(),f.run()]);
 const winners=outcomes.filter(o=>o.status==='fulfilled');
 assert.equal(winners.length,1);assert.equal(outcomes.filter(o=>o.status==='rejected').length,1);
 const winner=winners[0]!;assert.equal(winner.status,'fulfilled');
 for(const c of winner.value.funding)assert.ok(f.reservations.has(f.deployment.genesisHash,c.outPoint));
 winner.value.release();
 const retry=await f.run();retry.release();
});

test('competing transitions reserve pool inputs even with disjoint wallet funding',async()=>{
 const f=fixture(),genesis=await f.run(),tx=genesis.built.transaction,index=genesis.built.stateOutputIndex;
 const outputs=tx.outputs.map((cellOutput,i)=>ccc.Cell.from({outPoint:{txHash:tx.hash(),index:i},cellOutput:cellOutput.clone(),outputData:tx.outputsData[i]!}));
 for(const input of tx.inputs)f.cells.delete(pointKey(input.previousOutput));
 for(const c of outputs)f.cells.set(pointKey(c.outPoint),c);
 genesis.release();
 const pool=parsePool(f.deployment,outputs[index]!,outputs[index+1]!,outputs[index+2]!);
 const a=f.cell(21,10n**12n),b=f.cell(22,10n**12n);
 for(const c of [a,b])f.cells.set(pointKey(c.outPoint),c);
 const run=()=>fundPoolTransaction(f.client,f.deployment,f.wallet,{ckb:f.lock,token:f.lock,lp:f.lock},{kind:'transition',pool,action:{kind:'swap',direction:'xToY',amountIn:10_000_000_000n,minOut:1n}},{reservations:f.reservations});
 f.setPage([a]);const first=await run();
 f.setPage([b]);await assert.rejects(run(),{code:'RESERVED'});
 assert.equal(f.reservations.has(f.deployment.genesisHash,b.outPoint),false);
 assert.ok(f.reservations.has(f.deployment.genesisHash,pool.stateCell.outPoint));
 first.release();const retry=await run();retry.release();
});

test('review reconstructs immutable disclosures and rejects changed policy, bytes and caches',async()=>{
 const f=fixture(),funded=await f.run(),wallet={...f.wallet,funding:funded.funding};
 const recipients={ckb:f.lock,token:f.lock,lp:f.lock},intent={kind:'create' as const,request};
 const originalFee=funded.built.fee;
 funded.built.fee=999n;Object.assign(funded.built.result.flows,{paidX:1n});
 const review=reviewPoolTransaction(f.deployment,wallet,recipients,intent,funded.built.transaction);
 assert.equal(review.summary.fee,originalFee);assert.equal(review.summary.flows.paidX,request.x);
 assert.equal(review.summary.outputs.filter(o=>o.pool).length,3);
 assert.equal(review.summary.next.backing.state,request.parameters.backing.state);
 assert.throws(()=>Object.assign(review.summary.flows,{paidX:2n}),TypeError);
 assert.throws(()=>Object.assign(review.summary.outputs[0]!,{capacity:1n}),TypeError);
 for(const mode of ['output','action','cache','policy'] as const){
  const tx=funded.built.transaction.clone();
  if(mode==='output')tx.outputs[0]!.capacity+=1n;
  if(mode==='action')tx.witnesses[1]='0x';
  if(mode==='cache')tx.inputs[0]!.cellOutput!.capacity+=1n;
  assert.throws(()=>reviewPoolTransaction(f.deployment,mode==='policy'?{...wallet,feeRate:2000n}:wallet,recipients,intent,tx));
 }
 const signed=review.transaction(),args=ccc.WitnessArgs.fromBytes(signed.witnesses[0]!);
 args.lock='0x1234';signed.witnesses[0]=ccc.hexFrom(args.toBytes());
 review.assertIntegrity(signed);await review.assertFresh(f.client,{},signed);
 assert.throws(()=>reviewPoolTransaction(f.deployment,wallet,recipients,intent,signed),/unsigned/);
 const copy=review.transaction();copy.outputs[0]!.capacity+=1n;
 review.assertIntegrity(review.transaction());assert.throws(()=>review.assertIntegrity(copy));
 funded.built.transaction.outputs[0]!.capacity+=1n;wallet.funding[0]!.cellOutput.capacity+=1n;
 f.deployment.genesisHash=hash(99); // captured review still uses its original network.
 assert.equal(review.summary.genesisHash,hash(1));
 assert.equal(review.summary.fee,originalFee);
 funded.release();
});

test('review expires and rejects stale inputs or cancellation without authorizing submission',async()=>{
 const f=fixture(),funded=await f.run();
 const make=(ttl=120000)=>reviewPoolTransaction(f.deployment,{...f.wallet,funding:funded.funding},{ckb:f.lock,token:f.lock,lp:f.lock},{kind:'create',request},funded.built.transaction,ttl);
 const review=make();
 const controller=new AbortController();controller.abort();
 await assert.rejects(review.assertFresh(f.client,{signal:controller.signal}));
 f.cells.delete(pointKey(f.asset.outPoint));await assert.rejects(review.assertFresh(f.client));
 const expiring=make(1);await new Promise(resolve=>setTimeout(resolve,5));
 assert.throws(()=>expiring.transaction(),/expired/);
 assert.throws(()=>expiring.assertIntegrity(funded.built.transaction),/expired/);
 await assert.rejects(expiring.assertFresh(f.client),/expired/);
 funded.release();
});
