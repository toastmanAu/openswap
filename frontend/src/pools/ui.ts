import {ccc} from '@ckb-ccc/core';
import {scanPools,resolveJoyIdWallet,joyIdProofSource,fundPoolTransaction,reviewPoolTransaction,PoolFundingReservations,PoolSubmissionRecovery,
 type PoolSnapshot,type PoolIntent,type PoolJoyIdSigner,type FundedPoolTransaction,type PoolTransactionReview,type PoolSubmitClient} from '../../../pool-sdk/src/index.js';
import {transition,type Operation} from '../../../pool-model/src/model.js';
import {loadPoolManifest,type PoolManifest} from './manifest.js';
import {BrowserSubmissionJournal} from './journal.js';
import {parseUnits,formatUnits} from '../amounts.js';

export interface PoolEnv {client():ccc.Client;signer():ccc.Signer|undefined;epoch():number;run(fn:()=>Promise<void>):void}
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id)! as T;
const text=(id:string,message:string)=>{el(id).textContent=message;};
const value=(id:string)=>el<HTMLInputElement>(id).value;
const ckb=(n:bigint)=>`${formatUnits(n,8)} CKB`;
const units=(n:bigint)=>`${n} token units`;
const shares=(n:bigint)=>`${n} LP shares`;
/** Minimum accepted output: the fresh quote reduced by the slippage bound, never below 1. */
export const minimumOut=(quoted:bigint,slippageBps:number)=>{const n=quoted*BigInt(10000-slippageBps)/10000n;return n>0n?n:1n;};

/** The CCC client satisfies the narrow recovery interface. A real node answers an
 * unknown hash with `transaction: null` / status `unknown`, which CCC maps to
 * `undefined`; outages still throw and never read as an absent transaction. */
const recoveryClient=(client:ccc.Client)=>client as unknown as PoolSubmitClient;

interface Session {signer:ccc.Signer;epoch:number;client:ccc.Client;lock:ccc.Script;journal:BrowserSubmissionJournal;recovery:PoolSubmissionRecovery;reservations:PoolFundingReservations}
interface Pending {generation:number;session:Session;funded:FundedPoolTransaction;review:PoolTransactionReview;sign:()=>Promise<ccc.Transaction>;title:string}

export function createPoolUi(env:PoolEnv){
 let manifest:PoolManifest|undefined,loaded=false,snapshots:PoolSnapshot[]=[],checkedAt=0;
 let session:Session|undefined,pending:Pending|undefined,generation=0,busy=false;

 function setBusy(next:boolean){busy=next;for(const b of document.querySelectorAll<HTMLButtonElement>('#view-pools button,#pool-approve,#pool-dismiss'))b.disabled=next;}
 /** Drops any unsigned review and returns its funding reservation. */
 function invalidate(){
  generation++;
  if(pending){pending.funded.release();pending=undefined;}
  const dialog=el<HTMLDialogElement>('pool-review');if(dialog.open)dialog.close();
  text('pool-review-text','');
 }
 function reset(){invalidate();session=undefined;el('pool-submissions').replaceChildren();text('pool-submissions-status','Connect a wallet to see pool submissions from this browser.');}

 function selected():PoolSnapshot {
  const pool=snapshots.find(p=>p.poolId===value('pool-select'));
  if(!pool)throw new Error('Choose a pool after it has loaded');return pool;
 }
 function render(){
  const list=el<HTMLSelectElement>('pool-select'),previous=list.value;list.replaceChildren();
  for(const pool of snapshots){const option=document.createElement('option');option.value=pool.poolId;option.textContent=manifest?.pools.find(p=>p.poolId===pool.poolId)?.label??pool.poolId.slice(0,12);list.append(option);}
  if(snapshots.some(p=>p.poolId===previous))list.value=previous;
  const ready=!!manifest&&snapshots.length>0;
  for(const id of ['pool-swap','pool-deposit','pool-withdraw'])el(id).hidden=!ready;
  el('pool-create').hidden=!manifest?.create;
  if(!ready){text('pool-info','');return;}
  const pool=selected(),a=pool.accounting;
  text('pool-info',[
   `Pool ${pool.poolId}`,
   `Reserves: ${ckb(a.x)} · ${units(a.y)}`,
   `Swap fee: ${Number(a.feeBps)/100}%`,
   `LP supply: ${a.totalShares} (includes ${a.lockedShares} virtual locked shares that nobody can redeem)`,
   `Permanent backing (never withdrawable): state ${ckb(a.backing.state)} · CKB reserve ${ckb(a.backing.ckb)} · token reserve ${ckb(a.backing.token)}`,
   `Token: xUDT owner ${pool.token.args}`,
   `State cell: ${pool.stateCell.outPoint.txHash}:${pool.stateCell.outPoint.index} · checked ${new Date(checkedAt).toLocaleTimeString()}`,
  ].join('\n'));
  quote();
 }
 function quote(){
  if(!snapshots.length||!manifest){text('pool-quote','');return;}
  try{
   const pool=selected(),direction=value('pool-swap-direction') as 'xToY'|'yToX';
   const amountIn=direction==='xToY'?parseUnits(value('pool-swap-amount'),8):parseUnits(value('pool-swap-amount'),0);
   const flows=transition(pool.accounting,{kind:'swap',direction,amountIn,minOut:1n}).flows;
   const out=direction==='xToY'?flows.receivedY:flows.receivedX;
   const min=minimumOut(out,manifest.policy.slippageBps);
   text('pool-quote',`Expected: ${direction==='xToY'?units(out):ckb(out)} · minimum accepted ${direction==='xToY'?units(min):ckb(min)} (${manifest.policy.slippageBps/100}% bound). Quoted from the state checked at ${new Date(checkedAt).toLocaleTimeString()}; it is requoted from live state at review.`);
  }catch(error){text('pool-quote',value('pool-swap-amount').trim()?(error instanceof Error?error.message:String(error)):'Enter an amount to pay.');}
 }

 async function refresh(){
  const client=env.client();
  if(!loaded){manifest=await loadPoolManifest();loaded=true;}
  if(!manifest){snapshots=[];render();text('pool-status','Pools are not deployed on this network yet. No pool transactions can be prepared.');return;}
  if((await client.getHeaderByNumberNoCache(0))?.hash!==manifest.deployment.genesisHash){snapshots=[];render();text('pool-status','Pools are not deployed on this network yet: the connected node is not the network in the pool manifest.');return;}
  text('pool-status','Loading live pools…');
  const known=new Set(manifest.pools.map(p=>p.poolId)),found:PoolSnapshot[]=[];let skipped=0;
  for await(const pool of scanPools(client,manifest.deployment,{maxCandidates:1000,onMalformed:()=>skipped++}))if(known.has(pool.poolId))found.push(pool);
  if(client!==env.client())throw new Error('Connection changed while loading pools; refresh again');
  snapshots=found;checkedAt=Date.now();render();
  text('pool-status',`${found.length} of ${manifest.pools.length} listed pools live${skipped?` · ${skipped} malformed candidates skipped`:''}.`);
 }
 async function currentPool(poolId:string){await refresh();const pool=snapshots.find(p=>p.poolId===poolId);if(!pool)throw new Error('Pool is no longer live; refresh and choose again');return pool;}

 async function ensureSession():Promise<Session> {
  const signer=env.signer(),epoch=env.epoch(),client=env.client();
  if(!signer)throw new Error('Connect a wallet first');
  if(!manifest)throw new Error('Pools are not deployed on this network yet');
  if(session&&session.signer===signer&&session.epoch===epoch&&session.client===client)return session;
  const lock=(await signer.getRecommendedAddressObj()).script;
  if(env.signer()!==signer||env.epoch()!==epoch)throw new Error('Wallet changed; try again');
  const scope={genesisHash:manifest.deployment.genesisHash,accountLockHash:lock.hash()};
  const journal=new BrowserSubmissionJournal(localStorage,scope),reservations=new PoolFundingReservations();
  const recovery=new PoolSubmissionRecovery(journal,reservations,scope);
  // Restores reservations for every recorded submission before any new funding.
  await recovery.reconcile(recoveryClient(client));
  if(env.signer()!==signer||env.epoch()!==epoch)throw new Error('Wallet changed; try again');
  session={signer,epoch,client,lock,journal,recovery,reservations};
  renderSubmissions();return session;
 }
 function renderSubmissions(){
  const root=el('pool-submissions');root.replaceChildren();if(!session)return;
  const rows=session.journal.list();
  text('pool-submissions-status',rows.length?'Signed pool transactions saved in this browser before sending. Unknown means the node has not confirmed it; it does not prove failure. Their inputs stay reserved and nothing is retried automatically.':'No unresolved pool submissions from this browser.');
  for(const row of rows){const item=document.createElement('p');item.className='activity-row';item.textContent=`${row.status.toUpperCase()} · ${row.hash}`;root.append(item);}
 }

 async function prepare(title:string,build:(pool?:PoolSnapshot)=>Promise<PoolIntent>,poolId?:string){
  if(busy)throw new Error('Wait for the current pool transaction');
  invalidate();const start=generation,s=await ensureSession(),m=manifest!;
  const pool=poolId?await currentPool(poolId):undefined;
  if(pool){
   const state=`${pool.stateCell.outPoint.txHash}:${pool.stateCell.outPoint.index}`;
   const holder=s.journal.list().find(row=>row.orders.includes(state));
   if(holder)throw new Error(`Pool submission ${holder.hash} (${holder.status}) already spends this pool's current state, and its inputs stay reserved. Use Recheck until it resolves; do not prepare a replacement.`);
  }
  const intent=await build(pool);
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
   if(start!==generation||session!==s||env.signer()!==s.signer)throw new Error('Wallet or pool changed; prepare again');
   const bound=resolved.bindReview(review);
   pending={generation:start,session:s,funded,review,sign:()=>bound.sign(),title};
   showReview(pending,resolved.identity.keyType);
  }catch(error){funded.release();throw error;}
 }
 function showReview(p:Pending,keyType:string){
  const r=p.review.summary,f=r.flows,a=r.action,address=ccc.Address.fromScript(p.session.lock,p.session.client).toString();
  const minimum=a.kind==='swap'?`Minimum accepted: ${a.direction==='xToY'?units(a.minOut):ckb(a.minOut)}`:a.kind==='deposit'?`Minimum LP shares: ${a.minShares}`:a.kind==='withdraw'?`Minimum received: ${ckb(a.minX)} · ${units(a.minY)}`:`Minimum LP shares: ${a.minShares}`;
  const outputs=r.outputs.filter(o=>!o.pool).map(o=>`  #${o.index} ${o.asset==='ckb'?'CKB':o.asset==='token'?units(o.amount!):shares(o.amount!)} · capacity ${ckb(o.capacity)} (storage ${ckb(o.occupiedCapacity)})`);
  text('pool-review-text',[
   p.title,
   `Account: ${address} · JoyID ${keyType}`,
   `Network: CKB TESTNET · genesis ${r.genesisHash.slice(0,18)}…`,
   `Pool: ${r.poolId}`,
   `You pay: ${ckb(f.paidX)} · ${units(f.paidY)}${f.burnedShares?` · ${shares(f.burnedShares)}`:''}`,
   `You receive (exact): ${ckb(f.receivedX)} · ${units(f.receivedY)}${f.mintedShares?` · ${shares(f.mintedShares)}`:''}`,
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
  setBusy(true);text('pool-action-status','Waiting for wallet signature…');
  let signed:ccc.Transaction;
  try{signed=await p.sign();}
  catch(error){if(pending===p){pending=undefined;p.funded.release();el<HTMLDialogElement>('pool-review').close();}setBusy(false);throw error;}
  try{
   const outcome=await p.session.recovery.submit(recoveryClient(p.session.client),p.review,signed,p.funded);
   pending=undefined;el<HTMLDialogElement>('pool-review').close();
   text('pool-action-status',outcome.outcome==='sent'
    ?`Submitted ${outcome.hash}. It stays listed under pool submissions until confirmed and archived.`
    :`Status unknown for ${outcome.hash}: the node did not confirm receipt. The signed transaction is saved in this browser and its inputs stay reserved. Do not prepare it again; check its status with Recheck. Node response: ${outcome.error.slice(0,300)}`);
  }catch(error){
   // submit throws only before persisting, so nothing was sent.
   if(pending===p){pending=undefined;p.funded.release();el<HTMLDialogElement>('pool-review').close();}throw error;
  }finally{setBusy(false);renderSubmissions();}
 }

 el('pool-refresh').onclick=()=>env.run(async()=>{invalidate();await refresh();});
 el('pool-select').onchange=()=>{invalidate();render();};
 for(const id of ['pool-swap-direction','pool-swap-amount'])el(id).oninput=()=>{invalidate();quote();};
 el('pool-swap').onsubmit=e=>{e.preventDefault();env.run(()=>prepare('Pool swap',async pool=>{
  const direction=value('pool-swap-direction') as 'xToY'|'yToX',amountIn=direction==='xToY'?parseUnits(value('pool-swap-amount'),8):parseUnits(value('pool-swap-amount'),0);
  const flows=transition(pool!.accounting,{kind:'swap',direction,amountIn,minOut:1n}).flows;
  const action:Operation={kind:'swap',direction,amountIn,minOut:minimumOut(direction==='xToY'?flows.receivedY:flows.receivedX,manifest!.policy.slippageBps)};
  return {kind:'transition',pool:pool!,action};
 },selected().poolId));};
 el('pool-deposit').onsubmit=e=>{e.preventDefault();env.run(()=>prepare('Add liquidity',async pool=>{
  const maxX=parseUnits(value('pool-deposit-ckb'),8),maxY=parseUnits(value('pool-deposit-token'),0);
  const minted=transition(pool!.accounting,{kind:'deposit',maxX,maxY,minShares:1n}).flows.mintedShares;
  return {kind:'transition',pool:pool!,action:{kind:'deposit',maxX,maxY,minShares:minimumOut(minted,manifest!.policy.slippageBps)}};
 },selected().poolId));};
 el('pool-withdraw').onsubmit=e=>{e.preventDefault();env.run(()=>prepare('Remove liquidity',async pool=>{
  const burned=parseUnits(value('pool-withdraw-shares'),0);
  const flows=transition(pool!.accounting,{kind:'withdraw',shares:burned,minX:1n,minY:1n}).flows;
  const s=manifest!.policy.slippageBps;
  return {kind:'transition',pool:pool!,action:{kind:'withdraw',shares:burned,minX:minimumOut(flows.receivedX,s),minY:minimumOut(flows.receivedY,s)}};
 },selected().poolId));};
 el('pool-create').onsubmit=e=>{e.preventDefault();env.run(()=>prepare('Create pool',async()=>{
  const c=manifest?.create;if(!c)throw new Error('Pool creation is not enabled for this deployment');
  return {kind:'create',request:{parameters:c.parameters,tokenOwner:c.tokenOwner,x:parseUnits(value('pool-create-ckb'),8),y:parseUnits(value('pool-create-token'),0),minShares:1n}};
 }));};
 el('pool-approve').onclick=()=>env.run(approve);
 el('pool-dismiss').onclick=()=>invalidate();
 el('pool-review').addEventListener('cancel',()=>invalidate());
 el('pool-recheck').onclick=()=>env.run(async()=>{const s=await ensureSession();await s.recovery.reconcile(recoveryClient(s.client));renderSubmissions();});

 return {
  show:()=>env.run(async()=>{await refresh();if(env.signer())await ensureSession();}),
  invalidate,reset,
 };
}
