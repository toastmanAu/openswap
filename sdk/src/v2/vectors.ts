// Deterministic shared vectors for the v2 lock. Written to lock-v2-tests/vectors/
// by scripts/generate-lock-v2-vectors.ts; the Rust VM tests run every fill vector
// against the real binary and expect the model's verdict.
import { ccc } from '@ckb-ccc/core';
import { udt, CKB } from '../types.js';
import { writeLE } from '../codec.js';
import { encodeTermsV2, expiryAt, type OpenSwapTermsV2 } from './codec.js';
import { checkFill, requiredPayment, type ModelCell, type ModelTerms } from './model.js';

type Label = 'owner' | 'order' | 'twin' | 'other';
type TypeLabel = 'a' | 'b' | null;
export interface FillVector {
  name: string;
  terms: { capacityRefund: string; ask: TypeLabel; askAmount: string; offerAmount: string; minFill: string };
  index: number;
  order: { type: TypeLabel; capacity: string; data: string };
  outputs: { lock: Label; type: TypeLabel; capacity: string; data: string }[];
  expected: number;
}

const hex = (b: Uint8Array) => ccc.hexFrom(b);
const amt = (n: bigint) => writeLE(n, 16);
const CKB_UNIT = 100_000_000n;

interface Case { terms: ModelTerms & { ask: TypeLabel }; index: number; order: ModelCell & { type: TypeLabel }; outputs: (ModelCell & { lock: Label; type: TypeLabel })[] }

function verdict(c: Case): number { return checkFill(c.terms, 'order', c.order, c.index, c.outputs); }
function toVector(name: string, c: Case): FillVector {
  return {
    name,
    terms: { capacityRefund: String(c.terms.capacityRefund), ask: c.terms.ask, askAmount: String(c.terms.askAmount), offerAmount: String(c.terms.offerAmount), minFill: String(c.terms.minFill) },
    index: c.index,
    order: { type: c.order.type, capacity: String(c.order.capacity), data: hex(c.order.data) },
    outputs: c.outputs.map(o => ({ lock: o.lock, type: o.type, capacity: String(o.capacity), data: hex(o.data) })),
    expected: verdict(c),
  };
}

function rng(seed: bigint) {
  let s = seed & ((1n << 64n) - 1n);
  const next = () => { s ^= (s << 13n) & ((1n << 64n) - 1n); s ^= s >> 7n; s ^= (s << 17n) & ((1n << 64n) - 1n); return s; };
  return { next, below: (n: bigint) => n <= 0n ? 0n : next() % n, pick: <T>(xs: readonly T[]) => xs[Number(next() % BigInt(xs.length))]! };
}

/** A valid fill of one of the three shapes, partial or final. */
function valid(kind: 'udt-ckb' | 'udt-udt' | 'ckb-udt', partial: boolean, r: ReturnType<typeof rng>, index: number): Case {
  const offerAmount = 1000n + r.below(1n << 40n), askAmount = 1n + r.below(1n << 40n);
  const minFill = 1n + r.below(offerAmount / 4n);
  const owner = 'owner';
  const filler = Array.from({ length: index }, () => ({ lock: 'other' as Label, type: null, capacity: 61n * CKB_UNIT, data: new Uint8Array() }));
  if (kind === 'ckb-udt') {
    const refund = 142n * CKB_UNIT + r.below(CKB_UNIT);
    const capacity = refund * 3n + offerAmount;
    const terms = { owner, capacityRefund: refund, ask: 'b' as TypeLabel, askAmount, offerAmount, minFill };
    const taken = partial ? minFill + r.below(offerAmount - 2n * minFill) : capacity - refund;
    const paid = requiredPayment(terms, taken) + r.below(3n);
    const outputs: Case['outputs'] = [...filler, { lock: 'owner', type: 'b', capacity: refund, data: amt(paid) }];
    if (partial) outputs.push({ lock: 'order', type: null, capacity: capacity - taken - refund, data: new Uint8Array() });
    return { terms, index, order: { lock: 'order', type: null, capacity, data: new Uint8Array() }, outputs };
  }
  const ask: TypeLabel = kind === 'udt-ckb' ? null : 'b';
  const capacity = 300n * CKB_UNIT + r.below(1000n * CKB_UNIT);
  const terms = { owner, capacityRefund: 0n, ask, askAmount: ask === null ? 1n + r.below(1n << 50n) : askAmount, offerAmount, minFill };
  const amountIn = offerAmount - r.below(offerAmount / 3n);
  const taken = partial ? minFill + r.below(amountIn - 2n * minFill) : amountIn;
  const paid = requiredPayment(terms, taken) + r.below(3n);
  const leaving = partial ? 144n * CKB_UNIT + r.below(CKB_UNIT) : capacity;
  const payment = ask === null
    ? { lock: 'owner' as Label, type: null, capacity: leaving + paid, data: new Uint8Array() }
    : { lock: 'owner' as Label, type: 'b' as TypeLabel, capacity: leaving, data: amt(paid) };
  const outputs: Case['outputs'] = [...filler, payment];
  if (partial) outputs.push({ lock: 'order', type: 'a', capacity: capacity - leaving, data: amt(amountIn - taken) });
  return { terms, index, order: { lock: 'order', type: 'a', capacity, data: amt(amountIn) }, outputs };
}

const U64 = (1n << 64n) - 1n, U128 = (1n << 128n) - 1n;
/** Only on-chain representable cells and terms become vectors. */
function representable(c: Case): boolean {
  const caps = [c.order.capacity, ...c.outputs.map(o => o.capacity), c.terms.capacityRefund];
  const amounts = [c.terms.askAmount, c.terms.offerAmount, c.terms.minFill];
  return caps.every(n => n >= 0n && n <= U64) && amounts.every(n => n > 0n && n <= U128) && c.terms.minFill <= c.terms.offerAmount;
}

function taken0(c: Case): bigint { return BigInt(ccc.numLeFromBytes(c.order.data)); }

function mutate(c: Case, r: ReturnType<typeof rng>): Case {
  const m: Case = structuredClone(c);
  if (m.outputs.length === 0) return m;
  const o = m.outputs[Number(r.below(BigInt(m.outputs.length)))]!;
  const delta = r.pick([1n, -1n, CKB_UNIT, -CKB_UNIT, 1000n]);
  switch (Number(r.below(14n))) {
    case 0: o.capacity = o.capacity + delta < 0n ? 0n : o.capacity + delta; break;
    case 1: if (o.data.length === 16) { const v = BigInt(ccc.numLeFromBytes(o.data)) + delta; o.data = amt(v < 0n ? 0n : v); } break;
    case 2: o.lock = r.pick(['owner', 'order', 'twin', 'other'] as const); break;
    case 3: o.type = r.pick(['a', 'b', null] as const); break;
    case 4: o.data = r.pick([new Uint8Array(), new Uint8Array(15), new Uint8Array(17), amt(0n)]); break;
    case 5: m.outputs.push(structuredClone(m.outputs[m.outputs.length - 1]!)); break;
    case 6: m.outputs.pop(); break;
    case 7: m.terms.minFill = r.pick([1n, m.terms.minFill * 2n, m.terms.offerAmount]); break;
    case 8: m.terms.askAmount += r.pick([1n, m.terms.askAmount]); break;
    case 9: m.order.capacity += delta; break;
    case 10: m.order.data = r.pick([amt(0n), new Uint8Array(), new Uint8Array(3)]); break;
    case 11: m.terms.capacityRefund = r.pick([0n, 1n, m.terms.capacityRefund + 1n]); break;
    case 12: m.outputs.push({ lock: 'twin', type: m.order.type, capacity: CKB_UNIT * 61n, data: m.order.data }); break;
    default: m.outputs.reverse(); break;
  }
  return m;
}

export function buildFillVectors(): FillVector[] {
  const r = rng(0x6f70_656e_7377_6170n);
  const vectors: FillVector[] = [];
  const kinds = ['udt-ckb', 'udt-udt', 'ckb-udt'] as const;
  for (const kind of kinds) for (const partial of [false, true]) {
    const base = valid(kind, partial, r, 0);
    if (!representable(base)) throw new Error('base not representable');
    const v = toVector(`${kind}_${partial ? 'partial' : 'final'}`, base);
    if (v.expected !== 0) throw new Error(`base case ${v.name} rejected with ${v.expected}`);
    vectors.push(v);
  }
  // Named boundaries. Each edit starts from a valid case; `want` pins the verdict.
  const edge = (name: string, kind: typeof kinds[number], partial: boolean, want: number, edit: (c: Case) => void) => {
    const c = valid(kind, partial, r, 1); edit(c); if (!representable(c)) throw new Error(`${name} is not representable`); const v = toVector(name, c);
    if (v.expected !== want) throw new Error(`${name}: model says ${v.expected}, expected ${want}`);
    vectors.push(v);
  };
  const pay = (c: Case) => c.outputs[c.index]!, rem = (c: Case) => c.outputs[c.index + 1]!;
  const setAmount = (o: ModelCell, n: bigint) => { o.data = amt(n); };
  const taken = (c: Case) => c.order.type === null ? c.order.capacity - rem(c).capacity - pay(c).capacity : BigInt(ccc.numLeFromBytes(c.order.data)) - BigInt(ccc.numLeFromBytes(rem(c).data));
  for (const kind of kinds) {
    const udtAsk = kind !== 'udt-ckb';
    // Exact price: required payment accepted, one unit less rejected.
    for (const [suffix, minus, want] of [['exact', 0n, 0], ['one_short', 1n, 55]] as const) edge(`${kind}_price_${suffix}`, kind, true, want, c => {
      const need = requiredPayment(c.terms, taken(c)) - minus;
      if (udtAsk) setAmount(pay(c), need); else pay(c).capacity = c.order.capacity - rem(c).capacity + need;
    });
    edge(`${kind}_final_below_min_fill_ok`, kind, false, 0, c => { c.terms.minFill = c.terms.offerAmount; });
    edge(`${kind}_two_remainders`, kind, true, 70, c => { c.outputs.push(structuredClone(rem(c))); });
    edge(`${kind}_remainder_wrong_type`, kind, true, 71, c => { rem(c).type = c.order.type === null ? 'a' : null; });
    edge(`${kind}_remainder_grows_capacity`, kind, true, 73, c => { rem(c).capacity = c.order.capacity + 1n; });
    edge(`${kind}_no_offer_taken`, kind, true, 74, c => {
      if (c.order.type === null) { rem(c).capacity = c.order.capacity - pay(c).capacity; } else { rem(c).data = c.order.data; if (!udtAsk) pay(c).capacity = c.order.capacity - rem(c).capacity; else pay(c).capacity = c.order.capacity - rem(c).capacity; }
    });
    edge(`${kind}_twin_lock_is_not_remainder`, kind, false, 0, c => { c.outputs.push({ lock: 'twin', type: c.order.type, capacity: 61n * CKB_UNIT, data: c.order.data }); });
  }
  edge('udt_remainder_above_input', 'udt-udt', true, 74, c => { setAmount(rem(c), BigInt(ccc.numLeFromBytes(c.order.data)) + 1n); });
  edge('ckb_payment_above_leaving', 'ckb-udt', true, 74, c => { rem(c).capacity = c.order.capacity - pay(c).capacity + 1n; });
  edge('same_asset', 'udt-udt', false, 43, c => { c.terms.ask = 'a'; });
  edge('udt_udt_payment_capacity_not_leaving', 'udt-udt', true, 56, c => { pay(c).capacity += 1n; });
  edge('ckb_udt_payment_capacity_not_refund', 'ckb-udt', true, 56, c => { pay(c).capacity += 1n; rem(c).capacity -= 1n; });
  edge('udt_ckb_payment_below_leaving', 'udt-ckb', true, 56, c => { pay(c).capacity = c.order.capacity - rem(c).capacity - 1n; });
  edge('ckb_remainder_below_refund', 'ckb-udt', true, 76, c => { const all = c.order.capacity - pay(c).capacity; rem(c).capacity = c.terms.capacityRefund - 1n; void all; setAmount(pay(c), (1n << 127n)); });
  edge('fill_below_min_fill', 'udt-ckb', true, 75, c => { c.terms.minFill = taken(c) + 1n; });
  edge('remainder_below_min_fill', 'udt-udt', true, 76, c => { c.terms.minFill = BigInt(ccc.numLeFromBytes(rem(c).data)) + 1n; if (c.terms.minFill > taken(c)) c.terms.minFill = taken(c); setAmount(rem(c), c.terms.minFill - 1n); setAmount(pay(c), 1n << 120n); });
  edge('ckb_ask_udt_data_on_payment', 'udt-ckb', false, 54, c => { pay(c).data = amt(1n); });
  edge('payment_missing', 'udt-ckb', false, 51, c => { c.outputs.splice(c.index); });
  edge('payment_wrong_owner', 'udt-ckb', false, 52, c => { pay(c).lock = 'other'; });
  edge('payment_to_order_lock', 'udt-ckb', false, 52, c => { pay(c).lock = 'order'; });
  edge('udt_refund_nonzero', 'udt-ckb', false, 42, c => { c.terms.capacityRefund = 1n; });
  edge('ckb_offer_with_data', 'ckb-udt', false, 40, c => { c.order.data = new Uint8Array(1); });
  edge('udt_offer_zero', 'udt-ckb', false, 41, c => { c.order.data = amt(0n); });
  edge('max_u128_price', 'udt-udt', false, 0, c => { c.terms.askAmount = (1n << 128n) - 1n; c.terms.offerAmount = (1n << 128n) - 1n; setAmount(pay(c), taken0(c)); });
  for (let i = 0; i < 600; i++) {
    const base = valid(r.pick(kinds), r.below(2n) === 0n, r, Number(r.below(3n)));
    let c = base; const steps = Number(r.below(3n));
    for (let s = 0; s < steps; s++) c = mutate(c, r);
    if (representable(c)) vectors.push(toVector(`random_${i}`, c));
  }
  return vectors;
}

const owner = ccc.Script.from({ codeHash: '0x' + '11'.repeat(32), hashType: 'type', args: '0x' + '33'.repeat(20) });
const ask = ccc.Script.from({ codeHash: '0x' + '22'.repeat(32), hashType: 'data1', args: '0x' + '44'.repeat(32) });
export interface WireVector { name: string; argsHex: string; errorCode?: number; terms?: Record<string, string | null> }
export function buildWireVectors(): WireVector[] {
  const base: OpenSwapTermsV2 = { ownerLock: owner, nonce: new Uint8Array(16).fill(1), capacityRefund: 14_200_000_000n, expiry: 0n, askAsset: udt(ask), askAmount: 100n, offerAmount: 1000n, minFill: 50n };
  const ok = (name: string, t: OpenSwapTermsV2): WireVector => ({ name, argsHex: encodeTermsV2(t), terms: {
    ownerScriptHex: ccc.hexFrom(t.ownerLock.toBytes()), nonceHex: ccc.hexFrom(t.nonce), capacityRefund: String(t.capacityRefund), expiry: String(t.expiry),
    askScriptHex: t.askAsset.kind === 'udt' ? ccc.hexFrom(t.askAsset.script.toBytes()) : null, askAmount: String(t.askAmount), offerAmount: String(t.offerAmount), minFill: String(t.minFill) } });
  const vectors = [ok('udt_ask', base), ok('ckb_ask', { ...base, askAsset: CKB, capacityRefund: 0n }), ok('expiry', { ...base, expiry: expiryAt(1_793_000_000n) }),
    ok('full_fill_only', { ...base, minFill: 1000n }), ok('max_values', { ...base, askAmount: (1n << 128n) - 1n, offerAmount: (1n << 128n) - 1n, minFill: (1n << 128n) - 1n, capacityRefund: (1n << 64n) - 1n })];
  const o = owner.toBytes().length, b = ccc.bytesFrom(vectors[0]!.argsHex), end = b.length;
  const bad = (name: string, errorCode: number, change: (x: Uint8Array) => Uint8Array | void) => { const x = b.slice(); vectors.push({ name, errorCode, argsHex: ccc.hexFrom(change(x) ?? x) }); };
  bad('v1_version', 27, x => { x[o] = 1; }); bad('flags', 28, x => { x[o + 1] = 1; }); bad('reserved', 29, x => { x[o + 3] = 1; });
  bad('zero_nonce', 30, x => { x.fill(0, o + 4, o + 20); });
  bad('relative_expiry', 37, x => { x.set(writeLE(expiryAt(5n) | (1n << 63n), 8), o + 28); });
  bad('block_expiry', 37, x => { x.set(writeLE(5n, 8), o + 28); });
  bad('reserved_since_bits', 37, x => { x.set(writeLE(expiryAt(5n) | (1n << 56n), 8), o + 28); });
  bad('zero_timestamp_expiry', 37, x => { x.set(writeLE(0x4000_0000_0000_0000n, 8), o + 28); });
  bad('oversized_ask', 24, x => { x.set(writeLE(1025n, 4), o + 36); });
  bad('invalid_ask', 25, x => { x[o + 44] = 15; });
  bad('zero_ask', 31, x => { x.fill(0, end - 48, end - 32); });
  bad('zero_offer', 35, x => { x.fill(0, end - 32, end - 16); });
  bad('zero_min_fill', 36, x => { x.fill(0, end - 16, end); });
  bad('min_fill_above_offer', 36, x => { x.set(writeLE(1001n, 16), end - 16); });
  bad('trailing', 26, x => new Uint8Array([...x, 0])); bad('short_tail', 21, x => x.slice(0, o + 87));
  bad('v1_tail', 21, x => x.slice(0, o + 48));
  return vectors;
}
