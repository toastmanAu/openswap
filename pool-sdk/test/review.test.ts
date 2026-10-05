/** Rejection regressions for findings R1/R2 from the 85731fe internal review. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ccc} from '@ckb-ccc/core';
import {buildCreate,buildTransition} from '../src/builders.js';
import {XUDT_CODE_HASH} from '../src/codec.js';
import {parsePool,type PoolClient} from '../src/pools.js';
import {writeLE} from '../../sdk/src/codec.js';
const hash=(byte:string)=>`0x${byte.repeat(32)}` as ccc.Hex;
function fixture(){
 const lock=ccc.Script.from({codeHash:hash('11'),hashType:'data1',args:`0x${'22'.repeat(20)}`});
 const token=ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:hash('33')});
 const dep=(h:ccc.Hex)=>({outPoint:{txHash:h,index:0},depType:'code' as const});
 const deployment={genesisHash:hash('44'),codeHash:ccc.hashCkb('0x1234'),poolDep:dep(hash('55')),tokenDep:dep(hash('66'))};
 const funding=ccc.Cell.from({outPoint:{txHash:hash('77'),index:0},cellOutput:{lock,type:token,capacity:100000000000000n},outputData:ccc.hexFrom(writeLE(1000000000000000n,16))});
 const built=buildCreate(deployment,{lock,change:lock,deps:[dep(hash('88'))],funding:[funding],feeRate:1000n,maxFee:10000n},{ckb:lock,token:lock,lp:lock},
  {parameters:{feeBps:30n,lockedShares:1000n,backing:{state:34000000000n,ckb:8000000000n,token:16000000000n}},x:1000000000000n,y:4000000000000n,minShares:1n,tokenOwner:hash('33')});
 const client:PoolClient={
  getHeaderByNumberNoCache:async()=>({hash:deployment.genesisHash}) as ccc.ClientBlockHeader,
  findCellsPagedNoCache:async()=>({cells:[],lastCursor:'0x'}),
  getCellLiveNoCache:async point=>{
   if(funding.outPoint.eq(point))return funding.clone();
   const p=ccc.OutPoint.from(point);
   if(!p.eq(deployment.poolDep.outPoint)&&!p.eq(deployment.tokenDep.outPoint))return undefined;
   return ccc.Cell.from({outPoint:p,cellOutput:{lock,capacity:100000000000000n},outputData:p.eq(deployment.poolDep.outPoint)?'0x1234':ccc.hexFrom(readFileSync(new URL('../../tests/fixtures/xudt',import.meta.url)))});
  },
 };
 return {built,client,funding,deployment,lock};
}
test('R1: genesis and transition reject sparse, inherited, invalid, missing and extra witnesses',()=>{
 const f=fixture(),tx=f.built.transaction;
 const cells=tx.outputs.map((cellOutput,index)=>ccc.Cell.from({outPoint:{txHash:tx.hash(),index},cellOutput,outputData:tx.outputsData[index]!}));
 const pool=parsePool(f.deployment,cells[0]!,cells[1]!,cells[2]!);
 const normal=buildTransition(f.deployment,{lock:f.lock,change:f.lock,deps:tx.cellDeps.slice(2),funding:cells.slice(3),feeRate:1000n,maxFee:10000n},{ckb:f.lock,token:f.lock,lp:f.lock},pool,{kind:'withdraw',shares:1000n,minX:1n,minY:1n});
 for(const built of [f.built,normal]){
  for(const index of new Set([0,built.walletWitnessIndex,built.transaction.witnesses.length-1])){
   const sparse=built.transaction.clone();delete sparse.witnesses[index];
   assert.equal(sparse.witnesses.length,built.transaction.witnesses.length);
   assert.throws(()=>built.assertIntegrity(sparse),/missing witness slot/);
   const inherited=built.transaction.clone(),prototype=Object.create(Array.prototype);
   prototype[index]=inherited.witnesses[index];delete inherited.witnesses[index];Object.setPrototypeOf(inherited.witnesses,prototype);
   assert.throws(()=>built.assertIntegrity(inherited),/missing witness slot/);
   for(const value of [undefined,null,123,'0xzz']){
    const bad=built.transaction.clone();Reflect.set(bad.witnesses,index,value);
    assert.throws(()=>built.assertIntegrity(bad),/invalid witness bytes/);
   }
  }
  const missing=built.transaction.clone();missing.witnesses.pop();assert.throws(()=>built.assertIntegrity(missing),/count/);
  const extra=built.transaction.clone();extra.witnesses.push('0x');assert.throws(()=>built.assertIntegrity(extra),/count/);
 }
});
test('R2: false capacity, lock, type and data caches reject despite identical raw hash',async()=>{
 const {built,client}=fixture();
 for(const mutate of [
  (tx:ccc.Transaction)=>{tx.inputs[0]!.cellOutput!.capacity=1n;},
  (tx:ccc.Transaction)=>{tx.inputs[0]!.cellOutput!.lock.args='0x';},
  (tx:ccc.Transaction)=>{tx.inputs[0]!.cellOutput!.type=undefined;},
  (tx:ccc.Transaction)=>{tx.inputs[0]!.outputData=ccc.hexFrom(writeLE(1n,16));},
  (tx:ccc.Transaction)=>{Reflect.set(tx.inputs[0]!,'cellOutput',null);},
  (tx:ccc.Transaction)=>{Reflect.set(tx.inputs[0]!,'outputData',null);},
 ]){
  const candidate=built.transaction.clone();mutate(candidate);
  assert.equal(candidate.hash(),built.transaction.hash());
  assert.throws(()=>built.assertIntegrity(candidate),/cached input/);
  await assert.rejects(built.assertFresh(client,{},candidate),/cached input/);
 }
});
test('R2: honest, partial and absent caches work, including raw-deserialized signed candidates',async()=>{
 const {built,client}=fixture();
 const absent=ccc.Transaction.fromBytes(built.transaction.toBytes());
 assert.equal(absent.inputs[0]!.cellOutput,undefined);assert.equal(absent.inputs[0]!.outputData,undefined);
 const onlyOutput=built.transaction.clone();onlyOutput.inputs[0]!.outputData=undefined;
 const onlyData=built.transaction.clone();onlyData.inputs[0]!.cellOutput=undefined;
 for(const candidate of [built.transaction.clone(),absent,onlyOutput,onlyData]){
  const witness=ccc.WitnessArgs.fromBytes(candidate.witnesses[0]!);witness.lock=ccc.hexFrom(new Uint8Array(65).fill(42));candidate.witnesses[0]=ccc.hexFrom(witness.toBytes());
  built.assertIntegrity(candidate);await built.assertFresh(client,{},candidate);
 }
});
test('R2: cache mutation during freshness and mutation of original transaction caches reject',async()=>{
 const {built,client}=fixture(),candidate=built.transaction.clone(),read=client.getHeaderByNumberNoCache;
 client.getHeaderByNumberNoCache=async(...args)=>{const header=await read(...args);candidate.inputs[0]!.outputData='0x';return header;};
 await assert.rejects(built.assertFresh(client,{},candidate),/cached input data/);
 built.transaction.inputs[0]!.cellOutput!.capacity+=1n;
 assert.throws(()=>built.assertIntegrity(),/cached input output/);
});
