// Inventory-free reciprocal matching over v2 orders (partially fillable) and
// whole v1 lots, across several orders per side in one settlement. Bounded: within
// one market, the best-priced prefixes of both sides are tried; one side fills
// completely and only the last order on the other side may fill partly, by as
// little as its rules allow. Every v2 leg is re-planned by the SDK, which checks it
// against the lock model. Not a promise of optimal routing.
import { assetKey, isExpired, isV2, orderKey, partialRange, planFillV2, requiredPayment, type AnyOrder } from '@openswap/sdk';

export interface Leg { order: AnyOrder; /** Offer units taken; undefined = whole v1 lot. */ take?: bigint; delivered: bigint; paid: bigint }
/** Legs in settlement order: every left order (offering A), then every right order (offering B). */
export interface BookMatch { legs: Leg[]; surplus: Map<string, bigint> }
export interface PairMatch extends BookMatch { legs: [Leg, Leg] }

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

/**
 * Match the best-priced orders of one market. `lefts` offer A and ask B, `rights` offer B
 * and ask A, each sorted best first (lowest ask per unit offered). Considers every pair of
 * prefixes up to `maxLegs` orders; in each, one side fills whole and the other side's last
 * order fills only as much as needed. A prefix whose marginal order does not cross on its own
 * can still balance on average; every maker is paid its own price either way, and the per-asset
 * balance check decides. Keeps the plan that delivers the most A, preferring fewer legs on ties.
 * Work is O(maxLegs^3) leg plans. Returns undefined when nothing balances.
 */
export function matchBook(lefts: readonly AnyOrder[], rights: readonly AnyOrder[], options: { maxLegs?: number } = {}): BookMatch | undefined {
  const maxLegs = options.maxLegs ?? 8;
  if (!Number.isSafeInteger(maxLegs) || maxLegs < 2 || maxLegs > 32) throw new Error('maxLegs must be 2..32');
  if (!lefts.length || !rights.length) return;
  const a = assetKey(lefts[0]!.offerAsset), b = assetKey(lefts[0]!.askAsset);
  for (const o of lefts) if (assetKey(o.offerAsset) !== a || assetKey(o.askAsset) !== b) throw new Error('Left orders must share one market');
  for (const o of rights) if (assetKey(o.offerAsset) !== b || assetKey(o.askAsset) !== a) throw new Error('Right orders must be the reverse market');
  let best: { legs: Leg[]; volume: bigint; surplusA: bigint; surplusB: bigint } | undefined;
  const consider = (ls: (Leg | undefined)[], rs: (Leg | undefined)[]) => {
    if (ls.some(x => !x) || rs.some(x => !x)) return;
    const L = ls as Leg[], R = rs as Leg[];
    const deliveredA = L.reduce((s, x) => s + x.delivered, 0n), paidA = R.reduce((s, x) => s + x.paid, 0n);
    const deliveredB = R.reduce((s, x) => s + x.delivered, 0n), paidB = L.reduce((s, x) => s + x.paid, 0n);
    if (paidA > deliveredA || paidB > deliveredB) return;
    const legs = [...L, ...R], volume = paidA;
    if (!best || volume > best.volume || (volume === best.volume && legs.length < best.legs.length))
      best = { legs, volume, surplusA: deliveredA - paidA, surplusB: deliveredB - paidB };
  };
  for (let i = 1; i <= lefts.length && i < maxLegs; i++) {
    for (let j = 1; j <= rights.length && i + j <= maxLegs; j++) {
      const L = lefts.slice(0, i), R = rights.slice(0, j);
      // (a) lefts whole; rights whole but the last, which takes just enough B to pay them.
      const needB = L.reduce((s, o) => s + pay(o, available(o)), 0n), headB = R.slice(0, -1).reduce((s, o) => s + available(o), 0n);
      if (needB > headB) {
        const t = snapUp(R.at(-1)!, needB - headB);
        if (t !== undefined) consider(L.map(o => leg(o, available(o))), [...R.slice(0, -1).map(o => leg(o, available(o))), leg(R.at(-1)!, t)]);
      }
      // (b) rights whole; lefts whole but the last, which takes just enough A to pay them.
      const needA = R.reduce((s, o) => s + pay(o, available(o)), 0n), headA = L.slice(0, -1).reduce((s, o) => s + available(o), 0n);
      if (needA > headA) {
        const t = snapUp(L.at(-1)!, needA - headA);
        if (t !== undefined) consider([...L.slice(0, -1).map(o => leg(o, available(o))), leg(L.at(-1)!, t)], R.map(o => leg(o, available(o))));
      }
    }
  }
  if (!best) return;
  return { legs: best.legs, surplus: new Map([[a, best.surplusA], [b, best.surplusB]]) };
}

/** Match L (offers A, asks B) against R (offers B, asks A): the two-order case of matchBook. */
export function matchPair(l: AnyOrder, r: AnyOrder): PairMatch | undefined {
  if (assetKey(l.offerAsset) !== assetKey(r.askAsset) || assetKey(l.askAsset) !== assetKey(r.offerAsset)) return;
  return matchBook([l], [r], { maxLegs: 2 }) as PairMatch | undefined;
}

export function matchV2(orders: AnyOrder[], options: { nowSeconds: bigint; expiryMarginSeconds?: bigint; maxCandidates?: number; maxLegs?: number; perSide?: number }): BookMatch | undefined {
  const margin = options.expiryMarginSeconds ?? 300n, cap = options.maxCandidates ?? 1000, perSide = options.perSide ?? 24;
  if (!Number.isSafeInteger(cap) || cap < 2 || cap > 10000 || !Number.isSafeInteger(perSide) || perSide < 1 || perSide > 64) throw new Error('Invalid solver search bounds');
  const books = new Map<string, AnyOrder[]>(), ids = new Set<string>(), locks = new Set<string>();
  for (const o of orders.slice(0, cap)) {
    if (!o.supported || ids.has(orderKey(o)) || locks.has(o.lock.hash())) continue;
    // Honest-solver policy: never fill at or near expiry (median time lags).
    if (isV2(o) && isExpired(o, options.nowSeconds + margin)) continue;
    ids.add(orderKey(o)); locks.add(o.lock.hash());
    const key = `${o.genesisHash}:${assetKey(o.offerAsset)}>${assetKey(o.askAsset)}`;
    books.set(key, [...(books.get(key) ?? []), o]);
  }
  // Best first: lowest ask per unit offered; ties by order key for determinism.
  const price = (x: AnyOrder, y: AnyOrder) => { const d = x.askAmount * y.offerAmount - y.askAmount * x.offerAmount; return d < 0n ? -1 : d > 0n ? 1 : orderKey(x).localeCompare(orderKey(y)); };
  for (const key of [...books.keys()].sort()) {
    const left = books.get(key)!, o = left[0]!;
    const reverse = `${o.genesisHash}:${assetKey(o.askAsset)}>${assetKey(o.offerAsset)}`;
    const right = books.get(reverse);
    if (!right || key > reverse) continue;
    const m = matchBook([...left].sort(price).slice(0, perSide), [...right].sort(price).slice(0, perSide), { maxLegs: options.maxLegs });
    if (m) return m;
  }
}
