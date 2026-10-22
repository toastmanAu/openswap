/** Durable pool submission boundary and restart reconciliation. One send per
 * persisted transaction; no automatic retry, replacement or release. */
import {ccc} from '@ckb-ccc/core';
import type {ArchivableSubmissionJournal,SubmissionRecord} from '../../solver/src/journal.js';
import {abandonConflictedSubmission,archiveCommittedSubmission} from '../../solver/src/resolution.js';
import {PoolFundingReservations,type FundedPoolTransaction} from './funding.js';
import type {PoolTransactionReview} from './review.js';
import {pointKey,readBounded,withPoolDeadline,type PoolClient,type ReadOptions} from './pools.js';

export interface PoolRecoveryClient {
 getHeaderByNumberNoCache(number:number):Promise<{hash:ccc.Hex}|undefined>;
 getTransactionNoCache(hash:ccc.Hex):Promise<{status:string;blockNumber?:ccc.Num;transaction?:ccc.Transaction}|undefined>;
 getCellLiveNoCache(point:ccc.OutPointLike):Promise<ccc.Cell|undefined>;
}
export type PoolSubmitClient=PoolClient&Pick<PoolRecoveryClient,'getTransactionNoCache'>&{
 sendTransaction(tx:ccc.Transaction):Promise<ccc.Hex>;
};
export interface PoolResolutionClient extends PoolRecoveryClient {
 getTipHeader():Promise<{number:ccc.Num}>;
}
export type PoolSubmissionOutcome=Readonly<{hash:ccc.Hex;outcome:'sent'}|{hash:ccc.Hex;outcome:'unknown';error:string}>;
function requireRecovery(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(`Pool recovery: ${message}`);}

export class PoolSubmissionRecovery {
 /** Input key -> release for reservations owned by persisted submissions. */
 private readonly held=new Map<string,()=>void>();
 private running=false;
 private reconciled=false;
 constructor(private readonly journal:ArchivableSubmissionJournal,private readonly reservations:PoolFundingReservations,private readonly scope:{genesisHash:ccc.Hex;accountLockHash:ccc.Hex}){this.scope={...scope};}
 private async exclusive<T>(options:ReadOptions,client:PoolRecoveryClient,run:(o:ReadOptions)=>Promise<T>):Promise<T>{
  requireRecovery(!this.running,'already running');this.running=true;
  try{return await withPoolDeadline(options,async o=>{
   const scope=this.journal.getScope();
   requireRecovery(scope.genesisHash===this.scope.genesisHash&&scope.accountLockHash===this.scope.accountLockHash,'scope mismatch');
   requireRecovery((await readBounded(()=>client.getHeaderByNumberNoCache(0),o))?.hash===scope.genesisHash,'network mismatch');
   return run(o);
  });}finally{this.running=false;}
 }
 private hold(row:SubmissionRecord){
  for(const input of ccc.Transaction.fromBytes(row.transaction).inputs){
   const key=pointKey(input.previousOutput);
   if(!this.held.has(key))this.held.set(key,this.reservations.claim(this.scope.genesisHash,[input.previousOutput]));
  }
 }
 /** Release only inputs no remaining active submission references. */
 private releaseUnreferenced(){
  const referenced=new Set(this.journal.list().flatMap(row=>ccc.Transaction.fromBytes(row.transaction).inputs.map(i=>pointKey(i.previousOutput))));
  for(const [key,release] of this.held)if(!referenced.has(key)){release();this.held.delete(key);}
 }
 private find(hash:ccc.Hex){const row=this.journal.list().find(row=>row.hash===hash);requireRecovery(row,'unknown submission');return row;}

 /** Required at startup before any submit or resolution. */
 async reconcile(client:PoolRecoveryClient,options:ReadOptions={}){
  return this.exclusive(options,client,async o=>{
   const records=this.journal.list();
   // Restore exclusion for ALL records before any status await. Committed records
   // remain tracked to detect a later reorg; uncertain records never imply failure.
   for(const row of records)this.hold(row);
   const reports=[];
   for(const row of records){
    const observed=await readBounded(()=>client.getTransactionNoCache(row.hash),o);
    const status=observed?.status==='committed'?'committed':observed?.status==='rejected'?'rejected':'unknown';
    if(status!==row.status)this.journal.put({...row,status});
    const tx=ccc.Transaction.fromBytes(row.transaction);let liveInputs=0;
    for(const input of tx.inputs){
     const cell=await readBounded(()=>client.getCellLiveNoCache(input.previousOutput),o);
     if(cell){requireRecovery(cell.outPoint.eq(input.previousOutput),'input response mismatch');liveInputs++;}
    }
    reports.push(Object.freeze({hash:row.hash,status,observedStatus:observed?.status??'absent',liveInputs,totalInputs:tx.inputs.length,reserved:true as const}));
   }
   this.reconciled=true;
   return Object.freeze(reports);
  });
 }

 /** Persist exact signed bytes, take over the funding reservation, then send
  * once. Journal failure prevents send. A send error or timeout is ambiguous:
  * the row stays `unknown` and reserved until explicitly resolved. */
 async submit(client:PoolSubmitClient,review:PoolTransactionReview,signed:ccc.Transaction,funded:FundedPoolTransaction,options:ReadOptions={}):Promise<PoolSubmissionOutcome>{
  requireRecovery(this.reconciled,'reconcile before submitting');
  // Once the row is persisted, any failure (including the overall deadline or an
  // abort firing mid-send) is an ambiguous outcome, never a plain error.
  let persisted:ccc.Hex|undefined;
  try{return await this.exclusive(options,client,async o=>{
   const tx=signed.clone(),hash=tx.hash();
   requireRecovery(review.summary.genesisHash===this.scope.genesisHash,'review network mismatch');
   requireRecovery(hash===review.summary.transactionHash&&hash===funded.built.transaction.hash(),'signed transaction differs from review/funding');
   review.assertIntegrity(tx);
   requireRecovery(ccc.bytesFrom(ccc.WitnessArgs.fromBytes(tx.witnesses[review.summary.walletWitnessIndex]!).lock??'0x').some(b=>b!==0),'transaction is not signed');
   requireRecovery(!this.journal.list().some(row=>row.hash===hash),'submission already recorded');
   const points=tx.inputs.map(i=>i.previousOutput);
   requireRecovery(points.every(p=>this.reservations.has(this.scope.genesisHash,p)&&!this.held.has(pointKey(p))),'inputs are not reserved by this funding');
   await review.assertFresh(client,o,tx);o.signal?.throwIfAborted();
   const transaction=ccc.hexFrom(tx.toBytes());
   // Throws before send on any persistence failure; funding stays with the caller.
   this.journal.put({hash,transaction,orders:points.map(pointKey),status:'unknown',createdAt:Date.now()});
   persisted=hash;
   // Synchronous handover: no await between releasing and re-claiming.
   funded.release();this.hold(this.find(hash));
   try{
    const sent=await readBounded(()=>client.sendTransaction(ccc.Transaction.fromBytes(transaction)),o);
    requireRecovery(sent===hash,'node returned a different transaction hash');
    return Object.freeze({hash,outcome:'sent' as const});
   }catch(error){
    return Object.freeze({hash,outcome:'unknown' as const,error:error instanceof Error?error.message:String(error)});
   }
  });}catch(error){
   if(persisted===undefined)throw error;
   return Object.freeze({hash:persisted,outcome:'unknown' as const,error:error instanceof Error?error.message:String(error)});
  }
 }

 /** Operator resolution: archive a submission committed at sufficient depth. */
 async archiveCommitted(client:PoolResolutionClient,hash:ccc.Hex,options:ReadOptions&{minConfirmations?:number}={}){
  requireRecovery(this.reconciled,'reconcile before resolving');
  return this.exclusive(options,client,async o=>{
   const {transaction:_,...result}=await archiveCommittedSubmission(this.journal,client,hash,options.minConfirmations,read=>readBounded(read,o));
   this.releaseUnreferenced();return Object.freeze(result);
  });
 }

 /** Operator resolution: abandon a never-committed submission once one of its
  * inputs is spent elsewhere. See `abandonConflictedSubmission` for reorg risk. */
 async abandonConflicted(client:PoolRecoveryClient,hash:ccc.Hex,options:ReadOptions&{acknowledgeReorgRisk?:boolean}={}){
  requireRecovery(this.reconciled,'reconcile before resolving');
  return this.exclusive(options,client,async o=>{
   const {transaction:_,...result}=await abandonConflictedSubmission(this.journal,client,hash,options.acknowledgeReorgRisk===true,read=>readBounded(read,o));
   this.releaseUnreferenced();return Object.freeze(result);
  });
 }
}
