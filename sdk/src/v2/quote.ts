// Quote over v1 lots and v2 orders. v2 orders are taken partially when that
// fits their minimum fill, so only a final v1 lot (or an order that cannot be
// split further) overfills. Greedy by price, best first; not a global optimum.
import { U128_MAX } from '../codec.js';
import { assetKey, orderKey, type AssetId } from '../types.js';
import { isV2, type AnyOrder } from './builders.js';
import { requiredPayment } from './model.js';
import { isExpired, partialRange } from './orders.js';

export interface QuoteLeg { order: AnyOrder; take: bigint; pay: bigint; partial: boolean }
export interface MixedQuote { legs: QuoteLeg[]; amountIn: bigint; amountOut: bigint; overfill: bigint; requestedOutput: bigint; assetIn: AssetId; assetOut: AssetId; genesisHash: string }

/** Price as ask per offer unit, compared by cross-multiplication. */
function cheaper(a: AnyOrder, b: AnyOrder): number {
  const d = a.askAmount * b.offerAmount - b.askAmount * a.offerAmount;
  return d < 0n ? -1 : d > 0n ? 1 : orderKey(a).localeCompare(orderKey(b));
}

export function quoteMixed(orders: AnyOrder[], request: { assetIn: AssetId; assetOut: AssetId; amountOut: bigint; maxAmountIn: bigint; genesisHash: string; nowSeconds: bigint; expiryMarginSeconds?: bigint; maxLegs?: number }): MixedQuote {
  const { amountOut: target, maxAmountIn: budget } = request;
  const limit = request.maxLegs ?? 32, margin = request.expiryMarginSeconds ?? 300n;
  if (target <= 0n || target > U128_MAX || budget <= 0n || budget > U128_MAX) throw new Error('Invalid quote amounts');
  if (assetKey(request.assetIn) === assetKey(request.assetOut)) throw new Error('Choose different assets');
  const seen = new Set<string>();
  const book = orders.filter(o => {
    if (!o.supported || o.genesisHash !== request.genesisHash || assetKey(o.offerAsset) !== assetKey(request.assetOut) || assetKey(o.askAsset) !== assetKey(request.assetIn)) return false;
    // Honest solvers stop before expiry, with a margin for median-time lag.
    if (isV2(o) && isExpired(o, request.nowSeconds + margin)) return false;
    const k = o.lock.hash(); if (seen.has(k)) return false; seen.add(k); return true;
  }).sort(cheaper);
  const legs: QuoteLeg[] = [];
  let delivered = 0n, spent = 0n;
  for (const order of book) {
    if (delivered >= target || legs.length >= limit) break;
    const need = target - delivered;
    let take: bigint, partial = false;
    if (!isV2(order)) take = order.offerAmount;
    else {
      take = order.available;
      const range = partialRange(order);
      if (range && need < order.available) {
        const want = need < range.min ? range.min : need;
        if (want <= range.max) { take = want; partial = true; }
      }
    }
    const pay = isV2(order) ? requiredPayment(order, take) : order.askAmount;
    // A CKB final fill delivers `available`; a v1 CKB lot delivers offerAmount.
    legs.push({ order, take, pay, partial });
    delivered += take; spent += pay;
  }
  if (delivered < target) throw new Error('Not enough liquidity for this amount');
  if (spent > budget) throw new Error('Route exceeds the input budget');
  return { legs, amountIn: spent, amountOut: delivered, overfill: delivered - target, requestedOutput: target, assetIn: request.assetIn, assetOut: request.assetOut, genesisHash: request.genesisHash };
}
