/** Split-route quote: whole order lots plus a pool swap for the remainder. Pure. */
import {swapExactOut,type PoolState} from '../../pool-model/src/model.js';

export interface SplitLot {readonly offerAmount:bigint;readonly askAmount:bigint}
export interface SplitQuote<T extends SplitLot> {
 lots:T[];lotIn:bigint;lotOut:bigint;
 /** Pool leg: exact output `amountOut-lotOut`, minimal input from the model. */
 poolIn:bigint;poolOut:bigint;amountIn:bigint;amountOut:bigint;
}
/** Cheapest-first prefixes of the lots (offering the wanted asset for the paid
 * one), each topped up from the pool. Returns the lowest total input within the
 * budget, or undefined when no prefix leaves a remainder the pool can supply.
 * Lot prices are fixed and the pool's marginal price rises with size, so this
 * covers every useful cut-off; skipping a cheaper lot for a pricier one never
 * helps except through lot sizes, which this does not search (no knapsack). */
export function quoteSplit<T extends SplitLot>(lots:readonly T[],pool:PoolState,direction:'xToY'|'yToX',amountOut:bigint,maxAmountIn:bigint,maxLots=32):SplitQuote<T>|undefined {
 if(amountOut<=0n||maxAmountIn<=0n||!Number.isSafeInteger(maxLots)||maxLots<1||maxLots>32)throw new Error('Invalid split request');
 const sorted=lots.map((lot,index)=>({lot,index})).filter(({lot})=>lot.offerAmount>0n&&lot.askAmount>0n)
  .sort((a,b)=>{const d=a.lot.askAmount*b.lot.offerAmount-b.lot.askAmount*a.lot.offerAmount;return d<0n?-1:d>0n?1:a.index-b.index;});
 let best:SplitQuote<T>|undefined,lotIn=0n,lotOut=0n;
 for(let k=0;k<Math.min(maxLots,sorted.length);k++){
  lotIn+=sorted[k]!.lot.askAmount;lotOut+=sorted[k]!.lot.offerAmount;
  if(lotOut>=amountOut)break;// Whole lots alone: the order router's case.
  let flows;try{flows=swapExactOut(pool,direction,amountOut-lotOut).flows;}catch{continue;}
  const poolIn=direction==='xToY'?flows.paidX:flows.paidY,poolOut=direction==='xToY'?flows.receivedY:flows.receivedX,amountIn=lotIn+poolIn;
  if(amountIn>maxAmountIn)continue;
  if(!best||amountIn<best.amountIn||(amountIn===best.amountIn&&k+1<best.lots.length))
   best={lots:sorted.slice(0,k+1).map(s=>s.lot),lotIn,lotOut,poolIn,poolOut,amountIn,amountOut:lotOut+poolOut};
 }
 return best;
}
