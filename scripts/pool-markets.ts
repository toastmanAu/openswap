#!/usr/bin/env -S npx tsx
// More testnet pools and a live two-pool route. TESTNET ONLY.
//   prepare                 create one issuer key per new token, record the plan
//   mint [--execute]        the maker funds each issuer, each issuer mints its supply
//                           once to the maker and to the user's JoyID
//   create [--execute]      the maker creates one CKB pool per new token
//   route [--execute]       the maker swaps TEST2 -> CKB -> TEST3 through both pools
//                           in one transaction
//   verify                  check every recorded transaction on both endpoints
// The maker is the split-test wallet (.local/testnet-split-maker-key). Pool sends go
// through PoolSubmissionRecovery with a file journal under ignored .local/pool-markets/.
// Every signed transaction is recorded before its one send. Keys are never printed.
import {ccc} from '@ckb-ccc/shell';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {amountData,parseAmount} from '../sdk/src/codec.js';
import {createPool} from '../pool-model/src/model.js';
import {fundPoolTransaction,PoolFundingError,PoolFundingReservations,type PoolIntent} from '../pool-sdk/src/funding.js';
import {loadPool,scanPools,type PoolDeployment,type PoolSnapshot} from '../pool-sdk/src/pools.js';
import {reviewPoolTransaction} from '../pool-sdk/src/review.js';
import {PoolSubmissionRecovery,type PoolSubmitClient} from '../pool-sdk/src/recovery.js';
import {quoteRouteExactIn} from '../pool-sdk/src/route.js';
import {FileSubmissionJournal} from '../solver/src/journal.js';
import {ENDPOINTS,FEE_RATE,GENESIS,JOYID_PROFILE,MAX_FEE,POOL_PARAMETERS,XUDT,tokenScript} from './lib/pool-live.js';

/** Token plan, 8 decimals. Pool prices: 1 CKB = 10 TEST2; 1 TEST3 = 2 CKB. */
const UNIT=10n**8n;
const TOKENS=[
 {symbol:'TEST2',maker:200_000n*UNIT,joyid:20_000n*UNIT,pool:{x:5_000n*UNIT,y:50_000n*UNIT}},
 {symbol:'TEST3',maker:10_000n*UNIT,joyid:1_000n*UNIT,pool:{x:5_000n*UNIT,y:2_500n*UNIT}},
] as const;
type Symbol=typeof TOKENS[number]['symbol'];
const ISSUER_FUNDING=1_000n*UNIT;
const ROUTE_IN=1_000n*UNIT;

const local=(name:string)=>new URL(`../.local/${name}`,import.meta.url);
const makerKey=local('testnet-split-maker-key');
const issuerKey=(symbol:Symbol)=>local(`testnet-token-${symbol.toLowerCase()}-key`);
const planFile=new URL('../deployments/pool-markets.json',import.meta.url);
const recorded=(name:string)=>JSON.parse(readFileSync(new URL(`../deployments/${name}`,import.meta.url),'utf8'));
const deployment=recorded('pool-frontend.json').deployment as PoolDeployment;
const joyidAddress=recorded('pool-testnet.json').deployer as string;

const [command,...flags]=process.argv.slice(2);
for(const flag of flags)assert(flag==='--execute',`Unknown option ${flag}`);
const execute=flags.includes('--execute');
const readPlan=async()=>JSON.parse(await readFile(planFile,'utf8'));
const savePlan=(plan:unknown)=>writeFile(planFile,ccc.stringify(plan)+'\n');

async function open(url:string){
 const owned=ccc.ClientPublicTestnet.open({urls:[url]});
 assert.equal((await owned.value.getHeaderByNumber(0))?.hash,GENESIS,`${url} is not CKB testnet`);
 return owned;
}
const signer=async(key:URL,client:ccc.Client)=>new ccc.SignerCkbPrivateKey(client,(await readFile(key,'utf8')).trim());
async function until<T>(what:string,check:()=>Promise<T|undefined>,timeoutMs=900000):Promise<T>{
 const end=Date.now()+timeoutMs;
 for(;;){const value=await check();if(value!==undefined)return value;assert(Date.now()<end,`Timed out waiting for ${what}`);await new Promise(r=>setTimeout(r,5000));}
}
const committed=(client:ccc.Client,hash:ccc.Hex)=>until(`${hash} to commit`,async()=>(await client.getTransactionNoCache(hash))?.status==='committed'?true:undefined);

/** Records the signed bytes under `key` before the one send, then waits for commitment. */
async function sendRecorded(client:ccc.Client,plan:any,key:string,signed:ccc.Transaction){
 const hash=signed.hash();
 assert(!plan.transactions?.[key],`${key} is already recorded; inspect deployments/pool-markets.json, do not resend`);
 plan.transactions={...plan.transactions,[key]:{status:'sent',hash,transaction:ccc.hexFrom(signed.toBytes())}};
 await savePlan(plan);
 assert.equal(await client.sendTransaction(signed),hash);
 console.log(`${key}: sent ${hash}`);
 await committed(client,hash);
 plan.transactions[key]={status:'committed',hash};await savePlan(plan);
 console.log(`${key}: committed`);
 return hash;
}

/** The maker as a pool user: its own reservations, journal and recovery. */
async function poolMaker(client:ccc.Client){
 const s=await signer(makerKey,client),lock=(await s.getRecommendedAddressObj()).script;
 const scope={genesisHash:GENESIS,accountLockHash:lock.hash()};
 const reservations=new PoolFundingReservations();
 const journal=new FileSubmissionJournal(local('pool-markets/').pathname,scope);
 const recovery=new PoolSubmissionRecovery(journal,reservations,scope);
 assert.equal((await recovery.reconcile(client as unknown as PoolSubmitClient)).length,0,'Maker has unresolved pool submissions; resolve them first');
 const deps=(await client.getKnownScript(ccc.KnownScript.Secp256k1Blake160)).cellDeps.map(d=>d.cellDep);
 return {signer:s,lock,reservations,journal,recovery,wallet:{lock,change:lock,deps,feeRate:FEE_RATE,maxFee:MAX_FEE}};
}
type Maker=Awaited<ReturnType<typeof poolMaker>>;

/** Fund, review, sign; then (with --execute) journal and send once and archive at depth 3. */
async function poolSend(client:ccc.Client,m:Maker,plan:any,key:string,intent:PoolIntent,describe:(summary:any)=>unknown){
 const recipients={ckb:m.lock,token:m.lock,lp:m.lock};
 // The indexer can lag a just-committed mint; retry funding briefly.
 const funded=await until('maker funding to be indexed',async()=>{
  try{return await fundPoolTransaction(client as never,deployment,m.wallet,recipients,intent,{reservations:m.reservations,timeoutMs:60000});}
  catch(error){if(error instanceof PoolFundingError&&(error.code==='INSUFFICIENT'||error.code==='LIMIT'))return undefined;throw error;}
 },180000);
 try{
  for(const cell of funded.funding)assert(cell.cellOutput.lock.eq(m.lock),'Funding must belong to the maker');
  const prepared=await m.signer.prepareTransaction(funded.built.transaction.clone());
  assert.equal(ccc.hexFrom(prepared.toBytes()),ccc.hexFrom(funded.built.transaction.toBytes()),'Signer changed the prepared transaction');
  const review=reviewPoolTransaction(deployment,{...m.wallet,funding:funded.funding},recipients,intent,prepared,300000);
  assert(review.summary.fee<=MAX_FEE,'Fee exceeds cap');
  console.log(ccc.stringify({step:key,transactionHash:review.summary.transactionHash,fee:review.summary.fee,...describe(review.summary) as object}));
  if(!execute){funded.release();console.log(`Dry run: ${key} signed nothing and sent nothing. Add --execute.`);return undefined;}
  assert(!plan.transactions?.[key],`${key} is already recorded; inspect deployments/pool-markets.json, do not resend`);
  const signed=await m.signer.signOnlyTransaction(review.transaction());
  review.assertIntegrity(signed);
  plan.transactions={...plan.transactions,[key]:{status:'signed',hash:signed.hash(),summary:describe(review.summary)}};await savePlan(plan);
  const outcome=await m.recovery.submit(client as unknown as PoolSubmitClient,review,signed,funded,{timeoutMs:60000});
  console.log(`${key}: ${outcome.outcome} ${outcome.hash}`);
  await committed(client,outcome.hash);
  await until('3 confirmations',async()=>m.recovery.archiveCommitted(client as never,outcome.hash,{minConfirmations:3}).catch(()=>undefined));
  plan.transactions[key]={...plan.transactions[key],status:'committed'};await savePlan(plan);
  console.log(`${key}: committed and archived`);
  return {hash:outcome.hash,summary:review.summary};
 }catch(error){if(!execute)funded.release();throw error;}
}
async function livePool(client:ccc.Client,poolId:ccc.Hex):Promise<PoolSnapshot>{
 for await(const pool of scanPools(client as never,deployment))if(pool.poolId===poolId)return loadPool(client as never,deployment,pool.stateCell.outPoint);
 throw new Error(`Pool ${poolId} not found`);
}

if(command==='prepare'){
 await mkdir(local('pool-markets/'),{recursive:true,mode:0o700});
 const owned=await open(ENDPOINTS[0]);
 try{
  const maker=await (await signer(makerKey,owned.value)).getRecommendedAddressObj();
  const tokens=[];
  for(const t of TOKENS){
   try{await writeFile(issuerKey(t.symbol),ccc.hexFrom(randomBytes(32)),{flag:'wx',mode:0o600});console.log(`Created issuer key for ${t.symbol} (owner-only).`);}
   catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;console.log(`Issuer key for ${t.symbol} exists; reusing it.`);}
   const issuer=await (await signer(issuerKey(t.symbol),owned.value)).getRecommendedAddressObj(),token=tokenScript(issuer.script.hash());
   assert(!issuer.script.eq(maker.script),'Issuer must differ from the maker');
   tokens.push({symbol:t.symbol,decimals:8,issuer:issuer.toString(),issuerLockHash:issuer.script.hash(),token,typeHash:token.hash(),
    mint:{maker:t.maker,joyid:t.joyid},pool:{...t.pool,parameters:POOL_PARAMETERS}});
  }
  const existing=await readPlan().catch(()=>undefined);
  assert(!existing?.transactions,'deployments/pool-markets.json already records transactions; do not re-prepare');
  await savePlan({network:'testnet',maker:maker.toString(),joyid:joyidAddress,tokens});
  console.log(ccc.stringify({maker:maker.toString(),tokens:tokens.map(t=>({symbol:t.symbol,issuer:t.issuer,typeHash:t.typeHash}))}));
 }finally{await owned.dispose();}
}else if(command==='mint'){
 const plan=await readPlan(),owned=await open(ENDPOINTS[0]);
 try{
  const client=owned.value,maker=await signer(makerKey,client);
  assert.equal(await maker.getRecommendedAddress(),plan.maker,'Maker key does not match the plan');
  const joyid=await ccc.Address.fromString(plan.joyid,client);
  assert(joyid.script.codeHash===JOYID_PROFILE.codeHash&&joyid.script.hashType===JOYID_PROFILE.hashType,'Recipient must be a JoyID testnet address');
  const xudt=await client.getCellLive(XUDT.dep.outPoint,true);
  assert(xudt&&ccc.hashCkb(xudt.outputData)===XUDT.codeHash,'xUDT code dependency changed');
  // One maker transaction funds every issuer.
  if(!plan.transactions?.fundIssuers){
   const tx=ccc.Transaction.from({outputs:await Promise.all(plan.tokens.map(async(t:any)=>({lock:(await ccc.Address.fromString(t.issuer,client)).script,capacity:ISSUER_FUNDING})))});
   await tx.completeInputsByCapacity(maker);await tx.completeFeeBy(maker,FEE_RATE);
   const fee=await tx.getFee(client);assert(fee>0n&&fee<=MAX_FEE,`Fee ${fee} exceeds cap`);
   console.log(ccc.stringify({step:'fundIssuers',each:ISSUER_FUNDING,issuers:plan.tokens.map((t:any)=>t.issuer),fee}));
   if(!execute){console.log('Dry run: nothing signed or sent. Add --execute.');process.exit(0);}
   await sendRecorded(client,plan,'fundIssuers',await maker.signTransaction(tx));
  }
  for(const t of plan.tokens){
   const key=`mint${t.symbol}`;if(plan.transactions?.[key])continue;
   const issuer=await signer(issuerKey(t.symbol),client),issuerLock=(await issuer.getRecommendedAddressObj()).script;
   assert.equal(issuerLock.hash(),t.issuerLockHash,`Issuer key for ${t.symbol} does not match the plan`);
   const token=tokenScript(issuerLock.hash());assert.equal(token.hash(),t.typeHash);
   const makerLock=(await maker.getRecommendedAddressObj()).script;
   const tx=ccc.Transaction.from({cellDeps:[XUDT.dep]});
   tx.addOutput({lock:makerLock,type:token},amountData(BigInt(t.mint.maker)));
   tx.addOutput({lock:joyid.script,type:token},amountData(BigInt(t.mint.joyid)));
   await until(`${t.symbol} issuer funding to be indexed`,async()=>{try{await tx.completeInputsByCapacity(issuer);return true;}catch{return undefined;}},180000);
   await tx.completeFeeBy(issuer,FEE_RATE);
   for(const input of tx.inputs)assert((await input.getCell(client)).cellOutput.lock.eq(issuerLock),'Mint inputs must all belong to the issuer');
   const fee=await tx.getFee(client);assert(fee>0n&&fee<=MAX_FEE,`Fee ${fee} exceeds cap`);
   console.log(ccc.stringify({step:key,token:t.typeHash,maker:t.mint.maker,joyid:t.mint.joyid,fee}));
   if(!execute){console.log('Dry run: nothing signed or sent. Add --execute.');continue;}
   await sendRecorded(client,plan,key,await issuer.signTransaction(tx));
  }
 }finally{await owned.dispose();}
}else if(command==='create'){
 const plan=await readPlan(),owned=await open(ENDPOINTS[0]);let m:Maker|undefined;
 try{
  const client=owned.value;m=await poolMaker(client);
  assert.equal(ccc.Address.fromScript(m.lock,client).toString(),plan.maker,'Maker key does not match the plan');
  for(const t of plan.tokens){
   const key=`create${t.symbol}`;if(plan.transactions?.[key]?.status==='committed')continue;
   const parameters={feeBps:BigInt(t.pool.parameters.feeBps),lockedShares:BigInt(t.pool.parameters.lockedShares),backing:{state:BigInt(t.pool.parameters.backing.state),ckb:BigInt(t.pool.parameters.backing.ckb),token:BigInt(t.pool.parameters.backing.token)}};
   const x=BigInt(t.pool.x),y=BigInt(t.pool.y),minted=createPool(parameters,x,y,1n).flows.mintedShares;
   const done=await poolSend(client,m,plan,key,{kind:'create',request:{parameters,x,y,minShares:minted,tokenOwner:t.issuerLockHash}},s=>({poolId:s.poolId,token:t.symbol,x,y,lpShares:minted}));
   if(done){t.poolId=done.summary.poolId;t.label=`CKB / ${t.symbol}`;await savePlan(plan);}
  }
 }finally{m?.journal.close();await owned.dispose();}
}else if(command==='route'){
 const plan=await readPlan(),owned=await open(ENDPOINTS[0]);let m:Maker|undefined;
 try{
  const client=owned.value;m=await poolMaker(client);
  const [from,to]=[plan.tokens[0],plan.tokens[1]];assert(from.poolId&&to.poolId,'Create both pools first');
  const [a,b]=[await livePool(client,from.poolId),await livePool(client,to.poolId)];
  const q=quoteRouteExactIn(a.accounting,b.accounting,ROUTE_IN),minOut=q.amountOut*99n/100n;
  const done=await poolSend(client,m,plan,'routeTEST2toTEST3',{kind:'route',pools:[a,b],amountIn:ROUTE_IN,minOut},s=>({
   route:`${from.symbol} -> CKB -> ${to.symbol}`,pools:[from.poolId,to.poolId],states:[a.stateCell.outPoint,b.stateCell.outPoint],
   paid:s.route.paid,hop:s.route.hop,received:s.route.received,minOut:s.route.minOut}));
  if(done){plan.route={hash:done.hash,paid:done.summary.route!.paid,hop:done.summary.route!.hop,received:done.summary.route!.received,states:[a.stateCell.outPoint,b.stateCell.outPoint]};await savePlan(plan);}
 }finally{m?.journal.close();await owned.dispose();}
}else if(command==='verify'){
 const plan=await readPlan(),results:Record<string,unknown>={};
 const clients=[await open(ENDPOINTS[0]),await open(ENDPOINTS[1])];
 try{
  for(const [key,t] of Object.entries(plan.transactions??{}) as [string,{hash:ccc.Hex;status:string}][]){
   for(const [i,c] of clients.entries())assert.equal((await c.value.getTransactionNoCache(t.hash))?.status,'committed',`${key} not committed on ${ENDPOINTS[i]}`);
   results[key]={hash:t.hash,committedOn:ENDPOINTS};
  }
  // Both pools are discoverable on both endpoints with the planned token and backing.
  for(const t of plan.tokens)for(const c of clients){
   const pool=await livePool(c.value,t.poolId);
   assert.equal(pool.token.hash(),t.typeHash,`${t.symbol} pool token mismatch`);
   assert.deepEqual(pool.accounting.backing,{state:BigInt(t.pool.parameters.backing.state),ckb:BigInt(t.pool.parameters.backing.ckb),token:BigInt(t.pool.parameters.backing.token)});
  }
  if(plan.route){
   for(const c of clients){
    const tx=(await c.value.getTransactionNoCache(plan.route.hash))!.transaction!;
    assert(tx.inputs[0]!.previousOutput.eq(plan.route.states[0])&&tx.inputs[3]!.previousOutput.eq(plan.route.states[1]),'Route did not spend the reviewed pool states');
    const receipt=tx.outputs[6]!;
    assert.equal(receipt.lock.hash(),(await ccc.Address.fromString(plan.maker,c.value)).script.hash(),'Receipt does not pay the maker');
    assert.equal(receipt.type?.hash(),plan.tokens[1].typeHash,'Receipt is not the second token');
    assert.equal(parseAmount(tx.outputsData[6]!),BigInt(plan.route.received),'Receipt amount differs from the review');
   }
   results.route={hash:plan.route.hash,receiptChecked:true};
  }
  plan.verified={at:new Date().toISOString(),endpoints:ENDPOINTS,results};await savePlan(plan);
  console.log(ccc.stringify(plan.verified));
 }finally{for(const c of clients)await c.dispose();}
}else{
 console.error('Usage: npx tsx scripts/pool-markets.ts <prepare|mint|create|route|verify> [--execute]');process.exitCode=1;
}
