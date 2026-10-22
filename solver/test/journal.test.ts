import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ccc} from '@ckb-ccc/core';
import {FileSubmissionJournal,type SubmissionRecord} from '../src/journal.js';
const h=(n:string)=>`0x${n.repeat(64)}` as ccc.Hex;
const scope={genesisHash:h('1'),accountLockHash:h('2')};
const tx=ccc.Transaction.from({inputs:[{previousOutput:{txHash:h('3'),index:0}}],witnesses:['0x1234']});
const row:SubmissionRecord={hash:tx.hash(),transaction:ccc.hexFrom(tx.toBytes()),orders:[`${h('3')}:0`],status:'unknown',createdAt:1};
test('durable journal restores exact bytes, scopes ownership and excludes concurrent writers',()=>{
 const dir=mkdtempSync(join(tmpdir(),'solver-journal-'));
 try{
  const journal=new FileSubmissionJournal(dir,scope);journal.put(row);
  assert.throws(()=>new FileSubmissionJournal(dir,scope),/EEXIST/);
  journal.list()[0]!.orders.push('mutated');assert.deepEqual(journal.list(),[row]);journal.close();
  assert.throws(()=>new FileSubmissionJournal(dir,{...scope,genesisHash:h('4')}),/scope mismatch/);
  const reopened=new FileSubmissionJournal(dir,scope);assert.deepEqual(reopened.list(),[row]);
  reopened.put({...row,status:'committed'});reopened.put({...row,status:'unknown'});
  assert.throws(()=>reopened.put({...row,createdAt:2}),/immutable/);reopened.close();reopened.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('journal rejects corruption and fails closed after an interrupted-write obstacle',()=>{
 const dir=mkdtempSync(join(tmpdir(),'solver-journal-'));
 try{
  const journal=new FileSubmissionJournal(dir,scope);journal.put(row);
  const saved=readFileSync(join(dir,'submissions.json'),'utf8');
  writeFileSync(join(dir,'submissions.next'),'partial');
  assert.throws(()=>journal.put({...row,status:'committed'}),/EEXIST/);
  assert.throws(()=>journal.list(),/failed/);assert.equal(readFileSync(join(dir,'submissions.json'),'utf8'),saved);journal.close();
  writeFileSync(join(dir,'submissions.json'),'{');assert.throws(()=>new FileSubmissionJournal(dir,scope));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('abrupt process exit preserves submission and requires deliberate stale-lock recovery',()=>{
 const dir=mkdtempSync(join(tmpdir(),'solver-journal-'));
 try{
  const moduleUrl=new URL('../src/journal.ts',import.meta.url).href;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',
   `import {FileSubmissionJournal} from ${JSON.stringify(moduleUrl)};const journal=new FileSubmissionJournal(${JSON.stringify(dir)},${JSON.stringify(scope)});journal.put(${JSON.stringify(row)});process.exit(17);`],{encoding:'utf8',timeout:10000});
  assert.equal(child.status,17,child.stderr);
  assert.throws(()=>new FileSubmissionJournal(dir,scope),/EEXIST/);
  // Only this test's terminated child owned this lock; production code must not
  // automatically remove locks or equate their age with transaction rejection.
  unlinkSync(join(dir,'writer.lock'));
  const restored=new FileSubmissionJournal(dir,scope);assert.deepEqual(restored.list(),[row]);restored.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
