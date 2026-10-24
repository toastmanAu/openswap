#!/usr/bin/env -S npx tsx
// Live split-route test (docs/research/POOL_TESTNET_RUN.md). TESTNET ONLY.
//   prepare             create a dedicated maker key, print its address (fund it from the faucet)
//   place [--execute]   place two CKB-for-TEST order lots priced better than the live pool (dry run by default)
//   verify <tx-hash>    verify the JoyID split swap that filled the lots plus the pool
// The maker must differ from the JoyID taker: the frontend never routes through your own lots.
// The key stays in ignored .local/testnet-split-maker-key and is never printed.
import {ccc} from '@ckb-ccc/shell';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {CKB,udt,createOrder,submit,parse,payment,decodeTerms,assertNetwork,CatalogAssetResolver,PinnedXudtResolver,type Deployment} from '../sdk/src/index.js';
import {scanPools,type PoolDeployment} from '../pool-sdk/src/pools.js';
import {ENDPOINTS,FEE_RATE,GENESIS,MAX_FEE,XUDT} from './lib/pool-live.js';

const keyFile=new URL('../.local/testnet-split-maker-key',import.meta.url);
const configFile=new URL('../deployments/split-maker.json',import.meta.url);
const resultFile=new URL('../deployments/split-live-result.json',import.meta.url);
const deployment=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
const pools=JSON.parse(await readFile(new URL('../deployments/pool-frontend.json',import.meta.url),'utf8'));
const poolDeployment=pools.deployment as PoolDeployment,poolId=pools.pools[0].poolId as ccc.Hex;
const taker=JSON.parse(await readFile(new URL('../deployments/pool-testnet.json',import.meta.url),'utf8')).deployer as string;
const token=ccc.Script.from(JSON.parse(await readFile(new URL('../deployments/pool-issuer.json',import.meta.url),'utf8')).token);
assert.equal(token.hash(),pools.pools[0].token.typeHash,'Pool token mismatch');
/** Lots offer CKB for TEST: the maker only needs faucet CKB, and the taker sells TEST. */
const LOTS=[{offerCkb:20_00000000n,premiumBps:800n},{offerCkb:30_00000000n,premiumBps:500n}];
const [command,arg,...flags]=process.argv.slice(2);
const execute=[arg,...flags].includes('--execute');

async function open(url:string){
 const owned=ccc.ClientPublicTestnet.open({urls:[url]});
 assert.equal((await owned.value.getHeaderByNumber(0))?.hash,GENESIS,`${url} is not CKB testnet`);
 return owned;
}
const resolver=(client:ccc.Client)=>new PinnedXudtResolver(new CatalogAssetResolver(client),XUDT.codeHash,XUDT.dep);
const signerFor=async(client:ccc.Client)=>new ccc.SignerCkbPrivateKey(client,(await readFile(keyFile,'utf8')).trim());
async function livePool(client:ccc.Client){
 for await(const pool of scanPools(client as never,poolDeployment))if(pool.poolId===poolId)return pool;
 throw new Error('Pool not found');
}

if(command==='prepare'){
 await mkdir(new URL('../.local/',import.meta.url),{recursive:true,mode:0o700});
 try{await writeFile(keyFile,ccc.hexFrom(randomBytes(32)),{flag:'wx',mode:0o600});console.log('Created .local/testnet-split-maker-key (owner-only).');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;console.log('Maker key already exists; reusing it.');}
 const owned=await open(ENDPOINTS[0]);
 try{
  const address=await (await signerFor(owned.value)).getRecommendedAddressObj();
  assert.notEqual(address.toString(),taker,'Maker must differ from the JoyID taker');
  await writeFile(configFile,ccc.stringify({network:'testnet',address:address.toString(),lock:address.script,lockHash:address.script.hash()})+'\n');
  console.log('Maker address (fund with ~1,000 testnet CKB from https://faucet.nervos.org):',address.toString());
 }finally{await owned.dispose();}
}else if(command==='place'){
 const [primary,secondary]=[await open(ENDPOINTS[0]),await open(ENDPOINTS[1])];
 try{
  const client=primary.value;await assertNetwork(client,deployment);
  const signer=await signerFor(client),maker=await signer.getRecommendedAddressObj();
  assert.equal(maker.toString(),JSON.parse(await readFile(configFile,'utf8')).address,'Maker key does not match deployments/split-maker.json');
  assert.notEqual(maker.toString(),taker,'Maker must differ from the JoyID taker');
  const pool=await livePool(client),{x,y,feeBps}=pool.accounting;
  // The pool pays at most x/y·(1-fee) CKB per TEST at the margin; each lot pays more.
  const lots=LOTS.map(l=>({offerAmount:l.offerCkb,askAmount:l.offerCkb*y*10000n/(x*(10000n+l.premiumBps))}));
  const marginal=Number(x)*(10000-Number(feeBps))/10000/Number(y);
  const plan=lots.map(l=>({offerCkb:ccc.fixedPointToString(l.offerAmount),askTest:ccc.fixedPointToString(l.askAmount),ckbPerTest:(Number(l.offerAmount)/Number(l.askAmount)).toFixed(4)}));
  const built=await createOrder({signer,deployment,resolver:resolver(client),maxFee:MAX_FEE,feeRate:FEE_RATE},{offerAsset:CKB,askAsset:udt(token),lots});
  for(const input of built.tx.inputs)assert((await input.getCell(client)).cellOutput.lock.eq(maker.script),'Inputs must all belong to the maker');
  const fee=await built.tx.getFee(client);
  console.log(ccc.stringify({maker:maker.toString(),poolState:pool.stateCell.outPoint,poolMarginalCkbPerTest:marginal.toFixed(4),lots:plan,lockedCapacity:built.tx.outputs.slice(0,lots.length).reduce((s,o)=>s+o.capacity,0n),fee}));
  if(!execute){console.log('Dry run: nothing signed or sent. Add --execute to place the lots once.');process.exit(0);}
  const exists=await readFile(resultFile,'utf8').then(()=>true,(e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return false;throw e;});
  if(exists)throw new Error('deployments/split-live-result.json exists: the lots were already placed or are pending. Inspect it; do not place twice.');
  const hash=await submit(built,signer,{beforeBroadcast:(hash,transaction)=>writeFile(resultFile,ccc.stringify({status:'sent',create:hash,transaction,maker:maker.toString(),lots:plan})+'\n',{flag:'wx'})})
   .catch(error=>{console.error('Send outcome unknown; do not retry blindly. Inspect deployments/split-live-result.json.');throw error;});
  console.log('CREATE TX HASH:',hash);
  await client.waitTransaction(hash,1,600000);
  const points=lots.map((_,index)=>({txHash:hash,index}));
  for(const other of [client,secondary.value]){
   assert.equal((await other.getTransaction(hash))?.status,'committed','Create not committed on every endpoint');
   for(const [i,point] of points.entries()){
    const cell=await other.getCellLive(point,true);assert(cell,'Lot not live');
    const order=await parse(cell,deployment,resolver(other));
    assert(order.supported&&order.ownerLock.eq(maker.script)&&order.offerAmount===lots[i]!.offerAmount&&order.askAmount===lots[i]!.askAmount,'Lot mismatch');
   }
  }
  await writeFile(resultFile,ccc.stringify({status:'placed',create:hash,maker:maker.toString(),lots:plan,points,fee,verifiedEndpoints:ENDPOINTS})+'\n');
  console.log('Lots placed and verified on both endpoints.');
 }finally{await primary.dispose();await secondary.dispose();}
}else if(command==='verify'){
 assert(/^0x[0-9a-f]{64}$/.test(arg??''),'Usage: npx tsx scripts/split-live-test.ts verify <tx-hash>');
 const journal=JSON.parse(await readFile(resultFile,'utf8'));
 assert.equal(journal.status,'placed','Lots are not recorded as placed');
 const [primary,secondary]=[await open(ENDPOINTS[0]),await open(ENDPOINTS[1])];
 try{
  const checks=[];
  for(const client of [primary.value,secondary.value]){
   const response=await client.getTransactionNoCache(arg!);assert.equal(response?.status,'committed','Split swap not committed');
   const tx=response!.transaction,inputs=await Promise.all(tx.inputs.map(i=>i.getCell(client)));
   const n=inputs.findIndex(c=>c.outPoint.txHash!==journal.create);
   assert(n>=1,'No placed lot was filled');
   for(let i=0;i<n;i++){
    assert(inputs[i]!.cellOutput.lock.codeHash===deployment.codeHash,'Lot input is not an order');
    const expected=payment(decodeTerms(inputs[i]!.cellOutput.lock.args));
    assert.equal(ccc.hexFrom(tx.outputs[i]!.toBytes()),ccc.hexFrom(expected.cellOutput.toBytes()),`Maker payment ${i}`);
    assert.equal(tx.outputsData[i],expected.outputData,`Maker payment data ${i}`);
    assert.equal(await client.getCellLive(inputs[i]!.outPoint,true),undefined,'Lot still live');
   }
   const state=inputs[n]!.cellOutput.type;
   assert(state&&state.codeHash===poolDeployment.codeHash&&tx.outputs[n]!.type?.eq(state),'Pool state not at the input index after the lots');
   const pool=await livePool(client);
   checks.push({lotsFilled:n,makerPaymentsAtLotIndices:true,poolStateIndex:n,fee:(await tx.getFee(client)).toString(),poolAfter:{x:pool.accounting.x.toString(),y:pool.accounting.y.toString()}});
  }
  assert.deepEqual(checks[0]!.lotsFilled,checks[1]!.lotsFilled);
  await writeFile(resultFile,ccc.stringify({...journal,status:'filled',split:arg,checks,verifiedAt:new Date().toISOString()})+'\n');
  console.log(ccc.stringify(checks[0]),'\nSplit swap verified on both endpoints.');
 }finally{await primary.dispose();await secondary.dispose();}
}else throw new Error('Usage: npx tsx scripts/split-live-test.ts prepare | place [--execute] | verify <tx-hash>');
