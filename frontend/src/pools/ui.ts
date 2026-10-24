import {ccc} from '@ckb-ccc/core';
import {scanPools,resolveJoyIdWallet,joyIdProofSource,fundPoolTransaction,reviewPoolTransaction,PoolFundingReservations,PoolSubmissionRecovery,quoteSplit,
 type PoolSnapshot,type SplitLot,type PoolIntent,type PoolJoyIdSigner,type FundedPoolTransaction,type PoolTransactionReview,type PoolSubmitClient} from '../../../pool-sdk/src/index.js';
import {transition,swapExactOut,type Operation} from '../../../pool-model/src/model.js';
import {loadPoolManifest,type PoolManifest,type PoolTokenDisplay} from './manifest.js';
import {BrowserSubmissionJournal} from './journal.js';
import {parseUnits,formatUnits} from '../amounts.js';
import {explainError} from '../errors.js';
import {parseAmount} from '../../../sdk/src/codec.js';

export interface PoolMarket {poolId:ccc.Hex;token:ccc.Script;symbol:string;decimals:number;x:bigint;y:bigint}
export interface PoolRoute {poolId:ccc.Hex;direction:'xToY'|'yToX';amountIn:bigint;amountOut:bigint;checkedAt:number}
/** Whole order lots plus a pool swap for the rest, settled in one transaction. */
export interface SplitRoute<T extends SplitLot> extends PoolRoute {lots:T[];lotIn:bigint;lotOut:bigint;poolIn:bigint;poolOut:bigint}
export interface OrderCode {codeHash:ccc.Hex;cellDep:ccc.CellDepLike}
export interface PoolEnv {client():ccc.Client;signer():ccc.Signer|undefined;epoch():number;run(fn:()=>Promise<void>):void}
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id)! as T;
const text=(id:string,message:string)=>{el(id).textContent=message;};
const value=(id:string)=>el<HTMLInputElement>(id).value;
const ckb=(n:bigint)=>`${formatUnits(n,8)} CKB`;
type TokenDisplay=Pick<PoolTokenDisplay,'symbol'|'decimals'>;
/** Fallback when the manifest gives no metadata: exact raw base units. */
const RAW:TokenDisplay={symbol:'token units',decimals:0};
const tokenAmount=(n:bigint,t:TokenDisplay)=>`${formatUnits(n,t.decimals)} ${t.symbol}`;
const shares=(n:bigint)=>`${n} LP shares`;
/** Minimum accepted output: the fresh quote reduced by the slippage bound, never below 1. */
export const minimumOut=(quoted:bigint,slippageBps:number)=>{const n=quoted*BigInt(10000-slippageBps)/10000n;return n>0n?n:1n;};

/** The CCC client satisfies the narrow recovery interface. A real node answers an
 * unknown hash with `transaction: null` / status `unknown`, which CCC maps to
 * `undefined`; outages still throw and never read as an absent transaction. */
const recoveryClient=(client:ccc.Client)=>client as unknown as PoolSubmitClient;
/** Committed rows are archived (and their reservations dropped) at this depth. */
export const ARCHIVE_CONFIRMATIONS=24;
const RECHECK_MS=15000;

interface Session {signer:ccc.Signer;epoch:number;client:ccc.Client;lock:ccc.Script;journal:BrowserSubmissionJournal;recovery:PoolSubmissionRecovery;reservations:PoolFundingReservations}
interface Pending {generation:number;session:Session;funded:FundedPoolTransaction;review:PoolTransactionReview;sign:()=>Promise<ccc.Transaction>;title:string;token:TokenDisplay;
 /** Status line that reports this review's outcome: the Pools tab, or the Swap tab for a routed swap. */
 feedback:string}

export function createPoolUi(env:PoolEnv){
 let manifest:PoolManifest|undefined,loaded=false,snapshots:PoolSnapshot[]=[],checkedAt=0;
 let session:Session|undefined,pending:Pending|undefined,generation=0,busy=false;
 /** Latest observed label per journaled hash; hashes whose send succeeded here. */
 const labels=new Map<string,string>(),sentHere=new Set<string>();
 /** The connected account's LP shares per pool ID, read from live LP cells. */
 const lpBalances=new Map<string,bigint>();let lpGeneration=0;
 let resolving:Promise<void>|undefined,recheckTimer:ReturnType<typeof setTimeout>|undefined;

 function setBusy(next:boolean){busy=next;for(const b of document.querySelectorAll<HTMLButtonElement>('#view-pools button,#pool-approve,#pool-dismiss,#swap-submit'))b.disabled=next;}
 /** Drops any unsigned review and returns its funding reservation. */
 function invalidate(){
  generation++;
  if(pending){pending.funded.release();pending=undefined;}
  const dialog=el<HTMLDialogElement>('pool-review');if(dialog.open)dialog.close();
  text('pool-review-text','');
 }
 function reset(){invalidate();stopRecheck();labels.clear();lpBalances.clear();lpGeneration++;session=undefined;el('pool-submissions').replaceChildren();text('pool-submissions-status','Connect a wallet to see pool submissions from this browser.');}

 function selected():PoolSnapshot {
  const pool=snapshots.find(p=>p.poolId===value('pool-select'));
  if(!pool)throw new Error('Choose a pool after it has loaded');return pool;
 }
 /** Display metadata applies only if its type hash is the live pool's token (checked in refresh). */
 const tokenOf=(pool?:PoolSnapshot):TokenDisplay=>(pool&&manifest?.pools.find(p=>p.poolId===pool.poolId)?.token)||RAW;
 function labelToken(t:TokenDisplay){
  const name=t===RAW?'token units':t.symbol;
  el('pool-swap-direction').querySelector('option[value="yToX"]')!.textContent=`Pay ${name}, receive CKB`;
  text('pool-deposit-token-label',`Maximum ${name}`);
  el<HTMLInputElement>('pool-deposit-token').inputMode=t.decimals?'decimal':'numeric';
 }
 function render(){
  const list=el<HTMLSelectElement>('pool-select'),previous=list.value;list.replaceChildren();
  for(const pool of snapshots){const option=document.createElement('option');option.value=pool.poolId;option.textContent=manifest?.pools.find(p=>p.poolId===pool.poolId)?.label??pool.poolId.slice(0,12);list.append(option);}
  if(snapshots.some(p=>p.poolId===previous))list.value=previous;
  const ready=!!manifest&&snapshots.length>0;
  for(const id of ['pool-swap','pool-deposit','pool-withdraw'])el(id).hidden=!ready;
  el('pool-create').hidden=!manifest?.create;
  if(!ready){text('pool-info','');labelToken(RAW);return;}
  const pool=selected(),a=pool.accounting,t=tokenOf(pool);labelToken(t);renderLp();
  text('pool-info',[
   `Pool ${pool.poolId}`,
   `Reserves: ${ckb(a.x)} · ${tokenAmount(a.y,t)}`,
   `Swap fee: ${Number(a.feeBps)/100}%`,
   `LP supply: ${a.totalShares} (includes ${a.lockedShares} virtual locked shares that nobody can redeem)`,
   `Permanent backing (never withdrawable): state ${ckb(a.backing.state)} · CKB reserve ${ckb(a.backing.ckb)} · token reserve ${ckb(a.backing.token)}`,
   `Token: ${t===RAW?'':`${t.symbol} (${t.decimals} decimals) · `}xUDT ${pool.token.hash()} · owner ${pool.token.args}`,
   `State cell: ${pool.stateCell.outPoint.txHash}:${pool.stateCell.outPoint.index} · checked ${new Date(checkedAt).toLocaleTimeString()}`,
  ].join('\n'));
  quote();
 }
 /** Sums this account's live LP cells for the selected pool. Display only: funding
  * re-reads and validates every input at review. */
 async function loadLp(){
  const s=session,start=++lpGeneration;
  if(!s||!snapshots.length){renderLp();return;}
  const pool=selected();let total=0n,count=0;
  for await(const cell of s.client.findCells({script:s.lock,scriptType:'lock',scriptSearchMode:'exact',filter:{script:pool.lp},withData:true},'asc',50)){
   if(!cell.cellOutput.type?.eq(pool.lp))continue;
   total+=parseAmount(cell.outputData);if(++count>=200)break;
  }
  if(start!==lpGeneration||session!==s)return;
  lpBalances.set(pool.poolId,total);renderLp();
 }
 function renderLp(){
  if(!snapshots.length)return;
  const pool=selected(),balance=lpBalances.get(pool.poolId),t=tokenOf(pool);
  if(!session)text('pool-lp-balance',env.signer()?'Refresh to load your LP shares.':'Connect a wallet to see your LP shares.');
  else if(balance===undefined)text('pool-lp-balance','Loading your LP shares…');
  else if(balance===0n)text('pool-lp-balance','You have no LP shares in this pool.');
  else{
   const f=transition(pool.accounting,{kind:'withdraw',shares:balance,minX:1n,minY:1n}).flows;
   text('pool-lp-balance',`Your LP shares: ${balance} (worth about ${ckb(f.receivedX)} · ${tokenAmount(f.receivedY,t)} at the current pool state)`);
  }
  for(const b of document.querySelectorAll<HTMLButtonElement>('[data-share-pct]'))b.disabled=busy||!balance;
  withdrawQuote();
 }
 function withdrawQuote(){
  if(!snapshots.length||!manifest){text('pool-withdraw-quote','');return;}
  const raw=value('pool-withdraw-shares').trim();
  if(!raw){text('pool-withdraw-quote','Enter LP shares to burn, or pick a share of your position.');return;}
  try{
   const pool=selected(),t=tokenOf(pool),shares=parseUnits(raw,0),balance=lpBalances.get(pool.poolId);
   if(balance!==undefined&&shares>balance)throw new Error(`You have only ${balance} LP shares in this pool`);
   const f=transition(pool.accounting,{kind:'withdraw',shares,minX:1n,minY:1n}).flows,s=manifest.policy.slippageBps;
   const pct=balance?` (${Number(shares*10000n/balance)/100}% of your position)`:'';
   text('pool-withdraw-quote',`You receive about ${ckb(f.receivedX)} · ${tokenAmount(f.receivedY,t)}${pct}. Minimum accepted: ${ckb(minimumOut(f.receivedX,s))} · ${tokenAmount(minimumOut(f.receivedY,s),t)}. Requoted from live state at review.`);
  }catch(error){text('pool-withdraw-quote',error instanceof Error?error.message:String(error));}
 }
 function quote(){
  if(!snapshots.length||!manifest){text('pool-quote','');return;}
  try{
   const pool=selected(),t=tokenOf(pool),direction=value('pool-swap-direction') as 'xToY'|'yToX';
   const amountIn=parseUnits(value('pool-swap-amount'),direction==='xToY'?8:t.decimals);
   const flows=transition(pool.accounting,{kind:'swap',direction,amountIn,minOut:1n}).flows;
   const out=direction==='xToY'?flows.receivedY:flows.receivedX;
   const min=minimumOut(out,manifest.policy.slippageBps);
   text('pool-quote',`Expected: ${direction==='xToY'?tokenAmount(out,t):ckb(out)} · minimum accepted ${direction==='xToY'?tokenAmount(min,t):ckb(min)} (${manifest.policy.slippageBps/100}% bound). Quoted from the state checked at ${new Date(checkedAt).toLocaleTimeString()}; it is requoted from live state at review.`);
  }catch(error){text('pool-quote',value('pool-swap-amount').trim()?(error instanceof Error?error.message:String(error)):'Enter an amount to pay.');}
 }

 /** Runs a pool action with progress and errors shown beside the pool forms
  * (and in the global status line). */
 function act(progress:string,fn:()=>Promise<void>,target='pool-action-status'){
  text(target,progress);
  env.run(async()=>{try{await fn();}catch(error){text(target,explainError(error));throw error;}});
 }
 /** Retries when the app switches endpoints mid-load (for example at startup). */
 async function refresh(){
  for(let attempt=0;;attempt++){
   try{if(await refreshOnce())return;}
   catch(error){text('pool-status',`Could not load pools: ${explainError(error)}`);throw error;}
   if(attempt>=2){const message='Connection kept changing while loading pools; use Refresh';text('pool-status',message);throw new Error(message);}
  }
 }
 /** False when the connection changed during the load and the result was discarded. */
 async function refreshOnce():Promise<boolean>{
  const client=env.client();
  if(!loaded){manifest=await loadPoolManifest();loaded=true;}
  if(!manifest){snapshots=[];render();text('pool-status','Pools are not deployed on this network yet. No pool transactions can be prepared.');return true;}
  if((await client.getHeaderByNumberNoCache(0))?.hash!==manifest.deployment.genesisHash){
   if(client!==env.client())return false;
   snapshots=[];render();text('pool-status','Pools are not deployed on this network yet: the connected node is not the network in the pool manifest.');return true;
  }
  text('pool-status','Loading live pools…');
  const known=new Set(manifest.pools.map(p=>p.poolId)),found:PoolSnapshot[]=[];let skipped=0;
  for await(const pool of scanPools(client,manifest.deployment,{maxCandidates:1000,onMalformed:()=>skipped++}))if(known.has(pool.poolId))found.push(pool);
  if(client!==env.client())return false;
  for(const pool of found){
   const token=manifest.pools.find(p=>p.poolId===pool.poolId)?.token;
   if(token&&pool.token.hash()!==token.typeHash){
    const message=`Pool manifest token metadata does not match the live token of ${pool.poolId}; amounts cannot be shown safely`;
    snapshots=[];render();text('pool-status',message);throw new Error(message);
   }
  }
  snapshots=found;checkedAt=Date.now();render();
  text('pool-status',`${found.length} of ${manifest.pools.length} listed pools live${skipped?` · ${skipped} malformed candidates skipped`:''}.`);
  if(session)void loadLp().catch(()=>{});
  return true;
 }
 async function currentPool(poolId:string){await refresh();const pool=snapshots.find(p=>p.poolId===poolId);if(!pool)throw new Error('Pool is no longer live; refresh and choose again');return pool;}

 /** Single-flight per connection: concurrent callers (tab open, connect, review)
  * share one session instead of racing to replace each other's. */
 let opening:{key:unknown[];promise:Promise<Session>}|undefined;
 function ensureSession():Promise<Session> {
  const signer=env.signer(),epoch=env.epoch(),client=env.client();
  if(!signer)return Promise.reject(new Error('Connect a wallet first'));
  if(!manifest)return Promise.reject(new Error('Pools are not deployed on this network yet'));
  if(session&&session.signer===signer&&session.epoch===epoch&&session.client===client)return Promise.resolve(session);
  const key=[signer,epoch,client];
  if(opening&&opening.key.every((v,i)=>v===key[i]))return opening.promise;
  const promise=openSession(signer,epoch,client).finally(()=>{if(opening?.promise===promise)opening=undefined;});
  opening={key,promise};return promise;
 }
 async function openSession(signer:ccc.Signer,epoch:number,client:ccc.Client):Promise<Session> {
  const lock=(await signer.getRecommendedAddressObj()).script;
  if(env.signer()!==signer||env.epoch()!==epoch)throw new Error('Wallet changed; try again');
  const scope={genesisHash:manifest!.deployment.genesisHash,accountLockHash:lock.hash()};
  const journal=new BrowserSubmissionJournal(localStorage,scope),reservations=new PoolFundingReservations();
  const recovery=new PoolSubmissionRecovery(journal,reservations,scope);
  // Restores reservations for every recorded submission before any new funding.
  const reports=await recovery.reconcile(recoveryClient(client));
  if(env.signer()!==signer||env.epoch()!==epoch)throw new Error('Wallet changed; try again');
  session={signer,epoch,client,lock,journal,recovery,reservations};
  await settle(session,reports);renderSubmissions();scheduleRecheck();void loadLp().catch(()=>{});return session;
 }
 type Reports=Awaited<ReturnType<PoolSubmissionRecovery['reconcile']>>;
 /** Labels every row from what the node reports and archives committed rows that
  * are deep enough. Read-only: never signs, sends or retries. */
 async function settle(s:Session,reports:Reports){
  for(const r of reports){
   if(r.status==='committed'){
    try{await s.recovery.archiveCommitted(recoveryClient(s.client) as never,r.hash,{minConfirmations:ARCHIVE_CONFIRMATIONS});labels.delete(r.hash);sentHere.delete(r.hash);continue;}
    catch(error){
     const depth=/only (\d+) confirmations/.exec(error instanceof Error?error.message:'')?.[1];
     if(!depth)throw error;
     labels.set(r.hash,`COMMITTED · ${depth} of ${ARCHIVE_CONFIRMATIONS} confirmations; cleared from this list at ${ARCHIVE_CONFIRMATIONS}`);continue;
    }
   }
   labels.set(r.hash,r.status==='rejected'?'REJECTED · the node refused it. Its inputs stay reserved until it is resolved.'
    :r.observedStatus==='pending'||r.observedStatus==='proposed'?'PENDING · accepted by the node, waiting to be committed'
    :sentHere.has(r.hash)?'SENT · waiting for the node to report it'
    :'UNKNOWN · the node does not report this transaction yet. It may not have arrived; it may still commit.');
  }
 }
 /** One reconcile+settle at a time; submit waits for it so the two never overlap. */
 function recheck(s:Session):Promise<void>{
  resolving??=(async()=>{try{await settle(s,await s.recovery.reconcile(recoveryClient(s.client)));}finally{resolving=undefined;}})();
  return resolving.then(()=>{if(session===s)renderSubmissions();});
 }
 function stopRecheck(){if(recheckTimer)clearTimeout(recheckTimer);recheckTimer=undefined;}
 /** While rows remain, recheck in the background (skipped while busy or reviewing). */
 function scheduleRecheck(){
  stopRecheck();const s=session;
  if(!s||!s.journal.list().length)return;
  recheckTimer=setTimeout(()=>{
   if(session!==s)return;
   if(busy||pending){scheduleRecheck();return;}
   void recheck(s).catch(()=>{}).finally(()=>{if(session===s)scheduleRecheck();});
  },RECHECK_MS);
 }
 function renderSubmissions(){
  const root=el('pool-submissions');root.replaceChildren();if(!session)return;
  const rows=session.journal.list();
  text('pool-submissions-status',rows.length?`Signed pool transactions saved in this browser before sending, checked against the node every ${RECHECK_MS/1000} s. Their inputs stay reserved until they are resolved, and nothing is retried automatically.`:'No unresolved pool submissions from this browser.');
  for(const row of rows){const item=document.createElement('p');item.className='activity-row';item.textContent=`${labels.get(row.hash)??row.status.toUpperCase()} · ${row.hash}`;root.append(item);}
 }

 /** Single-flight: a second preparation must never start (and cancel the first)
  * while the first still holds its funding reservation. */
 async function prepare(title:string,build:(pool?:PoolSnapshot)=>Promise<PoolIntent>,poolId?:string,feedback='pool-action-status'){
  if(busy)throw new Error('A pool transaction is still being prepared, signed or sent. Wait for its result before starting another.');
  setBusy(true);
  try{await prepareReview(title,build,poolId,feedback);}finally{setBusy(false);}
 }
 async function prepareReview(title:string,build:(pool?:PoolSnapshot)=>Promise<PoolIntent>,poolId:string|undefined,feedback:string){
  invalidate();const start=generation,s=await ensureSession(),m=manifest!;
  const pool=poolId?await currentPool(poolId):undefined;
  if(pool){
   const state=`${pool.stateCell.outPoint.txHash}:${pool.stateCell.outPoint.index}`;
   const holder=s.journal.list().find(row=>row.orders.includes(state));
   if(holder)throw new Error(`Pool submission ${holder.hash} (${holder.status}) already spends this pool's current state, and its inputs stay reserved. Use Recheck until it resolves; do not prepare a replacement.`);
  }
  const intent=await build(pool);
  text(feedback,'Preparing the transaction with your JoyID account…');
  // Probe funding for JoyID preparation: one plain, data-free cell of this account.
  let probe:ccc.Cell|undefined;
  for await(const cell of s.client.findCells({script:s.lock,scriptType:'lock',scriptSearchMode:'exact',filter:{scriptLenRange:[0,1],outputDataLenRange:[0,1]},withData:true},'asc',10)){probe=cell;break;}
  if(!probe)throw new Error('This account needs a plain CKB cell to pay fees and storage');
  const signer=s.signer as unknown as PoolJoyIdSigner;
  const resolved=await resolveJoyIdWallet({current:()=>({signer:env.signer() as unknown as PoolJoyIdSigner,revision:`${env.epoch()}`})},m.deployment,m.joyid,probe,
   m.joyid.proofEndpoint?joyIdProofSource(m.joyid.proofEndpoint):undefined).catch(error=>{
    if(signer.signType!==ccc.SignerSignType.JoyId)throw new Error('Pool transactions currently require a JoyID wallet');throw error;});
  const wallet={...resolved.wallet(),change:s.lock,feeRate:m.policy.feeRate,maxFee:m.policy.maxFee};
  const recipients={ckb:s.lock,token:s.lock,lp:s.lock};
  const funded=await fundPoolTransaction(s.client as unknown as PoolSubmitClient,m.deployment,wallet,recipients,intent,{reservations:s.reservations});
  try{
   const prepared=await resolved.prepare(funded.built);
   const review=reviewPoolTransaction(m.deployment,{...wallet,funding:funded.funding},recipients,intent,prepared,m.policy.reviewTtlMs);
   if(start!==generation)throw new Error('The form, pool selection or connection changed while the review was being prepared. Nothing was signed; prepare again.');
   if(session!==s||env.signer()!==s.signer)throw new Error('The wallet connection changed while the review was being prepared. Nothing was signed; prepare again.');
   const bound=resolved.bindReview(review);
   pending={generation:start,session:s,funded,review,sign:()=>bound.sign({timeoutMs:60000}),title,token:tokenOf(pool),feedback};
   showReview(pending,resolved.identity.keyType);
   text(feedback,'Review ready. Check every line before approving.');
  }catch(error){funded.release();throw error;}
 }
 function showReview(p:Pending,keyType:string){
  const r=p.review.summary,f=r.flows,a=r.action,units=(n:bigint)=>tokenAmount(n,p.token),address=ccc.Address.fromScript(p.session.lock,p.session.client).toString();
  const minimum=a.kind==='swap'?`Minimum accepted${r.orders.length?' from the pool':''}: ${a.direction==='xToY'?units(a.minOut):ckb(a.minOut)}`:a.kind==='deposit'?`Minimum LP shares: ${a.minShares}`:a.kind==='withdraw'?`Minimum received: ${ckb(a.minX)} · ${units(a.minY)}`:`Minimum LP shares: ${a.minShares}`;
  const outputs=r.outputs.filter(o=>!o.pool&&!o.maker).map(o=>`  #${o.index} ${o.asset==='ckb'?'CKB':o.asset==='token'?units(o.amount!):shares(o.amount!)} · capacity ${ckb(o.capacity)} (storage ${ckb(o.occupiedCapacity)})`);
  const asset=(kind:'ckb'|'token',n:bigint)=>kind==='ckb'?ckb(n):units(n),t=r.total;
  // Split route: whole lots at their fixed terms, each maker paid at its own index.
  const split=r.orders.length?[
   `Order lots (${r.orders.length}, filled whole at fixed prices):`,
   ...r.orders.map(o=>`  lot ${o.outPoint.txHash.slice(0,10)}…:${o.outPoint.index} · you get ${asset(o.offer,o.offerAmount)} · maker paid ${asset(o.ask,o.askAmount)} at output #${o.paymentIndex}`),
   `Pool leg: pay ${ckb(f.paidX)} · ${units(f.paidY)} · receive ${ckb(f.receivedX)} · ${units(f.receivedY)}`,
   `Total you pay: ${ckb(t.paidX)} · ${units(t.paidY)}`,
   `Total you receive (exact): ${ckb(t.receivedX)} · ${units(t.receivedY)}`,
  ]:[];
  text('pool-review-text',[
   p.title,
   `Account: ${address} · JoyID ${keyType}`,
   `Network: CKB TESTNET · genesis ${r.genesisHash.slice(0,18)}…`,
   `Pool: ${r.poolId}`,
   ...(split.length?split:[
   `You pay: ${ckb(f.paidX)} · ${units(f.paidY)}${f.burnedShares?` · ${shares(f.burnedShares)}`:''}`,
   `You receive (exact): ${ckb(f.receivedX)} · ${units(f.receivedY)}${f.mintedShares?` · ${shares(f.mintedShares)}`:''}`]),
   minimum,
   `Network fee: ${ckb(r.fee)} (cap ${ckb(r.maxFee)})`,
   `CKB added to receipt cells for storage: ${ckb(r.ckbReceiptTopUp)}`,
   `Your outputs:`,...outputs,
   `Pool after: ${ckb(r.next.x)} · ${units(r.next.y)} · LP supply ${r.next.totalShares}`,
   `Permanent backing (never withdrawable): ${ckb(r.next.backing.state+r.next.backing.ckb+r.next.backing.token)}`,
   `Review expires: ${new Date(r.expiresAt).toLocaleTimeString()}. Approving asks your wallet to sign; the signed transaction is saved here before it is sent.`,
  ].join('\n'));
  text('pool-review-raw',ccc.stringify(p.review.transaction()));
  el<HTMLDialogElement>('pool-review').showModal();
 }
 async function approve(){
  const p=pending;
  if(!p||p.generation!==generation||env.signer()!==p.session.signer||env.epoch()!==p.session.epoch)throw new Error('Review is stale; prepare again');
  if(Date.now()>=p.review.summary.expiresAt){invalidate();throw new Error('Review expired. Prepare it again from live state.');}
  setBusy(true);text(p.feedback,'Waiting for wallet signature…');
  let signed:ccc.Transaction;
  try{signed=await p.sign();}
  catch(error){if(pending===p){pending=undefined;p.funded.release();el<HTMLDialogElement>('pool-review').close();}setBusy(false);throw error;}
  try{
   await resolving;
   const outcome=await p.session.recovery.submit(recoveryClient(p.session.client),p.review,signed,p.funded);
   pending=undefined;el<HTMLDialogElement>('pool-review').close();
   if(outcome.outcome==='sent'){sentHere.add(outcome.hash);labels.set(outcome.hash,'SENT · waiting for confirmation');}
   else labels.set(outcome.hash,'UNKNOWN · the send was not confirmed by the node. Do not prepare it again.');
   text(p.feedback,outcome.outcome==='sent'
    ?`Submitted ${outcome.hash}. It stays listed under pool submissions on the Pools tab until confirmed and archived.`
    :`Status unknown for ${outcome.hash}: the node did not confirm receipt. The signed transaction is saved in this browser and its inputs stay reserved. Do not prepare it again; check its status with Recheck on the Pools tab. Node response: ${outcome.error.slice(0,300)}`);
  }catch(error){
   // submit throws only before persisting, so nothing was sent.
   if(pending===p){pending=undefined;p.funded.release();el<HTMLDialogElement>('pool-review').close();}throw error;
  }finally{setBusy(false);renderSubmissions();scheduleRecheck();void loadLp().catch(()=>{});}
 }

 el('pool-refresh').onclick=()=>act('Refreshing pools…',async()=>{invalidate();await refresh();if(env.signer())await ensureSession();text('pool-action-status','');});
 el('pool-select').onchange=()=>{invalidate();render();void loadLp().catch(()=>{});};
 el('pool-withdraw-shares').oninput=()=>{invalidate();withdrawQuote();};
 for(const b of document.querySelectorAll<HTMLButtonElement>('[data-share-pct]'))b.onclick=()=>{
  const balance=snapshots.length?lpBalances.get(selected().poolId):undefined;if(!balance)return;
  el<HTMLInputElement>('pool-withdraw-shares').value=String(balance*BigInt(b.dataset.sharePct!)/100n);invalidate();withdrawQuote();
 };
 for(const id of ['pool-swap-direction','pool-swap-amount'])el(id).oninput=()=>{invalidate();quote();};
 el('pool-swap').onsubmit=e=>{e.preventDefault();if(busy)return;act('Checking the live pool…',()=>prepare('Pool swap',async pool=>{
  const direction=value('pool-swap-direction') as 'xToY'|'yToX',amountIn=parseUnits(value('pool-swap-amount'),direction==='xToY'?8:tokenOf(pool).decimals);
  const flows=transition(pool!.accounting,{kind:'swap',direction,amountIn,minOut:1n}).flows;
  const action:Operation={kind:'swap',direction,amountIn,minOut:minimumOut(direction==='xToY'?flows.receivedY:flows.receivedX,manifest!.policy.slippageBps)};
  return {kind:'transition',pool:pool!,action};
 },selected().poolId));};
 el('pool-deposit').onsubmit=e=>{e.preventDefault();if(busy)return;act('Checking the live pool…',()=>prepare('Add liquidity',async pool=>{
  const maxX=parseUnits(value('pool-deposit-ckb'),8),maxY=parseUnits(value('pool-deposit-token'),tokenOf(pool).decimals);
  const minted=transition(pool!.accounting,{kind:'deposit',maxX,maxY,minShares:1n}).flows.mintedShares;
  return {kind:'transition',pool:pool!,action:{kind:'deposit',maxX,maxY,minShares:minimumOut(minted,manifest!.policy.slippageBps)}};
 },selected().poolId));};
 el('pool-withdraw').onsubmit=e=>{e.preventDefault();if(busy)return;act('Checking the live pool…',()=>prepare('Remove liquidity',async pool=>{
  const burned=parseUnits(value('pool-withdraw-shares'),0);
  const flows=transition(pool!.accounting,{kind:'withdraw',shares:burned,minX:1n,minY:1n}).flows;
  const s=manifest!.policy.slippageBps;
  return {kind:'transition',pool:pool!,action:{kind:'withdraw',shares:burned,minX:minimumOut(flows.receivedX,s),minY:minimumOut(flows.receivedY,s)}};
 },selected().poolId));};
 el('pool-create').onsubmit=e=>{e.preventDefault();if(busy)return;act('Checking the network…',()=>prepare('Create pool',async()=>{
  const c=manifest?.create;if(!c)throw new Error('Pool creation is not enabled for this deployment');
  return {kind:'create',request:{parameters:c.parameters,tokenOwner:c.tokenOwner,x:parseUnits(value('pool-create-ckb'),8),y:parseUnits(value('pool-create-token'),0),minShares:1n}};
 }));};
 el('pool-approve').onclick=()=>act('Waiting for wallet signature…',approve,pending?.feedback);
 el('pool-dismiss').onclick=()=>invalidate();
 el('pool-review').addEventListener('cancel',()=>invalidate());
 el('pool-recheck').onclick=()=>act('Rechecking submissions…',async()=>{const s=await ensureSession();await recheck(s);scheduleRecheck();text('pool-action-status','');});

 /** Live pools whose token display metadata matched the live token (checked in refresh). */
 function markets():PoolMarket[]{
  return snapshots.flatMap(pool=>{const t=manifest?.pools.find(p=>p.poolId===pool.poolId)?.token;
   return t?[{poolId:pool.poolId,token:pool.token.clone(),symbol:t.symbol,decimals:t.decimals,x:pool.accounting.x,y:pool.accounting.y}]:[];});
 }
 /** Cheapest listed pool delivering at least `amountOut`, from the last loaded state. */
 function routeQuote(tokenHash:ccc.Hex,payCkb:boolean,amountOut:bigint):PoolRoute|undefined {
  let best:PoolRoute|undefined;
  for(const market of markets()){
   if(market.token.hash()!==tokenHash)continue;
   const pool=snapshots.find(p=>p.poolId===market.poolId)!,direction=payCkb?'xToY' as const:'yToX' as const;
   let r;try{r=swapExactOut(pool.accounting,direction,amountOut);}catch{continue;}
   const route={poolId:pool.poolId,direction,amountIn:payCkb?r.flows.paidX:r.flows.paidY,amountOut:payCkb?r.flows.receivedY:r.flows.receivedX,checkedAt};
   if(!best||route.amountIn<best.amountIn)best=route;
  }
  return best;
 }
 /** Cheapest split over listed pools for this pair, from the last loaded state. */
 function splitQuote<T extends SplitLot>(tokenHash:ccc.Hex,payCkb:boolean,amountOut:bigint,maxAmountIn:bigint,lots:readonly T[]):SplitRoute<T>|undefined {
  let best:SplitRoute<T>|undefined;
  for(const market of markets()){
   if(market.token.hash()!==tokenHash)continue;
   const pool=snapshots.find(p=>p.poolId===market.poolId)!,direction=payCkb?'xToY' as const:'yToX' as const;
   const q=quoteSplit(lots,pool.accounting,direction,amountOut,maxAmountIn);
   if(q&&(!best||q.amountIn<best.amountIn))best={...q,poolId:pool.poolId,direction,checkedAt};
  }
  return best;
 }
 /** Prepares a split route from live pool state: the chosen lots at their fixed
  * terms, and an exact-output pool swap for the remainder. One review, one
  * signature; the order lock and pool validator both run in the transaction. */
 function prepareSplit(route:Pick<SplitRoute<SplitLot&{cell:ccc.Cell}>,'poolId'|'direction'|'lots'>,orderCode:OrderCode,amountOut:bigint,maxAmountIn:bigint){
  const lotIn=route.lots.reduce((n,l)=>n+l.askAmount,0n),lotOut=route.lots.reduce((n,l)=>n+l.offerAmount,0n);
  return prepare(`Split route: ${route.lots.length} order lot${route.lots.length===1?'':'s'} + pool`,async pool=>{
   if(lotOut>=amountOut)throw new Error('The selected lots already cover the request; quote again');
   const r=swapExactOut(pool!.accounting,route.direction,amountOut-lotOut),poolIn=route.direction==='xToY'?r.flows.paidX:r.flows.paidY;
   if(lotIn+poolIn>maxAmountIn)throw new Error('The lots plus the pool now cost more than your maximum payment; quote again');
   return {kind:'transition',pool:pool!,action:{kind:'swap',direction:route.direction,amountIn:poolIn,minOut:amountOut-lotOut},
    orders:{codeHash:orderCode.codeHash,cellDep:orderCode.cellDep,cells:route.lots.map(l=>l.cell.clone())}};
  },route.poolId,'quote-status');
 }
 /** Prepares the routed swap from live state through the normal pool review:
  * exact output (minOut = requested), input bounded by the caller's maximum. */
 function prepareRouted(route:Pick<PoolRoute,'poolId'|'direction'>,amountOut:bigint,maxAmountIn:bigint){
  return prepare('Routed swap via pool',async pool=>{
   const r=swapExactOut(pool!.accounting,route.direction,amountOut),amountIn=route.direction==='xToY'?r.flows.paidX:r.flows.paidY;
   if(amountIn>maxAmountIn)throw new Error('The pool now needs more than your maximum payment; quote again');
   return {kind:'transition',pool:pool!,action:{kind:'swap',direction:route.direction,amountIn,minOut:amountOut}};
  },route.poolId,'quote-status');
 }

 return {
  show:()=>env.run(async()=>{await refresh();if(env.signer())await ensureSession();}),
  load:refresh,markets,routeQuote,prepareRouted,splitQuote,prepareSplit,tokenDep:()=>manifest?.deployment.tokenDep,
  invalidate,reset,
 };
}
