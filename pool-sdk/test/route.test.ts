import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ccc} from '@ckb-ccc/core';
import {writeLE,parseAmount} from '../../sdk/src/codec.js';
import {swap,ModelError} from '../../pool-model/src/model.js';
import {buildCreate,buildRoute,PoolBuildError,type Wallet} from '../src/builders.js';
import {fundPoolTransaction,PoolFundingReservations} from '../src/funding.js';
import {reviewPoolTransaction} from '../src/review.js';
import {quoteRouteExactIn,quoteRouteExactOut} from '../src/route.js';
import {parsePool,pointKey,poolScript,type PoolClient,type PoolDeployment,type PoolSnapshot} from '../src/index.js';
import {XUDT_CODE_HASH,decodeWitness,decodeState,Role} from '../src/codec.js';

const hash=(n:number)=>`0x${n.toString(16).padStart(2,'0').repeat(32)}` as ccc.Hex;
const dep=(n:number)=>({outPoint:{txHash:hash(n),index:0},depType:'code' as const});
const deployment:PoolDeployment={genesisHash:hash(1),codeHash:ccc.hashCkb('0x1234'),poolDep:dep(3),tokenDep:dep(4)};
const lock=ccc.Script.from({codeHash:hash(5),hashType:'data1',args:`0x${'66'.repeat(20)}`});
const tokenA=ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:hash(7)});
const tokenB=ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:hash(27)});
const recipients={ckb:lock,token:lock,lp:lock};
let next=40;
const cell=(capacity:bigint,type?:ccc.Script,amount?:bigint)=>ccc.Cell.from({outPoint:{txHash:hash(next++),index:0},cellOutput:{capacity,lock,type},outputData:amount===undefined?'0x':ccc.hexFrom(writeLE(amount,16))});
const parameters={feeBps:30n,lockedShares:1000n,backing:{state:34_000_000_000n,ckb:8_000_000_000n,token:16_000_000_000n}};
const outputs=(tx:ccc.Transaction)=>tx.outputs.map((cellOutput,index)=>ccc.Cell.from({outPoint:{txHash:tx.hash(),index},cellOutput,outputData:tx.outputsData[index]!}));
/** Pool A: 10,000 CKB / 40,000 A. Pool B: 20,000 CKB / 10,000 B. */
function pools(){
 const make=(token:ccc.Script,owner:ccc.Hex,x:bigint,y:bigint)=>{
  const w:Wallet={lock,deps:[dep(9)],funding:[cell(10n**14n,token,10n**15n)],change:lock,feeRate:1000n,maxFee:10000n};
  const all=outputs(buildCreate(deployment,w,recipients,{parameters,x,y,minShares:1n,tokenOwner:owner}).transaction);
  return parsePool(deployment,all[0]!,all[1]!,all[2]!);
 };
 return [make(tokenA,hash(7),10n**12n,4n*10n**12n),make(tokenB,hash(27),2n*10n**12n,10n**12n)] as const;
}
const wallet=(funding:ccc.Cell[]):Wallet=>({lock,deps:[dep(9)],funding,change:lock,feeRate:1000n,maxFee:10000n});
const sumTokens=(cells:readonly {cellOutput:ccc.CellOutput;outputData:ccc.Hex}[],token:ccc.Script)=>cells.reduce((n,c)=>n+(c.cellOutput.type?.eq(token)?parseAmount(c.outputData):0n),0n);

test('route quotes: exact output is minimal and covers the request; exact input matches the builder',()=>{
 const [a,b]=pools();
 for(const want of [1n,123_456_789n,5_000_000_000n,10n**11n]){
  const q=quoteRouteExactOut(a.accounting,b.accounting,want);
  assert.ok(q.amountOut>=want,`covers ${want}`);
  assert.deepEqual(quoteRouteExactIn(a.accounting,b.accounting,q.amountIn),q);
  // One unit less must deliver less, or nothing at all (the model refuses a zero output).
  if(q.amountIn>1n){let less=0n;try{less=quoteRouteExactIn(a.accounting,b.accounting,q.amountIn-1n).amountOut;}catch(e){assert.ok(e instanceof ModelError);}assert.ok(less<want,`minimal for ${want}`);}
 }
});

test('a route spends both pools in order, chains the hop exactly and conserves CKB and both tokens',()=>{
 const [a,b]=pools(),amountIn=40_000_000_000n;
 const funding=[cell(30_000_000_000n,tokenA,10n**12n),cell(10n**12n)];
 const built=buildRoute(deployment,wallet(funding),recipients,a,b,{amountIn,minOut:1n}),tx=built.transaction;
 built.assertIntegrity();
 assert.deepEqual(tx.inputs.map(i=>pointKey(i.previousOutput)),[a.stateCell,a.ckbCell,a.tokenCell,b.stateCell,b.ckbCell,b.tokenCell,...funding].map(c=>pointKey(c.outPoint)));
 assert.equal(built.walletWitnessIndex,6);assert.deepEqual(built.hops!.map(h=>h.stateOutputIndex),[0,3]);
 for(const [at,poolId] of [[0,a.poolId],[3,b.poolId]] as const){
  assert.ok(tx.outputs[at]!.type!.eq(poolScript(deployment.codeHash,poolId,Role.StateType)));
  const s=decodeState(tx.outputsData[at]!);assert.deepEqual([s.rx,s.ry],[BigInt(at+1),BigInt(at+2)]);
 }
 const [first,second]=[decodeWitness(tx.witnesses[0]!,false),decodeWitness(tx.witnesses[3]!,false)];
 const hop=swap(a.accounting,'yToX',amountIn,1n).flows.receivedX;
 assert.deepEqual(first,{kind:'swap',direction:'yToX',amountIn,minOut:hop});
 assert.deepEqual(second,{kind:'swap',direction:'xToY',amountIn:hop,minOut:1n});
 assert.deepEqual(['0x','0x','0x','0x'],[tx.witnesses[1],tx.witnesses[2],tx.witnesses[4],tx.witnesses[5]]);
 const received=swap(b.accounting,'xToY',hop,1n).flows.receivedY;
 assert.ok(tx.outputs[6]!.lock.eq(lock)&&tx.outputs[6]!.type!.eq(tokenB));assert.equal(parseAmount(tx.outputsData[6]!),received);
 const inputs=[a.stateCell,a.ckbCell,a.tokenCell,b.stateCell,b.ckbCell,b.tokenCell,...funding],outs=outputs(tx);
 assert.equal(inputs.reduce((n,c)=>n+c.cellOutput.capacity,0n)-tx.outputs.reduce((n,o)=>n+o.capacity,0n),built.fee);
 assert.equal(sumTokens(inputs,tokenA),sumTokens(outs,tokenA));assert.equal(sumTokens(inputs,tokenB),sumTokens(outs,tokenB));
 // Pool A received the token and paid the hop; pool B took exactly the hop.
 assert.equal(tx.outputs[1]!.capacity,a.ckbCell.cellOutput.capacity-hop);
 assert.equal(tx.outputs[4]!.capacity,b.ckbCell.cellOutput.capacity+hop);
 assert.ok(tx.outputs.at(-1)!.type===undefined);
});

test('a route refuses one pool twice, one token twice, issuer funding, other assets and an unmet minimum',()=>{
 const [a,b]=pools(),funding=[cell(30_000_000_000n,tokenA,10n**12n),cell(10n**12n)];
 const build=(f=funding,first:PoolSnapshot=a,second:PoolSnapshot=b,minOut=1n,w?:Partial<Wallet>)=>()=>buildRoute(deployment,{...wallet(f),...w},recipients,first,second,{amountIn:40_000_000_000n,minOut});
 assert.throws(build(funding,a,a),/two different pools/);
 const twin=(()=>{const w:Wallet={lock,deps:[dep(9)],funding:[cell(10n**14n,tokenA,10n**15n)],change:lock,feeRate:1000n,maxFee:10000n};
  const all=outputs(buildCreate(deployment,w,recipients,{parameters,x:10n**12n,y:10n**12n,minShares:1n,tokenOwner:hash(7)}).transaction);return parsePool(deployment,all[0]!,all[1]!,all[2]!);})();
 assert.throws(build(funding,a,twin),/must change tokens/);
 assert.throws(build([...funding,cell(20_000_000_000n,tokenB,5n)]),/unsupported funding type/);
 assert.throws(build([...funding,cell(20_000_000_000n,a.lp,5n)]),/unsupported funding type/);
 assert.throws(build([cell(10n**12n)]),(e:unknown)=>e instanceof PoolBuildError&&e.code==='FUNDING');
 assert.throws(build(funding,a,b,10n**15n),(e:unknown)=>e instanceof ModelError&&e.code==='SLIPPAGE');
 const issuer=ccc.Script.from({codeHash:hash(5),hashType:'data1',args:'0x01'});
 for(const owner of [hash(7),hash(27)]){
  const fake=new Proxy(issuer,{get:(t,p,r)=>p==='hash'?()=>owner:Reflect.get(t,p,r)});
  assert.throws(build(funding,a,b,1n,{lock:fake}),/issuer-mode/);
 }
});

test('route integrity pins both pool actions and the wallet witness',()=>{
 const [a,b]=pools(),built=buildRoute(deployment,wallet([cell(30_000_000_000n,tokenA,10n**12n),cell(10n**12n)]),recipients,a,b,{amountIn:40_000_000_000n,minOut:1n});
 for(const i of [0,3]){const tx=built.transaction.clone();tx.witnesses[i]=tx.witnesses[i===0?3:0]!;assert.throws(()=>built.assertIntegrity(tx),/pool action or other witness changed/);}
 const signed=built.transaction.clone(),args=ccc.WitnessArgs.fromBytes(signed.witnesses[6]!);args.lock=ccc.hexFrom(new Uint8Array(65).fill(1));signed.witnesses[6]=ccc.hexFrom(args.toBytes());
 built.assertIntegrity(signed);
});

test('route review and funding: totals, tagged outputs, and only token A and plain CKB are selected',async()=>{
 const [a,b]=pools(),amountIn=40_000_000_000n;
 const tokenCell=cell(30_000_000_000n,tokenA,10n**12n),cash=cell(10n**12n),otherAsset=cell(20_000_000_000n,tokenB,5n);
 const live=new Map([a.stateCell,a.ckbCell,a.tokenCell,b.stateCell,b.ckbCell,b.tokenCell,tokenCell,cash,otherAsset,
  ccc.Cell.from({outPoint:dep(3).outPoint,cellOutput:{capacity:10n**14n,lock},outputData:'0x1234'}),
  ccc.Cell.from({outPoint:dep(4).outPoint,cellOutput:{capacity:10n**14n,lock},outputData:ccc.hexFrom(readFileSync(new URL('../../tests/fixtures/xudt',import.meta.url)))})].map(c=>[pointKey(c.outPoint),c]));
 const client={getHeaderByNumberNoCache:async()=>({hash:deployment.genesisHash}),getCellLiveNoCache:async(p:ccc.OutPointLike)=>live.get(pointKey(p))?.clone(),
  findCellsPagedNoCache:async()=>({cells:[otherAsset,cash,tokenCell].map(c=>c.clone()),lastCursor:'0x01'})} as unknown as PoolClient;
 const intent={kind:'route' as const,pools:[a,b] as const,amountIn,minOut:1n};
 const w={lock,change:lock,deps:[dep(9)],feeRate:1000n,maxFee:10000n};
 const funded=await fundPoolTransaction(client,deployment,w,recipients,intent,{reservations:new PoolFundingReservations()});
 assert.deepEqual(funded.funding.map(c=>pointKey(c.outPoint)).sort(),[tokenCell,cash].map(c=>pointKey(c.outPoint)).sort());
 const review=reviewPoolTransaction(deployment,{...w,funding:funded.funding},recipients,intent,funded.built.transaction);
 const r=review.summary.route!;
 const hop=swap(a.accounting,'yToX',amountIn,1n).flows.receivedX,received=swap(b.accounting,'xToY',hop,1n).flows.receivedY;
 assert.deepEqual([r.paid,r.hop,r.received,r.minOut],[amountIn,hop,received,1n]);
 assert.deepEqual(r.hops.map(h=>h.poolId),[a.poolId,b.poolId]);
 assert.deepEqual(review.summary.outputs.filter(o=>o.pool).map(o=>o.index),[0,1,2,3,4,5]);
 const receipt=review.summary.outputs.find(o=>o.asset==='tokenOut'&&!o.pool)!;
 assert.equal(receipt.index,6);assert.equal(receipt.amount,received);
 await review.assertFresh(client);
 funded.release();
});
