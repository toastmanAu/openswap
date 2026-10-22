// P6 JoyID pool lifecycle (docs/research/POOL_TESTNET_RUN.md). TESTNET ONLY.
// Bundled into deployments/pool-lifecycle.playground.ts by scripts/build-pool-lifecycle.mjs.
// Each step: bounded funding -> JoyID preparation -> frozen review shown here ->
// explicit confirm() -> one-shot signature -> signed bytes persisted -> one send.
// Progress lives in this browser's localStorage: rerun to resume, never re-sign a
// recorded step. An unknown send outcome stops the run for manual inspection.
import {ccc} from '@ckb-ccc/ccc';
import {signer,client,render} from '@ckb-ccc/playground';
import {createPool,transition,type Operation} from '../pool-model/src/model.js';
import {fundPoolTransaction,PoolFundingReservations,type PoolIntent} from '../pool-sdk/src/funding.js';
import {resolveJoyIdWallet,type PoolJoyIdSigner} from '../pool-sdk/src/joyid.js';
import {loadPool,type PoolDeployment,type PoolSnapshot} from '../pool-sdk/src/pools.js';
import {reviewPoolTransaction} from '../pool-sdk/src/review.js';
import {PoolSubmissionRecovery,type PoolSubmitClient} from '../pool-sdk/src/recovery.js';
import type {ArchivableSubmissionJournal,SubmissionRecord} from '../solver/src/journal.js';
import {FEE_RATE,GENESIS,INITIAL_LIQUIDITY,JOYID_PROFILE,MAX_FEE,POOL_PARAMETERS} from './lib/pool-live.js';
// Injected by the bundle builder from the recorded deployments/pool-testnet.json and
// deployments/pool-issuer.json; the build refuses to run before both exist.
declare const __POOL_MANIFEST__:{genesisHash:string;codeHash:string;poolDep:ccc.CellDepLike;tokenDep:ccc.CellDepLike};
declare const __POOL_ISSUER__:{lockHash:string};
const manifest=__POOL_MANIFEST__,issuer=__POOL_ISSUER__;

const deployment:PoolDeployment={genesisHash:manifest.genesisHash as ccc.Hex,codeHash:manifest.codeHash as ccc.Hex,poolDep:manifest.poolDep,tokenDep:manifest.tokenDep};
const STEPS=['create','xToY','yToX','deposit','partialWithdraw','fullWithdraw','reenter'] as const;
type Step=typeof STEPS[number];
const fail=(message:string):never=>{throw new Error(`P6 lifecycle: ${message}`);};

if(client.addressPrefix!=='ckt'||(await client.getHeaderByNumber(0))?.hash!==GENESIS||deployment.genesisHash!==GENESIS)fail('select CKB TESTNET');
if(signer.signType!==ccc.SignerSignType.JoyId)fail('connect a JoyID wallet');
const [account]=await signer.getAddressObjs();
if(!account||account.script.codeHash!==JOYID_PROFILE.codeHash)fail('connect exactly one JoyID testnet account');
const owner=account!.script,storageKey=`openswap-p6:${GENESIS}:${owner.hash()}`;
console.log('P6 POOL LIFECYCLE — JoyID',account!.toString());

interface Progress {steps:Partial<Record<Step,{hash:ccc.Hex;stateIndex:number}>>}
const progress:Progress=JSON.parse(localStorage.getItem(`${storageKey}:progress`)??'{"steps":{}}');
const saveProgress=()=>localStorage.setItem(`${storageKey}:progress`,JSON.stringify(progress));

/** localStorage journal with the FileSubmissionJournal record checks that matter here. */
class BrowserJournal implements ArchivableSubmissionJournal {
 getScope(){return {genesisHash:GENESIS,accountLockHash:owner.hash()};}
 list():SubmissionRecord[]{return JSON.parse(localStorage.getItem(`${storageKey}:journal`)??'[]');}
 put(row:SubmissionRecord){
  const tx=ccc.Transaction.fromBytes(row.transaction);
  if(tx.hash()!==row.hash||ccc.hexFrom(tx.toBytes())!==row.transaction)fail('journal identity mismatch');
  const prior=this.list().find(r=>r.hash===row.hash);
  if(prior&&(prior.transaction!==row.transaction||prior.createdAt!==row.createdAt))fail('immutable submission changed');
  localStorage.setItem(`${storageKey}:journal`,JSON.stringify([...this.list().filter(r=>r.hash!==row.hash),row]));
  if(localStorage.getItem(`${storageKey}:journal`)===null)fail('journal write failed');
 }
 archive(hash:ccc.Hex,resolution:'committed'|'abandoned'){
  const row=this.list().find(r=>r.hash===hash)??fail('unknown submission');
  localStorage.setItem(`${storageKey}:archive`,JSON.stringify([...JSON.parse(localStorage.getItem(`${storageKey}:archive`)??'[]'),{resolution,record:row}]));
  localStorage.setItem(`${storageKey}:journal`,JSON.stringify(this.list().filter(r=>r.hash!==hash)));
 }
}
const reservations=new PoolFundingReservations(),journal=new BrowserJournal();
const recovery=new PoolSubmissionRecovery(journal,reservations,journal.getScope());
const chain=client as unknown as PoolSubmitClient;
const reports=await recovery.reconcile(chain);
for(const report of reports)console.log('Journaled submission',report.hash,report.observedStatus);
if(reports.some(r=>r.observedStatus!=='committed'))fail('an earlier submission is not committed yet; wait or inspect before continuing');
for(const report of reports)await recovery.archiveCommitted(client as never,report.hash,{minConfirmations:1});

const recipients={ckb:owner,token:owner,lp:owner};
const tokenOwner=issuer.lockHash as ccc.Hex;
const slippage=(amount:bigint)=>amount*99n/100n||1n;
async function currentPool(previous:Step):Promise<PoolSnapshot>{
 const step=progress.steps[previous]!;
 return loadPool(client,deployment,{txHash:step.hash,index:step.stateIndex});
}
function operation(step:Exclude<Step,'create'>,pool:PoolSnapshot):Operation{
 const s=pool.accounting,circulating=s.totalShares-s.lockedShares;
 const quote=(op:Operation)=>transition(s,op);
 if(step==='xToY'||step==='yToX'){
  const amountIn=step==='xToY'?100_00000000n:400_00000000n,probe={kind:'swap' as const,direction:step,amountIn,minOut:1n};
  const out=step==='xToY'?quote(probe).flows.receivedY:quote(probe).flows.receivedX;
  return {...probe,minOut:slippage(out)};
 }
 if(step==='deposit'||step==='reenter'){
  const maxX=step==='deposit'?200_00000000n:100_00000000n,maxY=maxX*s.y/s.x*101n/100n+1n;
  const minted=quote({kind:'deposit',maxX,maxY,minShares:1n}).flows.mintedShares;
  return {kind:'deposit',maxX,maxY,minShares:slippage(minted)};
 }
 const shares=step==='partialWithdraw'?circulating/2n:circulating,flows=quote({kind:'withdraw',shares,minX:1n,minY:1n}).flows;
 return {kind:'withdraw',shares,minX:slippage(flows.receivedX),minY:slippage(flows.receivedY)};
}

for(const [index,step] of STEPS.entries()){
 if(progress.steps[step]){console.log(`✓ ${step} already committed:`,progress.steps[step]!.hash);continue;}
 const probe=(await client.findCellsPagedNoCache({script:owner,scriptType:'lock',scriptSearchMode:'exact',filter:{scriptLenRange:[0,1],outputDataLenRange:[0,1]}},'asc',1)).cells[0]??fail('no plain CKB cell to resolve the JoyID session');
 const resolved=await resolveJoyIdWallet({current:()=>({signer:signer as unknown as PoolJoyIdSigner,revision:'playground'})},deployment,JOYID_PROFILE,probe);
 if(resolved.identity.keyType!=='main_key')fail('subkey sessions need an approved CoTA proof service; reconnect with the main key');
 const pool=index===0?undefined:await currentPool(STEPS[index-1]!);
 const intent:PoolIntent=pool?{kind:'transition',pool,action:operation(step as Exclude<Step,'create'>,pool)}:
  {kind:'create',request:{parameters:POOL_PARAMETERS,x:INITIAL_LIQUIDITY.x,y:INITIAL_LIQUIDITY.y,minShares:slippage(createPool(POOL_PARAMETERS,INITIAL_LIQUIDITY.x,INITIAL_LIQUIDITY.y,1n).flows.mintedShares),tokenOwner}};
 const walletPolicy={...resolved.wallet(),change:owner,feeRate:FEE_RATE,maxFee:MAX_FEE};
 const funded=await fundPoolTransaction(chain,deployment,walletPolicy,recipients,intent,{reservations});
 try{
  const prepared=await resolved.prepare(funded.built);
  const review=reviewPoolTransaction(deployment,{...walletPolicy,funding:funded.funding},recipients,intent,prepared);
  console.log(`STEP ${index+1}/${STEPS.length}: ${step}`);
  console.log(ccc.stringify({action:review.summary.action,flows:review.summary.flows,fee:review.summary.fee,previous:review.summary.previous,next:review.summary.next,expiresAt:new Date(review.summary.expiresAt).toISOString()}));
  await render(prepared);
  const approve=(globalThis as {confirm?:(message:string)=>boolean}).confirm;
  if(!approve||!approve(`Sign P6 step ${index+1}/${STEPS.length} (${step})? Review the summary in the console first. Fee: ${review.summary.fee} shannons.`))fail(`step ${step} not approved; nothing signed`);
  // Signing waits on a human in the JoyID popup: use the maximum bounded deadline.
  const signed=await resolved.bindReview(review).sign({timeoutMs:60000});
  const outcome=await recovery.submit(chain,review,signed,funded);
  if(outcome.outcome!=='sent')fail(`send outcome unknown for ${outcome.hash} (${outcome.error}); do NOT retry, inspect status first`);
  console.log(`${step} TX HASH:`,outcome.hash);
  await client.waitTransaction(outcome.hash,1,600000);
  await recovery.archiveCommitted(client as never,outcome.hash,{minConfirmations:1});
  progress.steps[step]={hash:outcome.hash,stateIndex:review.summary.stateOutputIndex};saveProgress();
 }finally{funded.release();}
}
console.log('P6 LIFECYCLE COMPLETE. Verify with: npm run pool:verify --',STEPS.map(s=>progress.steps[s]!.hash).join(' '));
