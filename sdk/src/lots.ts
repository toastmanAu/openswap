import { uint, U128_MAX } from './codec.js';
export function nonce(): Uint8Array {
  for (;;) { const value = crypto.getRandomValues(new Uint8Array(16)); if (value.some(n => n !== 0)) return value; }
}
export function nonces(count: number): Uint8Array[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1024) throw new Error('Invalid batch count');
  const seen = new Set<string>(); const result: Uint8Array[] = [];
  while (result.length < count) { const n = nonce(); const key = Array.from(n).join(','); if (!seen.has(key)) { seen.add(key); result.push(n); } }
  return result;
}
export const ceilDiv = (n: bigint, d: bigint): bigint => { if (n < 0n || d <= 0n) throw new Error('Invalid division'); return (n + d - 1n) / d; };
export function plan(input: { totalOffer: bigint; priceNumerator: bigint; priceDenominator: bigint; candidateCounts?: number[] }, capacityForLot?: (offer: bigint, ask: bigint) => bigint) {
  const { totalOffer, priceNumerator: num, priceDenominator: den } = input;
  uint(totalOffer, 128);
  if (totalOffer === 0n || num <= 0n || den <= 0n) throw new Error('Amounts and price must be positive');
  const counts = input.candidateCounts ?? [1, 2, 4, 8];
  if (counts.some(count => !Number.isSafeInteger(count) || count < 1 || count > 1024)) throw new Error('Lot count must be 1..1024');
  return counts.filter(count => BigInt(count) <= totalOffer).map(count => {
    if (!Number.isSafeInteger(count) || count < 1 || count > 1024) throw new Error('Lot count must be 1..1024');
    const offers = Array.from({ length: count }, (_, i) => totalOffer / BigInt(count) + (BigInt(i) < totalOffer % BigInt(count) ? 1n : 0n));
    const asks = offers.map(offer => { const ask = ceilDiv(offer * num, den); if (ask > U128_MAX) throw new Error('Ask overflows u128'); return ask; });
    const totalAsk = asks.reduce((a, b) => a + b, 0n);
    return { count, offers, asks, totalAsk, roundingPremium: totalAsk - ceilDiv(totalOffer * num, den), totalCapacity: capacityForLot ? offers.reduce((sum, offer, i) => sum + capacityForLot(offer, asks[i]!), 0n) : undefined };
  });
}
