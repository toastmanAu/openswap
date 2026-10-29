import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import * as sdk from '@openswap/sdk';
import { matchBook, matchPair, matchV2, ReferenceSolverV2, type BookMatch } from '../src/index.js';
import type { SubmissionRecord } from '../src/journal.js';
import { setup, a, b, owner, deployment, hex } from '../../sdk/test/fixture.js';

const v2: sdk.Deployment = { ...deployment, codeHash: '0x71027f76a5667e2b7c3294164e3171e582f4ffb17eea445a534b257bba5b3ede', cellDep: { outPoint: { txHash: hex(77), index: 0 }, depType: 'code' } };
const NOW = 1_800_000_000n, CKB = 100_000_000n;
type F = ReturnType<typeof setup>;
function market() {
  const f = setup(); f.fund();
  Object.assign(f.client, { cache: new ccc.ClientCacheMemory(), getTipHeader: async () => ({ timestamp: NOW * 1000n, number: 1n }) });
  f.client.findCells = async function* (key: { script: ccc.ScriptLike }) {
    for (const c of [...f.cells]) if (c.cellOutput.lock.codeHash === ccc.Script.from(key.script).codeHash) yield c;
  } as never;
  return f;
}
const place = (f: F, offer: sdk.AssetId, ask: sdk.AssetId, lot: sdk.CreateLotV2, expiry = 0n) =>
  f.add(sdk.planCreateV2(v2, { ownerLock: owner, nonce: sdk.nonce(), askAsset: ask, expiry }, offer, lot).cell);
const parsed = (f: F, c: ccc.Cell) => sdk.parseV2(c, v2, sdk.defaultResolver(f.client));
const journal = () => { const rows = new Map<ccc.Hex, SubmissionRecord>(); return { getScope: () => ({ genesisHash: deployment.genesisHash, accountLockHash: owner.hash() }), list: () => structuredClone([...rows.values()]), put: (r: SubmissionRecord) => { rows.set(r.hash, structuredClone(r)); } }; };
const ctx = (f: F): sdk.BuildContext => ({ ...f.context, deployment: v2 });

test('a large order is partially filled against a small reciprocal order, inventory-free', async () => {
  const f = market();
  // L sells 10,000 A at 0.1 B each; R sells 300 B at 2 A each (crosses: R pays more A per B).
  const l = await parsed(f, place(f, sdk.udt(a), sdk.udt(b), { offerAmount: 10_000n, askAmount: 1000n, minFill: 100n, partialFills: 4 }));
  const r = await parsed(f, place(f, sdk.udt(b), sdk.udt(a), { offerAmount: 300n, askAmount: 600n, minFill: 300n, partialFills: 0 }));
  const m = matchPair(l, r)!;
  assert.ok(m);
  const [legL, legR] = m.legs;
  assert.equal(legR.take, 300n, 'R filled whole');
  assert.ok(legL.take! < 10_000n && legL.take! >= 600n, 'L filled partially, at least what R asks');
  assert.ok(legL.paid <= legR.delivered && legR.paid <= legL.delivered);
  assert.equal(m.surplus.get(sdk.assetKey(sdk.udt(a))), legL.delivered - legR.paid);
});

test('non-crossing prices, expiry and near-expiry orders do not match', async () => {
  const f = market();
  const l = await parsed(f, place(f, sdk.udt(a), sdk.udt(b), { offerAmount: 1000n, askAmount: 1000n, minFill: 100n, partialFills: 2 }));
  const r = await parsed(f, place(f, sdk.udt(b), sdk.udt(a), { offerAmount: 1000n, askAmount: 1001n, minFill: 100n, partialFills: 2 }));
  assert.equal(matchPair(l, r), undefined, '1 B per A against 1.001 A per B does not cross');
  const cross = await parsed(f, place(f, sdk.udt(b), sdk.udt(a), { offerAmount: 1000n, askAmount: 900n, minFill: 100n, partialFills: 2 }, sdk.expiryAt(NOW + 200n)));
  assert.equal(matchV2([l, cross], { nowSeconds: NOW }), undefined, 'inside the 300 s margin');
  assert.ok(matchV2([l, cross], { nowSeconds: NOW, expiryMarginSeconds: 100n }));
});

test('a v2 order matches a whole v1 lot', async () => {
  const f = market();
  const l = await parsed(f, place(f, sdk.udt(a), sdk.udt(b), { offerAmount: 10_000n, askAmount: 1000n, minFill: 100n, partialFills: 4 }));
  const v1 = await sdk.parse(f.order(sdk.udt(b), sdk.udt(a), 50n, 400n), deployment, sdk.defaultResolver(f.client));
  const m = matchPair(l, v1)!;
  assert.equal(m.legs[1].take, undefined); assert.equal(m.legs[1].delivered, 50n);
  assert.ok(m.legs[0].take! >= 400n && m.legs[0].paid <= 50n);
});

test('CKB-offer and token-offer v2 orders match with exact capacities', async () => {
  const f = market();
  const l = await parsed(f, place(f, sdk.CKB, sdk.udt(b), { offerAmount: 5000n * CKB, askAmount: 500n, minFill: 500n * CKB, partialFills: 4 }));
  const r = await parsed(f, place(f, sdk.udt(b), sdk.CKB, { offerAmount: 100n, askAmount: 900n * CKB, minFill: 100n, partialFills: 0 }));
  const m = matchPair(l, r)!;
  assert.ok(m, 'L sells CKB at 10 CKB/B, R buys CKB at 9 CKB/B');
  assert.ok(m.surplus.get('ckb')! >= 0n && m.surplus.get(sdk.assetKey(sdk.udt(b)))! >= 0n);
});

test('v2 runner builds a pinned partial settlement, sends once and reserves it', async () => {
  const f = market();
  place(f, sdk.udt(a), sdk.udt(b), { offerAmount: 10_000n, askAmount: 1000n, minFill: 100n, partialFills: 4 });
  place(f, sdk.udt(b), sdk.udt(a), { offerAmount: 300n, askAmount: 600n, minFill: 300n, partialFills: 0 });
  let sends = 0; const events: string[] = [];
  f.client.sendTransaction = async tx => { sends++; return ccc.Transaction.from(tx).hash(); };
  f.client.getTransactionNoCache = async () => ({ status: 'pending' }) as ccc.ClientTransactionResponse;
  const solver = new ReferenceSolverV2(ctx(f), e => events.push(e), { journal: journal() });
  const tx = (await solver.tick(true))!;
  assert.equal(sends, 1);
  assert.equal(tx.outputs.filter(o => o.lock.codeHash === v2.codeHash).length, 1, 'one remainder');
  assert.equal(await solver.tick(true), undefined, 'both orders stay reserved while pending');
  assert.equal(sends, 1);
  assert.ok(events.includes('candidate_pair'));
});

test('keeper returns orders only after expiry plus delay, by chain time, with since set', async () => {
  const f = market();
  const late = place(f, sdk.udt(a), sdk.CKB, { offerAmount: 1000n, askAmount: 100n * CKB, minFill: 100n, partialFills: 0 }, sdk.expiryAt(NOW - 1000n));
  place(f, sdk.udt(a), sdk.CKB, { offerAmount: 1000n, askAmount: 100n * CKB, minFill: 100n, partialFills: 0 }, sdk.expiryAt(NOW - 100n));
  place(f, sdk.udt(a), sdk.CKB, { offerAmount: 1000n, askAmount: 100n * CKB, minFill: 100n, partialFills: 0 });
  let sent = 0; f.client.sendTransaction = async () => { sent++; throw new Error('dry run must not send'); };
  const solver = new ReferenceSolverV2(ctx(f), undefined, { journal: journal() });
  const tx = (await solver.returnExpired())!;
  assert.equal(sent, 0);
  assert.equal(tx.inputs.filter(i => i.since !== 0n).length, 1, 'only the order past expiry + 900 s');
  const i = tx.inputs.findIndex(x => x.previousOutput.eq(late.outPoint));
  assert.equal(tx.inputs[i]!.since, sdk.expiryAt(NOW - 1000n));
  assert(tx.outputs[i]!.lock.eq(owner)); assert.equal(tx.outputsData[i], late.outputData);
  // The fill side never touches expired orders.
  assert.equal(await new ReferenceSolverV2(ctx(f), undefined, { journal: journal() }).tick(), undefined);
});

// Multi-order matching ------------------------------------------------------------------
/** Per-asset conservation, recomputed from the legs: makers are paid no more than other makers deliver. */
function balanced(m: BookMatch) {
  const flow = new Map<string, bigint>();
  for (const l of m.legs) {
    const offer = sdk.assetKey(l.order.offerAsset), ask = sdk.assetKey(l.order.askAsset);
    flow.set(offer, (flow.get(offer) ?? 0n) + l.delivered); flow.set(ask, (flow.get(ask) ?? 0n) - l.paid);
  }
  for (const [k, v] of flow) { assert.ok(v >= 0n, `${k} short by ${-v}`); assert.equal(m.surplus.get(k), v); }
}

test('several small sellers fill one large buyer in one settlement, best prices first', async () => {
  const f = market();
  // Sellers of A (asking B) at 0.10, 0.11, 0.12, and one at 5 B per A that no buyer here can pay.
  const sellers = await Promise.all([[1000n, 100n], [1000n, 110n], [1000n, 120n], [1000n, 5000n]].map(([offer, ask]) =>
    parsed(f, place(f, sdk.udt(a), sdk.udt(b), { offerAmount: offer!, askAmount: ask!, minFill: 100n, partialFills: 2 }))));
  // One buyer offers 1,000 B for 5,000 A (0.2 B per A), partly fillable.
  const buyer = await parsed(f, place(f, sdk.udt(b), sdk.udt(a), { offerAmount: 1000n, askAmount: 5000n, minFill: 50n, partialFills: 4 }));
  const m = matchV2([...sellers, buyer], { nowSeconds: NOW })!;
  assert.ok(m);
  // matchV2 puts whichever side's market key sorts first on the left; pick legs by asset.
  const sold = m.legs.filter(l => sdk.assetKey(l.order.offerAsset) === sdk.assetKey(sdk.udt(a)));
  assert.deepEqual(sold.map(l => sdk.orderKey(l.order)), sellers.slice(0, 3).map(sdk.orderKey), 'the three cheapest sellers, cheapest first');
  assert.equal(m.legs.length, 4, 'the 5 B per A seller cannot be paid');
  assert.ok(sold.every(l => l.take === 1000n), 'sellers fill whole');
  const bought = m.legs.find(l => l.order === buyer)!; assert.ok(bought.take! < 1000n, 'the buyer fills only what is needed');
  balanced(m);
});

test('both sides can have several orders; the plan delivering most volume wins', async () => {
  const f = market();
  const left = await Promise.all([[600n, 60n], [800n, 90n]].map(([o, k]) => parsed(f, place(f, sdk.udt(a), sdk.udt(b), { offerAmount: o!, askAmount: k!, minFill: 100n, partialFills: 2 }))));
  const right = await Promise.all([[50n, 400n], [40n, 300n], [100n, 500n]].map(([o, k]) => parsed(f, place(f, sdk.udt(b), sdk.udt(a), { offerAmount: o!, askAmount: k!, minFill: 10n, partialFills: 2 }))));
  const m = matchBook(left, right)!;
  assert.ok(m);
  balanced(m);
  assert.ok(m.legs.length >= 4, `expected several orders per side, got ${m.legs.length}`);
  // No single pair delivers as much A to buyers.
  const pairBest = Math.max(...left.flatMap(l => right.map(r => Number(matchPair(l, r)?.legs[1].paid ?? 0n))));
  const delivered = m.legs.filter(l => sdk.assetKey(l.order.offerAsset) === sdk.assetKey(sdk.udt(b))).reduce((s, l) => s + l.paid, 0n);
  assert.ok(Number(delivered) > pairBest);
});

test('a marginal order that does not cross alone can still fill when the batch balances, each maker at its own price', async () => {
  const f = market();
  // Sellers at 0.10, 0.11, 0.12 and 0.30 B per A; one buyer at 0.20 B per A for up to 5,000 A.
  const sellers = await Promise.all([[1000n, 100n], [1000n, 110n], [1000n, 120n], [1000n, 300n]].map(([o, k]) => parsed(f, place(f, sdk.udt(a), sdk.udt(b), { offerAmount: o!, askAmount: k!, minFill: 100n, partialFills: 2 }))));
  const buyer = await parsed(f, place(f, sdk.udt(b), sdk.udt(a), { offerAmount: 1000n, askAmount: 5000n, minFill: 50n, partialFills: 4 }));
  const m = matchBook(sellers, [buyer])!;
  balanced(m);
  for (const l of m.legs) assert.ok(l.paid * l.order.offerAmount >= (l.take ?? l.delivered) * l.order.askAmount, 'each maker is paid at least its price');
  // All four sellers fill: the buyer receives 3,150 A at its 0.2 price rather than 1,650 A without the fourth.
  assert.equal(m.legs.length, 5); assert.equal(m.legs[4]!.paid, 3150n);
});

test('the leg cap bounds a settlement, and v1 lots join whole', async () => {
  const f = market();
  const sellers = await Promise.all(Array.from({ length: 10 }, (_, i) => parsed(f, place(f, sdk.udt(a), sdk.udt(b), { offerAmount: 100n, askAmount: 10n + BigInt(i), minFill: 100n, partialFills: 0 }))));
  const v1 = await sdk.parse(f.order(sdk.udt(b), sdk.udt(a), 50n, 400n), deployment, sdk.defaultResolver(f.client));
  const buyer = await parsed(f, place(f, sdk.udt(b), sdk.udt(a), { offerAmount: 10_000n, askAmount: 50_000n, minFill: 1n, partialFills: 8 }));
  const capped = matchV2([...sellers, buyer], { nowSeconds: NOW, maxLegs: 4 })!;
  assert.equal(capped.legs.length, 4); balanced(capped);
  const withLot = matchBook(sellers, [v1])!;
  assert.ok(withLot); balanced(withLot);
  const lot = withLot.legs.find(l => !sdk.isV2(l.order))!;
  assert.equal(lot.take, undefined); assert.equal(lot.delivered, 50n);
  assert.throws(() => matchBook(sellers, [v1], { maxLegs: 1 }), /maxLegs/);
});

test('v2 runner settles a multi-order match in one pinned transaction', async () => {
  const f = market();
  for (const ask of [100n, 105n, 110n]) place(f, sdk.udt(a), sdk.udt(b), { offerAmount: 1000n, askAmount: ask, minFill: 100n, partialFills: 2 });
  place(f, sdk.udt(b), sdk.udt(a), { offerAmount: 1000n, askAmount: 5000n, minFill: 50n, partialFills: 4 });
  let sends = 0; const events: [string, any][] = [];
  f.client.sendTransaction = async tx => { sends++; return ccc.Transaction.from(tx).hash(); };
  f.client.getTransactionNoCache = async () => ({ status: 'pending' }) as ccc.ClientTransactionResponse;
  const solver = new ReferenceSolverV2(ctx(f), (e, d) => events.push([e, d]), { journal: journal() });
  const tx = (await solver.tick(true))!;
  assert.equal(sends, 1);
  const orderInputs = (await Promise.all(tx.inputs.map(i => i.getCell(f.client)))).filter(c => c.cellOutput.lock.codeHash === v2.codeHash);
  assert.equal(orderInputs.length, 4, 'four orders in one transaction');
  for (let i = 0; i < 4; i++) assert(tx.outputs[i]!.lock.eq(owner), `payment ${i} at its order index`);
  assert.equal(tx.outputs.filter(o => o.lock.codeHash === v2.codeHash).length, 1, 'only the partly filled buyer remains');
  assert.equal(events.find(([e]) => e === 'candidate_pair')![1].orders.length, 4);
  assert.equal(await solver.tick(true), undefined, 'all four stay reserved while pending');
});
