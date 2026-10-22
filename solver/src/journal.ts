/** Node-only durable submission storage. No signer, RPC, retry or broadcast. */
import {closeSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync,writeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {ccc} from '@ckb-ccc/core';

export interface SubmissionRecord {
 hash:ccc.Hex;transaction:ccc.Hex;orders:string[];
 status:'unknown'|'committed'|'rejected';createdAt:number;
}
export interface JournalScope {genesisHash:ccc.Hex;accountLockHash:ccc.Hex}
export interface SubmissionJournal {
 getScope():JournalScope;
 list():SubmissionRecord[];
 put(value:SubmissionRecord):void;
}
export type SubmissionResolution='committed'|'abandoned';
/** Explicit operator resolution only. Callers prove the resolution first. */
export interface ArchivableSubmissionJournal extends SubmissionJournal {
 archive(hash:ccc.Hex,resolution:SubmissionResolution):void;
}
const MAX_BYTES=8*1024*1024;
function check(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(`Solver journal: ${message}`);}
function hash(value:unknown):asserts value is ccc.Hex {check(typeof value==='string'&&/^0x[0-9a-f]{64}$/.test(value),'invalid hash');}
function record(value:SubmissionRecord):SubmissionRecord {
 check(value&&typeof value==='object'&&Object.keys(value).sort().join(',')==='createdAt,hash,orders,status,transaction','invalid record shape');
 hash(value.hash);
 check(typeof value.transaction==='string'&&value.transaction.length<=1024*1024&&/^0x(?:[0-9a-f]{2})+$/.test(value.transaction),'invalid transaction bytes');
 const tx=ccc.Transaction.fromBytes(value.transaction);
 check(ccc.hexFrom(tx.toBytes())===value.transaction&&tx.hash()===value.hash,'transaction identity mismatch');
 check(['unknown','committed','rejected'].includes(value.status),'invalid status');
 check(Number.isSafeInteger(value.createdAt)&&value.createdAt>=0,'invalid timestamp');
 check(Array.isArray(value.orders)&&value.orders.length>0&&value.orders.length<=256&&new Set(value.orders).size===value.orders.length,'invalid orders');
 const inputs=new Set(tx.inputs.map(i=>`${i.previousOutput.txHash}:${i.previousOutput.index}`));
 check(value.orders.every(key=>typeof key==='string'&&inputs.has(key)),'order is not a transaction input');
 return {...value,orders:[...value.orders]};
}

/** Single process owner. A crash leaves a lock requiring deliberate operator
 * recovery; never infer that an old lock means its submissions failed. */
export class FileSubmissionJournal {
 private rows:SubmissionRecord[]=[];
 private closed=false;
 private failed=false;
 private readonly directory:string;
 private readonly lockPath:string;
 private readonly path:string;
 private readonly scope:JournalScope;
 constructor(directory:string,scope:JournalScope){
  hash(scope.genesisHash);hash(scope.accountLockHash);this.scope={...scope};
  this.directory=resolve(directory);mkdirSync(this.directory,{recursive:true,mode:0o700});
  check(lstatSync(this.directory).isDirectory()&&!lstatSync(this.directory).isSymbolicLink(),'directory must not be a symlink');
  this.path=join(this.directory,'submissions.json');this.lockPath=join(this.directory,'writer.lock');
  const lock=openSync(this.lockPath,'wx',0o600);closeSync(lock);
  try{
   let data:string|undefined;
   try{const stat=lstatSync(this.path);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=MAX_BYTES,'invalid journal file');data=readFileSync(this.path,'utf8');}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(data!==undefined){
    const parsed=JSON.parse(data);
    check(parsed?.version===1&&Object.keys(parsed).sort().join(',')==='records,scope,version','invalid format');
    check(parsed.scope?.genesisHash===this.scope.genesisHash&&parsed.scope?.accountLockHash===this.scope.accountLockHash,'scope mismatch');
    check(Array.isArray(parsed.records)&&parsed.records.length<=1000,'invalid record count');
    this.rows=parsed.records.map(record);
    check(new Set(this.rows.map(row=>row.hash)).size===this.rows.length,'duplicate transaction');
   }
  }catch(error){unlinkSync(this.lockPath);throw error;}
 }
 list():SubmissionRecord[]{this.active();return this.rows.map(record);}
 getScope():JournalScope{this.active();return {...this.scope};}
 private active(){check(!this.closed&&!this.failed,'closed or failed; reopen and reconcile before continuing');}
 put(value:SubmissionRecord):void {
  this.active();const next=record(value),prior=this.rows.find(row=>row.hash===next.hash);
  if(prior)check(prior.transaction===next.transaction&&prior.createdAt===next.createdAt&&JSON.stringify(prior.orders)===JSON.stringify(next.orders),'immutable submission changed');
  this.write([...this.rows.filter(row=>row.hash!==next.hash),next]);
 }
 /** Append the resolved record to `archive.jsonl` (fsynced) before removing it
  * from the active snapshot. A crash between both steps leaves it in both places;
  * re-archiving is safe and the active row keeps its inputs reserved meanwhile. */
 archive(hash:ccc.Hex,resolution:SubmissionResolution):void {
  this.active();check(resolution==='committed'||resolution==='abandoned','invalid resolution');
  const row=this.rows.find(row=>row.hash===hash);check(row,'unknown submission');
  const line=JSON.stringify({version:1,scope:this.scope,resolution,archivedAt:Date.now(),record:row})+'\n';
  let fd:number|undefined;
  try{
   fd=openSync(join(this.directory,'archive.jsonl'),'a',0o600);writeSync(fd,line);fsyncSync(fd);closeSync(fd);fd=undefined;
   this.syncDirectory();
  }catch(error){this.failed=true;if(fd!==undefined)closeSync(fd);throw error;}
  this.write(this.rows.filter(other=>other.hash!==hash));
 }
 private syncDirectory(){const directoryFd=openSync(this.directory,'r');try{fsyncSync(directoryFd);}finally{closeSync(directoryFd);}}
 private write(rows:SubmissionRecord[]){
  check(rows.length<=1000,'journal full; explicit archival required');
  const data=JSON.stringify({version:1,scope:this.scope,records:rows});check(new TextEncoder().encode(data).length<=MAX_BYTES,'journal size limit');
  const temporary=join(this.directory,'submissions.next');let fd:number|undefined;
  try{
   fd=openSync(temporary,'wx',0o600);writeFileSync(fd,data);fsyncSync(fd);closeSync(fd);fd=undefined;
   renameSync(temporary,this.path);this.syncDirectory();
   this.rows=rows;
  }catch(error){this.failed=true;if(fd!==undefined)closeSync(fd);throw error;}
 }
 close():void{if(this.closed)return;this.closed=true;unlinkSync(this.lockPath);}
}
