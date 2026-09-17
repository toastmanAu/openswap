import {type AssetId,type OpenSwapOrder,assetKey,orderKey} from './types.js';
import {comparePrice} from './orders.js';
import {U128_MAX} from './codec.js';
export interface SwapQuote {
 tipBlock:bigint;genesisHash:string;assetIn:AssetId;assetOut:AssetId;requestedOutput:bigint;
 selectedOrders:OpenSwapOrder[];amountIn:bigint;amountOut:bigint;overfill:bigint;
 networkFeeEstimate?:bigint;effectivePriceNum:bigint;effectivePriceDen:bigint;
}
/** Greedy price ordering plus a bounded ten-lot tail search; not optimal knapsack. */
export function quoteSwap(orders:OpenSwapOrder[],request:{assetIn:AssetId;assetOut:AssetId;amountOut:bigint;maxAmountIn:bigint;tipBlock:bigint;genesisHash:string;maxLots?:number;maxCandidates?:number}):SwapQuote {
 const {assetIn,assetOut,amountOut:target,maxAmountIn:budget}=request;
 const limit=request.maxLots??32,cap=request.maxCandidates??1000;
 if(target<=0n||target>U128_MAX||budget<=0n||budget>U128_MAX||request.tipBlock<0n)throw new Error('Invalid quote amounts or tip');
 if(assetKey(assetIn)===assetKey(assetOut))throw new Error('Choose different assets');
 if(!Number.isSafeInteger(limit)||limit<1||limit>32||!Number.isSafeInteger(cap)||cap<1||cap>10000)throw new Error('Invalid routing bounds');
 const ids=new Set<string>(),locks=new Set<string>();
 const book=orders.slice(0,cap).filter(o=>{
  if(!o.supported||o.offerAmount<=0n||o.askAmount<=0n||o.genesisHash!==request.genesisHash||assetKey(o.offerAsset)!==assetKey(assetOut)||assetKey(o.askAsset)!==assetKey(assetIn)||ids.has(orderKey(o))||locks.has(o.lock.hash()))return false;
  ids.add(orderKey(o));locks.add(o.lock.hash());return true;
 }).sort((a,b)=>comparePrice(a,b)||orderKey(a).localeCompare(orderKey(b)));
 let delivered=0n;const greedy:OpenSwapOrder[]=[];
 for(const order of book){if(delivered>=target||greedy.length>=limit)break;greedy.push(order);delivered+=order.offerAmount;}
 const totals=(selected:OpenSwapOrder[])=>({input:selected.reduce((n,o)=>n+o.askAmount,0n),output:selected.reduce((n,o)=>n+o.offerAmount,0n)});
 let best:OpenSwapOrder[]|undefined;let bestIn=0n,bestOut=0n;
 const consider=(selected:OpenSwapOrder[])=>{const {input,output}=totals(selected);if(!selected.length||selected.length>limit||output<target||input>budget||input>U128_MAX||output>U128_MAX)return;
  if(!best||input<bestIn||(input===bestIn&&(output<bestOut||(output===bestOut&&selected.length<best.length)))){best=selected;bestIn=input;bestOut=output;}
 };
 consider(greedy);
 const start=Math.max(0,greedy.length-5),prefix=greedy.slice(0,start),tail=book.slice(start,start+10);
 for(let mask=0;mask<2**tail.length;mask++)consider([...prefix,...tail.filter((_o,i)=>(mask&(1<<i))!==0)]);
 if(!best)throw new Error('No whole-lot route within the input budget and search bounds');
 return{tipBlock:request.tipBlock,genesisHash:request.genesisHash,assetIn,assetOut,requestedOutput:target,selectedOrders:best,amountIn:bestIn,amountOut:bestOut,overfill:bestOut-target,effectivePriceNum:bestIn,effectivePriceDen:bestOut};
}
