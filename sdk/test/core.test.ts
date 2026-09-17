import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ccc } from '@ckb-ccc/core';
import * as sdk from '../src/index.js';
const vectors = JSON.parse(readFileSync(new URL('../../tests/vectors/wire.json', import.meta.url), 'utf8'));
for (const v of vectors) test(`shared wire: ${v.name}`, () => {
  if (v.errorCode) { assert.throws(() => sdk.decodeTerms(v.expectedArgsHex), (e: unknown) => e instanceof sdk.WireError && e.code === v.errorCode); return; }
  const decoded = sdk.decodeTerms(v.expectedArgsHex);
  assert.equal(sdk.encodeTerms(decoded), v.expectedArgsHex);
  assert.equal(ccc.hexFrom(decoded.ownerLock.toBytes()), v.ownerScriptHex);
  assert.equal(decoded.capacityRefund.toString(), v.capacityRefund);
  assert.equal(decoded.askAmount.toString(), v.askAmount);
  assert.equal(ccc.hexFrom(decoded.nonce), v.nonceHex);
});
const deployment = JSON.parse(readFileSync(new URL('../../deployments/testnet.json', import.meta.url), 'utf8')) as sdk.Deployment;
const terms = sdk.decodeTerms(vectors[1].expectedArgsHex);
const token = terms.askAsset;
const mockClient = { getKnownScript: async () => ({ codeHash: token.kind === 'udt' ? token.script.codeHash : '', hashType: 'data1', cellDeps: [] }) } as unknown as ccc.Client;
const resolver = sdk.defaultResolver(mockClient);
test('codec rejects hostile sizes, negative numbers, overflow and every truncated valid prefix', () => {
  assert.throws(() => sdk.decodeTerms(new Uint8Array(65536)), sdk.WireError);
  assert.throws(() => sdk.encodeTerms({ ...terms, askAmount: -1n }));
  assert.throws(() => sdk.encodeTerms({ ...terms, capacityRefund: 1n << 64n }));
  const b = ccc.bytesFrom(vectors[1].expectedArgsHex); for (let i = 0; i < b.length; i++) assert.throws(() => sdk.decodeTerms(b.slice(0, i)));
});
test('lot planner preserves offer and rounds every maker ask upward', () => {
  const plans = sdk.plan({ totalOffer: 101n, priceNumerator: 7n, priceDenominator: 3n });
  for (const p of plans) {
    assert.equal(p.offers.reduce((a, b) => a + b, 0n), 101n);
    p.asks.forEach((a, i) => assert(a * 3n >= p.offers[i]! * 7n));
    assert(p.roundingPremium >= 0n);
  }
  assert.throws(() => sdk.plan({ totalOffer: 10n, priceNumerator: 1n, priceDenominator: 0n }));
});
test('capacity estimate uses final args and exact refund; CKB offer remains separate', async () => {
  const estimate = sdk.estimateCapacity(deployment, terms, sdk.CKB, 10_000_000_000n);
  assert.equal(estimate.capacity - estimate.capacityRefund, 10_000_000_000n);
  assert(estimate.capacityRefund >= estimate.orderMinimum);
  assert(estimate.capacityRefund >= estimate.paymentMinimum);
  const decoded = sdk.decodeTerms(estimate.cell.cellOutput.lock.args);
  assert.equal(decoded.capacityRefund, estimate.capacityRefund);
  const cell = ccc.Cell.from({ ...estimate.cell, outPoint: { txHash: '0x' + '01'.repeat(32), index: 0 } });
  const order = await sdk.parse(cell, deployment, resolver);
  assert.equal(order.offerAmount, 10_000_000_000n);
});
test('resolver rejects unknown and extended xUDT profiles', async () => {
  if (token.kind !== 'udt') throw new Error();
  const canonical = token.script.clone(); canonical.args = ccc.hexFrom(new Uint8Array(32));
  assert(await resolver.supports(canonical, sdk.amountData(1n)));
  assert(!await resolver.supports(canonical, ccc.hexFrom(new Uint8Array(17))));
  canonical.args += '01000000';
  assert(!await resolver.supports(canonical, sdk.amountData(1n)));
  const unknown = canonical.clone(); unknown.codeHash = ccc.hexFrom(new Uint8Array(32).fill(255));
  await assert.rejects(() => resolver.resolveCellDeps(unknown));
});
test('nonce batches are unique and nonzero', () => {
  const ns = sdk.nonces(64); assert.equal(new Set(ns.map(n => ccc.hexFrom(n))).size,64); assert(ns.every(n=>n.some(x=>x!==0)));
});
