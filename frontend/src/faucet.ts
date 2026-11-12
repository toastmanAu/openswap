import {ccc} from '@ckb-ccc/connector';
import {buildFaucetClaim,eligibleGrants,faucetConfigFrom,type FaucetGrant} from '@openswap/sdk';
import manifest from '../../deployments/faucet.json';
import {formatUnits} from './amounts.js';
import {explainError} from './errors.js';
import {ORDER_FEE_POLICY} from './fees.js';

/** Test-token faucet dialog: checks what the connected account may claim, builds the
 * claim (the wallet pays the new cells' capacity and the fee), has the wallet sign it,
 * and posts it to /api/faucet, which co-signs and broadcasts (functions/api/faucet.ts). */
export interface FaucetHost {signer:()=>ccc.Signer|undefined;busy:()=>boolean;onSubmitted:(hash:ccc.Hex,summary:string,signer:ccc.Signer)=>void;onCommitted:(hash:ccc.Hex,summary:string,signer:ccc.Signer)=>void}
const config=faucetConfigFrom(manifest);
const listOf=(grants:FaucetGrant[])=>grants.map(g=>`${formatUnits(g.amount,g.decimals)} ${g.symbol}`).join(', ');

export function createFaucet(host:FaucetHost){
 const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id)! as T;
 const dialog=el<HTMLDialogElement>('faucet-dialog'),claim=el<HTMLButtonElement>('faucet-claim'),status=el('faucet-status');
 const say=(message:string)=>{status.textContent=message;};
 let grants:FaucetGrant[]=[],generation=0,claiming=false;
 el('faucet-grants').textContent=listOf(config.grants);
 async function check(){
  const id=++generation,signer=host.signer();grants=[];claim.disabled=true;
  if(!signer){say('Connect a wallet to claim.');return;}
  say('Checking your balances…');
  try{
   const lock=(await signer.getRecommendedAddressObj()).script,found=await eligibleGrants(signer.client,lock,config);
   if(id!==generation||signer!==host.signer())return;
   grants=found;claim.disabled=!found.length||claiming;
   say(found.length?`You can claim: ${listOf(found)}.`:'This account already holds a claim of every test token.');
  }catch(error){if(id===generation)say(`Could not check balances: ${explainError(error)}`);}
 }
 async function submit(){
  const signer=host.signer();
  if(!signer||!grants.length||claiming)return;
  if(host.busy()){say('Wait for the current transaction.');return;}
  claiming=true;claim.disabled=true;const summary=`Faucet claim: ${listOf(grants)}`;
  try{
   say('Building the claim…');
   const tx=await buildFaucetClaim(signer,config,grants,manifest.xudtDep,ORDER_FEE_POLICY.minRate);
   say('Approve the claim in your wallet…');
   const signed=await signer.signTransaction(tx);
   say('Sending to the faucet…');
   const response=await fetch('./api/faucet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transaction:ccc.hexFrom(signed.toBytes())}),signal:AbortSignal.timeout(60_000)});
   const body=await response.json().catch(()=>({})) as {hash?:ccc.Hex;error?:string};
   if(!response.ok||!body.hash)throw new Error(body.error??`Faucet unavailable (HTTP ${response.status})`);
   host.onSubmitted(body.hash,summary,signer);
   say(`Submitted: ${body.hash}. Waiting for confirmation…`);
   await signer.client.waitTransaction(body.hash,1,300_000);
   host.onCommitted(body.hash,summary,signer);
   say(`Committed: ${body.hash}. The tokens are in your wallet.`);grants=[];
  }catch(error){say(explainError(error));}
  finally{claiming=false;claim.disabled=!grants.length;}
 }
 el('faucet-open').onclick=()=>{dialog.showModal();void check();};
 el('faucet-close').onclick=()=>dialog.close();
 claim.onclick=()=>void submit();
 return {reset:()=>{generation++;grants=[];if(dialog.open)void check();}};
}
