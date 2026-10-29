/** Local review boundary. Reconstructs the supported layout from explicit policy
 * and captured cells; does not authenticate RPC data or authorize a broadcast. */
import {ccc} from '@ckb-ccc/core';
import {parseAmount} from '../../sdk/src/codec.js';
import type {BuiltPoolTransaction,Wallet,Recipients} from './builders.js';
import {decodeWitness,poolScript,Role} from './codec.js';
import {minimumCapacity,parsePool,withPoolDeadline,type PoolDeployment,type PoolClient,type ReadOptions} from './pools.js';
import {buildIntent,type PoolIntent} from './funding.js';

type Immutable<T>=T extends (...args:never[])=>unknown?T:T extends object?{readonly [K in keyof T]:Immutable<T[K]>}:T;
function freeze<T>(value:T):Immutable<T>{
 if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
 return value as Immutable<T>;
}
function requireReview(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(`Pool review: ${message}`);}
/** What the user pays and receives across the pool leg and every order lot. */
function totals(flows:BuiltPoolTransaction['result']['flows'],orders:BuiltPoolTransaction['orders']){
 const sum=(asset:'ckb'|'token',side:'offer'|'ask')=>orders.reduce((n,o)=>n+(o[side]===asset?(side==='offer'?o.offerAmount:o.askAmount):0n),0n);
 return {paidX:flows.paidX+sum('ckb','ask'),paidY:flows.paidY+sum('token','ask'),receivedX:flows.receivedX+sum('ckb','offer'),receivedY:flows.receivedY+sum('token','offer')};
}

/** Call after checked wallet preparation. Wallet funding and intent cells must
 * be the independently captured selection, not caches copied out of the candidate.
 * A review is local policy evidence, not a signature or a chain reservation. */
export function reviewPoolTransaction(
 deployment:PoolDeployment,wallet:Wallet,recipients:Recipients,intent:PoolIntent,
 prepared:ccc.Transaction,ttlMs=120000,
){
 requireReview(Number.isSafeInteger(ttlMs)&&ttlMs>=1&&ttlMs<=300000,'expiry must be 1..300000 ms');
 const createdAt=Date.now(),started=performance.now();
 // No awaits: builders capture independent input snapshots and raw/witness bytes.
 // Rebuilding also checks requested minima, recipients, change and fee policy.
 const built=buildIntent(deployment,wallet,recipients,intent);
 built.assertIntegrity(prepared);
 requireReview(ccc.hexFrom(prepared.toBytes())===ccc.hexFrom(built.transaction.toBytes()),'expected unsigned prepared bytes');
 const transaction=prepared.clone();
 const action=decodeWitness(transaction.witnesses[built.actionWitnessIndex]!,intent.kind==='create');
 const lots=intent.kind==='transition'?intent.orders?.cells??[]:[];
 const pools=intent.kind==='transition'?[intent.pool]:intent.kind==='route'?[...intent.pools]:[];
 const inputs=[...lots,...pools.flatMap(p=>[p.stateCell,p.ckbCell,p.tokenCell]),...wallet.funding].map(c=>c.clone());
 const inputCapacity=inputs.reduce((n,c)=>n+c.cellOutput.capacity,0n);
 const outputCapacity=transaction.outputs.reduce((n,c)=>n+c.capacity,0n);
 const fee=inputCapacity-outputCapacity;
 requireReview(fee===built.fee&&fee>=0n,'capacity fee mismatch');
 const script=(s:ccc.Script)=>ccc.hexFrom(s.toBytes());
 const token=transaction.outputs[built.stateOutputIndex+2]!.type!;
 const lp=poolScript(deployment.codeHash,built.poolId,Role.LpType);
 const previous=pools[0]?parsePool(deployment,pools[0].stateCell,pools[0].ckbCell,pools[0].tokenCell).accounting:undefined;
 // Route: the token received is the second pool's; both pools' cells are pool outputs.
 const hops=built.hops??[],tokenOut=hops[1]?.token,poolOutputs=hops.length?hops.length*3:3;
 const route=hops.length?{
  hops:hops.map(h=>({poolId:h.poolId,token:script(h.token),action:{...h.action},previous:{...h.previous,backing:{...h.previous.backing}},next:{...h.result.next,backing:{...h.result.next.backing}},flows:{...h.result.flows},stateOutputIndex:h.stateOutputIndex})),
  tokenIn:script(hops[0]!.token),tokenOut:script(tokenOut!),
  paid:hops[0]!.result.flows.paidY,hop:hops[0]!.result.flows.receivedX,received:hops[1]!.result.flows.receivedY,minOut:hops[1]!.action.minOut,
 }:undefined;
 const summary=freeze({
  createdAt,expiresAt:createdAt+ttlMs,genesisHash:deployment.genesisHash,
  transactionHash:transaction.hash(),poolId:built.poolId,
  owner:script(ccc.Script.from(wallet.lock)),change:script(ccc.Script.from(wallet.change)),
  token:script(token),lp:script(lp),
  recipients:{ckb:script(ccc.Script.from(recipients.ckb)),token:script(ccc.Script.from(recipients.token)),lp:script(ccc.Script.from(recipients.lp))},
  action,flows:{...built.result.flows},previous,
  // Split route: each lot's maker payment is the output at its own input index.
  orders:built.orders.map(o=>({...o,outPoint:{txHash:o.outPoint.txHash,index:o.outPoint.index},owner:script(o.owner)})),
  total:totals(built.result.flows,built.orders),orderDependency:built.orderDep?{txHash:built.orderDep.outPoint.txHash,index:built.orderDep.outPoint.index,depType:built.orderDep.depType}:undefined,next:{...built.result.next,backing:{...built.result.next.backing}},
  route,
  fee,feeRate:wallet.feeRate,maxFee:wallet.maxFee,ckbReceiptTopUp:built.ckbReceiptTopUp,
  // All wallet receipts/change and permanent pool storage remain individually visible.
  outputs:transaction.outputs.map((output,index)=>({index,capacity:output.capacity,
   occupiedCapacity:minimumCapacity(ccc.CellAny.from({cellOutput:output,outputData:transaction.outputsData[index]!})),
   lock:script(output.lock),type:output.type?script(output.type):undefined,data:transaction.outputsData[index]!,
   asset:output.type?.eq(token)?'token':tokenOut&&output.type?.eq(tokenOut)?'tokenOut':output.type?.eq(lp)?'lp':output.type?'state':'ckb',
   amount:output.type?.eq(token)||output.type?.eq(lp)||(tokenOut&&output.type?.eq(tokenOut))?parseAmount(transaction.outputsData[index]!):undefined,
   pool:index>=built.stateOutputIndex&&index<built.stateOutputIndex+poolOutputs,maker:index<built.orders.length})),
  inputs:inputs.map(c=>({txHash:c.outPoint.txHash,index:c.outPoint.index,capacity:c.cellOutput.capacity,lock:script(c.cellOutput.lock),type:c.cellOutput.type?script(c.cellOutput.type):undefined,data:c.outputData})),
  dependencies:transaction.cellDeps.map(d=>({txHash:d.outPoint.txHash,index:d.outPoint.index,depType:d.depType})),
  walletWitnessIndex:built.walletWitnessIndex,stateOutputIndex:built.stateOutputIndex,
 });
 const assertActive=()=>requireReview(performance.now()-started<ttlMs&&Date.now()<createdAt+ttlMs,'expired');
 const assertIntegrity=(candidate:ccc.Transaction)=>{assertActive();built.assertIntegrity(candidate);};
 return Object.freeze({summary,
  transaction:()=>{assertActive();return transaction.clone();},
  assertIntegrity,
  assertFresh:async(client:PoolClient,options:ReadOptions={},candidate:ccc.Transaction=transaction)=>{
   assertIntegrity(candidate);
   await withPoolDeadline(options,o=>built.assertFresh(client,o,candidate));
   assertIntegrity(candidate);
  },
 });
}
export type PoolTransactionReview=ReturnType<typeof reviewPoolTransaction>;
