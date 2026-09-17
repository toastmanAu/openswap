import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import * as sdk from '../src/index.js';
import { setup, a, b, owner } from './fixture.js';
test('create completes CCC funding/fees without moving lots', async () => {
  const f=setup(); f.fund();
  const built=await sdk.createOrder(f.context,{offerAsset:sdk.CKB,askAsset:sdk.udt(b),lots:[{offerAmount:100n,askAmount:10n},{offerAmount:200n,askAmount:20n}]});
  built.assertLayout(); assert.notEqual(built.tx.outputs[0]!.lock.hash(),built.tx.outputs[1]!.lock.hash());
  assert.equal(sdk.decodeTerms(built.tx.outputs[1]!.lock.args).askAmount,20n);
});
test('reciprocal fill conserves both assets and pins maker outputs', async () => {
  const f=setup(); f.fund(); const left=f.order(sdk.udt(a),sdk.udt(b),200n,100n); const right=f.order(sdk.udt(b),sdk.udt(a),100n,150n);
  const built=await sdk.fillOrders(f.context,[left.outPoint,right.outPoint]); built.assertLayout();
  assert(built.tx.inputs[0]!.previousOutput.eq(left.outPoint)); assert(built.tx.inputs[1]!.previousOutput.eq(right.outPoint));
  assert.equal(built.tx.getOutputsUdtBalance(a),200n); assert.equal(built.tx.getOutputsUdtBalance(b),100n);
  assert.equal(sdk.parseAmount(built.tx.outputsData[0]!),100n); assert.equal(sdk.parseAmount(built.tx.outputsData[1]!),150n);
});
test('single owner proof pays cancellation fee without a second funding input', async () => {
  const f=setup(); const proof=f.fund(); const order=f.order(sdk.CKB,sdk.udt(b));
  const built=await sdk.cancelOrders(f.context,[order.outPoint]); built.assertLayout();
  assert.equal(built.tx.inputs.length,2); assert(built.tx.inputs[1]!.previousOutput.eq(proof.outPoint));
  assert.equal(built.tx.outputs[0]!.capacity,order.cellOutput.capacity);
  assert(built.tx.outputs[1]!.capacity < proof.cellOutput.capacity);
  assert.equal(proof.cellOutput.capacity-built.tx.outputs[1]!.capacity,await built.tx.getFee(f.client));
});
test('malformed-tail cancellation only needs valid owner prefix', async () => {
  const f=setup(); f.fund(); const order=f.order(sdk.CKB,sdk.udt(b));
  order.cellOutput.lock.args=ccc.hexFrom(owner.toBytes());
  const built=await sdk.cancelOrders(f.context,[order.outPoint]); built.assertLayout();
});
test('fee completion reorder fails before signing', async () => {
  const f=setup(); f.fund(); f.corrupt();
  await assert.rejects(()=>sdk.createOrder(f.context,{offerAsset:sdk.CKB,askAsset:sdk.udt(b),lots:[{offerAmount:100n,askAmount:10n}]}),/Pinned/);
  assert.equal(f.signed(),false);
});
test('dead order, duplicate group and missing proof are rejected', async () => {
  const f=setup(); const order=f.order(sdk.CKB,sdk.udt(b));
  await assert.rejects(()=>sdk.cancelOrders(f.context,[order.outPoint]),/separate plain/);
  await assert.rejects(()=>sdk.fillOrders(f.context,[order.outPoint,order.outPoint]),/Duplicate/);
  f.cells.length=0; await assert.rejects(()=>sdk.fillOrders(f.context,[order.outPoint]),/no longer live/);
});
test('extended token funding is excluded', async () => {
  const f=setup(); f.fund(); const order=f.order(sdk.CKB,sdk.udt(b));
  f.add(ccc.CellAny.from({cellOutput:{lock:owner,type:b,capacity:100000000000n},outputData:ccc.hexFrom(new Uint8Array(17).fill(1))}));
  await assert.rejects(()=>sdk.fillOrders(f.context,[order.outPoint]),/Insufficient token/);
});
test('post-build payment mutation is rejected', async () => {
  const f=setup(); f.fund(); const o=f.order(sdk.CKB,sdk.udt(b)); const built=await sdk.cancelOrders(f.context,[o.outPoint]);
  built.tx.outputs[0]!.capacity-=1n; assert.throws(()=>built.assertLayout(),/Pinned/);
});
test('spent funding is rejected before requesting a signature', async () => {
  const f=setup(); f.fund();
  const built=await sdk.createOrder(f.context,{offerAsset:sdk.CKB,askAsset:sdk.udt(b),lots:[{offerAmount:100n,askAmount:10n}]});
  f.cells.length=0;
  await assert.rejects(()=>sdk.submit(built,f.signer),/live|spent/i);
  assert.equal(f.signed(),false);
});
test('wallet preparation mutation is rejected before requesting a signature', async () => {
  const f=setup(); f.fund();
  const built=await sdk.createOrder(f.context,{offerAsset:sdk.CKB,askAsset:sdk.udt(b),lots:[{offerAmount:100n,askAmount:10n}]});
  f.corrupt();
  await assert.rejects(()=>sdk.submit(built,f.signer),/Pinned|changed/);
  assert.equal(f.signed(),false);
});
