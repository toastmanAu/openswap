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
// Solver books: several crossing orders per side matched by matchBook, laid out as
// fillOrdersV2 does (payments at input indexes in leg order, remainders after).
if (input.books) {
  const { matchBook } = await import('../../solver/src/matcher-v2.js');
  const markets = [[udt(a), udt(b)], [CKB, udt(b)], [udt(a), CKB]] as const;
  const books = [];
  let nonce = 1;
  for (let i = 0; books.length < input.books && i < input.books * 30; i++) {
    const [x, y] = markets[i % 3]!;
    const amount = (asset: typeof x) => asset.kind === 'ckb' ? (1000n + next(20_000n)) * UNIT : 1000n + next(1n << 40n);
    // A reference price for the market, then each order within +-20% of it.
    const refOffer = amount(x), refAsk = amount(y);
    const make = async (offer: typeof x, ask: typeof x, side: 'left' | 'right') => {
      const offerAmount = amount(offer), spread = 80n + next(41n);
      // left offers x for y near refAsk/refOffer; right offers y for x near refOffer/refAsk.
      const askAmount = (side === 'left' ? offerAmount * refAsk / refOffer : offerAmount * refOffer / refAsk) * spread / 100n || 1n;
      const n = nonce++ % 250 + 1;
      const plan = planCreateV2(deployment, { ownerLock: owner, nonce: new Uint8Array(16).fill(n).map((v, k) => k === 0 ? v : (v + k * 7 + nonce) & 255), askAsset: ask, expiry: 0n }, offer, { offerAmount, askAmount, minFill: 1n + next(offerAmount / 8n), partialFills: Number(next(5n)) });
      return { plan, order: await parseV2(ccc.Cell.from({ ...plan.cell, outPoint: { txHash: `0x${'dd'.repeat(32)}`, index: n } }), deployment, resolver) };
    };
    try {
      const lefts: Awaited<ReturnType<typeof make>>[] = [], rights: Awaited<ReturnType<typeof make>>[] = [];
      for (let k = 0, nl = 1 + Number(next(4n)); k < nl; k++) lefts.push(await make(x, y, 'left'));
      for (let k = 0, nr = 1 + Number(next(4n)); k < nr; k++) rights.push(await make(y, x, 'right'));
      const best = (p: typeof lefts) => [...p].sort((u, v) => { const d = u.order.askAmount * v.order.offerAmount - v.order.askAmount * u.order.offerAmount; return d < 0n ? -1 : d > 0n ? 1 : 0; });
      const L = best(lefts), R = best(rights);
      const m = matchBook(L.map(o => o.order), R.map(o => o.order), { maxLegs: 8 });
      if (!m || m.legs.length < 3) continue;
      const cellOf = new Map([...L, ...R].map(o => [o.order, o.plan.cell]));
      const plans = m.legs.map(leg => planFillV2(leg.order as OpenSwapOrderV2, leg.take!));
      books.push({ orders: m.legs.map(leg => enc(cellOf.get(leg.order as OpenSwapOrderV2)!)), payments: plans.map(p => enc(p.payment)), remainders: plans.filter(p => p.remainder).map(p => enc(p.remainder!)), partial: plans.some(p => !p.final), legs: m.legs.length });
    } catch { continue; }
  }
  process.stdout.write(JSON.stringify({ books }) + '\n', () => process.exit(0));
  await new Promise(() => {});
}
// Solver rings: three orders forming a cycle of assets (both orientations over a, b and
// CKB), matched by matchRing and laid out as fillOrdersV2 does.
if (input.rings) {
  const { matchRing } = await import('../../solver/src/matcher-v2.js');
  const cycles = [[udt(a), udt(b), CKB], [udt(a), CKB, udt(b)]] as const;
  const rings = [];
  let nonce = 1;
  for (let i = 0; rings.length < input.rings && i < input.rings * 40; i++) {
    const cycle = cycles[i % 2]!;
    const amount = (asset: (typeof cycle)[number]) => asset.kind === 'ckb' ? (1000n + next(20_000n)) * UNIT : 1000n + next(1n << 40n);
    // Reference values per asset; each order asks within 80-104% of the fair rate, so most rings profit.
    const ref = cycle.map(amount);
    try {
      const orders = [];
      for (let k = 0; k < 3; k++) {
        const offer = cycle[k]!, ask = cycle[(k + 1) % 3]!, offerAmount = amount(offer);
        const askAmount = offerAmount * ref[(k + 1) % 3]! / ref[k]! * (80n + next(25n)) / 100n || 1n;
        const n = nonce++;
        const plan = planCreateV2(deployment, { ownerLock: owner, nonce: new Uint8Array(16).map((_, j) => (n * 31 + j * 7 + 3) & 255), askAsset: ask, expiry: 0n }, offer, { offerAmount, askAmount, minFill: 1n + next(offerAmount / 8n), partialFills: Number(next(5n)) });
        orders.push({ plan, order: await parseV2(ccc.Cell.from({ ...plan.cell, outPoint: { txHash: `0x${'ee'.repeat(32)}`, index: n } }), deployment, resolver) });
      }
      const m = matchRing(orders[0]!.order, orders[1]!.order, orders[2]!.order);
      if (!m) continue;
      const plans = m.legs.map(leg => planFillV2(leg.order as OpenSwapOrderV2, leg.take!));
      rings.push({ orders: orders.map(o => enc(o.plan.cell)), payments: plans.map(p => enc(p.payment)), remainders: plans.filter(p => p.remainder).map(p => enc(p.remainder!)), partial: plans.some(p => !p.final), ckbFirst: cycle[1]!.kind === 'ckb' });
    } catch { continue; }
  }
  process.stdout.write(JSON.stringify({ rings }) + '\n', () => process.exit(0));
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
