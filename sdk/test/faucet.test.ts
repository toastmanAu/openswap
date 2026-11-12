import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import { amountData, checkFaucetClaim, faucetConfigFrom, type FaucetConfig } from '../src/index.js';

const script = (byte: string, codeHash = `0x${'9b'.repeat(32)}`) => ccc.Script.from({ codeHash, hashType: 'type', args: `0x${byte.repeat(20)}` });
const xudt = (byte: string) => ccc.Script.from({ codeHash: `0x${'50'.repeat(32)}`, hashType: 'data1', args: `0x${byte.repeat(32)}` });
const faucet = script('fa'), claimant = script('c1'), stranger = script('d2');
const A = xudt('a1'), B = xudt('b2'), C = xudt('c3');
const config: FaucetConfig = faucetConfigFrom({ lock: faucet, maxFee: 1_000_000, grants: [{ symbol: 'A', decimals: 8, token: A, amount: 1000 }, { symbol: 'B', decimals: 8, token: B, amount: '500' }] });
const STOCK = 143_00000000n, NEW = 144_00000000n;
let n = 0;
const cell = (lock: ccc.Script, capacity: bigint, type?: ccc.Script, amount?: bigint) =>
  ccc.Cell.from({ outPoint: { txHash: ccc.hexFrom(new Uint8Array(32).fill(++n)), index: 0 }, cellOutput: { lock, type, capacity }, outputData: amount === undefined ? '0x' : amountData(amount) });
type Out = { lock: ccc.Script; type?: ccc.Script; capacity: bigint; amount?: bigint };
function claim(inputs: ccc.Cell[], outputs: Out[]) {
  const tx = ccc.Transaction.from({ inputs: inputs.map(c => ({ previousOutput: c.outPoint })), outputs: outputs.map(o => ({ lock: o.lock, type: o.type, capacity: o.capacity })), outputsData: outputs.map(o => o.amount === undefined ? '0x' : amountData(o.amount)) });
  return { tx, inputs };
}
/** A valid claim of A: stock 10,000 A, claimant pays 144 CKB of capacity and a 0.0001 CKB fee. */
const good = (extra: Partial<{ given: bigint; stockBack: bigint; fee: bigint }> = {}) => {
  const fee = extra.fee ?? 10_000n, given = extra.given ?? 1000n;
  return claim([cell(faucet, STOCK, A, 10_000n), cell(claimant, 1000_00000000n)], [
    { lock: faucet, type: A, capacity: extra.stockBack ?? STOCK, amount: 10_000n - given },
    { lock: claimant, type: A, capacity: NEW, amount: given },
    { lock: claimant, capacity: 1000_00000000n - NEW - fee - ((extra.stockBack ?? STOCK) - STOCK) },
  ]);
};
const none = () => 0n;
const check = (c: ReturnType<typeof claim>, balances = none) => checkFaucetClaim(c.tx, c.inputs, config, balances);

test('faucet: a claim that moves one grant to its funder is accepted', () => {
  const result = check(good());
  assert(result.claimant.eq(claimant));
  assert.deepEqual(result.granted.map(g => g.symbol), ['A']);
  assert.equal(result.fee, 10_000n);
});

test('faucet: two tokens in one claim; exact amounts only', () => {
  const two = claim([cell(faucet, STOCK, A, 5000n), cell(faucet, STOCK, B, 5000n), cell(claimant, 1000_00000000n)], [
    { lock: faucet, type: A, capacity: STOCK, amount: 4000n }, { lock: claimant, type: A, capacity: NEW, amount: 1000n },
    { lock: faucet, type: B, capacity: STOCK, amount: 4500n }, { lock: claimant, type: B, capacity: NEW, amount: 500n },
    { lock: claimant, capacity: 1000_00000000n - 2n * NEW - 5000n },
  ]);
  assert.deepEqual(check(two).granted.map(g => g.symbol), ['A', 'B']);
  assert.throws(() => check(good({ given: 1001n })), /exactly 1000 base units of A/);
  assert.throws(() => check(good({ given: 999n })), /exactly 1000/);
});

test('faucet: never pays CKB, never splits its stock, never touches other tokens', () => {
  assert.throws(() => check(good({ stockBack: STOCK - 1n })), /pays no CKB/);
  assert.doesNotThrow(() => check(good({ stockBack: STOCK + 1n })), 'a claimant may add capacity to the stock cell');
  const split = claim([cell(faucet, STOCK, A, 10_000n), cell(claimant, 1000_00000000n)], [
    { lock: faucet, type: A, capacity: STOCK / 2n, amount: 4500n }, { lock: faucet, type: A, capacity: STOCK / 2n + 1n, amount: 4500n },
    { lock: claimant, type: A, capacity: NEW, amount: 1000n }, { lock: claimant, capacity: 800_00000000n },
  ]);
  assert.throws(() => check(split), /may not split/);
  const foreign = claim([cell(faucet, STOCK, C, 10_000n), cell(claimant, 1000_00000000n)], [
    { lock: faucet, type: C, capacity: STOCK, amount: 9000n }, { lock: claimant, type: C, capacity: NEW, amount: 1000n }, { lock: claimant, capacity: 800_00000000n },
  ]);
  assert.throws(() => check(foreign), /only the configured test tokens/);
  const plain = claim([cell(faucet, STOCK), cell(faucet, STOCK, A, 10_000n), cell(claimant, 1000_00000000n)], [
    { lock: faucet, type: A, capacity: 2n * STOCK, amount: 9000n }, { lock: claimant, type: A, capacity: NEW, amount: 1000n }, { lock: claimant, capacity: 800_00000000n },
  ]);
  assert.throws(() => check(plain), /only the configured test tokens/);
});

test('faucet: every other cell belongs to the one claimant, who funds the claim', () => {
  const { tx, inputs } = good();
  tx.outputs[2]!.lock = stranger;
  assert.throws(() => checkFaucetClaim(tx, inputs, config, none), /faucet or the claimant/);
  const mixed = claim([cell(faucet, STOCK, A, 10_000n), cell(claimant, 500_00000000n), cell(stranger, 500_00000000n)], [
    { lock: faucet, type: A, capacity: STOCK, amount: 9000n }, { lock: claimant, type: A, capacity: NEW, amount: 1000n }, { lock: claimant, capacity: 800_00000000n },
  ]);
  assert.throws(() => check(mixed), /one lock/);
  const typed = claim([cell(faucet, STOCK, A, 10_000n), cell(claimant, NEW, A, 5n), cell(claimant, 1000_00000000n)], [
    { lock: faucet, type: A, capacity: STOCK, amount: 9000n }, { lock: claimant, type: A, capacity: NEW, amount: 1005n }, { lock: claimant, capacity: 1000_00000000n - 10_000n },
  ]);
  assert.throws(() => check(typed), /plain CKB cells/);
  const unfunded = claim([cell(faucet, STOCK, A, 10_000n)], [{ lock: faucet, type: A, capacity: STOCK - NEW, amount: 9000n }]);
  assert.throws(() => check(unfunded), /must fund/);
  const noStock = claim([cell(claimant, 1000_00000000n)], [{ lock: claimant, capacity: 999_00000000n }]);
  assert.throws(() => check(noStock), /no faucet stock/);
});

test('faucet: refused when the claimant already holds a grant, gives nothing, or overpays the fee', () => {
  assert.throws(() => check(good(), () => 1000n), /already holds/);
  assert.doesNotThrow(() => check(good(), () => 999n));
  assert.throws(() => check(good({ given: 0n })), /gives no tokens/);
  assert.throws(() => check(good({ fee: 1_000_001n })), /at most 1000000 shannons/);
  assert.throws(() => check(good({ fee: 0n })), /must be positive/);
  const { tx, inputs } = good();
  assert.throws(() => checkFaucetClaim(tx, inputs.slice(1), config, none), /resolved/);
});

test('faucet config: positive, distinct grants', () => {
  assert.throws(() => faucetConfigFrom({ lock: faucet, maxFee: 1, grants: [] }), /positive/);
  assert.throws(() => faucetConfigFrom({ lock: faucet, maxFee: 1, grants: [{ symbol: 'A', decimals: 8, token: A, amount: 0 }] }), /positive/);
  assert.throws(() => faucetConfigFrom({ lock: faucet, maxFee: 1, grants: [{ symbol: 'A', decimals: 8, token: A, amount: 1 }, { symbol: 'A2', decimals: 8, token: A, amount: 2 }] }), /repeat/);
});
