import { assetKey, comparePrice, orderKey, type OpenSwapOrder } from '@openswap/sdk';
export interface Bundle { orders: OpenSwapOrder[]; surplus: Map<string, bigint> }
export function evaluate(orders: OpenSwapOrder[]): Bundle | undefined {
  if (orders.length < 2 || new Set(orders.map(orderKey)).size !== orders.length || new Set(orders.map(o => o.lock.hash())).size !== orders.length || new Set(orders.map(o => o.genesisHash)).size !== 1 || orders.some(o=>!o.supported)) return;
  const balance = new Map<string, bigint>();
  for (const o of orders) {
    const a = assetKey(o.offerAsset), b = assetKey(o.askAsset);
    balance.set(a, (balance.get(a) ?? 0n) + o.offerAmount);
    balance.set(b, (balance.get(b) ?? 0n) - o.askAmount);
  }
  if ([...balance.values()].some(v=>v<0n)) return;
  return { orders, surplus: balance };
}
/** Deterministic bounded reciprocal prefix search. This is not a promise of optimal routing. */
export function match(orders: OpenSwapOrder[], options: { maxOrders?: number; maxCandidates?: number; maxChecks?: number } = {}): Bundle | undefined {
  const max = options.maxOrders ?? 32, cap = options.maxCandidates ?? 1000, checks = options.maxChecks ?? 100_000;
  if (!Number.isSafeInteger(max) || max < 2 || max > 32 || !Number.isSafeInteger(cap) || cap < 2 || cap > 10000 || !Number.isSafeInteger(checks) || checks < 1 || checks > 1_000_000) throw new Error('Invalid solver search bounds');
  const books = new Map<string, OpenSwapOrder[]>();
  const ids = new Set<string>(), locks = new Set<string>();
  for (const o of orders.slice(0, cap)) {
    if (!o.supported || ids.has(orderKey(o)) || locks.has(o.lock.hash())) continue;
    ids.add(orderKey(o)); locks.add(o.lock.hash());
    const key = `${o.genesisHash}:${assetKey(o.offerAsset)}>${assetKey(o.askAsset)}`;
    const book = books.get(key) ?? []; book.push(o); books.set(key, book);
  }
  let work = 0;
  const pairs: [OpenSwapOrder[], OpenSwapOrder[]][] = [];
  for (const [key, left] of books) {
    left.sort(comparePrice);
    const o = left[0]!;
    const reverse = `${o.genesisHash}:${assetKey(o.askAsset)}>${assetKey(o.offerAsset)}`;
    const right = books.get(reverse);
    if (right && key < reverse) { right.sort(comparePrice); pairs.push([left, right]); }
  }
  // Prefer direct reciprocal pairs before multi-lot bundles.
  for (const [left, right] of pairs) for (const l of left) for (const r of right) {
    if (++work > checks) return;
    if (l.offerAmount >= r.askAmount && r.offerAmount >= l.askAmount) return evaluate([l,r]);
  }
  for (const [left, right] of pairs) for (let l=1;l<=Math.min(left.length,max-1);l++) for(let r=1;r<=Math.min(right.length,max-l);r++) {
    if (++work > checks) return;
    const bundle = evaluate([...left.slice(0,l),...right.slice(0,r)]);
    if (bundle) return bundle;
  }
}
