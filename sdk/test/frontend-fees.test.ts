import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORDER_FEE_POLICY, orderFeeQuote, feeLine } from '../../frontend/src/fees.js';

const node = (median: bigint | Error) => ({ getFeeRateStatistics: async () => { if (median instanceof Error) throw median; return { mean: median, median }; } }) as never;

test('order fee rate: the node median within [1,000, 5,000] shannons/KB; minimum if the node fails', async () => {
  assert.deepEqual(await orderFeeQuote(node(10n)), { rate: 1000n, suggested: 10n });
  assert.deepEqual(await orderFeeQuote(node(2500n)), { rate: 2500n, suggested: 2500n });
  assert.deepEqual(await orderFeeQuote(node(47_000n)), { rate: 5000n, suggested: 47_000n });
  assert.deepEqual(await orderFeeQuote(node(new Error('offline'))), { rate: 1000n });
  assert.equal(ORDER_FEE_POLICY.maxFee, 1_000_000n, '0.01 CKB per transaction');
});

test('review line states the rate paid and why', () => {
  const fmt = (n: bigint) => (Number(n) / 1e8).toFixed(8);
  assert.equal(feeLine(8000n, 1600, { rate: 5000n, suggested: 47_000n }, fmt), 'Network fee: 0.00008000 CKB (about 5000 shannons/KB; node suggested 47000, capped at 5000)');
  assert.match(feeLine(1600n, 1600, { rate: 1000n }, fmt), /about 1000 shannons\/KB; node gave no estimate; minimum used/);
  assert.match(feeLine(3200n, 1600, { rate: 2000n, suggested: 2000n }, fmt), /about 2000 shannons\/KB; node suggested 2000\)$/);
});
