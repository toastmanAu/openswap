/** Local review boundary. Reconstructs the supported layout from explicit policy
 * and captured cells; does not authenticate RPC data or authorize a broadcast. */
import {ccc} from '@ckb-ccc/core';
import {parseAmount} from '../../sdk/src/codec.js';
import {buildCreate,buildTransition,type Wallet,type Recipients} from './builders.js';
import {decodeWitness,poolScript,Role} from './codec.js';
import {minimumCapacity,parsePool,withPoolDeadline,type PoolDeployment,type PoolClient,type ReadOptions} from './pools.js';
import type {PoolIntent} from './funding.js';

type Immutable<T>=T extends (...args:never[])=>unknown?T:T extends object?{readonly [K in keyof T]:Immutable<T[K]>}:T;
function freeze<T>(value:T):Immutable<T>{
 if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
 return value as Immutable<T>;
}
function requireReview(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(`Pool review: ${message}`);}

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
 const built=intent.kind==='create'?buildCreate(deployment,wallet,recipients,intent.request):buildTransition(deployment,wallet,recipients,intent.pool,intent.action);
 built.assertIntegrity(prepared);
 requireReview(ccc.hexFrom(prepared.toBytes())===ccc.hexFrom(built.transaction.toBytes()),'expected unsigned prepared bytes');
 const transaction=prepared.clone();
 const action=decodeWitness(transaction.witnesses[intent.kind==='create'?built.stateOutputIndex:0]!,intent.kind==='create');
 const inputs=[...(intent.kind==='transition'?[intent.pool.stateCell,intent.pool.ckbCell,intent.pool.tokenCell]:[]),...wallet.funding].map(c=>c.clone());
 const inputCapacity=inputs.reduce((n,c)=>n+c.cellOutput.capacity,0n);
 const outputCapacity=transaction.outputs.reduce((n,c)=>n+c.capacity,0n);
 const fee=inputCapacity-outputCapacity;
 requireReview(fee===built.fee&&fee>=0n,'capacity fee mismatch');
 const script=(s:ccc.Script)=>ccc.hexFrom(s.toBytes());
 const token=transaction.outputs[built.stateOutputIndex+2]!.type!;
 const lp=poolScript(deployment.codeHash,built.poolId,Role.LpType);
 const previous=intent.kind==='transition'?parsePool(deployment,intent.pool.stateCell,intent.pool.ckbCell,intent.pool.tokenCell).accounting:undefined;
 const summary=freeze({
  createdAt,expiresAt:createdAt+ttlMs,genesisHash:deployment.genesisHash,
  transactionHash:transaction.hash(),poolId:built.poolId,
  owner:script(ccc.Script.from(wallet.lock)),change:script(ccc.Script.from(wallet.change)),
  token:script(token),lp:script(lp),
  recipients:{ckb:script(ccc.Script.from(recipients.ckb)),token:script(ccc.Script.from(recipients.token)),lp:script(ccc.Script.from(recipients.lp))},
  action,flows:{...built.result.flows},previous,next:{...built.result.next,backing:{...built.result.next.backing}},
  fee,feeRate:wallet.feeRate,maxFee:wallet.maxFee,ckbReceiptTopUp:built.ckbReceiptTopUp,
  // All wallet receipts/change and permanent pool storage remain individually visible.
  outputs:transaction.outputs.map((output,index)=>({index,capacity:output.capacity,
   occupiedCapacity:minimumCapacity(ccc.CellAny.from({cellOutput:output,outputData:transaction.outputsData[index]!})),
   lock:script(output.lock),type:output.type?script(output.type):undefined,data:transaction.outputsData[index]!,
   asset:output.type?.eq(token)?'token':output.type?.eq(lp)?'lp':output.type?'state':'ckb',
   amount:output.type?.eq(token)||output.type?.eq(lp)?parseAmount(transaction.outputsData[index]!):undefined,
   pool:index>=built.stateOutputIndex&&index<=built.stateOutputIndex+2})),
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
