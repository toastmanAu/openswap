import {ccc} from '@ckb-ccc/core';
import type {ArchivableSubmissionJournal,JournalScope,SubmissionRecord,SubmissionResolution} from '../../../solver/src/journal.js';

/** Browser counterpart of the solver's FileSubmissionJournal, with the same record
 * validation. localStorage writes are synchronous, so a failed put throws before
 * any send. A write by another tab since this instance last read poisons it:
 * reload and reconcile rather than overwrite. Clearing site data loses the
 * journal; the node remains the authority for what was sent. */
export interface JournalStorage {getItem(key:string):string|null;setItem(key:string,value:string):void}
function check(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(`Pool journal: ${message}`);}
const isHash=(v:unknown):v is ccc.Hex=>typeof v==='string'&&/^0x[0-9a-f]{64}$/.test(v);
function record(value:SubmissionRecord):SubmissionRecord {
 check(value&&typeof value==='object'&&Object.keys(value).sort().join(',')==='createdAt,hash,orders,status,transaction','invalid record shape');
 check(isHash(value.hash),'invalid hash');
 check(typeof value.transaction==='string'&&value.transaction.length<=1024*1024&&/^0x(?:[0-9a-f]{2})+$/.test(value.transaction),'invalid transaction bytes');
 const tx=ccc.Transaction.fromBytes(value.transaction);
 check(ccc.hexFrom(tx.toBytes())===value.transaction&&tx.hash()===value.hash,'transaction identity mismatch');
 check(['unknown','committed','rejected'].includes(value.status),'invalid status');
 check(Number.isSafeInteger(value.createdAt)&&value.createdAt>=0,'invalid timestamp');
 check(Array.isArray(value.orders)&&value.orders.length>0&&value.orders.length<=256&&new Set(value.orders).size===value.orders.length,'invalid input keys');
 const inputs=new Set(tx.inputs.map(i=>`${i.previousOutput.txHash}:${i.previousOutput.index}`));
 check(value.orders.every(key=>typeof key==='string'&&inputs.has(key)),'key is not a transaction input');
 return {...value,orders:[...value.orders]};
}
export class BrowserSubmissionJournal implements ArchivableSubmissionJournal {
 private rows:SubmissionRecord[]=[];
 private revision=0;
 private failed=false;
 private readonly key:string;
 private readonly scope:JournalScope;
 constructor(private readonly storage:JournalStorage,scope:JournalScope){
  check(isHash(scope.genesisHash)&&isHash(scope.accountLockHash),'invalid scope');this.scope={...scope};
  this.key=`toastdex-pool-journal:${scope.genesisHash}:${scope.accountLockHash}`;
  const state=this.read();this.rows=state.records;this.revision=state.revision;
 }
 private read():{revision:number;records:SubmissionRecord[]} {
  const raw=this.storage.getItem(this.key);if(raw===null)return {revision:0,records:[]};
  check(raw.length<=8*1024*1024,'journal size limit');
  const parsed=JSON.parse(raw);
  check(parsed?.version===1&&Object.keys(parsed).sort().join(',')==='records,revision,scope,version','invalid format');
  check(parsed.scope?.genesisHash===this.scope.genesisHash&&parsed.scope?.accountLockHash===this.scope.accountLockHash,'scope mismatch');
  check(Number.isSafeInteger(parsed.revision)&&parsed.revision>=0&&Array.isArray(parsed.records)&&parsed.records.length<=1000,'invalid records');
  const records=parsed.records.map(record);
  check(new Set(records.map((r:SubmissionRecord)=>r.hash)).size===records.length,'duplicate transaction');
  return {revision:parsed.revision,records};
 }
 private active(){
  check(!this.failed,'failed; reload the page and reconcile before continuing');
  const current=this.read();
  if(current.revision!==this.revision){this.failed=true;check(false,'changed in another tab; reload the page and reconcile');}
 }
 private write(rows:SubmissionRecord[]){
  check(rows.length<=1000,'journal full; explicit archival required');
  try{this.storage.setItem(this.key,JSON.stringify({version:1,scope:this.scope,revision:this.revision+1,records:rows}));}
  catch(error){this.failed=true;throw error;}
  this.revision++;this.rows=rows;
 }
 getScope():JournalScope{this.active();return {...this.scope};}
 list():SubmissionRecord[]{this.active();return this.rows.map(record);}
 put(value:SubmissionRecord):void {
  this.active();const next=record(value),prior=this.rows.find(row=>row.hash===next.hash);
  if(prior)check(prior.transaction===next.transaction&&prior.createdAt===next.createdAt&&JSON.stringify(prior.orders)===JSON.stringify(next.orders),'immutable submission changed');
  this.write([...this.rows.filter(row=>row.hash!==next.hash),next]);
 }
 /** Archive entry first, then removal; a failure between them leaves the row active. */
 archive(hash:ccc.Hex,resolution:SubmissionResolution):void {
  this.active();check(resolution==='committed'||resolution==='abandoned'||resolution==='released','invalid resolution');
  const row=this.rows.find(row=>row.hash===hash);check(row,'unknown submission');
  const archiveKey=`${this.key}:archive`;
  try{
   const archived:unknown[]=JSON.parse(this.storage.getItem(archiveKey)??'[]');
   this.storage.setItem(archiveKey,JSON.stringify([...archived,{version:1,resolution,archivedAt:Date.now(),record:row}].slice(-200)));
  }catch(error){this.failed=true;throw error;}
  this.write(this.rows.filter(other=>other.hash!==hash));
 }
}
