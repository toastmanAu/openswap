import {test} from 'node:test';import assert from 'node:assert/strict';import {ccc} from '@ckb-ccc/core';
import {recoverConflictedTransaction} from '../src/recovery.js';import {setup,owner} from '../../sdk/test/fixture.js';
test('losing transaction drops phantom change and restores live funding only',async()=>{
 const f=setup(),fund=f.fund(),spent=f.fund();const cache=new ccc.ClientCacheMemory();Object.assign(f.client,{cache});
 const tx=ccc.Transaction.from({inputs:[fund,spent]});tx.addOutput({lock:owner,capacity:10000000000n},'0x');await cache.markTransactions(tx);
 assert.equal(await cache.isUnusable(fund.outPoint),true);
 f.cells.splice(f.cells.indexOf(spent),1);
 await recoverConflictedTransaction(f.client,tx);
 assert.equal(await cache.isUnusable(fund.outPoint),false);assert.equal(await cache.isUnusable(spent.outPoint),true);
 assert.equal(await cache.isUnusable({txHash:tx.hash(),index:0}),true);
 const candidates=[];for await(const cell of cache.findCells({script:owner,scriptType:'lock',scriptSearchMode:'exact'}))candidates.push(cell);
 assert.equal(candidates.length,1);assert(candidates[0]!.outPoint.eq(fund.outPoint));
});
