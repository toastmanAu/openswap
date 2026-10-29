import type {ccc} from '@ckb-ccc/core';

/** Fee policy for order-book transactions (create, fill, cancel, return, order swaps).
 * The node's median fee rate is used within these bounds; pool transactions follow the
 * pool manifest's own fixed policy. 1,000 shannons/KB is the CKB minimum relay rate. */
export const ORDER_FEE_POLICY={minRate:1000n,maxRate:5000n,/** 0.01 CKB per transaction */maxFee:1_000_000n} as const;
export interface FeeQuote {/** Shannons per 1,000 bytes. */rate:bigint;/** The node's median, when it answered. */suggested?:bigint}

/** The rate to build with: the node's median, raised to the minimum and capped at the maximum.
 * A node that does not answer gets the minimum, which only risks a slower confirmation. */
export async function orderFeeQuote(client:Pick<ccc.Client,'getFeeRateStatistics'>):Promise<FeeQuote>{
 try{
  const suggested=(await client.getFeeRateStatistics()).median;
  const rate=suggested<ORDER_FEE_POLICY.minRate?ORDER_FEE_POLICY.minRate:suggested>ORDER_FEE_POLICY.maxRate?ORDER_FEE_POLICY.maxRate:suggested;
  return {rate,suggested};
 }catch{return {rate:ORDER_FEE_POLICY.minRate};}
}
/** Review line: what the transaction pays, at what rate, and whether the node's suggestion was capped. */
export function feeLine(fee:bigint,size:number,quote:FeeQuote,format:(shannons:bigint)=>string):string{
 const rate=size>0?fee*1000n/BigInt(size):0n;
 const capped=quote.suggested!==undefined&&quote.suggested>ORDER_FEE_POLICY.maxRate;
 const why=quote.suggested===undefined?'node gave no estimate; minimum used':capped?`node suggested ${quote.suggested}, capped at ${ORDER_FEE_POLICY.maxRate}`:`node suggested ${quote.suggested}`;
 return `Network fee: ${format(fee)} CKB (about ${rate} shannons/KB; ${why})`;
}
