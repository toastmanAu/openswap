/** Explicit operator resolution of journaled submissions. Read-only chain checks;
 * no signing, send or retry. Callers release reservations only after success. */
import {ccc} from '@ckb-ccc/core';
import type {ArchivableSubmissionJournal} from './journal.js';

export interface ResolutionClient {
 getTransactionNoCache(hash:ccc.Hex):Promise<{status:string;blockNumber?:ccc.Num;transaction?:ccc.Transaction}|undefined>;
 getTipHeader():Promise<{number:ccc.Num}>;
 /** Committed state only: a spend still in the transaction pool is not a conflict. */
 getCellLiveNoCache(point:ccc.OutPointLike):Promise<ccc.Cell|undefined>;
}
/** Wraps each RPC read, e.g. with a deadline. */
export type ResolutionRead=<T>(read:()=>Promise<T>)=>Promise<T>;
const IN_FLIGHT=new Set(['pending','proposed','sent']);
function requireResolution(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(`Submission resolution: ${message}`);}
function find(journal:ArchivableSubmissionJournal,hash:ccc.Hex){
 const row=journal.list().find(row=>row.hash===hash);requireResolution(row,'unknown submission');return row;
}

/** Archive a submission committed at `minConfirmations` depth or deeper. */
export async function archiveCommittedSubmission(journal:ArchivableSubmissionJournal,client:Pick<ResolutionClient,'getTransactionNoCache'|'getTipHeader'>,hash:ccc.Hex,minConfirmations=24,read:ResolutionRead=f=>f()){
 requireResolution(Number.isSafeInteger(minConfirmations)&&minConfirmations>=1&&minConfirmations<=10000,'invalid confirmation depth');
 const row=find(journal,hash);
 const observed=await read(()=>client.getTransactionNoCache(hash));
 requireResolution(observed?.status==='committed'&&observed.blockNumber!==undefined,'transaction is not committed');
 requireResolution(!observed.transaction||observed.transaction.hash()===hash,'transaction response mismatch');
 const tip=(await read(()=>client.getTipHeader())).number;
 const confirmations=ccc.numFrom(tip)-ccc.numFrom(observed.blockNumber)+1n;
 requireResolution(confirmations>=BigInt(minConfirmations),`only ${confirmations} confirmations`);
 if(row.status!=='committed')journal.put({...row,status:'committed'});
 journal.archive(hash,'committed');
 return Object.freeze({hash,resolution:'committed' as const,confirmations,transaction:row.transaction});
}

/** Abandon a never-committed submission only after at least one input has been
 * spent elsewhere, so it can no longer land unless that conflicting spend is
 * itself reorganized away. All-live inputs are refused: the signed bytes remain
 * valid and anyone holding them may still broadcast. */
export async function abandonConflictedSubmission(journal:ArchivableSubmissionJournal,client:Pick<ResolutionClient,'getTransactionNoCache'|'getCellLiveNoCache'>,hash:ccc.Hex,acknowledgeReorgRisk:boolean,read:ResolutionRead=f=>f()){
 requireResolution(acknowledgeReorgRisk===true,'abandoning requires explicit reorg-risk acknowledgement');
 const row=find(journal,hash),tx=ccc.Transaction.fromBytes(row.transaction);
 const status=async()=>{
  const observed=await read(()=>client.getTransactionNoCache(hash));
  requireResolution(observed?.status!=='committed'&&!IN_FLIGHT.has(observed?.status??''),`transaction is ${observed?.status}`);
 };
 await status();let spent=0;
 for(const input of tx.inputs){
  const cell=await read(()=>client.getCellLiveNoCache(input.previousOutput));
  if(cell)requireResolution(cell.outPoint.eq(input.previousOutput),'input response mismatch');else spent++;
 }
 requireResolution(spent>0,'all inputs are live; the signed transaction can still commit');
 // Re-check after the input reads: it must not have committed in between.
 await status();
 if(row.status==='committed')journal.put({...row,status:'unknown'});
 journal.archive(hash,'abandoned');
 return Object.freeze({hash,resolution:'abandoned' as const,spentInputs:spent,totalInputs:tx.inputs.length,transaction:row.transaction});
}
