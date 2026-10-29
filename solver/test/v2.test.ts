import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import * as sdk from '@openswap/sdk';
import { matchPair, matchV2, ReferenceSolverV2 } from '../src/index.js';
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
