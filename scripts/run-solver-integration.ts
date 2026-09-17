// Executes only the supplied setup order and this wallet's recorded fixture orders.
import {ccc} from '@ckb-ccc/shell';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {CKB,udt,assertNetwork,createOrder,cancelOrders,submit,parse,defaultResolver,orderKey,type Deployment} from '../sdk/src/index.js';
import {ReferenceSolver} from '../solver/src/index.js';
const setupHash=process.argv[2];assert.match(setupHash??'',/^0x[0-9a-fA-F]{64}$/,'Supply SOLVER SETUP TX HASH');
const execute=process.argv.includes('--execute');
const deployment=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
const config=JSON.parse(await readFile(new URL('../deployments/solver-wallet.json',import.meta.url),'utf8'));
const journalFile=new URL('../deployments/solver-integration-result.json',import.meta.url);
let journal:Record<string,string>={setupHash:setupHash!};
try{journal=JSON.parse(await readFile(journalFile,'utf8'));assert.equal(journal.setupHash,setupHash,'Journal belongs to another setup');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const owned=ccc.ClientPublicTestnet.open({urls:[process.env.CKB_RPC_URL??'https://testnet.ckb.dev']});
try{
 const client=owned.value;await assertNetwork(client,deployment);assert.equal(deployment.network,'testnet');
 const signer=new ccc.SignerCkbPrivateKey(client,(await readFile(new URL('../.local/testnet-solver-key',import.meta.url),'utf8')).trim());
 assert.equal(await signer.getRecommendedAddress(),config.address);
 const context={signer,deployment,maxFee:100000000n};
 const setup=await client.getTransaction(setupHash!);assert.equal(setup?.status,'committed');
 const makerPoint=ccc.OutPoint.from({txHash:setupHash!,index:0});
 const makerCell=ccc.Cell.from({outPoint:makerPoint,cellOutput:setup!.transaction.outputs[0]!,outputData:setup!.transaction.outputsData[0]!});
 const maker=await parse(makerCell,deployment,defaultResolver(client));assert(maker.supported);assert.equal(maker.offerAsset.kind,'ckb');assert.equal(maker.offerAmount,1n);assert.equal(maker.askAsset.kind,'udt');assert.equal(maker.askAmount,1n);
 assert(!maker.ownerLock.eq((await signer.getRecommendedAddressObj()).script),'Maker and solver must differ');
 const token=await ccc.Script.fromKnownScript(client,ccc.KnownScript.XUdt,maker.ownerLock.hash());
 assert(maker.askAsset.kind==='udt'&&maker.askAsset.script.eq(token));
 assert(setup!.transaction.outputs[1]!.lock.eq(ccc.Script.from(config.lock)));
 assert(setup!.transaction.outputs[2]!.lock.eq(ccc.Script.from(config.lock)));
 assert(setup!.transaction.outputs[2]!.type?.eq(token));
 console.log('Setup verified; separate solver:',config.address);
 if(!execute){console.log('Dry run: no signing or broadcast. Add --execute to run the bounded testnet scenario.');}
 else{
  const save=async()=>writeFile(journalFile,JSON.stringify(journal,null,2)+'\n');
  const step=async(name:string,build:()=>Promise<import('../sdk/src/index.js').BuiltTransaction>)=>{
   if(!journal[name]){const built=await build();journal[name]=await submit(built,signer);await save();console.log(name,journal[name]);}
   await client.waitTransaction(journal[name]!,1);return journal[name]!;
  };
  const created=await step('secpCreate',()=>createOrder(context,{offerAsset:CKB,askAsset:udt(token),lots:[{offerAmount:1n,askAmount:1n}]}));
  await step('secpCancel',()=>cancelOrders(context,[{txHash:created,index:0}]));
  assert.equal(await client.getCellLive({txHash:created,index:0},true),undefined);
  const reciprocal=await step('reciprocalCreate',()=>createOrder(context,{offerAsset:udt(token),askAsset:CKB,lots:[{offerAmount:1n,askAmount:1n}]}));
  if(!journal.solverFill){
   const allowed=new Set([`${setupHash}:0`,`${reciprocal}:0`]);
   let submitted:ccc.Hex|undefined;
   const solver=new ReferenceSolver(context,(event,details)=>{console.log(event,details);if(event==='settlement_submitted')submitted=(details as {txHash:ccc.Hex}).txHash;},{acceptOrder:o=>allowed.has(orderKey(o))});
   await solver.tick(true);
   if(!submitted)throw new Error('No bundle found yet; allow indexer to catch up, then rerun');
   journal.solverFill=submitted;await save();
  }
  await client.waitTransaction(journal.solverFill,1);
  const fill=(await client.getTransaction(journal.solverFill))!.transaction;
  assert(fill.inputs.some(i=>i.previousOutput.eq(makerPoint)));
  assert(fill.inputs.some(i=>i.previousOutput.eq({txHash:reciprocal,index:0})));
  for(const input of fill.inputs)assert(!(await input.getCell(client)).cellOutput.lock.eq(maker.ownerLock),'Token issuer input must be absent');
  assert.equal(await client.getCellLive(makerPoint,true),undefined);
  assert.equal(await client.getCellLive({txHash:reciprocal,index:0},true),undefined);
  journal.status='committed';await save();console.log('SEPARATE SOLVER INTEGRATION COMMITTED',journal);
 }
}finally{await owned.dispose();}
