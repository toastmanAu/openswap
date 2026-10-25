#!/usr/bin/env -S npx tsx
// Live pool contention (docs/research/POOL_TESTNET_RUN.md). TESTNET ONLY.
//   prepare                         create wallet B's key; wallet A is the split-test maker
//   fund [--execute]                A sends B 2,000 tCKB once (dry run by default)
//   race --round=N [--execute]      A and B swap against the SAME pool state at once,
//                                   through different endpoints; one must lose
//   resolve --round=N               archive the winner, abandon the loser once its pool
//                                   input is spent, and check the loser's funding is freed
//   requote --round=N [--execute]   the loser builds a fresh swap on the new pool state
// Every send goes through PoolSubmissionRecovery with a per-wallet file journal under
// ignored .local/pool-contention/. No step resends recorded bytes; a requote is new,
// explicit work. Keys stay in ignored .local files and are never printed.
import {ccc} from '@ckb-ccc/shell';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {transition,type Operation} from '../pool-model/src/model.js';
import {fundPoolTransaction,PoolFundingReservations,type FundedPoolTransaction,type PoolIntent} from '../pool-sdk/src/funding.js';
import {loadPool,scanPools,type PoolDeployment,type PoolSnapshot} from '../pool-sdk/src/pools.js';
import {reviewPoolTransaction,type PoolTransactionReview} from '../pool-sdk/src/review.js';
import {PoolSubmissionRecovery,type PoolSubmitClient} from '../pool-sdk/src/recovery.js';
import {FileSubmissionJournal} from '../solver/src/journal.js';
import {ENDPOINTS,FEE_RATE,GENESIS,MAX_FEE} from './lib/pool-live.js';

const local=(name:string)=>new URL(`../.local/${name}`,import.meta.url);
const KEYS={A:local('testnet-split-maker-key'),B:local('testnet-contention-key')} as const;
type Name=keyof typeof KEYS;
const walletsFile=new URL('../deployments/pool-contention-wallets.json',import.meta.url);
const fundFile=new URL('../deployments/pool-contention-funding.json',import.meta.url);
const pools=JSON.parse(await readFile(new URL('../deployments/pool-frontend.json',import.meta.url),'utf8'));
const deployment=pools.deployment as PoolDeployment,poolId=pools.pools[0].poolId as ccc.Hex;
const joyid=JSON.parse(await readFile(new URL('../deployments/pool-testnet.json',import.meta.url),'utf8')).deployer as string;
/** CKB paid into the pool by each racer (xToY needs only CKB). Distinct amounts keep the two swaps distinguishable. */
const AMOUNT_IN:Record<Name,bigint>={A:5_00000000n,B:6_00000000n};
const FUND_B=2000_00000000n;
const [command,...rest]=process.argv.slice(2);
const execute=rest.includes('--execute');
const roundFlag=rest.find(f=>f.startsWith('--round='));
const round=roundFlag?Number(roundFlag.slice(8)):NaN;
const resultFile=()=>{assert(Number.isSafeInteger(round)&&round>=1,'--round=N required');return new URL(`../deployments/pool-contention-result-${round}.json`,import.meta.url);};
const exists=(url:URL)=>readFile(url,'utf8').then(()=>true,(e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return false;throw e;});
const readJson=async(url:URL)=>JSON.parse(await readFile(url,'utf8'));
const save=(url:URL,value:unknown)=>writeFile(url,ccc.stringify(value)+'\n');

async function open(url:string){
 const owned=ccc.ClientPublicTestnet.open({urls:[url]});
 assert.equal((await owned.value.getHeaderByNumber(0))?.hash,GENESIS,`${url} is not CKB testnet`);
 return owned;
}
const signerFor=async(name:Name,client:ccc.Client)=>new ccc.SignerCkbPrivateKey(client,(await readFile(KEYS[name],'utf8')).trim());

/** One racer: its own client (endpoint), reservations, journal and recovery, as a separate user would have. */
async function racer(name:Name,client:ccc.Client){
 const signer=await signerFor(name,client),address=await signer.getRecommendedAddressObj(),lock=address.script;
 const recorded=(await readJson(walletsFile))[name];
 assert.equal(address.toString(),recorded,`Wallet ${name} does not match deployments/pool-contention-wallets.json`);
 const reservations=new PoolFundingReservations();
 const journal=new FileSubmissionJournal(new URL(`../.local/pool-contention/${name}/`,import.meta.url).pathname,{genesisHash:GENESIS,accountLockHash:lock.hash()});
 const recovery=new PoolSubmissionRecovery(journal,reservations,{genesisHash:GENESIS,accountLockHash:lock.hash()});
 const deps=(await client.getKnownScript(ccc.KnownScript.Secp256k1Blake160)).cellDeps.map(d=>d.cellDep);
 return {name,client,chain:client as unknown as PoolSubmitClient,signer,address,lock,reservations,journal,recovery,
  wallet:{lock,change:lock,deps,feeRate:FEE_RATE,maxFee:MAX_FEE}};
}
type Racer=Awaited<ReturnType<typeof racer>>;

async function livePool(client:ccc.Client):Promise<PoolSnapshot>{
 for await(const pool of scanPools(client as never,deployment))if(pool.poolId===poolId)return loadPool(client as never,deployment,pool.stateCell.outPoint);
 throw new Error('Pool not found');
}
function swap(pool:PoolSnapshot,amountIn:bigint):Operation{
 const probe={kind:'swap' as const,direction:'xToY' as const,amountIn,minOut:1n};
 return {...probe,minOut:transition(pool.accounting,probe).flows.receivedY*99n/100n||1n};
}
/** Fund, review and sign one swap without sending. The prepared bytes must equal the built bytes. */
async function prepare(r:Racer,pool:PoolSnapshot,amountIn:bigint){
 const intent:PoolIntent={kind:'transition',pool,action:swap(pool,amountIn)};
 const recipients={ckb:r.lock,token:r.lock,lp:r.lock};
 const funded:FundedPoolTransaction=await fundPoolTransaction(r.client as never,deployment,r.wallet,recipients,intent,{reservations:r.reservations,timeoutMs:60000});
 try{
  for(const cell of funded.funding)assert(cell.cellOutput.lock.eq(r.lock),'Funding must belong to the racer');
  const prepared=await r.signer.prepareTransaction(funded.built.transaction.clone());
  assert.equal(ccc.hexFrom(prepared.toBytes()),ccc.hexFrom(funded.built.transaction.toBytes()),'Signer changed the prepared transaction');
  const review:PoolTransactionReview=reviewPoolTransaction(deployment,{...r.wallet,funding:funded.funding},recipients,intent,prepared,300000);
  assert(review.summary.fee<=MAX_FEE,'Fee exceeds cap');
  const signed=await r.signer.signOnlyTransaction(review.transaction());
  review.assertIntegrity(signed);
  return {funded,review,signed};
 }catch(error){funded.release();throw error;}
}
async function status(client:ccc.Client,hash:ccc.Hex){return (await client.getTransactionNoCache(hash))?.status??'absent';}
async function until<T>(what:string,check:()=>Promise<T|undefined>,timeoutMs=900000):Promise<T>{
 const end=Date.now()+timeoutMs;
 for(;;){const value=await check();if(value!==undefined)return value;assert(Date.now()<end,`Timed out waiting for ${what}`);await new Promise(r=>setTimeout(r,5000));}
}

if(command==='prepare'){
 await mkdir(local(''),{recursive:true,mode:0o700});
 try{await writeFile(KEYS.B,ccc.hexFrom(randomBytes(32)),{flag:'wx',mode:0o600});console.log('Created .local/testnet-contention-key (owner-only).');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;console.log('Wallet B key already exists; reusing it.');}
 const owned=await open(ENDPOINTS[0]);
 try{
  const [a,b]=[await signerFor('A',owned.value),await signerFor('B',owned.value)];
  const wallets={A:await a.getRecommendedAddress(),B:await b.getRecommendedAddress()};
  assert(wallets.A!==wallets.B&&wallets.A!==joyid&&wallets.B!==joyid,'Racers must be distinct and differ from the JoyID');
  await save(walletsFile,{network:'testnet',...wallets});
  console.log(ccc.stringify(wallets));
 }finally{await owned.dispose();}
}else if(command==='fund'){
 const owned=await open(ENDPOINTS[0]);
 try{
  const client=owned.value,a=await signerFor('A',client),wallets=await readJson(walletsFile);
  assert.equal(await a.getRecommendedAddress(),wallets.A);
  const b=await ccc.Address.fromString(wallets.B,client);
  const tx=ccc.Transaction.from({outputs:[{lock:b.script,capacity:FUND_B}]});
  await tx.completeInputsByCapacity(a);await tx.completeFeeBy(a,FEE_RATE);
  const fee=await tx.getFee(client);assert(fee>0n&&fee<=MAX_FEE,`Fee ${fee} exceeds cap`);
  console.log(ccc.stringify({from:wallets.A,to:wallets.B,amount:FUND_B,fee}));
  if(!execute){console.log('Dry run: nothing signed or sent. Add --execute to fund once.');process.exit(0);}
  assert(!await exists(fundFile),'deployments/pool-contention-funding.json exists: B was already funded or is pending.');
  const signed=await a.signTransaction(tx),hash=signed.hash();
  await writeFile(fundFile,ccc.stringify({status:'sent',hash,transaction:ccc.hexFrom(signed.toBytes())})+'\n',{flag:'wx'});
  assert.equal(await client.sendTransaction(signed),hash);
  console.log('FUND TX HASH:',hash);
  await client.waitTransaction(hash,1,600000);
  await save(fundFile,{status:'committed',hash,amount:FUND_B,fee});
  console.log('B funded.');
 }finally{await owned.dispose();}
}else if(command==='race'){
 const file=resultFile();
 assert(!await exists(file),`deployments/pool-contention-result-${round}.json exists: this round already ran.`);
 const [first,second]=[await open(ENDPOINTS[0]),await open(ENDPOINTS[1])];
 const racers:Racer[]=[];
 try{
  racers.push(await racer('A',first.value),await racer('B',second.value));
  for(const r of racers){
   const reports=await r.recovery.reconcile(r.chain);
   assert.equal(reports.length,0,`Wallet ${r.name} has unresolved submissions; run resolve first`);
  }
  // Both racers capture the same pool state, as two users quoting at the same moment.
  const pool=await livePool(first.value);
  const seen=await livePool(second.value);
  assert(pool.stateCell.outPoint.eq(seen.stateCell.outPoint),'Endpoints disagree on the pool tip; try again later');
  const prepared=await Promise.all(racers.map(r=>prepare(r,pool,AMOUNT_IN[r.name])));
  const plan=racers.map((r,i)=>({wallet:r.name,endpoint:ENDPOINTS[i],hash:prepared[i]!.review.summary.transactionHash,amountIn:AMOUNT_IN[r.name],action:prepared[i]!.review.summary.action,fee:prepared[i]!.review.summary.fee}));
  console.log(ccc.stringify({poolState:pool.stateCell.outPoint,plan}));
  if(!execute){for(const p of prepared)p.funded.release();for(const r of racers)r.journal.close();console.log('Dry run: both swaps signed locally, nothing persisted or sent. Add --execute to race once.');process.exit(0);}
  await save(file,{status:'racing',round,poolState:pool.stateCell.outPoint,plan});
  // Both sends start together; each is journaled before its one send.
  const started=Date.now();
  const outcomes=await Promise.all(racers.map((r,i)=>r.recovery.submit(r.chain,prepared[i]!.review,prepared[i]!.signed,prepared[i]!.funded,{timeoutMs:60000}).then(o=>({...o,ms:Date.now()-started}))));
  console.log(ccc.stringify({outcomes}));
  const hashes=plan.map(p=>p.hash);
  const winner=await until('one swap to commit',async()=>{
   for(const [i,h] of hashes.entries())if(await status(racers[i]!.client,h)==='committed')return i;
   return undefined;
  });
  const loser=1-winner;
  // Commitment is checked on both endpoints, and the loser must not commit.
  for(const owned of [first,second])assert.equal(await status(owned.value,hashes[winner]!),'committed','Winner not committed on every endpoint');
  assert.notEqual(await status(first.value,hashes[loser]!),'committed','Both swaps committed: the pool state was not contended');
  // A review built on the pre-race snapshot must now refuse before any send. Fresh
  // reservations keep the loser's own journaled hold from being the reason.
  const stale=await prepare({...racers[loser]!,reservations:new PoolFundingReservations()},pool,AMOUNT_IN[racers[loser]!.name]).then(p=>{p.funded.release();return 'NOT REFUSED';},(e:Error)=>e.message);
  assert.notEqual(stale,'NOT REFUSED','A stale pool snapshot was accepted');
  await save(file,{status:'raced',round,poolState:pool.stateCell.outPoint,plan,outcomes,winner:plan[winner],loser:plan[loser],
   loserStatus:{[ENDPOINTS[0]]:await status(first.value,hashes[loser]!),[ENDPOINTS[1]]:await status(second.value,hashes[loser]!)},staleSnapshotRefusal:stale});
  console.log(`Winner ${plan[winner]!.wallet} ${hashes[winner]}; loser ${plan[loser]!.wallet} ${hashes[loser]}. Stale snapshot refused: ${stale}`);
 }finally{for(const r of racers)r.journal.close();await first.dispose();await second.dispose();}
}else if(command==='resolve'){
 const file=resultFile(),result=await readJson(file);
 assert.equal(result.status,'raced','Round is not in the raced state');
 const [first,second]=[await open(ENDPOINTS[0]),await open(ENDPOINTS[1])];
 const racers:Racer[]=[];
 try{
  racers.push(await racer('A',first.value),await racer('B',second.value));
  const by=(name:string)=>racers.find(r=>r.name===name)!;
  const winner=by(result.winner.wallet),loser=by(result.loser.wallet);
  const reconciled:Record<string,unknown>={};
  for(const r of racers)reconciled[r.name]=await r.recovery.reconcile(r.chain);
  // The loser leaves every node's pool once the winner commits; wait until it is no longer in flight.
  const loserStatus=await until('the loser to leave the transaction pool',async()=>{
   const s=await status(loser.client,result.loser.hash);return ['pending','proposed'].includes(s)?undefined:s;
  });
  const funding=ccc.Transaction.fromBytes(loser.journal.list().find(r=>r.hash===result.loser.hash)!.transaction).inputs.map(i=>i.previousOutput);
  assert(funding.every(p=>loser.reservations.has(GENESIS,p)),'Loser inputs must stay reserved until resolved');
  const abandoned=await loser.recovery.abandonConflicted(loser.chain as never,result.loser.hash,{acknowledgeReorgRisk:true});
  assert(funding.every(p=>!loser.reservations.has(GENESIS,p)),'Loser inputs still reserved after abandoning');
  const archived=await until('3 confirmations',async()=>winner.recovery.archiveCommitted(winner.client as never,result.winner.hash,{minConfirmations:3}).catch(()=>undefined));
  for(const r of racers)assert.equal(r.journal.list().length,0,`Wallet ${r.name} journal not empty`);
  await save(file,{...result,status:'resolved',reconciled,loserFinalStatus:loserStatus,abandoned,archived,loserReservationsReleased:true});
  console.log(ccc.stringify({loserFinalStatus:loserStatus,abandoned,archived}));
 }finally{for(const r of racers)r.journal.close();await first.dispose();await second.dispose();}
}else if(command==='requote'){
 const file=resultFile(),result=await readJson(file);
 assert.equal(result.status,'resolved','Resolve the round first');
 const owned=await open(ENDPOINTS[0]);let r:Racer|undefined;
 try{
  r=await racer(result.loser.wallet as Name,owned.value);
  assert.equal((await r.recovery.reconcile(r.chain)).length,0,'Loser journal not empty');
  const pool=await livePool(owned.value);
  assert(!pool.stateCell.outPoint.eq(ccc.OutPoint.from(result.poolState)),'Pool state did not move');
  const p=await prepare(r,pool,AMOUNT_IN[r.name]);
  console.log(ccc.stringify({wallet:r.name,poolState:pool.stateCell.outPoint,hash:p.review.summary.transactionHash,fee:p.review.summary.fee}));
  if(!execute){p.funded.release();r.journal.close();console.log('Dry run: signed locally, nothing persisted or sent. Add --execute to send once.');process.exit(0);}
  const outcome=await r.recovery.submit(r.chain,p.review,p.signed,p.funded,{timeoutMs:60000});
  assert.equal(outcome.outcome,'sent',`Send outcome ${outcome.outcome}; inspect before doing anything else`);
  await until('the requote to commit',async()=>await status(owned.value,outcome.hash)==='committed'?true:undefined);
  const archived=await until('3 confirmations',async()=>r!.recovery.archiveCommitted(owned.value as never,outcome.hash,{minConfirmations:3}).catch(()=>undefined));
  await save(file,{...result,status:'complete',requote:{hash:outcome.hash,poolState:pool.stateCell.outPoint,fee:p.review.summary.fee,archived}});
  console.log('Requote committed and archived:',outcome.hash);
 }finally{r?.journal.close();await owned.dispose();}
}else throw new Error('Usage: npx tsx scripts/pool-contention.ts prepare | fund [--execute] | race|resolve|requote --round=N [--execute]');
