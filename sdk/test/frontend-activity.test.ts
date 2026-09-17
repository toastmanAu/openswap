import {test} from 'node:test';import assert from 'node:assert/strict';import {ccc} from '@ckb-ccc/core';
import {readActivity,mergeActivity,accountKey,fetchActivity,type Activity} from '../../frontend/src/activity.js';
const hex=(n:string)=>`0x${n.repeat(32)}` as ccc.Hex;
const lock=ccc.Script.from({codeHash:hex('11'),hashType:'type',args:'0x'}),other=ccc.Script.from({codeHash:hex('22'),hashType:'type',args:'0x'});
const row:Activity={hash:hex('33'),account:accountKey([lock]),network:hex('44'),summary:'Swap',status:'submitted',createdAt:1};
test('activity storage rejects malformed records and bounds retained history',()=>{
 assert.deepEqual(readActivity('{'),[]);assert.deepEqual(readActivity(JSON.stringify([{...row,hash:'javascript:alert(1)'}])),[]);
 assert.equal(readActivity(JSON.stringify(Array(250).fill(row))).length,200);
 assert.equal(mergeActivity([row],{...row,status:'committed'}).length,1);assert.equal(accountKey([lock,other,lock]),accountKey([other,lock]));
});
test('activity isolates accounts/networks, deduplicates chain history and does not call unknown failed',async()=>{
 let queries=0,statusChecks=0;const client={findTransactionsPaged:async()=>{queries++;return{transactions:[{txHash:row.hash,blockNumber:10n}],lastCursor:'0x'};},getTransactionNoCache:async()=>{statusChecks++;return undefined;}} as unknown as ccc.Client;
 const result=await fetchActivity(client,[lock],row.network,[row,{...row,hash:hex('55'),account:accountKey([other])},{...row,hash:hex('66'),network:hex('77')}]);
 assert.equal(queries,1);assert.equal(statusChecks,1);assert.equal(result.length,1);assert.equal(result[0]!.status,'unknown');
});

test('null-response decoding and node outages leave a submission unknown',async()=>{
 const client={findTransactionsPaged:async()=>({transactions:[],lastCursor:'0x'}),getTransactionNoCache:async()=>{throw new TypeError('Cannot destructure null');}} as unknown as ccc.Client;
 const result=await fetchActivity(client,[lock],row.network,[row]);assert.equal(result[0]!.status,'unknown');assert.equal(result[0]!.hash,row.hash);
});
