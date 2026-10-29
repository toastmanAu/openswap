// Invoked by lock-v2-tests: SDK-planned v2 order chains (create, partial fills,
// final fill) for replay on the real binary. Deterministic, no keys or RPC.
import { readFileSync } from 'node:fs';
import { ccc } from '@ckb-ccc/core';
import { CKB, udt, type Deployment } from '../src/types.js';
import { parseV2, partialRange, planCreateV2, planFillV2, type OpenSwapOrderV2 } from '../src/v2/orders.js';
import { defaultResolver } from '../src/assets.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const deployment: Deployment = { network: 'testnet', genesisHash: `0x${'00'.repeat(32)}`, codeHash: input.codeHash, hashType: 'data1', cellDep: { outPoint: { txHash: `0x${'00'.repeat(32)}`, index: 0 }, depType: 'code' } };
const owner = ccc.Script.fromBytes(input.owner), a = ccc.Script.fromBytes(input.a), b = ccc.Script.fromBytes(input.b);
// Accept the fixture's always-success type scripts as plain 16-byte UDTs.
const resolver = { ...defaultResolver({} as ccc.Client), identify: async (s?: ccc.Script) => ({ asset: s ? udt(s) : CKB, supported: true }) } as never;
let s = BigInt(input.seed);
const next = (n: bigint) => { s ^= (s << 13n) & 0xffff_ffff_ffff_ffffn; s ^= s >> 7n; s ^= (s << 17n) & 0xffff_ffff_ffff_ffffn; return n <= 0n ? 0n : s % n; };
const enc = (c: ccc.CellAny) => ({ output: ccc.hexFrom(c.cellOutput.toBytes()), data: c.outputData });
const UNIT = 100_000_000n;
const shapes = [['a', 'ckb'], ['a', 'b'], ['ckb', 'b']] as const;
// Solver pairs: random crossing orders matched by the reference matcher, laid out
// as fillOrdersV2 does (payments at input indexes, remainders after).
if (input.pairs) {
  const { matchPair } = await import('../../solver/src/matcher-v2.js');
  const markets = [[udt(a), udt(b)], [CKB, udt(b)], [udt(a), CKB]] as const;
  const pairs = [];
  for (let i = 0; pairs.length < input.pairs && i < input.pairs * 20; i++) {
    const [x, y] = markets[i % 3]!;
    const amount = (asset: typeof x) => asset.kind === 'ckb' ? (1000n + next(50_000n)) * UNIT : 1000n + next(1n << 50n);
    const make = async (offer: typeof x, ask: typeof x, n: number, crossBy: bigint) => {
      const offerAmount = amount(offer), base = amount(ask);
      // Price relative to the other side; crossBy < 100 makes this side cheaper.
      const askAmount = base * crossBy / 100n || 1n;
      const plan = planCreateV2(deployment, { ownerLock: owner, nonce: new Uint8Array(16).fill(n), askAsset: ask, expiry: 0n }, offer, { offerAmount, askAmount, minFill: 1n + next(offerAmount / 8n), partialFills: Number(next(4n)) });
      return { plan, order: await parseV2(ccc.Cell.from({ ...plan.cell, outPoint: { txHash: `0x${'cc'.repeat(32)}`, index: n } }), deployment, resolver) };
    };
    try {
      const l = await make(x, y, 1, 100n), r = await make(y, x, 2, 1n + next(100n));
      const m = matchPair(l.order, r.order);
      if (!m) continue;
      const plans = m.legs.map(leg => planFillV2(leg.order as OpenSwapOrderV2, leg.take!));
      pairs.push({ orders: [enc(l.plan.cell), enc(r.plan.cell)], payments: plans.map(p => enc(p.payment)), remainders: plans.filter(p => p.remainder).map(p => enc(p.remainder!)), partial: plans.some(p => !p.final) });
    } catch { continue; }
  }
  // Exit only after the pipe has flushed; exiting directly truncates at 64 KiB.
  process.stdout.write(JSON.stringify({ pairs }) + '\n', () => process.exit(0));
  await new Promise(() => {});
}
const scenarios = [];
for (let i = 0; i < input.count; i++) {
  const [offerKind, askKind] = shapes[i % 3]!;
  const offer = offerKind === 'ckb' ? CKB : udt(a), ask = askKind === 'ckb' ? CKB : udt(b);
  const offerAmount = offerKind === 'ckb' ? (2000n + next(20_000n)) * UNIT : 1000n + next(1n << 60n);
  const askAmount = askKind === 'ckb' ? (1n + next(10_000n)) * UNIT : 1n + next(1n << 60n);
  const minFill = 1n + next(offerAmount / 6n), partialFills = Number(next(5n));
  const plan = planCreateV2(deployment, { ownerLock: owner, nonce: new Uint8Array(16).fill(i % 255 + 1), askAsset: ask, expiry: 0n }, offer, { offerAmount, askAmount, minFill, partialFills });
  let order: OpenSwapOrderV2 = await parseV2(ccc.Cell.from({ ...plan.cell, outPoint: { txHash: `0x${'aa'.repeat(32)}`, index: 0 } }), deployment, resolver);
  const steps = [];
  for (let k = 0; k < 12; k++) {
    const range = partialRange(order);
    let fill;
    if (range && next(4n) !== 0n) {
      try { fill = planFillV2(order, range.min + next(range.max - range.min + 1n)); } catch { fill = undefined; }
    }
    fill ??= planFillV2(order, order.available);
    steps.push({ take: String(fill.taken), paid: String(fill.paid), payment: enc(fill.payment), remainder: fill.remainder && enc(fill.remainder) });
    if (!fill.remainder) break;
    order = await parseV2(ccc.Cell.from({ ...fill.remainder, outPoint: { txHash: `0x${'bb'.repeat(32)}`, index: k + 1 } }), deployment, resolver);
  }
  scenarios.push({ shape: `${offerKind}->${askKind}`, partialFills, order: enc(plan.cell), steps });
}
console.log(JSON.stringify({ scenarios }));
