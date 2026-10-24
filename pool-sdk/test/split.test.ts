import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ccc} from '@ckb-ccc/core';
import {writeLE,parseAmount} from '../../sdk/src/codec.js';
import {estimateCapacity,payment} from '../../sdk/src/capacity.js';
import {CKB,udt} from '../../sdk/src/types.js';
import {buildCreate,buildTransition,PoolBuildError,type OrderFill,type Wallet} from '../src/builders.js';
import {fundPoolTransaction,PoolFundingReservations} from '../src/funding.js';
import {reviewPoolTransaction} from '../src/review.js';
import {parsePool,pointKey,type PoolClient,type PoolDeployment} from '../src/pools.js';
import {XUDT_CODE_HASH,decodeWitness,decodeState} from '../src/codec.js';

const hash=(n:number)=>`0x${n.toString(16).padStart(2,'0').repeat(32)}` as ccc.Hex;
const dep=(n:number)=>({outPoint:{txHash:hash(n),index:0},depType:'code' as const});
const deployment:PoolDeployment={genesisHash:hash(1),codeHash:ccc.hashCkb('0x1234'),poolDep:dep(3),tokenDep:dep(4)};
const lock=ccc.Script.from({codeHash:hash(5),hashType:'data1',args:`0x${'66'.repeat(20)}`});
const maker=ccc.Script.from({codeHash:hash(6),hashType:'data1',args:`0x${'77'.repeat(20)}`});
const token=ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:hash(7)});
const other=ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:hash(17)});
const orderCode='0xabcd' as ccc.Hex;
const orderDeployment={network:'testnet' as const,genesisHash:hash(1),codeHash:ccc.hashCkb(orderCode),hashType:'data1' as const,cellDep:dep(20)};
const funding=ccc.Cell.from({outPoint:{txHash:hash(8),index:0},cellOutput:{capacity:100_000_000_000_000n,lock,type:token},outputData:ccc.hexFrom(writeLE(10n**15n,16))});
const wallet:Wallet={lock,deps:[dep(9)],funding:[funding],change:lock,feeRate:1000n,maxFee:10000n};
const recipients={ckb:lock,token:lock,lp:lock};
const request={parameters:{feeBps:30n,lockedShares:1000n,backing:{state:34_000_000_000n,ckb:8_000_000_000n,token:16_000_000_000n}},x:10n**12n,y:4n*10n**12n,minShares:1n,tokenOwner:hash(7)};
const cells=(tx:ccc.Transaction)=>tx.outputs.map((cellOutput,index)=>ccc.Cell.from({outPoint:{txHash:tx.hash(),index},cellOutput,outputData:tx.outputsData[index]!}));
function pool(){const all=cells(buildCreate(deployment,wallet,recipients,request).transaction);return {all,pool:parsePool(deployment,all[0]!,all[1]!,all[2]!),funding:all.slice(3)};}
let next=40;
/** Real order cells from the order SDK. Pool price is 1 CKB = 4 tokens. */
function lots(offer:'ckb'|'token',ask:'ckb'|'token',sizes:[bigint,bigint][],askToken=token){
 const asset=(k:'ckb'|'token',t:ccc.Script)=>k==='ckb'?CKB:udt(t);
 return sizes.map(([o,a],i)=>{const c=estimateCapacity(orderDeployment,{ownerLock:maker,nonce:new Uint8Array(16).fill(i+1),askAsset:asset(ask,askToken),askAmount:a},asset(offer,token),o).cell;
  return ccc.Cell.from({outPoint:{txHash:hash(next++),index:0},cellOutput:c.cellOutput,outputData:c.outputData});});
}
const fill=(c:ccc.Cell[]):OrderFill=>({codeHash:orderDeployment.codeHash,cellDep:orderDeployment.cellDep,cells:c});
const tokens=(list:{cellOutput:ccc.CellOutput;outputData:ccc.Hex}[])=>list.reduce((n,c)=>n+(c.cellOutput.type?.eq(token)?parseAmount(c.outputData):0n),0n);

test('a split route puts lots first, pays each maker at its own index and conserves CKB and tokens',()=>{
 for(const [direction,offer,ask,sizes,amountIn] of [
  ['xToY','token','ckb',[[10_000_000_000n,2_000_000_000n],[20_000_000_000n,4_500_000_000n]],1_000_000_000n],
  ['yToX','ckb','token',[[1_000_000_000n,3_000_000_000n],[2_000_000_000n,7_000_000_000n]],4_000_000_000n],
 ] as const){
  const {pool:p,funding:f}=pool(),lot=lots(offer,ask,sizes.map(s=>[...s]) as [bigint,bigint][]),n=lot.length;
  const w={...wallet,funding:f},action={kind:'swap',direction,amountIn,minOut:1n} as const;
  const b=buildTransition(deployment,w,recipients,p,action,fill(lot)),tx=b.transaction;
  b.assertIntegrity();
  assert.deepEqual(tx.inputs.slice(0,n).map(i=>pointKey(i.previousOutput)),lot.map(c=>pointKey(c.outPoint)));
  assert.equal(pointKey(tx.inputs[n]!.previousOutput),pointKey(p.stateCell.outPoint));
  for(const [i,c] of lot.entries()){
   const expected=payment(estimateCapacity(orderDeployment,{ownerLock:maker,nonce:new Uint8Array(16).fill(i+1),askAsset:ask==='ckb'?CKB:udt(token),askAmount:sizes[i]![1]},offer==='ckb'?CKB:udt(token),sizes[i]![0]).terms);
   assert.ok(tx.outputs[i]!.eq(expected.cellOutput)&&tx.outputsData[i]===expected.outputData,`payment ${i}`);
   assert.equal(b.orders[i]!.paymentIndex,i);assert.ok(b.orders[i]!.outPoint.eq(c.outPoint));
  }
  const state=decodeState(tx.outputsData[n]!);assert.deepEqual([state.rx,state.ry],[BigInt(n+1),BigInt(n+2)]);
  assert.equal(b.stateOutputIndex,n);assert.equal(b.actionWitnessIndex,n);assert.equal(b.walletWitnessIndex,n+3);
  assert.equal(decodeWitness(tx.witnesses[n]!,false).kind,'swap');
  for(let i=0;i<n;i++)assert.equal(tx.witnesses[i],'0x');
  assert.deepEqual(tx.cellDeps.map(d=>pointKey(d.outPoint)),[dep(3),dep(4),dep(20),dep(9)].map(d=>pointKey(d.outPoint)));
  const inputs=[...lot,p.stateCell,p.ckbCell,p.tokenCell,...f],outs=cells(tx);
  assert.equal(inputs.reduce((s,c)=>s+c.cellOutput.capacity,0n)-outs.reduce((s,c)=>s+c.cellOutput.capacity,0n),b.fee);
  assert.equal(tokens(inputs),tokens(outs),'token conservation');
  // The user's receipt holds both legs; the review totals show them together.
  const review=reviewPoolTransaction(deployment,w,recipients,{kind:'transition',pool:p,action,orders:fill(lot)},tx);
  const {flows,total,orders,outputs}=review.summary,lotIn=sizes.reduce((s,[o])=>s+o,0n),lotOut=sizes.reduce((s,[,a])=>s+a,0n);
  assert.equal(orders.length,n);assert.deepEqual(outputs.map(o=>o.maker),outputs.map((_,i)=>i<n));
  if(direction==='xToY'){
   assert.deepEqual([total.paidX,total.receivedY],[flows.paidX+lotOut,flows.receivedY+lotIn]);
   assert.ok(outs.slice(n+3).some(c=>c.cellOutput.type?.eq(token)&&parseAmount(c.outputData)===total.receivedY));
  }else{
   assert.deepEqual([total.paidY,total.receivedX],[flows.paidY+lotOut,flows.receivedX+lotIn]);
   assert.ok(outs.slice(n+3).some(c=>!c.cellOutput.type&&c.cellOutput.capacity>=total.receivedX&&c.cellOutput.capacity<total.receivedX+100_00000000n));
  }
 }
});

test('split routes refuse lots outside the pool pair or direction, duplicates, creation and non-swap actions',()=>{
 const {pool:p,funding:f}=pool(),w={...wallet,funding:f};
 const swap={kind:'swap',direction:'xToY',amountIn:1_000_000_000n,minOut:1n} as const;
 const good=lots('token','ckb',[[10_000_000_000n,2_000_000_000n]]);
 const cases:[string,()=>unknown][]=[
  ['other token',()=>buildTransition(deployment,w,recipients,p,swap,fill(lots('ckb','token',[[1_000_000_000n,3_000_000_000n]],other)))],
  ['wrong direction',()=>buildTransition(deployment,w,recipients,p,swap,fill(lots('ckb','token',[[1_000_000_000n,3_000_000_000n]])))],
  ['duplicate',()=>buildTransition(deployment,w,recipients,p,swap,fill([good[0]!,good[0]!]))],
  ['deposit',()=>buildTransition(deployment,w,recipients,p,{kind:'deposit',maxX:10n**9n,maxY:4n*10n**9n,minShares:1n},fill(good))],
  ['too many',()=>buildTransition(deployment,w,recipients,p,swap,fill(lots('token','ckb',Array.from({length:33},(_,i)=>[1_000_000_000n+BigInt(i),200_000_000n]))))],
  ['not an order',()=>buildTransition(deployment,w,recipients,p,swap,{...fill(good),codeHash:hash(30)})],
 ];
 for(const [label,run] of cases)assert.throws(run,PoolBuildError,label);
 // Token-priced lots need token funding beyond the pool leg.
 const plain=f.filter(c=>!c.cellOutput.type);
 assert.throws(()=>buildTransition(deployment,{...w,funding:plain},recipients,p,{kind:'swap',direction:'yToX',amountIn:4_000_000_000n,minOut:1n},fill(lots('ckb','token',[[1_000_000_000n,3_000_000_000n]]))),
  (e:unknown)=>e instanceof PoolBuildError&&e.code==='FUNDING');
});

test('freshness checks the order code and every lot, and funding covers maker payments in the token',async()=>{
 const {all,pool:p}=pool(),lot=lots('ckb','token',[[1_000_000_000n,3_000_000_000n],[2_000_000_000n,7_000_000_000n]]);
 const live=new Map([...all,...lot].map(c=>[pointKey(c.outPoint),c]));
 let orderData=orderCode;
 const client={
  getHeaderByNumberNoCache:async()=>({hash:deployment.genesisHash}),
  getCellLiveNoCache:async(point:ccc.OutPointLike)=>{
   const o=ccc.OutPoint.from(point);
   if(o.eq(dep(3).outPoint)||o.eq(dep(4).outPoint)||o.eq(dep(20).outPoint))return ccc.Cell.from({outPoint:o,cellOutput:{lock,capacity:10n**14n},outputData:o.eq(dep(3).outPoint)?'0x1234':o.eq(dep(20).outPoint)?orderData:ccc.hexFrom(readFileSync(new URL('../../tests/fixtures/xudt',import.meta.url)))});
   return live.get(pointKey(o))?.clone();
  },
  findCellsPagedNoCache:async()=>({cells:all.slice(3).map(c=>c.clone()),lastCursor:'0x'}),
 } as unknown as PoolClient;
 const action={kind:'swap',direction:'yToX',amountIn:4_000_000_000n,minOut:1n} as const;
 const reservations=new PoolFundingReservations();
 const funded=await fundPoolTransaction(client,deployment,{lock,change:lock,deps:[dep(9)],feeRate:1000n,maxFee:10000n},recipients,{kind:'transition',pool:p,action,orders:fill(lot)},{reservations});
 assert.ok(tokens(funded.funding)>=funded.built.result.flows.paidY+10_000_000_000n);
 for(const c of lot)assert.ok(reservations.has(deployment.genesisHash,c.outPoint),'lots are reserved with the review');
 await funded.built.assertFresh(client);
 orderData='0xabce';
 await assert.rejects(funded.built.assertFresh(client),/order dependency data hash/);
 orderData=orderCode;live.delete(pointKey(lot[1]!.outPoint));
 await assert.rejects(funded.built.assertFresh(client),/no longer live/);
 funded.release();
});
