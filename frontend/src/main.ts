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
let generation=0,busy=false,orders:swap.OpenSwapOrder[]=[],scanAbort:AbortController|undefined;
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
function showView(view:string){if(view==='activity')void refreshActivity();if(view==='pools')poolUi.show();for(const name of ['swap','orders','pools','activity','settings'])el(`view-${name}`).hidden=name!==view;for(const b of document.querySelectorAll<HTMLButtonElement>('[data-view]'))b.setAttribute('aria-pressed',String(b.dataset.view===view));}
for(const b of document.querySelectorAll<HTMLButtonElement>('[data-view]'))b.onclick=()=>showView(b.dataset.view!);
el('reverse').onclick=()=>{const base=value('base');el<HTMLSelectElement>('base').value=value('quote');el<HTMLSelectElement>('quote').value=base;el<HTMLInputElement>('swap-output').value='';el<HTMLInputElement>('swap-budget').value='';invalidate();renderBook();};
function swapAssets(){const base=selected('base'),quote=selected('quote');return value('swap-direction')==='buy'?{assetOut:base,assetIn:quote}:{assetOut:quote,assetIn:base};}
function localQuote(){if(!scanFresh)throw new Error('Refresh live orders before requesting a quote.');const {assetIn,assetOut}=swapAssets();return swap.quoteSwap(orders.filter(o=>!isOwnOrder(o,walletLocks)),{assetIn,assetOut,amountOut:parseUnits(value('swap-output'),decimals(assetOut)),maxAmountIn:value('swap-budget').trim()?parseUnits(value('swap-budget'),decimals(assetIn)):swap.U128_MAX,tipBlock:0n,genesisHash:deployment.genesisHash});}
type Route={venue:'orders';quote:swap.SwapQuote}|{venue:'pool';route:PoolRoute}|{venue:'split';route:SplitRoute<swap.OpenSwapOrder>}|{venue:'route';route:MultiHopRoute};
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
 try{orderRoute={venue:'orders',quote:localQuote()};orderNote=`Order book: ${amount(orderRoute.quote.amountOut,assetOut)} for ${amount(orderRoute.quote.amountIn,assetIn)} (${orderRoute.quote.selectedOrders.length} whole lot${orderRoute.quote.selectedOrders.length===1?'':'s'})`;}
 catch(error){orderNote=`Order book: ${String(error).includes('No whole-lot')?'no whole-lot route for this amount':error instanceof Error?error.message:String(error)}`;}
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
   const lots=orders.filter(o=>o.supported&&o.genesisHash===deployment.genesisHash&&!isOwnOrder(o,walletLocks)&&swap.assetKey(o.offerAsset)===swap.assetKey(assetOut)&&swap.assetKey(o.askAsset)===swap.assetKey(assetIn)
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
 const cost=(r:Route)=>r.venue==='orders'?{input:r.quote.amountIn,output:r.quote.amountOut}:{input:r.route.amountIn,output:r.route.amountOut};
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
  const input=best.venue==='orders'?best.quote.amountIn:best.route.amountIn,output=best.venue==='orders'?best.quote.amountOut:best.route.amountOut;
  text('pay-estimate',formatUnits(input,decimals(assetIn)));
  text('quote-status',`Best route: ${best.venue==='pool'?'pool':best.venue==='route'?'two pools via CKB in one transaction':best.venue==='split'?`split, ${best.route.lots.length} order lot${best.route.lots.length===1?'':'s'} + pool in one transaction`:'order book'}. Receive ${amount(output,assetOut)} for ${amount(input,assetIn)}. Price ≈ ${unitPrice(input,output,decimals(assetIn),decimals(assetOut))} ${label(assetIn)} per ${label(assetOut)}. Compared: ${notes.join(' · ')}. Fees and storage are additional.${own}`);
 }catch(error){text('quote-status',error instanceof Error?error.message:String(error));}
}
for(const id of ['swap-output','swap-budget','swap-direction','offer','ask','lots','direction'])el(id).oninput=()=>{invalidate();updateQuote();updateOrderPreview();};
function updateOrderPreview(){
 if(!owner){text('order-estimate','Connect a wallet to estimate the CKB capacity needed for your order.');return;}
 if(!value('offer')||!value('ask')){text('order-estimate','Enter your offer and ask to see the price and storage reserve.');return;}
 try{const base=selected('base'),quote=selected('quote'),offer=value('direction')==='sell'?base:quote,ask=value('direction')==='sell'?quote:base;
 const offered=parseUnits(value('offer'),decimals(offer)),wanted=parseUnits(value('ask'),decimals(ask));const plan=swap.plan({totalOffer:offered,priceNumerator:wanted,priceDenominator:offered,candidateCounts:[Number(value('lots'))]})[0];if(!plan)throw new Error('Offer must contain at least one unit per lot');
 const capacity=plan.offers.reduce((n,v,i)=>n+swap.estimateCapacity(deployment,{ownerLock:owner!,nonce:new Uint8Array(16),askAsset:ask,askAmount:plan.asks[i]!},offer,v).cell.cellOutput.capacity,0n);
 const reserve=capacity-(offer.kind==='ckb'?offered:0n);
 text('order-estimate',`Price ≈ ${unitPrice(plan.totalAsk,offered,decimals(ask),decimals(offer))} ${label(ask)} per ${label(offer)}. CKB locked: ${formatUnits(capacity,8)} (${formatUnits(reserve,8)} storage reserve). Storage reserve returns on fill or cancellation. Network fee calculated at review.`);
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
 for(const order of owned.slice(0,10)){const row=document.createElement('div');row.className='quote-row';const copy=document.createElement('span');copy.textContent=`Offer ${amount(order.offerAmount,order.offerAsset)} for ${amount(order.askAmount,order.askAsset)}`;row.append(copy,cancelButton(order,'Cancel order'));root.append(row);}
 if(owned.length>10){const more=document.createElement('p');more.textContent=`${owned.length-10} more in the Orders tab. `;more.append(button('Show all',async()=>showView('orders')));root.append(more);}
}
function cancelButton(order:swap.OpenSwapOrder,title='Cancel'){return button(title,async()=>buildReview(ctx=>swap.cancelOrders(ctx,[order.outPoint]),`Recover order ${swap.orderKey(order)}. A separate plain owner cell pays the fee.`));}
function renderAvailable(){renderSwapOwnOrders();const root=el('available-orders');root.replaceChildren();text('quote-age',scanFresh?`Orders checked ${new Date(lastScan).toLocaleTimeString()}`:'Live orders need refreshing.');const markets=poolUi.markets();
 text('available-note',orders.length||markets.length?`${markets.length?`${markets.length} pool${markets.length===1?'':'s'} (any amount, price moves with size)${orders.length?' and ':''}`:''}${orders.length?`${orders.length} order-book lot${orders.length===1?'':'s'} (whole lots only, fixed price)`:''}.`:'No live swaps yet. Place an order in the Orders tab.');
 // Pools first: they take any amount, so they set the pair for the form above.
 for(const market of markets){const row=document.createElement('div');row.className='quote-row';const copy=document.createElement('span');
  copy.textContent=`Pool: CKB ⇄ ${market.symbol} · 1 ${market.symbol} ≈ ${unitPrice(market.x,market.y,8,market.decimals)} CKB · reserves ${formatUnits(market.x,8)} CKB / ${formatUnits(market.y,market.decimals)} ${market.symbol}`;
  row.append(copy,button('Trade this pair',async()=>{el<HTMLSelectElement>('quote').value='ckb';el<HTMLSelectElement>('base').value=market.token.hash();el<HTMLInputElement>('swap-output').value='';invalidate();renderBook();updateQuote();el('swap-output').focus();}));root.append(row);}
 for(const order of orders.slice(0,30)){const row=document.createElement('div');row.className='quote-row';const copy=document.createElement('span');copy.textContent=`Order lot: pay ${amount(order.askAmount,order.askAsset)} → receive ${amount(order.offerAmount,order.offerAsset)}`;if(isOwnOrder(order,walletLocks)){copy.textContent+=' · Your order';row.append(copy,cancelButton(order,'Cancel order'));root.append(row);continue;}row.append(copy,button('Fill this lot',async()=>{await buildReview(async ctx=>{await assertExternalFill(ctx.signer,[order]);await checkFunding(ctx.signer,order.askAsset,order.askAmount);return swap.fillOrders(ctx,[order.outPoint]);},`You pay: ${amount(order.askAmount,order.askAsset)}\nYou receive: ${amount(order.offerAmount,order.offerAsset)}`);}));root.append(row);}
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
 scanAbort?.abort();invalidate();poolUi.reset();connector.disconnect();signer=undefined;owner=undefined;walletLocks=[];text('connected-account','');orders=[];
 const oldRpc=rpcOwner,oldIndexer=indexerOwner;rpcOwner=nextRpc;indexerOwner=nextIndexer;client=nextRpc.value;connector.client=client;
 await oldRpc.dispose();await oldIndexer.dispose();renderBook();text('status','Connected to CKB testnet.');
}
el('endpoints').onsubmit=e=>{e.preventDefault();if(busy)return;run(async()=>{await configure(value('rpc'),value('indexer'));await scan();});};
el('add-token').onsubmit=e=>{e.preventDefault();run(async()=>{const script=ccc.Script.from(JSON.parse(value('token-script')));const result=await assetResolver(client).identify(script);if(!result.supported)throw new Error(result.reason??'This token needs an AssetResolver');addAsset(value('token-label'),script);saveAssets();});};
for(const id of ['base','quote'])el(id).onchange=()=>{invalidate();renderBook();};
async function scan(){scanFresh=false;scanAbort?.abort();const abort=new AbortController();scanAbort=abort;const current=client;const found:swap.OpenSwapOrder[]=[];let malformed=0;text('scan-status','Scanning live cells…');
 try{for await(const order of swap.scan(current,deployment,assetResolver(current),{maxCells:10000,signal:abort.signal,onMalformed:()=>malformed++}))found.push(order);
 if(abort.signal.aborted||client!==current)throw new Error('Order scan replaced; refresh and try again');scanFresh=true;lastScan=Date.now();orders=found;for(const o of found)for(const a of [o.offerAsset,o.askAsset])if(a.kind==='udt'&&!assets.has(swap.assetKey(a)))addAsset(`Token ${a.scriptHash.slice(0,8)}…`,a.script);text('scan-status',`${found.length} supported live orders · ${malformed} malformed cells skipped · scan cap 10,000 cells`);renderBook();}catch(error){if(!abort.signal.aborted){text('scan-status','Scan failed. Previously loaded orders may be stale.');throw error;}throw error;}
}
el('refresh').onclick=()=>run(async()=>{await scan();await refreshActivity();});
function button(title:string,action:()=>Promise<void>){const b=document.createElement('button');b.disabled=busy;b.textContent=title;b.onclick=()=>{if(!busy)run(action);};return b;}
function renderOwnOrders(){
 const mine=el('my-orders');mine.replaceChildren();if(!owner){mine.textContent='Connect a wallet to manage your orders.';return;}
 const owned=orders.filter(o=>isOwnOrder(o,walletLocks));if(!owned.length)mine.textContent='No live orders for this wallet.';
 for(const order of owned){const row=document.createElement('p');row.textContent=`Offer ${amount(order.offerAmount,order.offerAsset)} for ${amount(order.askAmount,order.askAsset)} `;row.append(cancelButton(order));mine.append(row);}
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
  for(const order of shown){const tr=document.createElement('tr');for(const content of [amount(order.offerAmount,order.offerAsset),amount(order.askAmount,order.askAsset),`${order.askAmount}/${order.offerAmount}`,`${order.outPoint.txHash.slice(0,12)}…:${order.outPoint.index}`]){const td=document.createElement('td');td.textContent=content;tr.append(td);}const td=document.createElement('td');td.append(isOwnOrder(order,walletLocks)?button('Your order',async()=>showView('orders')):button('Fill lot',async()=>buildReview(async ctx=>{await assertExternalFill(ctx.signer,[order]);await checkFunding(ctx.signer,order.askAsset,order.askAmount);return swap.fillOrders(ctx,[order.outPoint]);},`You pay: ${amount(order.askAmount,order.askAsset)}\nYou receive: ${amount(order.offerAmount,order.offerAsset)}`)));tr.append(td);body.append(tr);}table.append(body);wrap.append(table);root.append(wrap);
 }

}
function context():swap.BuildContext{if(!signer)throw new Error('Connect a wallet first');if(busy)throw new Error('Wait for the current transaction');if(!owner)throw new Error('Wait for the connected account to load');return{signer,deployment,resolver:assetResolver(client)};}

el('create').onsubmit=e=>{e.preventDefault();run(async()=>{
 const ctx=context(),start=generation;await assertActiveAccount(ctx.signer,start);const base=selected('base'),quote=selected('quote');const offer=value('direction')==='sell'?base:quote,ask=value('direction')==='sell'?quote:base;
 const offered=parseUnits(value('offer'),decimals(offer)),wanted=parseUnits(value('ask'),decimals(ask));const plan=swap.plan({totalOffer:offered,priceNumerator:wanted,priceDenominator:offered,candidateCounts:[Number(value('lots'))]})[0];if(!plan)throw new Error('Offer must contain at least one unit per lot');
 const built=await swap.createOrder(ctx,{offerAsset:offer,askAsset:ask,lots:plan.offers.map((offerAmount,i)=>({offerAmount,askAmount:plan.asks[i]!}))});
 if(start!==generation)throw new Error('Wallet or market changed; prepare again');
 await prepare(built,`Create ${plan.count} independent lots.\nOffer: ${amount(offered,offer)}\nTotal ask: ${amount(plan.totalAsk,ask)}\nRounding premium: ${amount(plan.roundingPremium,ask)}\nOrder capacity: ${ccc.fixedPointToString(built.tx.outputs.slice(0,plan.count).reduce((n,o)=>n+o.capacity,0n))} CKB`);
 });};
async function buildReview(build:(ctx:swap.BuildContext)=>Promise<swap.BuiltTransaction>,summary:string){const ctx=context(),start=generation;await assertActiveAccount(ctx.signer,start);const built=await build(ctx);if(start!==generation||ctx.signer!==signer)throw new Error('Wallet changed; prepare again');await prepare(built,summary);}
async function prepare(built:swap.BuiltTransaction,summary:string){if(!signer)throw new Error('Wallet disconnected');built.assertLayout();const selected=signer,start=generation;const fee=await built.tx.getFee(selected.client);const addresses=await selected.getAddressObjs();const costs=await capacityReview(built.tx,selected.client,addresses.map(a=>a.script),deployment);await assertActiveAccount(selected,start);if(start!==generation||signer!==selected)throw new Error('Wallet changed; prepare again');review={built,signer:selected,generation:start,summary,account:accountKey(addresses.map(a=>a.script)),createdAt:Date.now()};text('review-text',`${summary}\n\nNetwork fee: ${ccc.fixedPointToString(fee)} CKB\nProtocol fee: 0 CKB\nWallet CKB change: ${formatUnits(costs.walletChange,8)} CKB (negative means leaving wallet; includes network fee)\nCKB locked in new orders: ${formatUnits(costs.orderLocked,8)}\nCKB released from your orders: ${formatUnits(costs.orderReleased,8)}\nChange in token-cell storage reserve: ${formatUnits(costs.tokenReserveChange,8)} CKB (recoverable capacity, not a fee)\nInputs: ${built.tx.inputs.length} · Outputs: ${built.tx.outputs.length}\nNetwork: CKB TESTNET\nConnected account: ${ccc.Address.fromScript(owner!,selected.client).toString()}`);text('review-raw',ccc.stringify(built.tx));el<HTMLDialogElement>('review').showModal();}
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
 const tip=await client.getTipHeader();
 const routed=swap.quoteSwap(orders.filter(o=>!isOwnOrder(o,walletLocks)),{assetIn,assetOut,amountOut:requested,maxAmountIn:budget,tipBlock:tip.number,genesisHash:deployment.genesisHash});
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
 await poolUi.load().then(registerPoolMarkets,report);await scan();
});
function registerPoolMarkets(){
 poolTokenDep=poolUi.tokenDep();
 for(const market of poolUi.markets()){tokenDecimals.set(market.token.hash(),market.decimals);if(!assets.has(market.token.hash()))addAsset(market.symbol,market.token);}
 renderAvailable();
}
