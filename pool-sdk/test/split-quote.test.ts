import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quoteSplit} from '../src/split.js';
import {createPool,swapExactOut} from '../../pool-model/src/model.js';

const pool=createPool({feeBps:30n,lockedShares:1000n,backing:{state:34_000_000_000n,ckb:8_000_000_000n,token:16_000_000_000n}},10n**12n,4n*10n**12n,1n).next;
const exact=(out:bigint)=>swapExactOut(pool,'xToY',out).flows.paidX;
test('split quotes take cheap lots and fill the rest from the pool, never worse than the pool alone',()=>{
 // Pool: 1 CKB ≈ 4 tokens. Lots offer tokens for CKB; two beat the pool, one does not.
 const lots=[{id:'dear',offerAmount:100n*10n**8n,askAmount:30n*10n**8n},{id:'cheap',offerAmount:100n*10n**8n,askAmount:20n*10n**8n},{id:'mid',offerAmount:200n*10n**8n,askAmount:45n*10n**8n}];
 const want=1000n*10n**8n,q=quoteSplit(lots,pool,'xToY',want,10n**30n)!;
 assert.deepEqual(q.lots.map(l=>l.id),['cheap','mid']);
 assert.equal(q.lotIn,65n*10n**8n);assert.equal(q.poolIn,exact(want-300n*10n**8n));
 assert.ok(q.amountOut>=want&&q.amountIn===q.lotIn+q.poolIn);
 assert.ok(q.amountIn<exact(want),'beats the pool alone');
 // The budget excludes the best split; a smaller remainder never helps here.
 assert.equal(quoteSplit(lots,pool,'xToY',want,q.amountIn-1n),undefined);
 // Lots covering the whole request are the order router's job, not a split.
 assert.equal(quoteSplit([{offerAmount:want,askAmount:1n}],pool,'xToY',want,10n**30n),undefined);
 assert.equal(quoteSplit([],pool,'xToY',want,10n**30n),undefined);
 assert.throws(()=>quoteSplit(lots,pool,'xToY',0n,1n));
});
test('split quotes respect the lot cap and the pool reserve',()=>{
 const many=Array.from({length:40},()=>({offerAmount:10n**8n,askAmount:10n**7n}));
 assert.equal(quoteSplit(many,pool,'xToY',100n*10n**8n,10n**30n)!.lots.length,32);
 // Remainder beyond the pool's reserve: no split.
 assert.equal(quoteSplit([{offerAmount:1n,askAmount:1n}],pool,'xToY',pool.y+1n,10n**30n),undefined);
});
