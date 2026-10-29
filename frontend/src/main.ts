import {ccc,WebComponentConnector,ConnectorConnectionEvent,SelectClientEvent} from '@ckb-ccc/connector';
import * as swap from '@openswap/sdk';
import deploymentJson from '../../deployments/testnet.json';
import './style.css';
import {parseUnits,formatUnits,unitPrice} from './amounts.js';
import {explainError} from './errors.js';
import {capacityReview} from './review.js';
import {isOwnOrder,assertExternalFill} from './ownership.js';
import {readActivity,mergeActivity,fetchActivity,accountKey,type Activity} from './activity.js';
import {createPoolUi,type PoolRoute,type SplitRoute,type MultiHopRoute} from './pools/ui.js';
import {XUDT_CODE_HASH} from '../../pool-sdk/src/codec.js';
import {createMarkets} from './markets.js';
const deployment=deploymentJson as swap.Deployment;
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id)! as T;
const value=(id:string)=>(el<HTMLInputElement>(id)).value;
const text=(id:string,message:string)=>{el(id).textContent=message;};
const report=(error:unknown)=>{text('status',explainError(error));el('status').classList.add('notice');};
const run=(fn:()=>Promise<void>)=>{void fn().catch(report);};
let rpcOwner=ccc.ClientPublicTestnet.open({urls:['https://testnet.ckb.dev']});
let indexerOwner=ccc.ClientPublicTestnet.open({urls:['https://testnet.ckb.dev']});
let client:ccc.Client=rpcOwner.value,signer:ccc.Signer|undefined,owner:ccc.Script|undefined;
let walletLocks:ccc.Script[]=[];
let connectionEpoch=0;
let scanFresh=false,lastScan=0;
let generation=0,busy=false,orders:swap.AnyOrder[]=[],scanAbort:AbortController|undefined;
/** Order lock v2 (partial fills, expiry), enabled only when a v2 manifest is served. */
let v2:swap.Deployment|undefined;
/** Chain tip time in seconds, read at each scan; expiry is judged by chain time. */
let chainNow=0n;
/** Returns wait this long after expiry so the median time used by `since` has passed. */
const RETURN_DELAY=900n;
const bookPages=new Map<string,number>();
let review:{built:swap.BuiltTransaction;signer:ccc.Signer;generation:number;summary:string;account:string;createdAt:number}|undefined;
let activity:Activity[]=[];try{activity=readActivity(localStorage.getItem('toastdex-activity'));}catch{}
let historyGeneration=0;
function saveActivity(item:Activity){activity=mergeActivity(activity,item);try{localStorage.setItem('toastdex-activity',JSON.stringify(activity));}catch{report(new Error('Transaction sent, but this browser could not save activity. Keep the transaction hash.'));}}
function clearActivity(){historyGeneration++;el('activity-list').replaceChildren();text('activity-status','Connect a wallet to see recent transactions.');}
function renderActivityRows(rows:Activity[]){const root=el('activity-list');root.replaceChildren();for(const row of rows){const item=document.createElement('div');item.className='activity-row';const title=document.createElement('p');title.textContent=`${row.status.toUpperCase()} · ${row.summary.split('\n')[0]}`;const link=document.createElement('a');link.href=`https://pudge.explorer.nervos.org/transaction/${row.hash}`;link.target='_blank';link.rel='noopener noreferrer';link.textContent=`${row.hash.slice(0,18)}…${row.hash.slice(-8)}`;item.append(title,link);if(row.block){const block=document.createElement('small');block.textContent=` · Block ${row.block}`;item.append(block);}root.append(item);}}
async function refreshActivity(){const selected=signer,locks=[...walletLocks],id=++historyGeneration;if(!selected||!locks.length){clearActivity();return;}renderActivityRows(activity.filter(r=>r.account===accountKey(locks)&&r.network===deployment.genesisHash).slice(-20).reverse());text('activity-status','Loading recent activity…');try{const rows=await fetchActivity(selected.client,locks,deployment.genesisHash,activity);if(id!==historyGeneration||selected!==signer)return;renderActivityRows(rows);for(const row of rows)if(activity.some(a=>a.hash===row.hash&&a.account===row.account))saveActivity(row);text('activity-status',rows.length?'Recent wallet transactions. Unknown means the node has not confirmed the transaction; it does not prove failure.':'No recent transactions found.');}catch(error){console.warn('Activity refresh failed',error);if(id===historyGeneration)text('activity-status','Activity unavailable. Your transaction hashes remain saved; try Refresh activity.');}}
el('refresh-activity').onclick=()=>run(refreshActivity);
/** Catalog profiles plus the pool token's pinned Data1 xUDT profile once the
 * approved pool manifest is loaded, so the same token trades in both venues. */
let poolTokenDep:ccc.CellDepLike|undefined;
const tokenDecimals=new Map<string,number>();
function assetResolver(c:ccc.Client):swap.AssetResolver{const base=new swap.CatalogAssetResolver(c);return poolTokenDep?new swap.PinnedXudtResolver(base,XUDT_CODE_HASH,poolTokenDep):base;}
const poolUi=createPoolUi({client:()=>client,signer:()=>signer,epoch:()=>connectionEpoch,run});
const assets=new Map<string,{label:string;asset:swap.AssetId}>([['ckb',{label:'CKB',asset:swap.CKB}]]);
const connector=new WebComponentConnector();connector.client=client;connector.name='ToastDEX Testnet';
connector.addEventListener('select-client',event=>{const selected=(event as SelectClientEvent).client;if(selected.addressPrefix!=='ckt'){report(new Error('Only testnet is supported'));return;}connector.client=selected;client=selected;});
connector.addEventListener('connection',event=>{
 const connection=(event as ConnectorConnectionEvent).connectionOwner,epoch=++connectionEpoch;
 signer=connection?.value.signerInfo.signer;owner=undefined;walletLocks=[];clearActivity();poolUi.reset();text('connect',signer?'Loading account…':'Connect wallet');text('connected-account','');text('wallet-address',signer?'Loading account…':'Browse without connecting.');invalidate();renderBook();
 const selected=signer;run(async()=>{if(!selected){text('wallet-address','Browse without connecting.');text('connect','Connect wallet');text('connected-account','');renderBook();return;}
 const [address,addresses]=await Promise.all([selected.getRecommendedAddressObj(),selected.getAddressObjs()]);if(signer!==selected||epoch!==connectionEpoch)return;walletLocks=addresses.map(a=>a.script);
 owner=address.script;text('wallet-address',address.toString());text('connected-account',`Account: ${address.toString()}`);text('connect','Switch wallet');renderBook();void refreshActivity();if(!el('view-pools').hidden)poolUi.show();});
});
connector.addEventListener('close',()=>el<HTMLDialogElement>('wallet-dialog').close());
el('wallet-host').append(connector);
el('connect').onclick=()=>run(async()=>{
 if(busy)return;
 const previous=signer;
 if(previous){connector.disconnect();signer=undefined;owner=undefined;walletLocks=[];invalidate();text('connected-account','');text('connect','Connect wallet');renderBook();await previous.disconnect();}
 el<HTMLDialogElement>('wallet-dialog').showModal();
});
async function assertActiveAccount(expected:ccc.Signer,start:number){
 const addresses=await expected.getAddressObjs();
 const same=addresses.length===walletLocks.length&&addresses.every(a=>walletLocks.some(lock=>lock.eq(a.script)));
 if(signer!==expected||generation!==start)throw new Error('Wallet or transaction details changed; prepare again');
 if(!same){connector.disconnect();signer=undefined;owner=undefined;walletLocks=[];invalidate();text('connected-account','');renderBook();throw new Error('Wallet account changed. Reconnect and prepare the transaction again.');}
}
window.addEventListener('focus',()=>{const current=signer,start=generation;if(current&&owner)run(()=>assertActiveAccount(current,start));});
el('close-wallet').onclick=()=>el<HTMLDialogElement>('wallet-dialog').close();
function invalidate(){generation++;review=undefined;el<HTMLDialogElement>('review').close();poolUi.invalidate();}
function selected(id:string){const result=assets.get(value(id));if(!result)throw new Error('Choose an asset');return result.asset;}
function label(asset:swap.AssetId){return assets.get(swap.assetKey(asset))?.label??`${swap.assetKey(asset).slice(0,10)}…`;}
function decimals(asset:swap.AssetId){return asset.kind==='ckb'?8:tokenDecimals.get(swap.assetKey(asset))??swap.tokensForNetwork('testnet').find(t=>t.typeHash===swap.assetKey(asset))?.decimals??0;}
function amount(n:bigint,asset:swap.AssetId){return `${formatUnits(n,decimals(asset))} ${label(asset)}`;}
/** Offer still available and the payment for all of it (v1 lots are always whole). */
const remaining=(o:swap.AnyOrder)=>swap.isV2(o)?o.available:o.offerAmount;
const askNow=(o:swap.AnyOrder)=>swap.isV2(o)?swap.requiredPayment(o,o.available):o.askAmount;
const returnable=(o:swap.AnyOrder)=>swap.isV2(o)&&swap.isExpired(o,chainNow-RETURN_DELAY);
const v1Lots=(list:swap.AnyOrder[])=>list.filter(o=>!swap.isV2(o)) as swap.OpenSwapOrder[];
function aboutTime(seconds:bigint){return new Date(Number(seconds)*1000).toLocaleString();}
/** Partial-fill and expiry notes for a v2 order row. */
function v2Note(o:swap.AnyOrder){
 if(!swap.isV2(o))return '';
 const parts=[o.minFill<o.available?`partial from ${amount(o.minFill,o.offerAsset)}`:'whole only'];
 const at=swap.expirySeconds(o.expiry);
 if(at!==undefined)parts.push(swap.isExpired(o,chainNow)?`expired ${aboutTime(at)}`:`until about ${aboutTime(at)}`);
 return ` · ${parts.join(' · ')}`;
}
function v2Context():swap.BuildContext{if(!v2)throw new Error('Order lock v2 is not deployed on this network');return{...context(),deployment:v2};}
function showView(view:string){if(view==='activity')void refreshActivity();if(view==='pools')poolUi.show();for(const name of ['swap','orders','markets','pools','activity','settings'])el(`view-${name}`).hidden=name!==view;for(const b of document.querySelectorAll<HTMLButtonElement>('[data-view]'))b.setAttribute('aria-pressed',String(b.dataset.view===view));if(view==="markets")void marketView.show();}
for(const b of document.querySelectorAll<HTMLButtonElement>('[data-view]'))b.onclick=()=>showView(b.dataset.view!);
/** Market history read from the chain: v1 and v2 order fills plus pool swaps. Open orders
 * feed depth; expired v2 orders are left out, as the router does. */
let startupDone:()=>void=()=>{};const startup=new Promise<void>(resolve=>{startupDone=resolve;});
const marketView=createMarkets({
 ready:()=>startup,
 client:()=>client,
 sources:()=>({orders:[{version:1,codeHash:deployment.codeHash},...(v2?[{version:2 as const,codeHash:v2.codeHash}]:[])],pools:poolUi.deployment()}),
 book:()=>orders.filter(o=>o.supported&&!(swap.isV2(o)&&swap.isExpired(o,chainNow))).map(o=>({offer:o.offerAsset,ask:o.askAsset,available:swap.isV2(o)?o.available:o.offerAmount,askAmount:o.askAmount,offerAmount:o.offerAmount})),
 pools:()=>poolUi.markets(),
 label,decimals,
 explorer:hash=>`https://pudge.explorer.nervos.org/transaction/${hash}`,
});
el('reverse').onclick=()=>{const base=value('base');el<HTMLSelectElement>('base').value=value('quote');el<HTMLSelectElement>('quote').value=base;el<HTMLInputElement>('swap-output').value='';el<HTMLInputElement>('swap-budget').value='';invalidate();renderBook();};
function swapAssets(){const base=selected('base'),quote=selected('quote');return value('swap-direction')==='buy'?{assetOut:base,assetIn:quote}:{assetOut:quote,assetIn:base};}
function mixedQuote(){if(!scanFresh)throw new Error('Refresh live orders before requesting a quote.');const {assetIn,assetOut}=swapAssets();return swap.quoteMixed(orders.filter(o=>!isOwnOrder(o,walletLocks)),{assetIn,assetOut,amountOut:parseUnits(value('swap-output'),decimals(assetOut)),maxAmountIn:value('swap-budget').trim()?parseUnits(value('swap-budget'),decimals(assetIn)):swap.U128_MAX,genesisHash:deployment.genesisHash,nowSeconds:chainNow});}
function localQuote(){if(!scanFresh)throw new Error('Refresh live orders before requesting a quote.');const {assetIn,assetOut}=swapAssets();return swap.quoteSwap(v1Lots(orders).filter(o=>!isOwnOrder(o,walletLocks)),{assetIn,assetOut,amountOut:parseUnits(value('swap-output'),decimals(assetOut)),maxAmountIn:value('swap-budget').trim()?parseUnits(value('swap-budget'),decimals(assetIn)):swap.U128_MAX,tipBlock:0n,genesisHash:deployment.genesisHash});}
type Route={venue:'orders';quote:swap.SwapQuote}|{venue:'mixed';quote:swap.MixedQuote}|{venue:'pool';route:PoolRoute}|{venue:'split';route:SplitRoute<swap.OpenSwapOrder>}|{venue:'route';route:MultiHopRoute};
/** Best route for the request: the order book (whole lots), a listed pool (exact
 * output), or a split of whole lots plus the pool in one transaction. Lowest
 * input wins; ties go to the larger output, then orders, then the pool. A split
 * must be strictly cheaper than both. A token-to-token request may also go
 * through two pools via CKB. Pool, split and two-pool routes need a JoyID wallet. */
function bestRoute(){
 const {assetIn,assetOut}=swapAssets(),amountOut=parseUnits(value('swap-output'),decimals(assetOut));
 const budget=value('swap-budget').trim()?parseUnits(value('swap-budget'),decimals(assetIn)):swap.U128_MAX;
 let orderRoute:Route|undefined,poolRoute:Route|undefined,splitRoute:Route|undefined,hopRoute:Route|undefined,orderNote:string,poolNote:string|undefined,splitNote:string|undefined,hopNote:string|undefined;
 const joyIdOnly=signer!==undefined&&signer.signType!==ccc.SignerSignType.JoyId;
 if(v2){
  try{const quote=mixedQuote(),partial=quote.legs.filter(l=>l.partial).length;orderRoute={venue:'mixed',quote};orderNote=`Order book: ${amount(quote.amountOut,assetOut)} for ${amount(quote.amountIn,assetIn)} (${quote.legs.length} order${quote.legs.length===1?'':'s'}${partial?`, ${partial} partly filled`:''})`;}
  catch(error){orderNote=`Order book: ${error instanceof Error?error.message:String(error)}`;}
  // The whole-lot search over v1 lots alone can beat the greedy mixed quote.
  try{const whole=localQuote(),mixed=orderRoute?.venue==='mixed'?orderRoute.quote.amountIn:undefined;if(mixed===undefined||whole.amountIn<mixed){orderRoute={venue:'orders',quote:whole};orderNote=`Order book: ${amount(whole.amountOut,assetOut)} for ${amount(whole.amountIn,assetIn)} (${whole.selectedOrders.length} whole lot${whole.selectedOrders.length===1?'':'s'})`;}}catch{}
 }else{
 try{orderRoute={venue:'orders',quote:localQuote()};orderNote=`Order book: ${amount(orderRoute.quote.amountOut,assetOut)} for ${amount(orderRoute.quote.amountIn,assetIn)} (${orderRoute.quote.selectedOrders.length} whole lot${orderRoute.quote.selectedOrders.length===1?'':'s'})`;}
 catch(error){orderNote=`Order book: ${String(error).includes('No whole-lot')?'no whole-lot route for this amount':error instanceof Error?error.message:String(error)}`;}
 }
 const token=assetIn.kind==='ckb'?assetOut:assetOut.kind==='ckb'?assetIn:undefined;
 if(token?.kind==='udt'){
  const route=poolUi.routeQuote(token.scriptHash,assetIn.kind==='ckb',amountOut);
  if(route){
   poolNote=`Pool: ${amount(route.amountOut,assetOut)} for ${amount(route.amountIn,assetIn)}`;
   if(route.amountIn>budget)poolNote+=' (over your maximum payment)';
   else if(joyIdOnly)poolNote+=' (needs a JoyID wallet)';
   else poolRoute={venue:'pool',route};
  }
  if(scanFresh){
   // Distinct, supported lots of this pair from other owners; the builder rechecks each.
   const locks=new Set<string>();
   const lots=v1Lots(orders).filter(o=>o.supported&&o.genesisHash===deployment.genesisHash&&!isOwnOrder(o,walletLocks)&&swap.assetKey(o.offerAsset)===swap.assetKey(assetOut)&&swap.assetKey(o.askAsset)===swap.assetKey(assetIn)
    &&!locks.has(o.lock.hash())&&locks.add(o.lock.hash()));
   const split=poolUi.splitQuote(token.scriptHash,assetIn.kind==='ckb',amountOut,budget,lots);
   if(split){
    splitNote=`Split: ${amount(split.amountOut,assetOut)} for ${amount(split.amountIn,assetIn)} (${split.lots.length} lot${split.lots.length===1?'':'s'} + pool)`;
    if(joyIdOnly)splitNote+=' (needs a JoyID wallet)';else splitRoute={venue:'split',route:split};
   }
  }
 }
 // Token to token: two pools via CKB, settled in one transaction.
 if(assetIn.kind==='udt'&&assetOut.kind==='udt'){
  const route=poolUi.multiHopQuote(assetIn.scriptHash,assetOut.scriptHash,amountOut);
  if(route){
   hopNote=`Two pools via CKB: ${amount(route.amountOut,assetOut)} for ${amount(route.amountIn,assetIn)}`;
   if(route.amountIn>budget)hopNote+=' (over your maximum payment)';
   else if(joyIdOnly)hopNote+=' (needs a JoyID wallet)';
   else hopRoute={venue:'route',route};
  }
 }
 const cost=(r:Route)=>r.venue==='orders'||r.venue==='mixed'?{input:r.quote.amountIn,output:r.quote.amountOut}:{input:r.route.amountIn,output:r.route.amountOut};
 let best=orderRoute;
 if(poolRoute&&(!best||cost(poolRoute).input<cost(best).input||(cost(poolRoute).input===cost(best).input&&cost(poolRoute).output>cost(best).output)))best=poolRoute;
 if(splitRoute&&(!best||cost(splitRoute).input<cost(best).input))best=splitRoute;
 if(hopRoute&&(!best||cost(hopRoute).input<cost(best).input||(cost(hopRoute).input===cost(best).input&&cost(hopRoute).output>cost(best).output)))best=hopRoute;
 // Lots this account owns in the requested direction: never routed, but say so.
 const ownSkipped=scanFresh?orders.filter(o=>o.supported&&o.genesisHash===deployment.genesisHash&&isOwnOrder(o,walletLocks)&&swap.assetKey(o.offerAsset)===swap.assetKey(assetOut)&&swap.assetKey(o.askAsset)===swap.assetKey(assetIn)).length:0;
 return {best,assetIn,assetOut,notes:[orderNote,...(poolNote?[poolNote]:[]),...(splitNote?[splitNote]:[]),...(hopNote?[hopNote]:[])],ownSkipped};
}
function updateQuote(){
 text('pay-estimate','—');
 if(!value('swap-output').trim()){text('quote-status','Enter the amount you want to receive, or choose an available swap below.');return;}
 try{
  const {best,assetIn,assetOut,notes,ownSkipped}=bestRoute();
  const own=ownSkipped?` Skipped ${ownSkipped} of your own lot${ownSkipped===1?'':'s'} in this direction: you cannot fill your own orders. Cancel ${ownSkipped===1?'it':'them'} under Your orders on this pair.`:'';
  if(!best){text('quote-status',`No available swap for this amount and direction. ${notes.join(' · ')}. Try a listed swap below, reverse the tokens, or place an order.${own}`);return;}
  const input=best.venue==='orders'||best.venue==='mixed'?best.quote.amountIn:best.route.amountIn,output=best.venue==='orders'||best.venue==='mixed'?best.quote.amountOut:best.route.amountOut;
  text('pay-estimate',formatUnits(input,decimals(assetIn)));
  text('quote-status',`Best route: ${best.venue==='mixed'?`order book${best.quote.legs.some(l=>l.partial)?', taking part of an order':''}`:best.venue==='pool'?'pool':best.venue==='route'?'two pools via CKB in one transaction':best.venue==='split'?`split, ${best.route.lots.length} order lot${best.route.lots.length===1?'':'s'} + pool in one transaction`:'order book'}. Receive ${amount(output,assetOut)} for ${amount(input,assetIn)}. Price ≈ ${unitPrice(input,output,decimals(assetIn),decimals(assetOut))} ${label(assetIn)} per ${label(assetOut)}. Compared: ${notes.join(' · ')}. Fees and storage are additional.${own}`);
 }catch(error){text('quote-status',error instanceof Error?error.message:String(error));}
}
for(const id of ['swap-output','swap-budget','swap-direction','offer','ask','lots','direction','partial-fills','min-fill','order-expiry'])el(id).oninput=()=>{invalidate();updateQuote();updateOrderPreview();};
/** v2 creation options from the form: partial fills, minimum fill and expiry. */
function v2Options(){
 const partialFills=Number(value('partial-fills')),duration=BigInt(value('order-expiry'));
 const expiry=duration>0n?swap.expiryAt(BigInt(Math.floor(Date.now()/1000))+duration):0n;
 return {partialFills,expiry,minFillText:value('min-fill').trim()};
}
function v2Lots(offer:swap.AssetId,plan:{offers:bigint[];asks:bigint[]}){
 const {partialFills,minFillText}=v2Options();
 const wanted=minFillText?parseUnits(minFillText,decimals(offer)):0n;
 return plan.offers.map((offerAmount,i)=>{const fallback=offerAmount/10n||1n;const minFill=partialFills===0?offerAmount:wanted>0n?(wanted<offerAmount?wanted:offerAmount):fallback;return{offerAmount,askAmount:plan.asks[i]!,minFill,partialFills};});
}
function v2Disclosure(offer:swap.AssetId,ask:swap.AssetId,lots:{minFill:bigint;partialFills:number;offerAmount:bigint}[],expiry:bigint,planned:ReturnType<typeof swap.planCreateV2>[]){
 const lines:string[]=[];const lot=lots[0]!;
 lines.push(lot.partialFills===0?'Partial fills: no, each order fills completely':`Partial fills: up to ${lot.partialFills} per order, each at least ${amount(lot.minFill,offer)} and never leaving less than that. Each fill pays you at your price.`);
 if(lot.partialFills>0){const ranges=planned.map(p=>swap.plannedPartialRange(v2!,p,offer));const first=ranges[0];
  if(ranges.some(r=>!r))lines.push(`Too small to fill partly: ${ranges.every(r=>!r)?'these orders':'some of these orders'} can only fill completely, because each remainder must keep enough ${offer.kind==='ckb'?'CKB to store the order itself':'capacity for its payment cells'}. Offer more per order, use fewer orders, or lower the minimum fill.`);
  else if(first)lines.push(`A partial fill of the first order can take ${amount(first.min,offer)} to ${amount(first.max,offer)}.`);}
 if(lot.partialFills>0&&offer.kind==='ckb')lines.push(`Each partial fill keeps about ${formatUnits(swap.paymentMinimum({ownerLock:owner!,askAsset:ask}),8)} CKB of your offer as storage for the ${label(ask)} it pays you. That CKB stays yours, so slightly less CKB is sold in total.`);
 const at=swap.expirySeconds(expiry);
 lines.push(at===undefined?'Good until: filled or cancelled':`Good until: about ${aboutTime(at)}. After that, anyone can return the order to you unchanged. Until someone does, it can still be filled at your price.`);
 return lines.join('\n');
}
function updateOrderPreview(){
 if(!owner){text('order-estimate','Connect a wallet to estimate the CKB capacity needed for your order.');return;}
 if(!value('offer')||!value('ask')){text('order-estimate','Enter your offer and ask to see the price and storage reserve.');return;}
 try{const base=selected('base'),quote=selected('quote'),offer=value('direction')==='sell'?base:quote,ask=value('direction')==='sell'?quote:base;
 const offered=parseUnits(value('offer'),decimals(offer)),wanted=parseUnits(value('ask'),decimals(ask));const plan=swap.plan({totalOffer:offered,priceNumerator:wanted,priceDenominator:offered,candidateCounts:[Number(value('lots'))]})[0];if(!plan)throw new Error('Offer must contain at least one unit per lot');
 const capacity=v2?v2Lots(offer,plan).reduce((n,lot)=>n+swap.planCreateV2(v2!,{ownerLock:owner!,nonce:new Uint8Array(16).fill(1),askAsset:ask,expiry:0n},offer,lot).capacity,0n)
  :plan.offers.reduce((n,v,i)=>n+swap.estimateCapacity(deployment,{ownerLock:owner!,nonce:new Uint8Array(16),askAsset:ask,askAmount:plan.asks[i]!},offer,v).cell.cellOutput.capacity,0n);
 const reserve=capacity-(offer.kind==='ckb'?offered:0n);
 const partial=v2&&offer.kind==='udt'&&v2Options().partialFills>0?` It includes storage for up to ${v2Options().partialFills} partial-fill payment cells, which come back to you with each payment.`:'';
 text('order-estimate',`Price ≈ ${unitPrice(plan.totalAsk,offered,decimals(ask),decimals(offer))} ${label(ask)} per ${label(offer)}. CKB locked: ${formatUnits(capacity,8)} (${formatUnits(reserve,8)} storage reserve). Storage reserve returns on fill or cancellation.${partial} Network fee calculated at review.`);
 }catch(error){text('order-estimate',error instanceof Error?error.message:String(error));}
}
async function tokenBalance(wallet:ccc.Signer,asset:swap.AssetId){
 if(asset.kind==='ckb')return wallet.getBalance();
 let total=0n,count=0;const seen=new Set<string>();
 for await(const cell of wallet.findCells({script:asset.script,scriptLenRange:[asset.script.occupiedSize,asset.script.occupiedSize+1],outputDataLenRange:[16,17]},true)){
  if(++count>10000)throw new Error('Wallet balance scan limit reached');
  const key=`${cell.outPoint.txHash}:${cell.outPoint.index}`;if(seen.has(key))continue;seen.add(key);
  if(cell.cellOutput.type?.eq(asset.script)&&await assetResolver(wallet.client).supports(asset.script,cell.outputData))total+=swap.parseAmount(cell.outputData);
 }return total;
}
async function checkFunding(wallet:ccc.Signer,asset:swap.AssetId,required:bigint){
 if(asset.kind==='ckb')return;
 const available=await tokenBalance(wallet,asset);if(available<required)throw new Error(`You need ${amount(required,asset)} to fill this swap. This wallet has ${amount(available,asset)} available. Receive this testnet token in your connected wallet, or choose a swap that accepts a token you hold.`);
}
let balanceGeneration=0;
function showBalance(){const generation=++balanceGeneration,wallet=signer;if(!wallet||!owner){text('pay-balance','Connect to see your balance');text('receive-balance','');return;}const {assetIn,assetOut}=swapAssets();
 for(const [id,asset] of [['pay-balance',assetIn],['receive-balance',assetOut]] as const){text(id,'Checking balance…');void tokenBalance(wallet,asset).then(n=>{if(generation===balanceGeneration&&signer===wallet)text(id,`Wallet: ${amount(n,asset)}${asset.kind==='ckb'?' total capacity (includes cell storage)':''}`);}).catch(()=>{if(generation===balanceGeneration)text(id,'Balance unavailable; checked again when preparing');});}}
/** The connected account's live lots on the selected pair, both directions, cancellable here. */
function renderSwapOwnOrders(){
 const root=el('swap-own-orders');root.replaceChildren();if(!owner||!assets.has(value('base'))||!assets.has(value('quote')))return;
 const pair=new Set([swap.assetKey(selected('base')),swap.assetKey(selected('quote'))]);
 const owned=orders.filter(o=>isOwnOrder(o,walletLocks)&&pair.has(swap.assetKey(o.offerAsset))&&pair.has(swap.assetKey(o.askAsset))&&swap.assetKey(o.offerAsset)!==swap.assetKey(o.askAsset));
 if(!owned.length)return;
 const heading=document.createElement('h2');heading.textContent=`Your orders on this pair (${owned.length})`;
 const note=document.createElement('p');note.textContent='Swaps never fill your own orders. Cancel one to recover its CKB and tokens.';root.append(heading,note);
 for(const order of owned.slice(0,10)){const row=document.createElement('div');row.className='quote-row';const copy=document.createElement('span');copy.textContent=`Offer ${amount(remaining(order),order.offerAsset)} for ${amount(askNow(order),order.askAsset)}${v2Note(order)}`;row.append(copy,cancelButton(order,'Cancel order'));root.append(row);}
 if(owned.length>10){const more=document.createElement('p');more.textContent=`${owned.length-10} more in the Orders tab. `;more.append(button('Show all',async()=>showView('orders')));root.append(more);}
}
function cancelButton(order:swap.AnyOrder,title='Cancel'){return button(title,async()=>buildReview(ctx=>swap.isV2(order)?swap.cancelOrdersV2(v2Context(),[order.outPoint]):swap.cancelOrders(ctx,[order.outPoint]),`Recover order ${swap.orderKey(order)}. A separate plain owner cell pays the fee.`));}
/** Fill all that is left of one order. */
function fillButton(order:swap.AnyOrder,title:string){return button(title,async()=>buildReview(async ctx=>{await assertExternalFill(ctx.signer,[order]);await checkFunding(ctx.signer,order.askAsset,askNow(order));return swap.isV2(order)?swap.fillOrdersV2(v2Context(),[{outPoint:order.outPoint}],{nowSeconds:chainNow}):swap.fillOrders(ctx,[order.outPoint]);},`You pay: ${amount(askNow(order),order.askAsset)}\nYou receive: ${amount(remaining(order),order.offerAsset)}`));}
/** Anyone may return an expired v2 order to its owner; the caller pays the fee. */
function returnButton(order:swap.AnyOrder){return button('Return to owner',async()=>buildReview(async()=>swap.returnExpiredV2(v2Context(),[order.outPoint],chainNow-RETURN_DELAY),`Return expired order ${swap.orderKey(order)} to its owner, unchanged.\nYou pay only the network fee. The order's CKB and tokens go back to the owner's own address.`));}
function renderAvailable(){renderSwapOwnOrders();marketView.bookChanged();const root=el('available-orders');root.replaceChildren();text('quote-age',scanFresh?`Orders checked ${new Date(lastScan).toLocaleTimeString()}`:'Live orders need refreshing.');const markets=poolUi.markets();
 text('available-note',orders.length||markets.length?`${markets.length?`${markets.length} pool${markets.length===1?'':'s'} (any amount, price moves with size)${orders.length?' and ':''}`:''}${orders.length?`${orders.length} order-book ${v2?'order':'lot'}${orders.length===1?'':'s'} (fixed price${v2?', some can fill partly':', whole lots only'})`:''}.`:'No live swaps yet. Place an order in the Orders tab.');
 // Pools first: they take any amount, so they set the pair for the form above.
 for(const market of markets){const row=document.createElement('div');row.className='quote-row';const copy=document.createElement('span');
  copy.textContent=`Pool: CKB ⇄ ${market.symbol} · 1 ${market.symbol} ≈ ${unitPrice(market.x,market.y,8,market.decimals)} CKB · reserves ${formatUnits(market.x,8)} CKB / ${formatUnits(market.y,market.decimals)} ${market.symbol}`;
  row.append(copy,button('Trade this pair',async()=>{el<HTMLSelectElement>('quote').value='ckb';el<HTMLSelectElement>('base').value=market.token.hash();el<HTMLInputElement>('swap-output').value='';invalidate();renderBook();updateQuote();el('swap-output').focus();}));root.append(row);}
 for(const order of orders.slice(0,30)){const row=document.createElement('div');row.className='quote-row';const copy=document.createElement('span');copy.textContent=`${swap.isV2(order)?'Order':'Order lot'}: pay ${amount(askNow(order),order.askAsset)} → receive ${amount(remaining(order),order.offerAsset)}${v2Note(order)}`;if(isOwnOrder(order,walletLocks)){copy.textContent+=' · Your order';row.append(copy,cancelButton(order,'Cancel order'));root.append(row);continue;}
  if(swap.isV2(order)&&swap.isExpired(order,chainNow)){if(returnable(order))row.append(copy,returnButton(order));else row.append(copy);root.append(row);continue;}
  row.append(copy,fillButton(order,swap.isV2(order)?'Fill all':'Fill this lot'));root.append(row);}
}

function refreshAssets(){for(const id of ['base','quote']){const select=el<HTMLSelectElement>(id),previous=select.value;select.replaceChildren();for(const [key,item]of assets){const option=document.createElement('option');option.value=key;option.textContent=item.label;select.append(option);}select.value=assets.has(previous)?previous:id==='quote'?[...assets.keys()][1]??'ckb':'ckb';}renderBook();}
function saveAssets(){localStorage.setItem('openswap-assets',ccc.stringify([...assets.values()].filter(a=>a.asset.kind==='udt').map(a=>({label:a.label,script:a.asset.kind==='udt'?a.asset.script:undefined}))));}
function addAsset(name:string,script:ccc.Script){const asset=swap.udt(script);assets.set(swap.assetKey(asset),{label:name.slice(0,32),asset});refreshAssets();}
function renderCatalog(){
 const network=value('catalog-network') as swap.TokenNetwork;
 const query=value('catalog-search').trim().toLowerCase();
 const tokens=swap.tokensForNetwork(network).filter(t=>`${t.symbol} ${t.name} ${t.kind} ${t.source==='utxoswap'?'RGB++ UTXOSwap':''} ${t.typeHash}`.toLowerCase().includes(query));
 text('catalog-note',`${tokens.length} tokens · snapshot ${swap.CATALOG_DATE}. ${network==='mainnet'?'Mainnet preview: trading requires a mainnet OpenSwap deployment.':'Select a token to use it as the quote asset.'}`);
 const root=el('catalog-results');root.replaceChildren();
 for(const token of tokens){const row=document.createElement('div');row.className='catalog-row';const description=document.createElement('span');description.textContent=`${token.symbol} · ${token.name} · ${token.kind} · ${token.decimals} decimals${token.rank?` · #${token.rank}, ${token.holders} holders`:''}${token.source==='utxoswap'?' · UTXOSwap':''}`;row.append(description);
 const action=button(network==='mainnet'?'Mainnet only':token.profile==='resolver-required'?'Adapter required':'Use token',async()=>{if(network!=='testnet')throw new Error('Mainnet trading is not deployed');const script=ccc.Script.from(token.script);const resolved=await assetResolver(client).identify(script);if(!resolved.supported)throw new Error(resolved.reason);invalidate();addAsset(token.symbol,script);el<HTMLSelectElement>('quote').value=token.typeHash;renderBook();});action.disabled=network!=='testnet'||token.profile==='resolver-required';row.append(action);root.append(row);}
 if(!tokens.length)root.textContent='No matching tokens.';
}
el('catalog-network').onchange=renderCatalog;el('catalog-search').oninput=renderCatalog;
function endpoint(input:string){const url=new URL(input);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Use an HTTP(S) endpoint without embedded credentials');return url.toString();}
async function configure(rpc:string,indexer:string){
 const nextRpc=ccc.ClientPublicTestnet.open({urls:[endpoint(rpc)]}),nextIndexer=ccc.ClientPublicTestnet.open({urls:[endpoint(indexer)]});
 try{
  await swap.assertNetwork(nextRpc.value,deployment);
  const response=await fetch(endpoint(indexer),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'get_indexer_tip',params:[]}),signal:AbortSignal.timeout(20000)});
  const result=await response.json();if(!response.ok||result.error||!result.result)throw new Error('Indexer tip unavailable');
  const header=await nextRpc.value.getHeaderByNumber(BigInt(result.result.block_number));if(header?.hash!==result.result.block_hash)throw new Error('RPC and indexer are on different chains or the indexer tip is unavailable');
  nextRpc.value.findCellsPagedNoCache=(...args)=>nextIndexer.value.findCellsPagedNoCache(...args);
  nextRpc.value.findTransactionsPaged=nextIndexer.value.findTransactionsPaged.bind(nextIndexer.value);
 }catch(error){await nextRpc.dispose();await nextIndexer.dispose();throw error;}
 scanAbort?.abort();invalidate();poolUi.reset();marketView.reset();connector.disconnect();signer=undefined;owner=undefined;walletLocks=[];text('connected-account','');orders=[];
 const oldRpc=rpcOwner,oldIndexer=indexerOwner;rpcOwner=nextRpc;indexerOwner=nextIndexer;client=nextRpc.value;connector.client=client;
 await oldRpc.dispose();await oldIndexer.dispose();renderBook();text('status','Connected to CKB testnet.');
}
el('endpoints').onsubmit=e=>{e.preventDefault();if(busy)return;run(async()=>{await configure(value('rpc'),value('indexer'));await scan();});};
el('add-token').onsubmit=e=>{e.preventDefault();run(async()=>{const script=ccc.Script.from(JSON.parse(value('token-script')));const result=await assetResolver(client).identify(script);if(!result.supported)throw new Error(result.reason??'This token needs an AssetResolver');addAsset(value('token-label'),script);saveAssets();});};
for(const id of ['base','quote'])el(id).onchange=()=>{invalidate();renderBook();};
async function scan(){scanFresh=false;scanAbort?.abort();const abort=new AbortController();scanAbort=abort;const current=client;const found:swap.AnyOrder[]=[];let malformed=0;text('scan-status','Scanning live cells…');
 try{for await(const order of swap.scan(current,deployment,assetResolver(current),{maxCells:10000,signal:abort.signal,onMalformed:()=>malformed++}))found.push(order);
 if(v2){for await(const order of swap.scanV2(current,v2,assetResolver(current),{maxCells:10000,signal:abort.signal,onMalformed:()=>malformed++}))found.push(order);chainNow=(await current.getTipHeader()).timestamp/1000n;}
 if(abort.signal.aborted||client!==current)throw new Error('Order scan replaced; refresh and try again');scanFresh=true;lastScan=Date.now();orders=found;for(const o of found)for(const a of [o.offerAsset,o.askAsset])if(a.kind==='udt'&&!assets.has(swap.assetKey(a)))addAsset(`Token ${a.scriptHash.slice(0,8)}…`,a.script);text('scan-status',`${found.length} supported live orders · ${malformed} malformed cells skipped · scan cap 10,000 cells`);renderBook();}catch(error){if(!abort.signal.aborted){text('scan-status','Scan failed. Previously loaded orders may be stale.');throw error;}throw error;}
}
el('refresh').onclick=()=>run(async()=>{await scan();await refreshActivity();});
function button(title:string,action:()=>Promise<void>){const b=document.createElement('button');b.disabled=busy;b.textContent=title;b.onclick=()=>{if(!busy)run(action);};return b;}
function renderOwnOrders(){
 const mine=el('my-orders');mine.replaceChildren();if(!owner){mine.textContent='Connect a wallet to manage your orders.';return;}
 const owned=orders.filter(o=>isOwnOrder(o,walletLocks));if(!owned.length)mine.textContent='No live orders for this wallet.';
 for(const order of owned){const row=document.createElement('p');row.textContent=`Offer ${amount(remaining(order),order.offerAsset)} for ${amount(askNow(order),order.askAsset)}${v2Note(order)} `;row.append(cancelButton(order));mine.append(row);}
}
function renderBook(){
 renderOwnOrders(); renderAvailable();updateQuote();updateOrderPreview();if(assets.has(value('base'))&&assets.has(value('quote'))){showBalance();text('order-pair',`${label(selected('base'))} / ${label(selected('quote'))}`);const direction=el<HTMLSelectElement>('direction');direction.options[0]!.textContent=`Offer ${label(selected('base'))}, ask ${label(selected('quote'))}`;direction.options[1]!.textContent=`Offer ${label(selected('quote'))}, ask ${label(selected('base'))}`;}
 const root=el('book');root.replaceChildren();const base=assets.get(value('base'))?.asset,quote=assets.get(value('quote'))?.asset;
 if(!base||!quote||swap.assetKey(base)===swap.assetKey(quote)){root.textContent='Choose two different assets to view a market.';return;}
 for(const [title,offer,ask]of [['Asks · base offered',base,quote],['Bids · quote offered',quote,base]] as const){
  const heading=document.createElement('h3');heading.textContent=title;root.append(heading);
  const rows=orders.filter(o=>swap.assetKey(o.offerAsset)===swap.assetKey(offer)&&swap.assetKey(o.askAsset)===swap.assetKey(ask)).sort(swap.comparePrice);
  if(!rows.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='No live lots in this direction.';root.append(empty);continue;}
  const wrap=document.createElement('div');wrap.className='book-scroll';const table=document.createElement('table');table.innerHTML='<thead><tr><th>Offer · units</th><th>Ask · units</th><th>Exact price</th><th>Order</th><th></th></tr></thead>';const body=document.createElement('tbody');
  const pageKey=title+swap.assetKey(offer)+swap.assetKey(ask);const page=Math.min(bookPages.get(pageKey)??0,Math.floor((rows.length-1)/50));const shown=rows.slice(page*50,page*50+50);
  const navigation=document.createElement('p');navigation.textContent=`Lots ${page*50+1}–${Math.min(rows.length,page*50+50)} of ${rows.length} `;if(page>0)navigation.append(button('Previous page',async()=>{bookPages.set(pageKey,page-1);renderBook();}));if((page+1)*50<rows.length)navigation.append(button('Next page',async()=>{bookPages.set(pageKey,page+1);renderBook();}));root.append(navigation);
  for(const order of shown){const tr=document.createElement('tr');for(const content of [amount(remaining(order),order.offerAsset)+v2Note(order),amount(askNow(order),order.askAsset),`${order.askAmount}/${order.offerAmount}`,`${order.outPoint.txHash.slice(0,12)}…:${order.outPoint.index}`]){const td=document.createElement('td');td.textContent=content;tr.append(td);}const td=document.createElement('td');td.append(isOwnOrder(order,walletLocks)?button('Your order',async()=>showView('orders')):swap.isV2(order)&&swap.isExpired(order,chainNow)?(returnable(order)?returnButton(order):document.createTextNode('Expired')):fillButton(order,swap.isV2(order)?'Fill all':'Fill lot'));tr.append(td);body.append(tr);}table.append(body);wrap.append(table);root.append(wrap);
 }

}
function context():swap.BuildContext{if(!signer)throw new Error('Connect a wallet first');if(busy)throw new Error('Wait for the current transaction');if(!owner)throw new Error('Wait for the connected account to load');return{signer,deployment,resolver:assetResolver(client)};}

el('create').onsubmit=e=>{e.preventDefault();run(async()=>{
 const ctx=context(),start=generation;await assertActiveAccount(ctx.signer,start);const base=selected('base'),quote=selected('quote');const offer=value('direction')==='sell'?base:quote,ask=value('direction')==='sell'?quote:base;
 const offered=parseUnits(value('offer'),decimals(offer)),wanted=parseUnits(value('ask'),decimals(ask));const plan=swap.plan({totalOffer:offered,priceNumerator:wanted,priceDenominator:offered,candidateCounts:[Number(value('lots'))]})[0];if(!plan)throw new Error('Offer must contain at least one unit per lot');
 if(v2){
  const {expiry}=v2Options(),lots=v2Lots(offer,plan);
  const built=await swap.createOrdersV2(v2Context(),{offerAsset:offer,askAsset:ask,expiry,lots});
  if(start!==generation)throw new Error('Wallet or market changed; prepare again');
  await prepare(built,`Create ${plan.count} order${plan.count===1?'':'s'} (order lock v2).\nOffer: ${amount(offered,offer)}\nTotal ask: ${amount(plan.totalAsk,ask)}\nRounding premium: ${amount(plan.roundingPremium,ask)}\n${v2Disclosure(offer,ask,lots,expiry,built.lots)}\nOrder capacity: ${ccc.fixedPointToString(built.tx.outputs.slice(0,plan.count).reduce((n,o)=>n+o.capacity,0n))} CKB`);
  return;
 }
 const built=await swap.createOrder(ctx,{offerAsset:offer,askAsset:ask,lots:plan.offers.map((offerAmount,i)=>({offerAmount,askAmount:plan.asks[i]!}))});
 if(start!==generation)throw new Error('Wallet or market changed; prepare again');
 await prepare(built,`Create ${plan.count} independent lots.\nOffer: ${amount(offered,offer)}\nTotal ask: ${amount(plan.totalAsk,ask)}\nRounding premium: ${amount(plan.roundingPremium,ask)}\nOrder capacity: ${ccc.fixedPointToString(built.tx.outputs.slice(0,plan.count).reduce((n,o)=>n+o.capacity,0n))} CKB`);
 });};
async function buildReview(build:(ctx:swap.BuildContext)=>Promise<swap.BuiltTransaction>,summary:string){const ctx=context(),start=generation;await assertActiveAccount(ctx.signer,start);const built=await build(ctx);if(start!==generation||ctx.signer!==signer)throw new Error('Wallet changed; prepare again');await prepare(built,summary);}
async function prepare(built:swap.BuiltTransaction,summary:string){if(!signer)throw new Error('Wallet disconnected');built.assertLayout();const selected=signer,start=generation;const fee=await built.tx.getFee(selected.client);const addresses=await selected.getAddressObjs();const costs=await capacityReview(built.tx,selected.client,addresses.map(a=>a.script),v2?[deployment,v2]:[deployment]);await assertActiveAccount(selected,start);if(start!==generation||signer!==selected)throw new Error('Wallet changed; prepare again');review={built,signer:selected,generation:start,summary,account:accountKey(addresses.map(a=>a.script)),createdAt:Date.now()};text('review-text',`${summary}\n\nNetwork fee: ${ccc.fixedPointToString(fee)} CKB\nProtocol fee: 0 CKB\nWallet CKB change: ${formatUnits(costs.walletChange,8)} CKB (negative means leaving wallet; includes network fee)\nCKB locked in new orders: ${formatUnits(costs.orderLocked,8)}\nCKB released from your orders: ${formatUnits(costs.orderReleased,8)}\nChange in token-cell storage reserve: ${formatUnits(costs.tokenReserveChange,8)} CKB (recoverable capacity, not a fee)\nInputs: ${built.tx.inputs.length} · Outputs: ${built.tx.outputs.length}\nNetwork: CKB TESTNET\nConnected account: ${ccc.Address.fromScript(owner!,selected.client).toString()}`);text('review-raw',ccc.stringify(built.tx));el<HTMLDialogElement>('review').showModal();}
el('swap').onsubmit=e=>{e.preventDefault();run(async()=>{
 const ctx=context(),start=generation;await assertActiveAccount(ctx.signer,start);const base=selected('base'),quote=selected('quote');
 const assetOut=value('swap-direction')==='buy'?base:quote,assetIn=value('swap-direction')==='buy'?quote:base;
 const requested=parseUnits(value('swap-output'),decimals(assetOut)),budget=value('swap-budget').trim()?parseUnits(value('swap-budget'),decimals(assetIn)):swap.U128_MAX;
 // Fresh orders and fresh pool state are independent reads.
 await Promise.all([scan(),poolUi.load().catch(()=>{})]);
 if(start!==generation)throw new Error('Wallet or market changed; quote again');
 // Re-select the venue from fresh orders and pool state; the pool path has its own review.
 const {best,notes}=bestRoute();
 if(!best)throw new Error(`No available swap for ${amount(requested,assetOut)} paying ${label(assetIn)}. ${notes.join(' · ')}.`);
 if(best.venue==='pool'){
  text('quote-status','Best route: pool. Preparing the pool review…');
  try{await poolUi.prepareRouted(best.route,requested,budget);}catch(error){text('quote-status',explainError(error));throw error;}
  return;
 }
 if(best.venue==='route'){
  text('quote-status','Best route: two pools via CKB. Preparing one review…');
  try{await poolUi.prepareMultiHop(best.route,requested,budget);}catch(error){text('quote-status',explainError(error));throw error;}
  return;
 }
 if(best.venue==='split'){
  text('quote-status',`Best route: split, ${best.route.lots.length} order lot${best.route.lots.length===1?'':'s'} + pool. Preparing one review…`);
  try{await assertExternalFill(ctx.signer,best.route.lots);await poolUi.prepareSplit(best.route,{codeHash:deployment.codeHash,cellDep:deployment.cellDep},requested,budget);}
  catch(error){text('quote-status',explainError(error));throw error;}
  return;
 }
 if(best.venue==='mixed'){
  const q=best.quote,legs=q.legs;
  await assertExternalFill(ctx.signer,legs.map(l=>l.order));
  await checkFunding(ctx.signer,assetIn,q.amountIn);
  const built=await swap.fillOrdersV2(v2Context(),legs.map(l=>({outPoint:l.order.outPoint,take:swap.isV2(l.order)?l.take:undefined})),{v1:deployment,nowSeconds:chainNow});
  // The builder re-plans every leg from live cells; refuse if that differs from the quote.
  let paid=0n,received=0n;built.orders.forEach((o,i)=>{const plan=built.plans[i];paid+=plan?plan.paid:o.askAmount;received+=plan?plan.taken:o.offerAmount;});
  if(paid>q.amountIn||paid>budget||received<requested)throw new Error('Live orders changed since the quote; quote again');
  if(start!==generation||ctx.signer!==signer)throw new Error('Wallet changed; quote again');
  const partial=built.plans.filter(p=>p&&!p.final).length;
  await prepare(built,`Order-book swap\nRequested: ${amount(requested,assetOut)}\nYou receive: ${amount(received,assetOut)}\nExtra received: ${amount(received-requested,assetOut)}\nYou pay: ${amount(paid,assetIn)}\nOrders: ${legs.length}${partial?`\nPartly filled: ${partial}. The rest of ${partial===1?'that order':'those orders'} stays listed at the maker's price.`:''}\nFee and CKB storage funding are additional to input required.`);
  return;
 }
 const tip=await client.getTipHeader();
 const routed=swap.quoteSwap(v1Lots(orders).filter(o=>!isOwnOrder(o,walletLocks)),{assetIn,assetOut,amountOut:requested,maxAmountIn:budget,tipBlock:tip.number,genesisHash:deployment.genesisHash});
 await assertExternalFill(ctx.signer,routed.selectedOrders);
 await checkFunding(ctx.signer,assetIn,routed.amountIn);
 const prepared=await swap.prepareSwap(ctx,routed,{maxAmountIn:routed.amountIn,minAmountOut:requested});
 if(start!==generation||ctx.signer!==signer)throw new Error('Wallet changed; quote again');
 const q=prepared.quote;
 await prepare(prepared.built,`Whole-lot swap\nRequested: ${amount(q.requestedOutput,assetOut)}\nYou receive: ${amount(q.amountOut,assetOut)}\nExtra received: ${amount(q.overfill,assetOut)}\nYou pay: ${amount(q.amountIn,assetIn)}\nLots: ${q.selectedOrders.length}\nQuoted at block: ${q.tipBlock}\nFee and CKB storage funding are additional to input required.`);
});};
el('dismiss').onclick=()=>{review=undefined;el<HTMLDialogElement>('review').close();};
function setBusy(value:boolean){busy=value;for(const button of document.querySelectorAll<HTMLButtonElement>('#create button,#swap button,#refresh,#endpoints button,#connect,#book button,#my-orders button,#dismiss,#sign,#available-orders button,#swap-own-orders button,#reverse'))button.disabled=value;}
el('sign').onclick=()=>run(async()=>{const pending=review;if(!pending||pending.generation!==generation||pending.signer!==signer)throw new Error('Review is stale; prepare again');if(Date.now()-pending.createdAt>60000){invalidate();throw new Error('Review is over one minute old. Refresh and prepare it again.');}setBusy(true);text('status','Preparing wallet signature…');let submittedHash:string|undefined;
 try{await assertActiveAccount(pending.signer,pending.generation);const hash=await swap.submit(pending.built,pending.signer,{beforeBroadcast:hash=>{submittedHash=hash;saveActivity({hash,account:pending.account,network:deployment.genesisHash,summary:pending.summary.slice(0,2000),status:'unknown',createdAt:Date.now()});}});submittedHash=hash;saveActivity({hash,account:pending.account,network:deployment.genesisHash,summary:pending.summary.slice(0,2000),status:'submitted',createdAt:Date.now()});void refreshActivity();review=undefined;el<HTMLDialogElement>('review').close();text('status',`Submitted: ${hash}. Waiting for confirmation…`);await pending.signer.client.waitTransaction(hash,1);text('status',`Committed: ${hash}`);saveActivity({hash,account:pending.account,network:deployment.genesisHash,summary:pending.summary.slice(0,2000),status:'committed',createdAt:Date.now()});void refreshActivity();await scan();}catch(error){if(submittedHash){review=undefined;el<HTMLDialogElement>('review').close();void refreshActivity();throw new Error(`Transaction ${submittedHash} was sent to the node, but its final status is not confirmed here. Check Activity or the explorer before retrying. ${String(error)}`);}throw error;}finally{setBusy(false);}
});
run(async()=>{
 try{for(const item of JSON.parse(localStorage.getItem('openswap-assets')??'[]'))addAsset(String(item.label),ccc.Script.from(item.script));}catch{report(new Error('Stored token list was invalid; add the tokens again.'));}
 const testOwner=await ccc.Address.fromString('ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq',client);
 const testToken=await ccc.Script.fromKnownScript(client,ccc.KnownScript.XUdt,testOwner.script.hash());addAsset('Order-test xUDT',testToken);
 for(const token of swap.tokensForNetwork('testnet'))if(token.profile!=='resolver-required')addAsset(token.symbol,ccc.Script.from(token.script));renderCatalog();refreshAssets();if(value('quote')==='ckb')el<HTMLSelectElement>('quote').value=testToken.hash();await configure(value('rpc'),value('indexer'));
 // Pool tokens join the asset list (and the resolver) before the order scan, so
 // orders in a pool's token are recognised and both venues can be compared.
 await poolUi.load().then(registerPoolMarkets,report);
 v2=await loadOrderV2().catch(error=>{report(error);return undefined;});showV2Options();startupDone();await scan();
});
/** The v2 order lock manifest, if this build ships one; absent means v1 only. */
async function loadOrderV2():Promise<swap.Deployment|undefined>{
 const response=await fetch('./order-v2-manifest.json',{cache:'no-store'});
 if(response.status===404)return undefined;
 if(!response.ok)throw new Error(`Order lock v2 manifest unavailable (HTTP ${response.status})`);
 const d=await response.json() as swap.Deployment;
 if(d.network!=='testnet'||d.genesisHash!==deployment.genesisHash||d.hashType!=='data1'||!/^0x[0-9a-f]{64}$/.test(d.codeHash)||d.codeHash===deployment.codeHash||ccc.CellDep.from(d.cellDep).depType!=='code')throw new Error('Order lock v2 manifest is invalid for this network');
 return d;
}
function showV2Options(){el('order-v2-options').hidden=!v2;text('lot-note',v2?'Orders can fill partially if you allow it below. Rounding may slightly increase the total ask.':'Each lot fills in full. Rounding may slightly increase the total ask.');text('swap-fill-note',v2?'Orders can be filled partly when their maker allows it. Your quote shows the actual amount received. Network fees and cell storage are additional.':'Orders fill in whole lots. Your quote shows the actual amount received. Network fees and cell storage are additional.');}
function registerPoolMarkets(){
 poolTokenDep=poolUi.tokenDep();
 for(const market of poolUi.markets()){tokenDecimals.set(market.token.hash(),market.decimals);if(!assets.has(market.token.hash()))addAsset(market.symbol,market.token);}
 renderAvailable();
}
