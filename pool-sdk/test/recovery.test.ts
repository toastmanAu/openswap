import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ccc} from '@ckb-ccc/core';
import {PoolSubmissionRecovery,type PoolSubmitClient} from '../src/recovery.js';
import {PoolFundingReservations} from '../src/funding.js';
import {pointKey} from '../src/pools.js';
import {reviewPoolTransaction} from '../src/review.js';
import {FileSubmissionJournal,type SubmissionRecord} from '../../solver/src/journal.js';
import {hash as fixtureHash,request,fixture} from './funding-fixture.js';
const hash=(s:string)=>`0x${s.repeat(64)}` as ccc.Hex;
test('pool restart reserves before reads, retains ambiguous outcomes and detects committed-to-absent reorg',async()=>{
 const scope={genesisHash:hash('1'),accountLockHash:hash('2')},point={txHash:hash('3'),index:0};
 const tx=ccc.Transaction.from({inputs:[{previousOutput:point}],witnesses:['0x1234']});
 let row:SubmissionRecord={hash:tx.hash(),transaction:ccc.hexFrom(tx.toBytes()),orders:[`${point.txHash}:0`],createdAt:1,status:'unknown'};
 const store={getScope:()=>({...scope}),list:()=>[structuredClone(row)],put:(value:SubmissionRecord)=>{row=structuredClone(value);},archive:()=>assert.fail('no archival')};
 const reservations=new PoolFundingReservations(),recovery=new PoolSubmissionRecovery(store,reservations,scope);
 let status:string|undefined,fail=false;
 const client={getHeaderByNumberNoCache:async()=>({hash:scope.genesisHash}),getTransactionNoCache:async()=>{assert.ok(reservations.has(scope.genesisHash,point));if(fail)throw new Error('offline');return status?{status}:undefined;},getCellLiveNoCache:async()=>undefined};
 for(const observed of [undefined,'pending','committed',undefined,'rejected']){
  status=observed;const reports=await recovery.reconcile(client);
  assert.equal(reports[0]!.status,observed==='committed'?'committed':observed==='rejected'?'rejected':'unknown');
  assert.ok(reservations.has(scope.genesisHash,point));
 }
 fail=true;await assert.rejects(recovery.reconcile(client),/offline/);assert.ok(reservations.has(scope.genesisHash,point));
 fail=false;await recovery.reconcile(client);
});

/** Funded, reviewed and mock-signed create plus a file journal and chain mock. */
async function setup(){
 const f=fixture(),funded=await f.run();
 const review=reviewPoolTransaction(f.deployment,{...f.wallet,funding:funded.funding},{ckb:f.lock,token:f.lock,lp:f.lock},{kind:'create',request},funded.built.transaction);
 const signed=review.transaction(),index=review.summary.walletWitnessIndex,args=ccc.WitnessArgs.fromBytes(signed.witnesses[index]!);
 args.lock=ccc.hexFrom(new Uint8Array(65).fill(7));signed.witnesses[index]=ccc.hexFrom(args.toBytes());
 const scope={genesisHash:f.deployment.genesisHash,accountLockHash:f.lock.hash()};
 const directory=mkdtempSync(join(tmpdir(),'pool-recovery-'));
 const journal=new FileSubmissionJournal(directory,scope);
 const recovery=new PoolSubmissionRecovery(journal,f.reservations,scope);
 const chain={status:undefined as string|undefined,blockNumber:undefined as bigint|undefined,tip:0n,sent:[] as ccc.Hex[],send:async(tx:ccc.Transaction):Promise<ccc.Hex>=>tx.hash()};
 const client={...(f.client as object),
  getTransactionNoCache:async()=>chain.status?{status:chain.status,blockNumber:chain.blockNumber}:undefined,
  getTipHeader:async()=>({number:chain.tip}),
  sendTransaction:async(tx:ccc.Transaction)=>{chain.sent.push(ccc.hexFrom(tx.toBytes()));return chain.send(tx);},
 } as unknown as PoolSubmitClient&{getTipHeader():Promise<{number:ccc.Num}>};
 const inputs=signed.inputs.map(i=>i.previousOutput);
 const reserved=()=>inputs.every(p=>f.reservations.has(scope.genesisHash,p));
 return {f,funded,review,signed,scope,directory,journal,recovery,chain,client,inputs,reserved,cleanup:()=>{journal.close();rmSync(directory,{recursive:true,force:true});}};
}

test('submit persists exact signed bytes before one send and takes over the funding reservation',async()=>{
 const s=await setup();
 try{
  await assert.rejects(s.recovery.submit(s.client,s.review,s.signed,s.funded),/reconcile before submitting/);
  await s.recovery.reconcile(s.client);
  const bytes=ccc.hexFrom(s.signed.toBytes());
  s.chain.send=async tx=>{
   // Pre-send boundary: the durable row already holds the exact bytes.
   const rows=JSON.parse(readFileSync(join(s.directory,'submissions.json'),'utf8')).records;
   assert.equal(rows.length,1);assert.equal(rows[0].transaction,bytes);assert.equal(rows[0].status,'unknown');
   return tx.hash();
  };
  const outcome=await s.recovery.submit(s.client,s.review,s.signed,s.funded);
  assert.deepEqual(outcome,{hash:s.signed.hash(),outcome:'sent'});
  assert.deepEqual(s.chain.sent,[bytes]);
  // The caller's stale release handle cannot clear the recovery-owned claim.
  s.funded.release();assert.ok(s.reserved());
  await assert.rejects(s.f.run(),/not enough token/); // reserved asset is skipped
  await assert.rejects(s.recovery.submit(s.client,s.review,s.signed,s.funded),/already recorded|not reserved/);
  assert.equal(s.chain.sent.length,1);
 }finally{s.cleanup();}
});

test('journal failure prevents send and leaves funding with the caller',async()=>{
 const s=await setup();
 try{
  await s.recovery.reconcile(s.client);
  const put=s.journal.put.bind(s.journal);
  s.journal.put=()=>{throw new Error('disk full');};
  await assert.rejects(s.recovery.submit(s.client,s.review,s.signed,s.funded),/disk full/);
  assert.equal(s.chain.sent.length,0);assert.ok(s.reserved());
  s.funded.release();assert.ok(!s.reserved());
  s.journal.put=put;
 }finally{s.cleanup();}
});

test('submit refuses unsigned, mutated, unreserved, expired or stale transactions without persisting',async()=>{
 const s=await setup();
 try{
  await s.recovery.reconcile(s.client);
  const unsigned=s.review.transaction();
  await assert.rejects(s.recovery.submit(s.client,s.review,unsigned,s.funded),/not signed/);
  const mutated=s.signed.clone();mutated.outputs[0]!.capacity+=1n;
  await assert.rejects(s.recovery.submit(s.client,s.review,mutated,s.funded),/differs/);
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(s.recovery.submit(s.client,s.review,s.signed,s.funded,{signal:aborted.signal}));
  const spent=s.f.cells.get(pointKey(s.f.asset.outPoint))!;s.f.cells.delete(pointKey(s.f.asset.outPoint));
  await assert.rejects(s.recovery.submit(s.client,s.review,s.signed,s.funded));
  s.f.cells.set(pointKey(spent.outPoint),spent);
  const expiring=reviewPoolTransaction(s.f.deployment,{...s.f.wallet,funding:s.funded.funding},{ckb:s.f.lock,token:s.f.lock,lp:s.f.lock},{kind:'create',request},s.funded.built.transaction,1);
  await new Promise(resolve=>setTimeout(resolve,5));
  await assert.rejects(s.recovery.submit(s.client,expiring,s.signed,s.funded),/expired/);
  s.funded.release();
  await assert.rejects(s.recovery.submit(s.client,s.review,s.signed,s.funded),/not reserved/);
  assert.equal(s.journal.list().length,0);assert.equal(s.chain.sent.length,0);
 }finally{s.cleanup();}
});

test('a deadline firing mid-send is an unknown outcome, not a thrown error',async()=>{
 const s=await setup();
 try{
  await s.recovery.reconcile(s.client);
  s.chain.send=()=>new Promise(()=>{});// the node never answers
  const outcome=await s.recovery.submit(s.client,s.review,s.signed,s.funded,{timeoutMs:50});
  assert.equal(outcome.outcome,'unknown');assert.match((outcome as {error:string}).error,/deadline exceeded/);
  assert.equal(outcome.hash,s.signed.hash());assert.equal(s.chain.sent.length,1);
  assert.equal(s.journal.list()[0]!.status,'unknown');assert.ok(s.reserved());
 }finally{s.cleanup();}
});

test('ambiguous send stays unknown and reserved across restart without retry',async()=>{
 const s=await setup();
 try{
  await s.recovery.reconcile(s.client);
  s.chain.send=async()=>{throw new Error('socket hang up');};
  const outcome=await s.recovery.submit(s.client,s.review,s.signed,s.funded);
  assert.equal(outcome.outcome,'unknown');assert.match((outcome as {error:string}).error,/socket hang up/);
  assert.equal(s.journal.list()[0]!.status,'unknown');assert.ok(s.reserved());
  // Restart: a fresh process reloads the row and reserves before any status read.
  s.journal.close();
  const journal=new FileSubmissionJournal(s.directory,s.scope),reservations=new PoolFundingReservations();
  const recovery=new PoolSubmissionRecovery(journal,reservations,s.scope);
  try{
   const reports=await recovery.reconcile(s.client);
   assert.equal(reports.length,1);assert.equal(reports[0]!.status,'unknown');
   assert.ok(s.inputs.every(p=>reservations.has(s.scope.genesisHash,p)));
   await assert.rejects(recovery.abandonConflicted(s.client,s.signed.hash(),{acknowledgeReorgRisk:true}),/all inputs are live/);
   assert.equal(s.chain.sent.length,1);
  }finally{journal.close();}
 }finally{rmSync(s.directory,{recursive:true,force:true});}
});

test('committed submissions archive only at explicit confirmation depth',async()=>{
 const s=await setup();
 try{
  await s.recovery.reconcile(s.client);
  await s.recovery.submit(s.client,s.review,s.signed,s.funded);
  const txHash=s.signed.hash();
  await assert.rejects(s.recovery.archiveCommitted(s.client,txHash),/not committed/);
  s.chain.status='committed';s.chain.blockNumber=100n;s.chain.tip=110n;
  await assert.rejects(s.recovery.archiveCommitted(s.client,txHash),/only 11 confirmations/);
  await assert.rejects(s.recovery.archiveCommitted(s.client,txHash,{minConfirmations:0}),/invalid confirmation depth/);
  await assert.rejects(s.recovery.archiveCommitted(s.client,fixtureHash(77)),/unknown submission/);
  assert.ok(s.reserved());
  s.chain.tip=123n;
  const result=await s.recovery.archiveCommitted(s.client,txHash);
  assert.equal(result.confirmations,24n);
  assert.equal(s.journal.list().length,0);assert.ok(!s.reserved());
  const archived=readFileSync(join(s.directory,'archive.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(archived.length,1);assert.equal(archived[0].resolution,'committed');
  assert.equal(archived[0].record.transaction,ccc.hexFrom(s.signed.toBytes()));assert.equal(archived[0].record.status,'committed');
 }finally{s.cleanup();}
});

test('abandoning requires acknowledgement, a spent input and no in-flight or committed status',async()=>{
 const s=await setup();
 try{
  await s.recovery.reconcile(s.client);
  await s.recovery.submit(s.client,s.review,s.signed,s.funded);
  const txHash=s.signed.hash();
  await assert.rejects(s.recovery.abandonConflicted(s.client,txHash),/acknowledgement/);
  await assert.rejects(s.recovery.abandonConflicted(s.client,txHash,{acknowledgeReorgRisk:true}),/all inputs are live/);
  // A conflicting spend consumes one funding input.
  const point=pointKey(s.f.asset.outPoint),spent=s.f.cells.get(point)!;s.f.cells.delete(point);
  for(const status of ['pending','proposed','committed']){
   s.chain.status=status;
   await assert.rejects(s.recovery.abandonConflicted(s.client,txHash,{acknowledgeReorgRisk:true}),new RegExp(`transaction is ${status}`));
  }
  // Commits between the input reads and the final status check.
  s.chain.status='rejected';const read=s.client.getCellLiveNoCache;
  s.client.getCellLiveNoCache=async p=>{s.chain.status='committed';return read(p);};
  await assert.rejects(s.recovery.abandonConflicted(s.client,txHash,{acknowledgeReorgRisk:true}),/transaction is committed/);
  s.client.getCellLiveNoCache=read;assert.ok(s.reserved());assert.equal(s.journal.list().length,1);
  s.chain.status=undefined;
  const result=await s.recovery.abandonConflicted(s.client,txHash,{acknowledgeReorgRisk:true});
  assert.equal(result.spentInputs,1);assert.equal(s.journal.list().length,0);assert.ok(!s.reserved());
  const archived=JSON.parse(readFileSync(join(s.directory,'archive.jsonl'),'utf8'));
  assert.equal(archived.resolution,'abandoned');assert.equal(archived.record.hash,txHash);
  s.f.cells.set(point,spent);
 }finally{s.cleanup();}
});
