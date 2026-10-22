import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ccc} from '@ckb-ccc/core';
import {PoolSubmissionRecovery} from '../src/recovery.js';
import {PoolFundingReservations} from '../src/funding.js';
import type {SubmissionRecord} from '../../solver/src/journal.js';
const hash=(s:string)=>`0x${s.repeat(64)}` as ccc.Hex;
test('pool restart reserves before reads, retains ambiguous outcomes and detects committed-to-absent reorg',async()=>{
 const scope={genesisHash:hash('1'),accountLockHash:hash('2')},point={txHash:hash('3'),index:0};
 const tx=ccc.Transaction.from({inputs:[{previousOutput:point}],witnesses:['0x1234']});
 let row:SubmissionRecord={hash:tx.hash(),transaction:ccc.hexFrom(tx.toBytes()),orders:[`${point.txHash}:0`],createdAt:1,status:'unknown'};
 const store={getScope:()=>({...scope}),list:()=>[structuredClone(row)],put:(value:SubmissionRecord)=>{row=structuredClone(value);}};
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
