// Inventory-free reciprocal matching over v2 orders (partially fillable) and
// whole v1 lots, across several orders per side in one settlement, or around a cycle
// of three assets when no direct match exists. Bounded: within
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

/** One order per edge of a cycle: legs[k] offers what legs[k-1] asks (indexes mod 3). */
export interface RingMatch extends BookMatch { ring: true }
/**
 * Match three orders forming a cycle of assets: o1 offers A for B, o2 offers B for C,
 * o3 offers C for A. Each order is paid from what the next one delivers. One order (the
 * anchor) fills whole; the next takes just enough to pay it, and so on around the ring,
 * which closes if the anchor delivers at least what the last order must be paid. Every
 * anchor is tried; the plan with the most orders filled whole, then the most paid to
 * makers, is kept. Inventory-free: no asset may come up short.
 */
export function matchRing(o1: AnyOrder, o2: AnyOrder, o3: AnyOrder): RingMatch | undefined {
  const ring = [o1, o2, o3];
  for (let k = 0; k < 3; k++) if (assetKey(ring[k]!.askAsset) !== assetKey(ring[(k + 1) % 3]!.offerAsset)) return;
  if (new Set(ring.map(o => assetKey(o.offerAsset))).size !== 3) return;
  let best: { legs: Leg[]; whole: number; paid: bigint } | undefined;
  for (let anchor = 0; anchor < 3; anchor++) {
    const takes: bigint[] = [];
    takes[anchor] = available(ring[anchor]!);
    let ok = true;
    for (let step = 1; step < 3 && ok; step++) {
      const prev = (anchor + step - 1) % 3, k = (anchor + step) % 3;
      const t = snapUp(ring[k]!, pay(ring[prev]!, takes[prev]!));
      if (t === undefined) ok = false; else takes[k] = t;
    }
    if (!ok) continue;
    const legs = ring.map((o, k) => leg(o, takes[k]!));
    if (legs.some(l => !l)) continue;
    const L = legs as Leg[];
    // Asset k+1 is delivered by order k+1 and paid to order k.
    if (L.some((l, k) => l.paid > L[(k + 1) % 3]!.delivered)) continue;
    const whole = L.filter((l, k) => l.delivered === available(ring[k]!)).length, paid = L.reduce((s, l) => s + l.paid, 0n);
    if (!best || whole > best.whole || (whole === best.whole && paid > best.paid)) best = { legs: L, whole, paid };
  }
  if (!best) return;
  const surplus = new Map<string, bigint>();
  best.legs.forEach((l, k) => { const asset = assetKey(ring[(k + 1) % 3]!.offerAsset); surplus.set(asset, best!.legs[(k + 1) % 3]!.delivered - l.paid); });
  return { legs: best.legs, surplus, ring: true };
}

/** The best few orders of three books that form a cycle, tried best price first. */
function matchRings(books: Map<string, AnyOrder[]>, keyOf: (o: AnyOrder, ask?: boolean) => string, perEdge: number): RingMatch | undefined {
  const keys = [...books.keys()].sort();
  for (const k1 of keys) {
    const first = books.get(k1)![0]!;
    for (const k2 of keys) {
      const second = books.get(k2)![0]!;
      if (keyOf(second) !== keyOf(first, true)) continue;
      const k3 = keys.find(k => { const o = books.get(k)![0]!; return keyOf(o) === keyOf(second, true) && keyOf(o, true) === keyOf(first); });
      // Each cycle appears once per starting edge; start it at its smallest key.
      if (!k3 || !(k1 < k2 && k1 < k3)) continue;
      for (const a of books.get(k1)!.slice(0, perEdge)) for (const b of books.get(k2)!.slice(0, perEdge)) for (const c of books.get(k3)!.slice(0, perEdge)) {
        const m = matchRing(a, b, c);
        if (m) return m;
      }
    }
  }
}

export function matchV2(orders: AnyOrder[], options: { nowSeconds: bigint; expiryMarginSeconds?: bigint; maxCandidates?: number; maxLegs?: number; perSide?: number; rings?: boolean; perEdge?: number }): BookMatch | undefined {
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
  // No direct match: look for three-asset cycles (A->B->C->A), best orders per book first.
  if (options.rings === false) return;
  for (const book of books.values()) book.sort(price);
  return matchRings(books, (o, ask) => `${o.genesisHash}:${assetKey(ask ? o.askAsset : o.offerAsset)}`, options.perEdge ?? 4);
}
