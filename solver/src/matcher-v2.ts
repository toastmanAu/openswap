// Inventory-free reciprocal matching over v2 orders (partially fillable) and
// whole v1 lots. Pairwise and bounded: one order is always filled completely
// and the other as little as its rules allow. Every v2 leg is re-planned by the
// SDK, which checks it against the lock model. Not a promise of optimal routing.
import { assetKey, isExpired, isV2, orderKey, partialRange, planFillV2, requiredPayment, type AnyOrder } from '@openswap/sdk';

export interface Leg { order: AnyOrder; /** Offer units taken; undefined = whole v1 lot. */ take?: bigint; delivered: bigint; paid: bigint }
export interface PairMatch { legs: [Leg, Leg]; surplus: Map<string, bigint> }

const available = (o: AnyOrder) => isV2(o) ? o.available : o.offerAmount;
const pay = (o: AnyOrder, take: bigint) => isV2(o) ? requiredPayment(o, take) : o.askAmount;
/** Smallest allowed take of at least `x`, or undefined. */
function snapUp(o: AnyOrder, x: bigint): bigint | undefined {
  const all = available(o);
  if (x > all) return undefined;
  if (!isV2(o)) return all;
  const range = partialRange(o);
  if (range && x <= range.max) return x < range.min ? range.min : x;
  return all;
}
function leg(o: AnyOrder, take: bigint): Leg | undefined {
  if (!isV2(o)) return take === o.offerAmount ? { order: o, delivered: take, paid: o.askAmount } : undefined;
  try { const p = planFillV2(o, take); return { order: o, take, delivered: p.taken, paid: p.paid }; } catch { return undefined; }
}

/** Match L (offers A, asks B) against R (offers B, asks A). */
export function matchPair(l: AnyOrder, r: AnyOrder): PairMatch | undefined {
  if (assetKey(l.offerAsset) !== assetKey(r.askAsset) || assetKey(l.askAsset) !== assetKey(r.offerAsset)) return;
  const tries: [bigint, bigint][] = [];
  const fullL = available(l), needB = pay(l, fullL), xR = snapUp(r, needB);
  if (xR !== undefined) tries.push([fullL, xR]);
  const fullR = available(r), needA = pay(r, fullR), xL = snapUp(l, needA);
  if (xL !== undefined) tries.push([xL, fullR]);
  for (const [takeL, takeR] of tries) {
    const a = leg(l, takeL), b = leg(r, takeR);
    if (!a || !b || b.paid > a.delivered || a.paid > b.delivered) continue;
    const surplus = new Map([[assetKey(l.offerAsset), a.delivered - b.paid], [assetKey(r.offerAsset), b.delivered - a.paid]]);
    return { legs: [a, b], surplus };
  }
}

export function matchV2(orders: AnyOrder[], options: { nowSeconds: bigint; expiryMarginSeconds?: bigint; maxCandidates?: number; maxChecks?: number }): PairMatch | undefined {
  const margin = options.expiryMarginSeconds ?? 300n, cap = options.maxCandidates ?? 1000, checks = options.maxChecks ?? 100_000;
  if (!Number.isSafeInteger(cap) || cap < 2 || cap > 10000 || !Number.isSafeInteger(checks) || checks < 1 || checks > 1_000_000) throw new Error('Invalid solver search bounds');
  const books = new Map<string, AnyOrder[]>(), ids = new Set<string>(), locks = new Set<string>();
  for (const o of orders.slice(0, cap)) {
    if (!o.supported || ids.has(orderKey(o)) || locks.has(o.lock.hash())) continue;
    // Honest-solver policy: never fill at or near expiry (median time lags).
    if (isV2(o) && isExpired(o, options.nowSeconds + margin)) continue;
    ids.add(orderKey(o)); locks.add(o.lock.hash());
    const key = `${o.genesisHash}:${assetKey(o.offerAsset)}>${assetKey(o.askAsset)}`;
    books.set(key, [...(books.get(key) ?? []), o]);
  }
  const price = (a: AnyOrder, b: AnyOrder) => { const d = a.askAmount * b.offerAmount - b.askAmount * a.offerAmount; return d < 0n ? -1 : d > 0n ? 1 : orderKey(a).localeCompare(orderKey(b)); };
  let work = 0;
  for (const key of [...books.keys()].sort()) {
    const left = books.get(key)!, o = left[0]!;
    const reverse = `${o.genesisHash}:${assetKey(o.askAsset)}>${assetKey(o.offerAsset)}`;
    const right = books.get(reverse);
    if (!right || key > reverse) continue;
    left.sort(price); right.sort(price);
    for (const l of left) for (const r of right) {
      if (++work > checks) return;
      const m = matchPair(l, r);
      if (m) return m;
    }
  }
}
