import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ccc} from '@ckb-ccc/core';
import {JoyId} from '@ckb-ccc/joy-id';
import {writeLE} from '../../sdk/src/codec.js';
import {buildCreate,buildTransition} from '../src/builders.js';
import {resolveJoyIdWallet,type JoyIdWalletProfile,type PoolJoyIdSigner} from '../src/joyid.js';
import {parsePool,type PoolDeployment,pointKey} from '../src/pools.js';
import {XUDT_CODE_HASH} from '../src/codec.js';
import type {JoyIdProofSource} from '../src/joyid-proof.js';
import {reviewPoolTransaction} from '../src/review.js';

const oldLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
before(()=>Object.defineProperty(globalThis,'location',{value:{href:'http://localhost/test'},configurable:true}));
after(()=>{if(oldLocation)Object.defineProperty(globalThis,'location',oldLocation);else Reflect.deleteProperty(globalThis,'location');});
const hash=(n:number)=>`0x${n.toString(16).padStart(2,'0').repeat(32)}` as ccc.Hex;
const dep=(n:number)=>({outPoint:{txHash:hash(n),index:0},depType:'code' as const});
const request={parameters:{feeBps:30n,lockedShares:1000n,backing:{state:34_000_000_000n,ckb:8_000_000_000n,token:16_000_000_000n}},x:10n**12n,y:4n*10n**12n,minShares:1n,tokenOwner:hash(7)};
const tokenData=ccc.hexFrom(readFileSync(new URL('../../tests/fixtures/xudt',import.meta.url)));

test('review-bound signing is one-shot and rejects refusal, mutations, session changes and late results',async()=>{
 for(const mode of ['ok','refusal','raw','proof','unsigned','session','timeout'] as const){
  const f=fixture(true),resolved=await f.resolve();let calls=0;
  // Replace the signer method BEFORE invocation: no popup, key, RPC or WebAuthn.
  f.signer.signOnlyTransaction=async input=>{
   calls++;if(mode==='refusal')throw new Error('Mock wallet refusal');
   if(mode==='timeout')await new Promise(resolve=>setTimeout(resolve,100));
   const tx=ccc.Transaction.from(input).clone(),args=ccc.WitnessArgs.fromBytes(tx.witnesses[0]!);
   if(mode!=='unsigned')args.lock='0x1234';
   if(mode==='proof')args.outputType='0xff';tx.witnesses[0]=ccc.hexFrom(args.toBytes());
   if(mode==='raw')tx.outputs[0]!.capacity+=1n;
   if(mode==='session')f.setRevision('changed');return tx;
  };
  const wallet={...resolved.wallet(),change:f.lock,funding:[f.funding],feeRate:1000n,maxFee:10000n};
  const built=buildCreate(f.deployment,wallet,f.recipients,request),prepared=await resolved.prepare(built);
  const review=reviewPoolTransaction(f.deployment,wallet,f.recipients,{kind:'create',request},prepared);
  const bound=resolved.bindReview(review);assert.equal(bound.identity.keyType,'sub_key');assert.equal(bound.summary,review.summary);
  assert.throws(()=>resolved.bindReview(review),/already bound/);
  if(mode==='ok'){const signed=await bound.sign();review.assertIntegrity(signed);}
  else await assert.rejects(bound.sign({timeoutMs:mode==='timeout'?40:15000}));
  assert.equal(calls,1);await assert.rejects(bound.sign(),/already used/);
 }
});

function fixture(subkey=false){
 const codeType=ccc.Script.from({codeHash:hash(11),hashType:'type',args:hash(12)});
 const lock=ccc.Script.from({codeHash:codeType.hash(),hashType:'type',args:`0x0001${'66'.repeat(20)}`});
 const token=ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:hash(7)});
 const deployment:PoolDeployment={genesisHash:hash(1),codeHash:ccc.hashCkb('0x1234'),poolDep:dep(3),tokenDep:dep(4)};
 const cotaType=ccc.Script.from({codeHash:hash(13),hashType:'type',args:'0x'});
 const cell=(index:number,data:ccc.Hex,type?:ccc.Script)=>ccc.Cell.from({outPoint:dep(index).outPoint,cellOutput:{lock:lock.clone(),type:type?.clone(),capacity:100_000_000_000_000n},outputData:data});
 const code=cell(9,'0xabcd',codeType),cota=cell(10,hash(21),cotaType),funding=cell(8,ccc.hexFrom(writeLE(10n**15n,16)),token);
 const cells=new Map([cell(3,'0x1234'),cell(4,tokenData),code,cota,funding].map(c=>[pointKey(c.outPoint),c]));
 let genesis=deployment.genesisHash,revision='1',page=[cota.clone()],proofCalls=0,prepareCalls=0;
 const publicKey=`0x${'77'.repeat(64)}` as ccc.Hex;
 const client={addressPrefix:'ckt',
  getKnownScript:async(script:ccc.KnownScript)=>{assert.equal(script,ccc.KnownScript.JoyId);return {codeHash:lock.codeHash,hashType:lock.hashType,cellDeps:[{cellDep:dep(9)}]};},
  getCellDeps:async()=>[ccc.CellDep.from(dep(9))],
  getHeaderByNumberNoCache:async()=>({hash:genesis}),
  getCellLiveNoCache:async(p:ccc.OutPointLike)=>cells.get(pointKey(p))?.clone(),
  findCellsPagedNoCache:async(key:ccc.ClientIndexerSearchKeyLike,_order:string,limit:number)=>{
   assert.equal(limit,5);assert.equal(key.scriptType,'lock');assert.ok(ccc.Script.from(key.script).eq(lock));
   return {lastCursor:'0x01',cells:page.map(c=>c.clone())};
  },
  findCellsByLock:()=>{throw new Error('unbounded connector CoTA scan must not be called');},
 } as unknown as ccc.Client;
 const signer=new JoyId.CkbSigner(client,'Offline fixture','','https://example.invalid','https://example.invalid',{
  get:async()=>({address:ccc.Address.fromScript(lock,client).toString(),publicKey,keyType:subkey?'sub_key':'main_key'}),set:async()=>{},
 });
 const originalPrepare=signer.prepareTransaction.bind(signer);
 signer.prepareTransaction=async tx=>{prepareCalls++;return originalPrepare(tx);};
 let active:PoolJoyIdSigner=signer;
 const source={current:()=>({signer:active,revision})};
 const profile:JoyIdWalletProfile={codeHash:lock.codeHash,hashType:lock.hashType,codeDeps:[{dep:dep(9),dataHash:ccc.hashCkb(code.outputData)}],cotaType};
 const proofSource:JoyIdProofSource=async r=>{proofCalls++;assert.equal(r.publicKey,publicKey);assert.equal(r.lock,ccc.hexFrom(lock.toBytes()));return '0x123456';};
 const resolve=()=>resolveJoyIdWallet(source,deployment,profile,funding,proofSource);
 const recipients={ckb:lock,token:lock,lp:lock};
 return {subkey,lock,cota,code,token,funding,cells,client,source,signer,profile,deployment,proofSource,resolve,recipients,
  counts:()=>({proofCalls,prepareCalls}),setGenesis:(value:ccc.Hex)=>{genesis=value;},setRevision:(value:string)=>{revision=value;},setSigner:(value:PoolJoyIdSigner)=>{active=value;},setPage:(value:ccc.Cell[])=>{page=value;},
 };
}

test('actual JoyID primary/subkey preparation uses pinned bounded resolution without connector CoTA scans',async()=>{
 for(const subkey of [false,true]){
  const f=fixture(subkey),resolved=await f.resolve();
  assert.equal(resolved.identity.keyType,subkey?'sub_key':'main_key');
  assert.equal(f.counts().proofCalls,subkey?1:0);assert.equal(f.counts().prepareCalls,1);
  const wallet={...resolved.wallet(),change:f.lock,funding:[f.funding],feeRate:1000n,maxFee:10000n};
  const genesis=buildCreate(f.deployment,wallet,f.recipients,request);
  assert.equal(ccc.hexFrom((await resolved.prepare(genesis)).toBytes()),ccc.hexFrom(genesis.transaction.toBytes()));
  await resolved.assertFresh();
  // Exercise every operation with real connector preparation and fresh mocked
  // predecessors; no synthetic proof is claimed to be cryptographically valid.
  let tx=genesis.transaction,index=genesis.stateOutputIndex;
  for(const kind of ['xToY','yToX','deposit','withdraw','deposit'] as const){
   for(const input of tx.inputs)f.cells.delete(pointKey(input.previousOutput));
   const all=tx.outputs.map((cellOutput,index)=>ccc.Cell.from({outPoint:{txHash:tx.hash(),index},cellOutput,outputData:tx.outputsData[index]!}));
   for(const cell of all)f.cells.set(pointKey(cell.outPoint),cell.clone());
   const pool=parsePool(f.deployment,all[index]!,all[index+1]!,all[index+2]!);
   const operation=kind==='deposit'?{kind:'deposit' as const,maxX:10000000000n,maxY:40000000000n,minShares:1n}:kind==='withdraw'?{kind:'withdraw' as const,shares:pool.accounting.totalShares-pool.accounting.lockedShares,minX:1n,minY:1n}:{kind:'swap' as const,direction:kind,amountIn:10000000000n,minOut:1n};
   const built=buildTransition(f.deployment,{...wallet,funding:all.filter((_,i)=>i<index||i>index+2)},f.recipients,pool,operation);
   tx=await resolved.prepare(built);built.assertIntegrity(tx);index=0;
  }
 }
});

test('resolved policy is isolated from caller/profile/returned wallet mutations',async()=>{
 const f=fixture(true),resolved=await f.resolve(),original=resolved.wallet();
 f.profile.codeDeps[0]!.dep.outPoint.txHash=hash(55);f.profile.codeHash=hash(56);f.profile.cotaType!.args='0xff';
 f.deployment.genesisHash=hash(57);f.funding.cellOutput.capacity+=1n;
 const copy=resolved.wallet();ccc.Script.from(copy.lock).args='0x';ccc.CellDep.from(copy.deps[0]!).outPoint.txHash=hash(58);copy.witness!.outputType='0x99';
 await resolved.assertFresh();
 assert.ok(ccc.Script.from(resolved.wallet().lock).eq(original.lock));
 assert.ok(ccc.CellDep.from(resolved.wallet().deps[0]!).eq(original.deps[0]!));
 assert.equal(resolved.wallet().witness!.outputType,'0x123456');
 assert.throws(()=>{Object.assign(resolved.identity,{revision:'fake'});},TypeError);
});

test('session, account, credential, client and genesis changes invalidate a resolved wallet',async()=>{
 for(const mode of ['revision','account','key','credential','client','signer','network'] as const){
  const f=fixture(),resolved=await f.resolve();
  if(mode==='revision')f.setRevision('2');
  if(mode==='account')f.signer.getAddressObjs=async()=>[ccc.Address.fromScript({...f.lock,args:'0x0001ffff'},f.client)];
  if(mode==='key')f.signer.getIdentity=async()=>JSON.stringify({keyType:'main_key',publicKey:'88'.repeat(64)});
  if(mode==='credential')f.signer.getIdentity=async()=>JSON.stringify({keyType:'sub_session_key',publicKey:'77'.repeat(64)});
  if(mode==='client')Object.defineProperty(f.signer,'client',{value:{...f.client},configurable:true});
  if(mode==='signer')f.setSigner({...f.signer} as PoolJoyIdSigner);
  if(mode==='network')f.setGenesis(hash(99));
  await assert.rejects(resolved.assertFresh(),/.+/,mode);
 }
});

test('identity/session changes during reads or preparation fail before returning a profile',async()=>{
 for(const mode of ['identity','session','prepare'] as const){
  const f=fixture(true);
  if(mode==='identity'){let count=0;f.signer.getIdentity=async()=>JSON.stringify({keyType:'sub_key',publicKey:(++count===1?'77':'88').repeat(64)});}
  if(mode==='session'){const read=f.client.getCellLiveNoCache.bind(f.client);f.client.getCellLiveNoCache=async(...args)=>{f.setRevision('2');return read(...args);};}
  if(mode==='prepare'){const prepare=f.signer.prepareTransaction.bind(f.signer);f.signer.prepareTransaction=async tx=>{const out=await prepare(tx);f.setRevision('2');return out;};}
  await assert.rejects(f.resolve(),/changed/);
 }
});

test('CoTA discovery rejects foreign/malformed/duplicate/excess/stale state and proof failures',async()=>{
 for(const mode of ['none','excess','duplicate','owner','type','stale','root-change','empty-proof','oversize-proof'] as const){
  const f=fixture(true);let proof=f.proofSource;
  if(mode==='none')f.setPage([]);
  if(mode==='excess')f.setPage(Array(5).fill(f.cota));
  if(mode==='duplicate')f.setPage([f.cota,f.cota]);
  if(mode==='owner'){f.cota.cellOutput.lock.args='0x';f.setPage([f.cota]);}
  if(mode==='type'){f.cota.cellOutput.type!.args='0xff';f.setPage([f.cota]);}
  if(mode==='stale')f.cells.delete(pointKey(f.cota.outPoint));
  if(mode==='root-change')proof=async()=>{f.cota.outputData=hash(98);return '0x123456';};
  if(mode==='empty-proof')proof=async()=> '0x';
  if(mode==='oversize-proof')proof=async()=> `0x${'aa'.repeat(3001)}`;
  await assert.rejects(resolveJoyIdWallet(f.source,f.deployment,f.profile,f.funding,proof),/.+/,mode);
 }
});

test('code manifest and preparation reject unapproved dependencies, witnesses, raw fields and caches',async()=>{
 for(const mode of ['hash','unresolved','dep-group','duplicate','new-dep','output','input','witness','cache'] as const){
  const f=fixture();
  if(mode==='hash')f.profile.codeDeps[0]!.dataHash=hash(33);
  if(mode==='unresolved'){f.code.cellOutput.type!.args='0x22';}
  if(mode==='dep-group')f.profile.codeDeps[0]!.dep.depType='depGroup';
  if(mode==='duplicate')Object.assign(f.profile,{codeDeps:[f.profile.codeDeps[0],f.profile.codeDeps[0]]});
  const prepare=f.signer.prepareTransaction.bind(f.signer);
  f.signer.prepareTransaction=async tx=>{
   const out=await prepare(tx);
   if(mode==='new-dep')out.cellDeps.push(ccc.CellDep.from(dep(90)));
   if(mode==='output')out.addOutput({lock:f.lock,capacity:10000000000n},'0x');
   if(mode==='input')out.inputs[0]!.since=1n;
   if(mode==='witness')out.witnesses[0]='0x';
   if(mode==='cache')out.inputs[0]!.cellOutput!.capacity+=1n;
   return out;
  };
  await assert.rejects(f.resolve(),/.+/,mode);
 }
});

test('final preparation rejects stale inputs, wrong profiles and wallet mutations',async()=>{
 for(const mode of ['spent','proof','extra-dep','raw','cache','action','wallet-proof','session'] as const){
  const f=fixture(true),resolved=await f.resolve();
  const wallet={...resolved.wallet(),change:f.lock,funding:[f.funding],feeRate:1000n,maxFee:10000n};
  if(mode==='proof')wallet.witness!.outputType='0x99';
  if(mode==='extra-dep')wallet.deps.push(dep(90));
  const built=buildCreate(f.deployment,wallet,f.recipients,request);
  if(mode==='spent')f.cells.delete(pointKey(f.funding.outPoint));
  const prepare=f.signer.prepareTransaction.bind(f.signer);
  f.signer.prepareTransaction=async tx=>{
   const out=await prepare(tx);
   if(mode==='raw')out.outputs.at(-1)!.capacity-=1n;
   if(mode==='cache')out.inputs[0]!.cellOutput!.capacity+=1n;
   if(mode==='action')out.witnesses[1]='0x';
   if(mode==='wallet-proof'){const args=ccc.WitnessArgs.fromBytes(out.witnesses[0]!);args.outputType='0x99';out.witnesses[0]=ccc.hexFrom(args.toBytes());}
   if(mode==='session')f.setRevision('2');
   return out;
  };
  await assert.rejects(resolved.prepare(built),/.+/,mode);
 }
});

test('resolution and later freshness have bounded cancellation/deadlines and ignore late results',async()=>{
 const cancelled=fixture(),controller=new AbortController();controller.abort(new Error('cancelled'));
 await assert.rejects(resolveJoyIdWallet(cancelled.source,cancelled.deployment,cancelled.profile,cancelled.funding,undefined,{signal:controller.signal}),/cancelled/);
 assert.equal(cancelled.counts().prepareCalls,0);
 const hanging=fixture(true);let observed:AbortSignal|undefined;
 await assert.rejects(resolveJoyIdWallet(hanging.source,hanging.deployment,hanging.profile,hanging.funding,async(_request,o)=>{observed=o.signal;return new Promise(()=>{});},{timeoutMs:30}),/deadline/);
 assert.ok(observed?.aborted);
 const late=fixture();let finish:((tx:ccc.Transaction)=>void)|undefined,captured:ccc.Transaction|undefined;
 late.signer.prepareTransaction=async tx=>{captured=ccc.Transaction.from(tx);return new Promise(resolve=>{finish=resolve;});};
 await assert.rejects(resolveJoyIdWallet(late.source,late.deployment,late.profile,late.funding,undefined,{timeoutMs:30}),/deadline/);
 assert.ok(finish&&captured);finish(captured);await Promise.resolve();
 const ready=fixture(),lifetime=new AbortController(),resolved=await resolveJoyIdWallet(ready.source,ready.deployment,ready.profile,ready.funding,undefined,{signal:lifetime.signal});
 lifetime.abort(new Error('review cancelled'));await assert.rejects(resolved.assertFresh(),/review cancelled/);
});
