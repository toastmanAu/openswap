/** Two-pool route quotes: token A -> CKB -> token B. Pure. */
import {swap,swapExactOut,type PoolState} from '../../pool-model/src/model.js';

export interface RouteQuote {
 /** Token A paid into the first pool. */
 amountIn:bigint;
 /** CKB out of the first pool, all of it paid into the second. */
 hop:bigint;
 /** Token B out of the second pool. */
 amountOut:bigint;
}
/** Exact input: everything the first pool returns goes into the second. */
export function quoteRouteExactIn(first:PoolState,second:PoolState,amountIn:bigint):RouteQuote {
 const hop=swap(first,'yToX',amountIn,1n).flows.receivedX;
 return {amountIn,hop,amountOut:swap(second,'xToY',hop,1n).flows.receivedY};
}
/** Minimal token A delivering at least `amountOut` token B. The second pool
 * needs at least `c` CKB for that output, and the first pool's exact-output
 * input for `c` is minimal; any smaller input yields less than `c` CKB and so
 * less than `amountOut`. The whole hop goes into the second pool, so the final
 * output can exceed the request by rounding. */
export function quoteRouteExactOut(first:PoolState,second:PoolState,amountOut:bigint):RouteQuote {
 const ckbNeeded=swapExactOut(second,'xToY',amountOut).flows.paidX;
 const leg=swapExactOut(first,'yToX',ckbNeeded).flows;
 return {amountIn:leg.paidY,hop:leg.receivedX,amountOut:swap(second,'xToY',leg.receivedX,amountOut).flows.receivedY};
}
