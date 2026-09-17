import {ccc} from '@ckb-ccc/core';
import {type SwapQuote} from '../quote.js';
import {fillOrders,type BuildContext,type BuiltTransaction} from './builders.js';
import {parse,assertNetwork} from '../orders.js';
import {defaultResolver} from '../assets.js';
import {assetKey} from '../types.js';
export async function prepareSwap(context:BuildContext,quote:SwapQuote,limits:{maxAmountIn:bigint;minAmountOut:bigint}):Promise<{built:BuiltTransaction;quote:SwapQuote}>{
 await assertNetwork(context.signer.client,context.deployment);
 if(quote.genesisHash!==context.deployment.genesisHash||limits.maxAmountIn<=0n||limits.minAmountOut<=0n)throw new Error('Invalid swap limits or network');
 if(!quote.selectedOrders.length||quote.selectedOrders.length>32)throw new Error('Invalid quote lot count');
 let amountIn=0n,amountOut=0n;
 for(const order of quote.selectedOrders){
  const live=await context.signer.client.getCellLive(order.outPoint,true);if(!live)throw new Error('Quote is stale: order spent; refresh and requote');
  const actual=await parse(live,context.deployment,context.resolver??defaultResolver(context.signer.client));
  if(!actual.supported||assetKey(actual.offerAsset)!==assetKey(quote.assetOut)||assetKey(actual.askAsset)!==assetKey(quote.assetIn)||ccc.hexFrom(live.cellOutput.toBytes())!==ccc.hexFrom(order.cell.cellOutput.toBytes())||live.outputData!==order.cell.outputData)throw new Error('Quote does not match live order');
  amountIn+=actual.askAmount;amountOut+=actual.offerAmount;
 }
 if(amountIn>limits.maxAmountIn||amountOut<limits.minAmountOut||amountOut<quote.requestedOutput)throw new Error('Swap exceeds input limit or fails minimum output');
 const built=await fillOrders(context,quote.selectedOrders.map(o=>o.outPoint));
 return{built,quote:{...quote,amountIn,amountOut,overfill:amountOut-quote.requestedOutput,effectivePriceNum:amountIn,effectivePriceDen:amountOut,networkFeeEstimate:await built.tx.getFee(context.signer.client)}};
}
