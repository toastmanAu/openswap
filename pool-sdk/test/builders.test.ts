import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ccc} from '@ckb-ccc/core';
import {writeLE,parseAmount} from '../../sdk/src/codec.js';
import {buildCreate,buildTransition,type Wallet} from '../src/builders.js';
import {parsePool,loadPool,scanPools,readBounded,minimumCapacity,liveCell,type PoolClient,type PoolDeployment} from '../src/pools.js';
import {XUDT_CODE_HASH,decodeWitness,encodeAction,decodeState,encodeState} from '../src/codec.js';
import {runRequest,type CliRequest} from '../src/cli.js';

const hash=(n:number)=>`0x${n.toString(16).padStart(2,'0').repeat(32)}` as ccc.Hex;
const dep=(n:number)=>({outPoint:{txHash:hash(n),index:0},depType:'code' as const});
const deployment:PoolDeployment={genesisHash:hash(1),codeHash:ccc.hashCkb('0x1234'),poolDep:dep(3),tokenDep:dep(4)};
const lock=ccc.Script.from({codeHash:hash(5),hashType:'data1',args:`0x${'66'.repeat(20)}`});
const token=ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:hash(7)});
const funding=ccc.Cell.from({outPoint:{txHash:hash(8),index:0},cellOutput:{capacity:100_000_000_000_000n,lock,type:token},outputData:ccc.hexFrom(writeLE(10n**15n,16))});
const wallet:Wallet={lock,deps:[dep(9)],funding:[funding],change:lock,feeRate:1000n,maxFee:10000n};
const recipients={ckb:lock,token:lock,lp:lock};
const request={parameters:{feeBps:30n,lockedShares:1000n,backing:{state:34_000_000_000n,ckb:8_000_000_000n,token:16_000_000_000n}},x:10n**12n,y:4n*10n**12n,minShares:1n,tokenOwner:hash(7)};
const create=()=>buildCreate(deployment,wallet,recipients,request);
function cells(tx:ccc.Transaction){return tx.outputs.map((cellOutput,index)=>ccc.Cell.from({outPoint:{txHash:tx.hash(),index},cellOutput,outputData:tx.outputsData[index]!}));}
function fixture(){const built=create(),all=cells(built.transaction);return {built,all,pool:parsePool(deployment,all[0]!,all[1]!,all[2]!),wallet:{...wallet,funding:all.slice(3)}};}
function client(all:ccc.Cell[]):PoolClient{return {
 getHeaderByNumberNoCache:async()=>({hash:deployment.genesisHash}) as ccc.ClientBlockHeader,
 getCellLiveNoCache:async p=>{
  const point=ccc.OutPoint.from(p);
  if(point.eq(dep(3).outPoint)||point.eq(dep(4).outPoint))return ccc.Cell.from({outPoint:point,cellOutput:{lock,capacity:100_000_000_000_000n},outputData:point.eq(dep(3).outPoint)?'0x1234':ccc.hexFrom(readFileSync(new URL('../../tests/fixtures/xudt',import.meta.url)))});
  return all.find(c=>c.outPoint.eq(p))?.clone();
 },
 findCellsPagedNoCache:async()=>({lastCursor:'0x01',cells:all.slice(0,1)}),
};}
test('creation and every transition conserve capacity and tokens, with explicit fees and witnesses',()=>{
 const {built,all,pool,wallet:w}=fixture();
 assert.equal(decodeWitness(built.transaction.witnesses[0]!,true).kind,'create');
 assert.equal(funding.cellOutput.capacity-all.reduce((n,c)=>n+c.cellOutput.capacity,0n),built.fee);
 for(const action of [{kind:'swap',direction:'xToY',amountIn:10000n,minOut:1n},{kind:'swap',direction:'yToX',amountIn:10000n,minOut:1n},
  {kind:'deposit',maxX:100000n,maxY:400000n,minShares:1n},{kind:'withdraw',shares:pool.accounting.totalShares-pool.accounting.lockedShares,minX:1n,minY:1n}] as const){
  const b=buildTransition(deployment,w,recipients,pool,action),out=cells(b.transaction);
  b.assertIntegrity();assert.equal(decodeWitness(b.transaction.witnesses[0]!,false).kind,action.kind);
  assert.equal(all.reduce((n,c)=>n+c.cellOutput.capacity,0n)-out.reduce((n,c)=>n+c.cellOutput.capacity,0n),b.fee);
  const y=(cs:ccc.Cell[])=>cs.filter(c=>c.cellOutput.type?.eq(token)).reduce((n,c)=>n+parseAmount(c.outputData),0n);
  assert.equal(y(all),y(out));
  assert.equal(out[0]!.cellOutput.capacity,request.parameters.backing.state);
  assert.equal(out[2]!.cellOutput.capacity,request.parameters.backing.token);
  if(action.kind==='swap'&&action.direction==='yToX')assert.ok(b.ckbReceiptTopUp>0n);
  if(action.kind==='withdraw')assert.equal(parsePool(deployment,out[0]!,out[1]!,out[2]!).accounting.totalShares,request.parameters.lockedShares);
 }
});
test('rejects insufficient funds, dust, fee caps, duplicate/mixed/unknown funding, issuer and invalid backing',()=>{
 assert.throws(()=>buildCreate(deployment,{...wallet,maxFee:1n},recipients,request),/fee exceeds/);
 assert.throws(()=>buildCreate(deployment,{...wallet,funding:[funding,funding]},recipients,request),/duplicate/);
 const other=funding.clone();other.cellOutput.lock.args='0x';
 assert.throws(()=>buildCreate(deployment,{...wallet,funding:[other]},recipients,request),/mixed/);
 const unknown=funding.clone();unknown.cellOutput.type!.args=hash(20);
 assert.throws(()=>buildCreate(deployment,{...wallet,funding:[unknown]},recipients,request),/unsupported funding/);
 assert.throws(()=>buildCreate(deployment,wallet,recipients,{...request,tokenOwner:lock.hash()}),/issuer/);
 assert.throws(()=>buildCreate(deployment,wallet,recipients,{...request,parameters:{...request.parameters,backing:{...request.parameters.backing,state:1n}}}),/capacity|backing/);
 assert.throws(()=>buildCreate(deployment,wallet,recipients,{...request,y:10n**16n}),/insufficient token/);
 const poor=funding.clone();poor.cellOutput.capacity=20_000_000_000n;
 assert.throws(()=>buildCreate(deployment,{...wallet,funding:[poor]},recipients,request),/insufficient capacity/);
 const b=create(),last=cells(b.transaction).at(-1)!;const dusty=funding.clone();
 dusty.cellOutput.capacity-=last.cellOutput.capacity-minimumCapacity(last)+1n;
 assert.throws(()=>buildCreate(deployment,{...wallet,funding:[dusty]},recipients,request),/dust/);
 assert.throws(()=>buildCreate(deployment,{...wallet,funding:Array(257).fill(funding)},recipients,request),/count/);
});
test('integrity guard permits only signature replacement, not recipients, actions, fees or extra witnesses',()=>{
 for(const b of [create(),(()=>{const f=fixture();return buildTransition(deployment,f.wallet,recipients,f.pool,{kind:'swap',direction:'xToY',amountIn:100n,minOut:1n});})()]){
  const signed=b.transaction.clone(),w=ccc.WitnessArgs.fromBytes(signed.witnesses[b.walletWitnessIndex]!);w.lock=ccc.hexFrom(new Uint8Array(65).fill(42));signed.witnesses[b.walletWitnessIndex]=ccc.hexFrom(w.toBytes());b.assertIntegrity(signed);
  const changed=b.transaction.clone();changed.outputs[3]!.lock.args='0x';assert.throws(()=>b.assertIntegrity(changed),/raw transaction/);
  const action=b.transaction.clone();action.witnesses[0]='0x';assert.throws(()=>b.assertIntegrity(action));
  const extra=b.transaction.clone();extra.witnesses.push('0x');assert.throws(()=>b.assertIntegrity(extra),/count/);
 }
});
test('discovery requires exact live siblings, profile, genesis and unchanged state',async()=>{
 const {all,pool}=fixture();const c=client(all);
 assert.equal((await loadPool(c,deployment,all[0]!.outPoint)).poolId,pool.poolId);
 await assert.rejects(loadPool(c,{...deployment,genesisHash:hash(99)},all[0]!.outPoint),/genesis/);
 await assert.rejects(loadPool(client(all.slice(0,2)),deployment,all[0]!.outPoint),/no longer live/);
 const forged=all[1]!.clone();forged.outPoint.txHash=hash(99);assert.throws(()=>parsePool(deployment,all[0]!,forged,all[2]!),/OutPoint/);
 let reads=0;c.getCellLiveNoCache=async p=>{if(ccc.OutPoint.from(p).index===0n&&++reads===2)return undefined;return all.find(x=>x.outPoint.eq(p));};
 await assert.rejects(loadPool(c,deployment,all[0]!.outPoint),/no longer live/);
});
test('freshness checks every input and fails closed for spent wallet funding',async()=>{
 const {all,pool,wallet:w}=fixture(),b=buildTransition(deployment,w,recipients,pool,{kind:'withdraw',shares:1000n,minX:1n,minY:1n});
 await b.assertFresh(client(all));await assert.rejects(b.assertFresh(client(all.slice(0,-1))),/no longer live/);
});
test('scanner bounds duplicate pages and rejects nonprogress, oversize pages and RPC errors',async()=>{
 const {all}=fixture(),c=client(all);let calls=0;
 c.findCellsPagedNoCache=async()=>{calls++;return {lastCursor:`0x0${calls}`,cells:[all[0]!]};};
 const out=[];for await(const p of scanPools(c,deployment,{pageSize:1,maxCandidates:2}))out.push(p);
 assert.equal(out.length,1);assert.equal(calls,2);
 c.findCellsPagedNoCache=async()=>({lastCursor:'0x01',cells:[all[0]!]});
 await assert.rejects(async()=>{for await(const _ of scanPools(c,deployment,{pageSize:1}))void _;},/cursor/);
 c.findCellsPagedNoCache=async()=>({lastCursor:'0x01',cells:[all[0]!,all[0]!]});
 await assert.rejects(async()=>{for await(const _ of scanPools(c,deployment,{pageSize:1}))void _;},/page size/);
 c.findCellsPagedNoCache=async()=>{throw new Error('transport failed');};
 await assert.rejects(async()=>{for await(const _ of scanPools(c,deployment))void _;},/transport/);
});
test('RPC deadlines and cancellation do not hang',async()=>{
 await assert.rejects(readBounded(()=>new Promise(()=>{}),{timeoutMs:5}),/deadline/);
 const controller=new AbortController();controller.abort(new Error('cancelled'));
 await assert.rejects(readBounded(async()=>1,{signal:controller.signal}),/cancelled/);
 const active=new AbortController();const pending=readBounded(()=>new Promise(()=>{}),{signal:active.signal});active.abort(new Error('cancelled in flight'));await assert.rejects(pending,/cancelled in flight/);
});
test('cancellation before dispatch must not start the queued RPC',async()=>{
 let dispatched=0;const controller=new AbortController();
 const pending=readBounded(async()=>{dispatched++;return 1;},{signal:controller.signal});
 controller.abort(new Error('cancel before dispatch'));
 await assert.rejects(pending,/cancel before dispatch/);await Promise.resolve();
 assert.equal(dispatched,0);
});
test('freshness rejects wallet preparation mutations made while RPC is pending',async()=>{
 const b=create(),c=client([funding]);const original=c.getHeaderByNumberNoCache;
 c.getHeaderByNumberNoCache=async(...args)=>{
  const result=await original(...args);b.transaction.outputs[3]!.capacity+=1n;return result;
 };
 await assert.rejects(b.assertFresh(c),/raw transaction changed/);
});
test('RPC argument mutation cannot redefine the requested OutPoint, and returned cells are isolated',async()=>{
 const c=client([funding]),expected=funding.outPoint.clone();
 c.getCellLiveNoCache=async p=>{const point=ccc.OutPoint.from(p);point.txHash=hash(99);const wrong=funding.clone();wrong.outPoint=point;return wrong;};
 await assert.rejects(liveCell(c,expected),/different OutPoint/);assert.ok(expected.eq(funding.outPoint));
 const shared=funding.clone();c.getCellLiveNoCache=async()=>shared;
 const observed=await liveCell(c,expected);shared.cellOutput.capacity+=1n;
 assert.notEqual(observed.cellOutput.capacity,shared.cellOutput.capacity);
});
test('aliased RPC snapshots and reorg removal during wallet reads fail freshness',async()=>{
 const {all,pool,wallet:w}=fixture();const shared=all.map(x=>x.clone()),c=client(shared);
 c.getCellLiveNoCache=async p=>{
  if(ccc.OutPoint.from(p).index===1n)shared[0]!.outputData=encodeState({...decodeState(shared[0]!.outputData),fee:31n});
  return shared.find(cell=>cell.outPoint.eq(p));
 };
 await assert.rejects(loadPool(c,deployment,all[0]!.outPoint),/changed during discovery/);
 const b=buildTransition(deployment,w,recipients,pool,{kind:'withdraw',shares:1000n,minX:1n,minY:1n}),reorg=client(all),read=reorg.getCellLiveNoCache;
 let removed=false;
 reorg.getCellLiveNoCache=async(...args)=>{
  const point=ccc.OutPoint.from(args[0]);
  if(point.eq(all[3]!.outPoint))removed=true;
  if(removed&&point.eq(all[0]!.outPoint))return undefined;
  return read(...args);
 };
 await assert.rejects(b.assertFresh(reorg),/no longer live/);
});
test('prepared candidate is checked before and after RPC, including nonbinding witness changes',async()=>{
 const f=fixture(),b=buildTransition(deployment,f.wallet,recipients,f.pool,{kind:'deposit',maxX:100000n,maxY:400000n,minShares:1n});
 const candidate=b.transaction.clone(),c=client(f.all),read=c.getHeaderByNumberNoCache;
 c.getHeaderByNumberNoCache=async(...args)=>{
  const result=await read(...args),w=ccc.WitnessArgs.fromBytes(candidate.witnesses[0]!);
  w.inputType=encodeAction({kind:'deposit',maxX:100001n,maxY:400000n,minShares:1n});candidate.witnesses[0]=ccc.hexFrom(w.toBytes());return result;
 };
 await assert.rejects(b.assertFresh(c,{},candidate),/action/);b.assertIntegrity();
});
test('recipient scripts and returned transaction do not alias caller wallet scripts',()=>{
 const b=create(),saved=lock.toBytes();b.transaction.outputs[3]!.lock.args='0x';
 assert.deepEqual(lock.toBytes(),saved);assert.deepEqual(funding.cellOutput.lock.toBytes(),saved);
});
test('malicious page shapes, oversized cursors and oversized live data fail bounded checks',async()=>{
 const {all}=fixture(),c=client(all);
 for(const response of [{cells:null,lastCursor:'0x'},{cells:[],lastCursor:`0x${'00'.repeat(2049)}`},{cells:[],lastCursor:'not hex'}]){
  c.findCellsPagedNoCache=async()=>response as unknown as ccc.ClientFindCellsResponse;
  await assert.rejects(async()=>{for await(const _ of scanPools(c,deployment))void _;},/Malformed|oversized/);
 }
 const huge=funding.clone();huge.outputData=`0x${'00'.repeat(1024*1024+1)}`;
 c.getCellLiveNoCache=async()=>huge;
 await assert.rejects(liveCell(c,huge.outPoint),/1 MiB/);
});
test('scanner reports malformed profile candidates and independently bounds pages',async()=>{
 const {all}=fixture(),bad=all[0]!.clone();bad.outputData=encodeState({...decodeState(bad.outputData),tokenCodeHash:hash(99)});
 const c=client([bad,...all.slice(1)]);let rejected=0,yielded=0;
 for await(const _ of scanPools(c,deployment,{onMalformed:()=>{rejected++;}})){void _;yielded++;}
 assert.equal(rejected,1);assert.equal(yielded,0);
 let pages=0;const good=client(all);good.findCellsPagedNoCache=async()=>({lastCursor:`0x0${++pages}`,cells:[all[0]!]});
 for await(const _ of scanPools(good,deployment,{maxPages:2,pageSize:1,maxCandidates:10}))void _;
 assert.equal(pages,2);
});
test('valid but economically nonbinding action changes still fail SDK integrity',()=>{
 const f=fixture();const b=buildTransition(deployment,f.wallet,recipients,f.pool,{kind:'deposit',maxX:100000n,maxY:400000n,minShares:1n});
 const tx=b.transaction.clone(),args=ccc.WitnessArgs.fromBytes(tx.witnesses[0]!);
 args.inputType=encodeAction({kind:'deposit',maxX:100001n,maxY:400000n,minShares:1n});tx.witnesses[0]=ccc.hexFrom(args.toBytes());
 assert.equal(tx.hash(),b.transaction.hash());assert.throws(()=>b.assertIntegrity(tx),/action/);
});
test('dry-run CLI validates decimal amounts, emits unsigned bytes, checks deps and rejects stale inputs',async()=>{
 const cli:CliRequest={rpcUrl:'http://127.0.0.1:8114',command:'create',deployment,funding:[funding.outPoint],wallet:{lock,change:lock,deps:wallet.deps,feeRate:'1000',maxFee:'10000'},recipients,
  create:{feeBps:'30',lockedShares:'1000',backing:{state:'34000000000',ckb:'8000000000',token:'16000000000'},x:'1000000000000',y:'4000000000000',minShares:'1',tokenOwner:hash(7)}};
 const output=await runRequest(cli,client([funding])) as {unsigned:boolean;transactionBytes:ccc.Hex};
 assert.equal(output.unsigned,true);assert.equal(ccc.Transaction.fromBytes(output.transactionBytes).hash(),create().transaction.hash());
 await assert.rejects(runRequest(cli,client([])),/no longer live/);
 await assert.rejects(runRequest({...cli,create:{...cli.create!,x:'1e12'}},client([funding])),/decimal strings/);
 await assert.rejects(runRequest({...cli,deployment:{...deployment,codeHash:hash(99)}},client([funding])),/Dependency data hash/);
 await assert.rejects(runRequest({...cli,deployment:{...deployment,poolDep:{...dep(3),depType:'depGroup'}}},client([funding])),/direct code/);
 const f=fixture();
 const withdrawal:CliRequest={...cli,command:'transition',state:f.all[0]!.outPoint,funding:f.all.slice(3).map(c=>c.outPoint),action:{kind:'withdraw',shares:'1000',minX:'1',minY:'1'}};
 assert.equal((await runRequest(withdrawal,client(f.all)) as {unsigned:boolean}).unsigned,true);
 const scan=await runRequest({rpcUrl:cli.rpcUrl,command:'scan',deployment},client(f.all)) as {pools:unknown[]};assert.equal(scan.pools.length,1);
});
