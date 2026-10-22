/** Read-only restart reconciliation. No automatic send, replacement or release. */
import {ccc} from '@ckb-ccc/core';
import type {SubmissionJournal} from '../../solver/src/journal.js';
import {PoolFundingReservations} from './funding.js';
import {readBounded,withPoolDeadline,type ReadOptions} from './pools.js';

export interface PoolRecoveryClient {
 getHeaderByNumberNoCache(number:number):Promise<{hash:ccc.Hex}|undefined>;
 getTransactionNoCache(hash:ccc.Hex):Promise<{status:string}|undefined>;
 getCellLiveNoCache(point:ccc.OutPointLike):Promise<ccc.Cell|undefined>;
}
export class PoolSubmissionRecovery {
 private readonly held=new Set<string>();
 private running=false;
 constructor(private readonly journal:SubmissionJournal,private readonly reservations:PoolFundingReservations,private readonly scope:{genesisHash:ccc.Hex;accountLockHash:ccc.Hex}){this.scope={...scope};}
 async reconcile(client:PoolRecoveryClient,options:ReadOptions={}){
  if(this.running)throw new Error('Pool recovery already running');this.running=true;
  try{return await withPoolDeadline(options,async o=>{
   const scope=this.journal.getScope();
   if(scope.genesisHash!==this.scope.genesisHash||scope.accountLockHash!==this.scope.accountLockHash)throw new Error('Pool recovery scope mismatch');
   if((await readBounded(()=>client.getHeaderByNumberNoCache(0),o))?.hash!==scope.genesisHash)throw new Error('Pool recovery network mismatch');
   const records=this.journal.list();
   // Restore exclusion for ALL records before any status await. Committed records
   // remain tracked to detect a later reorg; uncertain records never imply failure.
   for(const row of records){
    const tx=ccc.Transaction.fromBytes(row.transaction);
    for(const input of tx.inputs){
     const key=`${input.previousOutput.txHash}:${input.previousOutput.index}`;
     if(this.held.has(key))continue;
     this.reservations.claim(scope.genesisHash,[input.previousOutput]);this.held.add(key);
    }
   }
   const reports=[];
   for(const row of records){
    const observed=await readBounded(()=>client.getTransactionNoCache(row.hash),o);
    const status=observed?.status==='committed'?'committed':observed?.status==='rejected'?'rejected':'unknown';
    if(status!==row.status)this.journal.put({...row,status});
    const tx=ccc.Transaction.fromBytes(row.transaction);let liveInputs=0;
    for(const input of tx.inputs){
     const cell=await readBounded(()=>client.getCellLiveNoCache(input.previousOutput),o);
     if(cell){if(!cell.outPoint.eq(input.previousOutput))throw new Error('Pool recovery input response mismatch');liveInputs++;}
    }
    reports.push(Object.freeze({hash:row.hash,status,observedStatus:observed?.status??'absent',liveInputs,totalInputs:tx.inputs.length,reserved:true as const}));
   }
   return Object.freeze(reports);
  });}finally{this.running=false;}
 }
}
