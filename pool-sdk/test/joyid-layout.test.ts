import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {ccc} from '@ckb-ccc/core';
import {JoyId} from '@ckb-ccc/joy-id';
import {writeLE} from '../../sdk/src/codec.js';
import {buildCreate,buildTransition,type Wallet} from '../src/builders.js';
import {decodeWitness,XUDT_CODE_HASH} from '../src/codec.js';
import {parsePool,type PoolDeployment} from '../src/pools.js';

// No browser, RPC, aggregator, popup, user account or real signing. Run the
// installed connector's preparation logic with a public, in-memory connection.
const oldLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
before(()=>Object.defineProperty(globalThis,'location',{value:{href:'http://localhost/test'},configurable:true}));
after(()=>{if(oldLocation)Object.defineProperty(globalThis,'location',oldLocation);else Reflect.deleteProperty(globalThis,'location');});
const hash=(n:number)=>`0x${n.toString(16).padStart(2,'0').repeat(32)}` as ccc.Hex;
const dep=(n:number)=>({outPoint:{txHash:hash(n),index:0},depType:'code' as const});
const deployment:PoolDeployment={genesisHash:hash(1),codeHash:hash(2),poolDep:dep(3),tokenDep:dep(4)};
const lock=ccc.Script.from({codeHash:'0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac',hashType:'type',args:`0x0001${'66'.repeat(20)}`});
const token=ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:hash(7)});
const funding=ccc.Cell.from({outPoint:{txHash:hash(8),index:0},cellOutput:{capacity:100_000_000_000_000n,lock,type:token},outputData:ccc.hexFrom(writeLE(10n**15n,16))});
const recipients={ckb:lock,token:lock,lp:lock};
const request={parameters:{feeBps:30n,lockedShares:1000n,backing:{state:34_000_000_000n,ckb:8_000_000_000n,token:16_000_000_000n}},x:10n**12n,y:4n*10n**12n,minShares:1n,tokenOwner:hash(7)};
function fixture(subkey=false){
 const proof=subkey?'0x123456' as const:undefined;
 const wallet:Wallet={lock,deps:subkey?[dep(9),dep(10)]:[dep(9)],funding:[funding],change:lock,feeRate:1000n,maxFee:10000n,witness:{kind:'joyid',outputType:proof}};
 const built=buildCreate(deployment,wallet,recipients,request);
 const all=built.transaction.outputs.map((cellOutput,index)=>ccc.Cell.from({outPoint:{txHash:built.transaction.hash(),index},cellOutput,outputData:built.transaction.outputsData[index]!}));
 const pool=parsePool(deployment,all[1]!,all[2]!,all[3]!);
 const nextWallet={...wallet,funding:[all[0]!,...all.slice(4)]};
 return {wallet,built,all,pool,nextWallet,proof};
}
function connector(subkey=false){
 const client={addressPrefix:'ckt',getKnownScript:async()=>({codeHash:lock.codeHash,hashType:lock.hashType,cellDeps:[{cellDep:dep(9)}]}),getCellDeps:async()=>[ccc.CellDep.from(dep(9))]} as unknown as ccc.Client;
 return new JoyId.CkbSigner(client,'Offline fixture','','https://example.invalid','https://example.invalid',{
  get:async()=>({address:ccc.Address.fromScript(lock,client).toString(),publicKey:hash(99),keyType:subkey?'sub_key':'main_key'}),set:async()=>{},
 });
}
function withLock(tx:ccc.Transaction,index:number,bytes:number){
 const next=tx.clone(),args=ccc.WitnessArgs.fromBytes(next.witnesses[index]!);
 args.lock=ccc.hexFrom(new Uint8Array(bytes).fill(42));next.witnesses[index]=ccc.hexFrom(args.toBytes());return next;
}

test('JoyID genesis separates action from primary/subkey proof and derives the nonzero-index identity',async()=>{
 for(const subkey of [false,true]){
  const {built,all,pool,proof}=fixture(subkey),tx=built.transaction;
  assert.equal(built.stateOutputIndex,1);assert.equal(built.walletWitnessIndex,0);
  assert.equal(tx.inputs.length,1);assert.equal(tx.witnesses.length,2);
  assert.equal(built.poolId,ccc.hashCkb(ccc.bytesConcat(tx.inputs[0]!.toBytes(),writeLE(1n,8))));
  assert.equal(pool.metadata.rx,2n);assert.equal(pool.metadata.ry,3n);
  assert.equal(decodeWitness(tx.witnesses[1]!,true).kind,'create');
  assert.equal(ccc.WitnessArgs.fromBytes(tx.witnesses[0]!).outputType,proof);
  assert.ok(all[0]!.cellOutput.type!.eq(pool.lp));
  const prepared=await connector(subkey).prepareTransaction(tx.clone());
  built.assertIntegrity(prepared);assert.equal(ccc.hexFrom(prepared.toBytes()),ccc.hexFrom(tx.toBytes()));
  // Pre-resolved fake subkey proof stays pinned. Its authenticity and the
  // aggregator resolution path are NOT established by this preparation test.
 }
});

test('actual JoyID preparation preserves every transition and bounded variable-size signatures',async()=>{
 for(const subkey of [false,true]){
  const {pool,nextWallet}=fixture(subkey);
  for(const operation of [
   {kind:'swap',direction:'xToY',amountIn:10000n,minOut:1n},
   {kind:'swap',direction:'yToX',amountIn:10000n,minOut:1n},
   {kind:'deposit',maxX:100000n,maxY:400000n,minShares:1n},
   {kind:'withdraw',shares:pool.accounting.totalShares-pool.accounting.lockedShares,minX:1n,minY:1n},
  ] as const){
   const built=buildTransition(deployment,nextWallet,recipients,pool,operation);
   assert.equal(built.stateOutputIndex,0);assert.equal(built.walletWitnessIndex,3);
   const prepared=await connector(subkey).prepareTransaction(built.transaction.clone());built.assertIntegrity(prepared);
   for(const bytes of [1,65,300,999,1000]){
    const candidate=withLock(prepared,3,bytes);built.assertIntegrity(candidate);
    assert.ok(candidate.estimateFee(nextWallet.feeRate)<=built.fee);
    assert.equal(candidate.hash(),prepared.hash());
   }
  }
 }
});

test('JoyID guard rejects action/proof/raw/cache mutations, oversize signatures and sparse witnesses',()=>{
 const f=fixture(true);
 for(const built of [f.built,buildTransition(deployment,f.nextWallet,recipients,f.pool,{kind:'deposit',maxX:100000n,maxY:400000n,minShares:1n})]){
  const tx=built.transaction,index=built.walletWitnessIndex;
  for(const bytes of [0,1001,4096])assert.throws(()=>built.assertIntegrity(withLock(tx,index,bytes)),/signature|witness/);
  const trailing=withLock(tx,index,300);trailing.witnesses[index]=`${trailing.witnesses[index]!}00`;assert.throws(()=>built.assertIntegrity(trailing));
  for(const field of ['inputType','outputType'] as const){
   const bad=tx.clone(),args=ccc.WitnessArgs.fromBytes(bad.witnesses[index]!);args[field]='0x9999';bad.witnesses[index]=ccc.hexFrom(args.toBytes());
   assert.throws(()=>built.assertIntegrity(bad),/witness/);
  }
  const sparse=tx.clone();delete sparse.witnesses[index];assert.throws(()=>built.assertIntegrity(sparse),/missing/);
  const raw=tx.clone();raw.outputs.at(-1)!.capacity-=1n;assert.throws(()=>built.assertIntegrity(raw),/raw/);
  const deps=tx.clone();deps.cellDeps.push(ccc.CellDep.from(dep(20)));assert.throws(()=>built.assertIntegrity(deps),/raw/);
  const cache=tx.clone();cache.inputs[index]!.cellOutput!.capacity+=1n;assert.throws(()=>built.assertIntegrity(cache),/cached/);
  const action=tx.clone();action.witnesses[index===0?1:0]='0x';assert.throws(()=>built.assertIntegrity(action),/action/);
  const signed=withLock(tx,index,300);signed.inputs.forEach(i=>{i.cellOutput=undefined;i.outputData=undefined;});built.assertIntegrity(signed);
 }
 const {wallet}=f;
 for(const proof of ['0xzz',`0x${'aa'.repeat(3001)}`] as ccc.Hex[])assert.throws(()=>buildCreate(deployment,{...wallet,witness:{kind:'joyid',outputType:proof}},recipients,request),/proof/);
});

test('legacy secp layout remains strict and JoyID witness reserve is reflected in fees',()=>{
 const {wallet,built}=fixture(),legacy=buildCreate(deployment,{...wallet,witness:undefined},recipients,request);
 assert.equal(legacy.stateOutputIndex,0);assert.equal(legacy.transaction.witnesses.length,1);
 assert.equal(decodeWitness(legacy.transaction.witnesses[0]!,true).kind,'create');
 assert.notEqual(legacy.poolId,built.poolId);assert.ok(built.fee>legacy.fee);
 assert.throws(()=>legacy.assertIntegrity(withLock(legacy.transaction,0,64)),/65 bytes/);
 assert.throws(()=>legacy.assertIntegrity(withLock(legacy.transaction,0,66)),/witness|65 bytes/);
 assert.throws(()=>buildCreate(deployment,{...wallet,maxFee:legacy.fee},recipients,request),/fee exceeds/);
 assert.equal(funding.cellOutput.capacity-built.transaction.outputs.reduce((sum,out)=>sum+out.capacity,0n),built.fee);
});
