import {test} from 'node:test';import assert from 'node:assert/strict';
import {setup,b,owner} from './fixture.js';import {createOrder,CKB,udt} from '../src/index.js';
import {capacityReview} from '../../frontend/src/review.js';import {explainError} from '../../frontend/src/errors.js';
test('review separates order capacity from fee and wallet debit',async()=>{
 const f=setup();f.fund();const built=await createOrder(f.context,{offerAsset:CKB,askAsset:udt(b),lots:[{offerAmount:100000000n,askAmount:10n}]});
 const result=await capacityReview(built.tx,f.client,[owner],f.context.deployment);
 assert.equal(result.orderLocked,built.tx.outputs[0]!.capacity);assert.equal(result.orderReleased,0n);assert.equal(result.tokenReserveChange,0n);
 assert.equal(result.walletChange,-result.orderLocked-await built.tx.getFee(f.client));
});
test('errors distinguish missing liquidity, rejected wallet prompts and unknown network outcomes',()=>{
 assert.match(explainError(new Error('No whole-lot route within budget')),/smaller amount/);
 assert.match(explainError(new Error('User rejected request')),/cancelled/);
 assert.match(explainError(new Error('fetch failed')),/Check Activity before retrying/);
 assert.match(explainError(new Error('Quote is stale: order spent')),/Refresh/);
});
