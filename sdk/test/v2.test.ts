import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ccc } from '@ckb-ccc/core';
import * as sdk from '../src/index.js';
import { buildFillVectors, buildWireVectors } from '../src/v2/vectors.js';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../lock-v2-tests/vectors/${name}`, import.meta.url), 'utf8'));

test('v2 vector files equal a fresh generation (run scripts/generate-lock-v2-vectors.ts)', () => {
  assert.deepEqual(read('wire.json'), JSON.parse(JSON.stringify(buildWireVectors())));
  assert.deepEqual(read('fill.json'), JSON.parse(JSON.stringify(buildFillVectors())));
});

for (const v of read('wire.json')) test(`v2 wire: ${v.name}`, () => {
  if (v.errorCode) { assert.throws(() => sdk.decodeTermsV2(v.argsHex), (e: unknown) => e instanceof sdk.WireError && e.code === v.errorCode); return; }
  const t = sdk.decodeTermsV2(v.argsHex);
  assert.equal(sdk.encodeTermsV2(t), v.argsHex);
  assert.equal(String(t.minFill), v.terms.minFill);
  assert.equal(String(t.expiry), v.terms.expiry);
});

test('v2 codec rejects every truncated prefix and v1 args', () => {
  const b = ccc.bytesFrom(read('wire.json')[0].argsHex);
  for (let i = 0; i < b.length; i++) assert.throws(() => sdk.decodeTermsV2(b.slice(0, i)));
  const v1 = JSON.parse(readFileSync(new URL('../../tests/vectors/wire.json', import.meta.url), 'utf8'));
  assert.throws(() => sdk.decodeTermsV2(v1[1].expectedArgsHex), sdk.WireError);
});

test('expiry encodes an absolute timestamp since and round-trips', () => {
  const e = sdk.expiryAt(1_793_000_000n);
  assert.equal(e, 0x4000_0000_0000_0000n | 1_793_000_000n);
  assert.equal(sdk.expirySeconds(e), 1_793_000_000n);
  assert.equal(sdk.expirySeconds(0n), undefined);
  assert.throws(() => sdk.expiryAt(0n));
  assert.ok(!sdk.validExpiry(5n));
});

test('model: required payment is the exact maker-favouring boundary', () => {
  const terms = { owner: 'o', capacityRefund: 0n, ask: null, askAmount: 7n, offerAmount: 3n, minFill: 1n };
  const order = { lock: 'L', type: 'a', capacity: 1000n, data: sdk.writeLE(10n, 16) };
  for (let taken = 1n; taken <= 9n; taken++) {
    const need = sdk.requiredPayment(terms, taken);
    const rest = { lock: 'L', type: 'a', capacity: 1000n, data: sdk.writeLE(10n - taken, 16) };
    const at = (paid: bigint) => sdk.checkFill(terms, 'L', order, 0, [{ lock: 'o', type: null, capacity: paid, data: new Uint8Array() }, rest]);
    assert.equal(at(need), 0, `taken ${taken}`);
    assert.equal(at(need - 1n), 55, `taken ${taken} one short`);
    assert.ok(need * 3n >= taken * 7n && (need - 1n) * 3n < taken * 7n);
  }
});
