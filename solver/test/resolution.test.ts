import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ccc} from '@ckb-ccc/core';
import {FileSubmissionJournal,type SubmissionRecord} from '../src/journal.js';
import {abandonConflictedSubmission,archiveCommittedSubmission} from '../src/resolution.js';
import {ReferenceSolver} from '../src/runner.js';
import {setup,a,b,owner} from '../../sdk/test/fixture.js';
import {udt} from '../../sdk/src/index.js';

const h=(s:string)=>`0x${s.repeat(64)}` as ccc.Hex;
const scope={genesisHash:h('1'),accountLockHash:h('2')};
function row(){
 const tx=ccc.Transaction.from({inputs:[{previousOutput:{txHash:h('3'),index:0}},{previousOutput:{txHash:h('4'),index:1}}],witnesses:['0x1234']});
 return {hash:tx.hash(),transaction:ccc.hexFrom(tx.toBytes()),orders:[`${h('3')}:0`],status:'unknown',createdAt:1} as SubmissionRecord;
}
function chain(){
 const state={status:undefined as string|undefined,blockNumber:undefined as bigint|undefined,tip:0n,dead:new Set<string>()};
 return {state,client:{
  getTransactionNoCache:async()=>state.status?{status:state.status,blockNumber:state.blockNumber}:undefined,
  getTipHeader:async()=>({number:state.tip}),
  getCellLiveNoCache:async(p:ccc.OutPointLike)=>{const x=ccc.OutPoint.from(p);return state.dead.has(`${x.txHash}:${x.index}`)?undefined:ccc.Cell.from({outPoint:x,cellOutput:{capacity:0n,lock:{codeHash:h('5'),hashType:'type',args:'0x'}},outputData:'0x'});},
 }};
}
function withJournal(run:(journal:FileSubmissionJournal,directory:string)=>Promise<void>){
 return async()=>{
  const directory=mkdtempSync(join(tmpdir(),'solver-resolution-')),journal=new FileSubmissionJournal(directory,scope);
  try{await run(journal,directory);}finally{journal.close();rmSync(directory,{recursive:true,force:true});}
 };
}
const archived=(directory:string)=>readFileSync(join(directory,'archive.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));

test('committed submissions archive only at confirmation depth and survive reopen',withJournal(async(journal,directory)=>{
 const r=row(),{state,client}=chain();journal.put(r);
 await assert.rejects(archiveCommittedSubmission(journal,client,r.hash),/not committed/);
 state.status='committed';state.blockNumber=10n;state.tip=20n;
 await assert.rejects(archiveCommittedSubmission(journal,client,r.hash),/only 11 confirmations/);
 await assert.rejects(archiveCommittedSubmission(journal,client,r.hash,0),/invalid confirmation depth/);
 await assert.rejects(archiveCommittedSubmission(journal,client,h('9')),/unknown submission/);
 assert.equal((await archiveCommittedSubmission(journal,client,r.hash,11)).confirmations,11n);
 assert.deepEqual(journal.list(),[]);
 const [line]=archived(directory);assert.equal(line.resolution,'committed');assert.equal(line.record.status,'committed');assert.equal(line.record.transaction,r.transaction);
 journal.close();const reopened=new FileSubmissionJournal(directory,scope);
 try{assert.deepEqual(reopened.list(),[]);}finally{reopened.close();}
}));

test('abandoning needs acknowledgement, a spent input and a non-committed, non-in-flight status',withJournal(async(journal,directory)=>{
 const r=row(),{state,client}=chain();journal.put(r);
 await assert.rejects(abandonConflictedSubmission(journal,client,r.hash,false),/acknowledgement/);
 await assert.rejects(abandonConflictedSubmission(journal,client,r.hash,true),/all inputs are live/);
 state.dead.add(`${h('4')}:1`);
 for(const status of ['pending','proposed','sent','committed']){
  state.status=status;await assert.rejects(abandonConflictedSubmission(journal,client,r.hash,true),new RegExp(`transaction is ${status}`));
 }
 state.status='rejected';const read=client.getCellLiveNoCache;
 client.getCellLiveNoCache=async p=>{state.status='committed';return read(p);};
 await assert.rejects(abandonConflictedSubmission(journal,client,r.hash,true),/transaction is committed/);
 client.getCellLiveNoCache=read;assert.equal(journal.list().length,1);
 state.status=undefined;
 const result=await abandonConflictedSubmission(journal,client,r.hash,true);
 assert.equal(result.spentInputs,1);assert.equal(result.totalInputs,2);assert.deepEqual(journal.list(),[]);
 assert.equal(archived(directory)[0].resolution,'abandoned');
}));

test('operator resolution lets a restarted solver use previously reserved orders again',async()=>{
 const f=setup();f.fund();Object.assign(f.client,{cache:new ccc.ClientCacheMemory()});
 const left=f.order(udt(a),udt(b)),right=f.order(udt(b),udt(a));
 f.client.findCells=async function*(){yield left;yield right;};
 const solverScope={genesisHash:f.context.deployment.genesisHash,accountLockHash:owner.hash()};
 const directory=mkdtempSync(join(tmpdir(),'solver-resolution-runner-'));
 let journal=new FileSubmissionJournal(directory,solverScope),sends=0;
 try{
  f.client.sendTransaction=async()=>{sends++;throw new Error('reply lost');};
  await assert.rejects(new ReferenceSolver(f.context,undefined,{journal}).tick(true),/reply lost/);
  const [stuck]=journal.list();assert.ok(stuck);
  f.client.getTransactionNoCache=async()=>undefined;
  assert.equal(await new ReferenceSolver(f.context,undefined,{journal}).tick(true),undefined,'orders stay reserved');
  // Operator stops the solver, observes a conflicting spend of one input and abandons.
  journal.close();journal=new FileSubmissionJournal(directory,solverScope);
  const spent=ccc.Transaction.fromBytes(stuck.transaction).inputs[0]!.previousOutput;
  const client={getTransactionNoCache:async()=>undefined,getCellLiveNoCache:async(p:ccc.OutPointLike)=>spent.eq(p)?undefined:ccc.Cell.from({outPoint:p,cellOutput:{capacity:0n,lock:owner},outputData:'0x'})};
  await abandonConflictedSubmission(journal,client,stuck.hash,true);
  journal.close();journal=new FileSubmissionJournal(directory,solverScope);
  f.client.sendTransaction=async tx=>{sends++;return ccc.Transaction.from(tx).hash();};
  assert.ok(await new ReferenceSolver(f.context,undefined,{journal}).tick(true),'restarted solver rebuilds');
  assert.equal(sends,2);assert.equal(journal.list().length,1);
 }finally{journal.close();rmSync(directory,{recursive:true,force:true});}
});

test('operator CLI lists offline and refuses a journal held by a running solver',()=>{
 const directory=mkdtempSync(join(tmpdir(),'solver-journal-cli-'));
 const cli=(...args:string[])=>spawnSync(process.execPath,['--import','tsx',new URL('../../scripts/solver-journal.ts',import.meta.url).pathname,...args,`--journal-dir=${directory}`],{encoding:'utf8',timeout:30000});
 try{
  const listed=cli('list');assert.equal(listed.status,0,listed.stderr);assert.match(listed.stderr,/0 active submissions/);
  assert.notEqual(cli('archive-committed','0x12').status,0);
  assert.match(cli('bogus').stderr,/Usage/);
  assert.match(cli('list','--force').stderr,/Unknown option/);
  const held=new FileSubmissionJournal(directory,readScope());
  try{const locked=cli('list');assert.notEqual(locked.status,0);assert.match(locked.stderr,/locked: stop the solver/);}finally{held.close();}
 }finally{rmSync(directory,{recursive:true,force:true});}
});
function readScope(){
 const deployment=JSON.parse(readFileSync(new URL('../../deployments/testnet.json',import.meta.url),'utf8'));
 const wallet=JSON.parse(readFileSync(new URL('../../deployments/solver-wallet.json',import.meta.url),'utf8'));
 return {genesisHash:deployment.genesisHash,accountLockHash:ccc.Script.from(wallet.lock).hash()};
}
