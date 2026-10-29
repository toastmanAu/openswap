import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import * as sdk from '../src/index.js';
import { setup, a, b, owner, deployment, hex } from './fixture.js';

const v2: sdk.Deployment = { ...deployment, codeHash: '0x71027f76a5667e2b7c3294164e3171e582f4ffb17eea445a534b257bba5b3ede', cellDep: { outPoint: { txHash: hex(77), index: 0 }, depType: 'code' } };
const NOW = 1_800_000_000n, CKB = 100_000_000n;
const base = (askAsset: sdk.AssetId, expiry = 0n) => ({ ownerLock: owner, nonce: new Uint8Array(16).fill(9), askAsset, expiry });
function order(f: ReturnType<typeof setup>, offer: sdk.AssetId, ask: sdk.AssetId, lot: sdk.CreateLotV2, expiry = 0n) {
  const planned = sdk.planCreateV2(v2, { ...base(ask, expiry), nonce: sdk.nonce() }, offer, lot);
  return f.add(planned.cell);
}
const parsed = async (f: ReturnType<typeof setup>, cell: ccc.Cell) => sdk.parseV2(cell, v2, sdk.defaultResolver(f.client));
const ctx = (f: ReturnType<typeof setup>): sdk.BuildContext => ({ ...f.context, deployment: v2 });

test('create sizes UDT offers for N partial payment cells and CKB offers for one', async () => {
  const pay = sdk.paymentMinimum({ ownerLock: owner, askAsset: sdk.udt(b) });
  const u = sdk.planCreateV2(v2, base(sdk.udt(b)), sdk.udt(a), { offerAmount: 1000n, askAmount: 500n, minFill: 100n, partialFills: 3 });
  assert.equal(u.capacity, u.orderMinimum + 3n * pay);
  assert.equal(u.terms.capacityRefund, 0n);
  const c = sdk.planCreateV2(v2, base(sdk.udt(b)), sdk.CKB, { offerAmount: 5000n * CKB, askAmount: 500n, minFill: 1000n * CKB, partialFills: 3 });
  assert.equal(c.capacity, 5000n * CKB + pay); assert.equal(c.terms.capacityRefund, pay);
  const whole = sdk.planCreateV2(v2, base(sdk.CKB), sdk.udt(a), { offerAmount: 1000n, askAmount: 5n * CKB, minFill: 1n, partialFills: 0 });
  assert.equal(whole.terms.minFill, 1000n, 'no partial fills means full fills only');
  assert.throws(() => sdk.planCreateV2(v2, base(sdk.udt(a)), sdk.udt(a), { offerAmount: 1n, askAmount: 1n, minFill: 1n, partialFills: 0 }), /same-asset/);
});

test('partial range boundaries agree with the lock model for every order shape', async () => {
  const f = setup();
  const shapes: [sdk.AssetId, sdk.AssetId, sdk.CreateLotV2][] = [
    [sdk.udt(a), sdk.CKB, { offerAmount: 10_000n, askAmount: 1000n * CKB, minFill: 1000n, partialFills: 4 }],
    [sdk.udt(a), sdk.udt(b), { offerAmount: 10_000n, askAmount: 777n, minFill: 1000n, partialFills: 4 }],
    [sdk.CKB, sdk.udt(b), { offerAmount: 10_000n * CKB, askAmount: 333n, minFill: 1000n * CKB, partialFills: 4 }],
  ];
  for (const [offer, ask, lot] of shapes) {
    const o = await parsed(f, order(f, offer, ask, lot));
    const range = sdk.partialRange(o)!;
    assert.ok(range, `${offer.kind}->${ask.kind} has a partial range`);
    for (const take of [range.min, range.max, (range.min + range.max) / 2n, o.available]) {
      const plan = sdk.planFillV2(o, take);
      assert.equal(plan.final, take === o.available);
      assert.equal(plan.paid, sdk.requiredPayment(o, take));
    }
    assert.throws(() => sdk.planFillV2(o, range.min - 1n), /minimum/);
    if (range.max + 1n < o.available) assert.throws(() => sdk.planFillV2(o, range.max + 1n));
  }
});

test('a UDT->UDT order funded for two partial fills takes two, then only a final fill', async () => {
  const f = setup();
  let o = await parsed(f, order(f, sdk.udt(a), sdk.udt(b), { offerAmount: 9000n, askAmount: 900n, minFill: 1000n, partialFills: 2 }));
  for (let i = 0; i < 2; i++) {
    const plan = sdk.planFillV2(o, 1000n);
    const next = f.add(plan.remainder!);
    o = await parsed(f, next);
  }
  assert.equal(o.available, 7000n);
  assert.throws(() => sdk.planFillV2(o, 1000n), /no capacity left/);
  const last = sdk.planFillV2(o, o.available);
  assert.equal(last.payment.cellOutput.capacity, o.cell.cellOutput.capacity, 'final payment carries all remaining capacity');
});

test('a CKB offer sells one capacityRefund less per partial fill, never more than offered', async () => {
  const f = setup();
  const lot = { offerAmount: 3000n * CKB, askAmount: 300n, minFill: 500n * CKB, partialFills: 4 };
  let o = await parsed(f, order(f, sdk.CKB, sdk.udt(b), lot));
  let sold = 0n;
  const first = sdk.planFillV2(o, 1000n * CKB); sold += first.taken;
  o = await parsed(f, f.add(first.remainder!));
  const last = sdk.planFillV2(o, o.available); sold += last.taken;
  assert.equal(sold, lot.offerAmount - o.capacityRefund);
});

test('fill builder: partial v2 fill and a whole v1 lot in one pinned transaction', async () => {
  const f = setup(); f.fund();
  f.add(ccc.CellAny.from({ cellOutput: { lock: owner, type: b, capacity: 200n * CKB }, outputData: sdk.amountData(10_000n) }));
  const v2order = order(f, sdk.udt(a), sdk.udt(b), { offerAmount: 10_000n, askAmount: 1000n, minFill: 1000n, partialFills: 2 });
  const v1lot = f.order(sdk.udt(a), sdk.udt(b), 100n, 10n);
  const built = await sdk.fillOrdersV2(ctx(f), [{ outPoint: v2order.outPoint, take: 2500n }, { outPoint: v1lot.outPoint }], { v1: deployment, nowSeconds: NOW });
  built.assertLayout();
  const tx = built.tx;
  assert.equal(sdk.parseAmount(tx.outputsData[0]!), 250n, 'v2 payment at index 0');
  assert.equal(sdk.parseAmount(tx.outputsData[1]!), 10n, 'v1 payment at index 1');
  assert(tx.outputs[2]!.lock.eq(v2order.cellOutput.lock), 'remainder keeps the identical lock');
  assert.equal(sdk.parseAmount(tx.outputsData[2]!), 7500n);
  assert.equal(tx.getOutputsUdtBalance(a), 10_100n, 'token a conserved: remainder plus taker change');
  assert(tx.cellDeps.some(d => d.outPoint.eq(v2.cellDep.outPoint)) && tx.cellDeps.some(d => d.outPoint.eq(ccc.OutPoint.from(deployment.cellDep.outPoint!))));
  built.tx.outputs[2]!.capacity -= 1n; assert.throws(() => built.assertLayout(), /Pinned/);
});

test('fill refuses expired orders unless explicitly allowed; return needs expiry and sets since', async () => {
  const f = setup(); f.fund();
  const expiry = sdk.expiryAt(NOW - 10n);
  const o = order(f, sdk.udt(a), sdk.CKB, { offerAmount: 1000n, askAmount: 100n * CKB, minFill: 100n, partialFills: 0 }, expiry);
  await assert.rejects(() => sdk.fillOrdersV2(ctx(f), [{ outPoint: o.outPoint }], { nowSeconds: NOW }), /expired/);
  (await sdk.fillOrdersV2(ctx(f), [{ outPoint: o.outPoint }], { nowSeconds: NOW, allowExpired: true })).assertLayout();
  await assert.rejects(() => sdk.returnExpiredV2(ctx(f), [o.outPoint], NOW - 11n), /not expired/);
  const back = await sdk.returnExpiredV2(ctx(f), [o.outPoint], NOW);
  back.assertLayout();
  assert.equal(back.tx.inputs[0]!.since, expiry);
  assert(back.tx.outputs[0]!.lock.eq(owner) && back.tx.outputs[0]!.type?.eq(a));
  assert.equal(back.tx.outputs[0]!.capacity, o.cellOutput.capacity);
  assert.equal(back.tx.outputsData[0], o.outputData);
  const never = order(f, sdk.udt(a), sdk.CKB, { offerAmount: 1000n, askAmount: 100n * CKB, minFill: 100n, partialFills: 0 });
  await assert.rejects(() => sdk.returnExpiredV2(ctx(f), [never.outPoint], NOW), /not expired/);
});

test('owner cancellation of a v2 order uses the v1 recovery-plus-proof layout', async () => {
  const f = setup(); f.fund();
  const o = order(f, sdk.CKB, sdk.udt(b), { offerAmount: 1000n * CKB, askAmount: 5n, minFill: 1000n * CKB, partialFills: 0 });
  const built = await sdk.cancelOrdersV2(ctx(f), [o.outPoint]); built.assertLayout();
  assert(built.tx.outputs[0]!.lock.eq(owner)); assert.equal(built.tx.outputs[0]!.capacity, o.cellOutput.capacity);
});

test('quote takes the cheapest orders, splits the last v2 order and skips near-expiry ones', async () => {
  const f = setup();
  const cheap = await parsed(f, order(f, sdk.udt(a), sdk.udt(b), { offerAmount: 1000n, askAmount: 100n, minFill: 100n, partialFills: 4 }));
  const dear = await parsed(f, order(f, sdk.udt(a), sdk.udt(b), { offerAmount: 1000n, askAmount: 200n, minFill: 100n, partialFills: 4 }));
  const expiring = await parsed(f, order(f, sdk.udt(a), sdk.udt(b), { offerAmount: 1000n, askAmount: 1n, minFill: 100n, partialFills: 4 }, sdk.expiryAt(NOW + 60n)));
  const v1 = await sdk.parse(f.order(sdk.udt(a), sdk.udt(b), 500n, 75n), deployment, sdk.defaultResolver(f.client));
  const q = sdk.quoteMixed([dear, expiring, v1, cheap], { assetIn: sdk.udt(b), assetOut: sdk.udt(a), amountOut: 1800n, maxAmountIn: 10_000n, genesisHash: deployment.genesisHash, nowSeconds: NOW });
  assert.deepEqual(q.legs.map(l => [l.order === cheap ? 'cheap' : l.order === v1 ? 'v1' : l.order === dear ? 'dear' : 'expiring', l.take, l.partial]), [['cheap', 1000n, false], ['v1', 500n, false], ['dear', 300n, true]]);
  assert.equal(q.amountOut, 1800n); assert.equal(q.overfill, 0n); assert.equal(q.amountIn, 100n + 75n + 60n);
  // Below the min fill, the partial rounds up to it.
  const small = sdk.quoteMixed([dear], { assetIn: sdk.udt(b), assetOut: sdk.udt(a), amountOut: 10n, maxAmountIn: 10_000n, genesisHash: deployment.genesisHash, nowSeconds: NOW });
  assert.equal(small.legs[0]!.take, 100n); assert.equal(small.overfill, 90n);
  assert.throws(() => sdk.quoteMixed([dear], { assetIn: sdk.udt(b), assetOut: sdk.udt(a), amountOut: 900n, maxAmountIn: 10n, genesisHash: deployment.genesisHash, nowSeconds: NOW }), /budget/);
});
