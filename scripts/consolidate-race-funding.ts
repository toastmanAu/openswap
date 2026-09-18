// Bounded maintenance of the dedicated test wallet, never the user's JoyID wallet.
import {ccc} from '@ckb-ccc/core';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {assertNetwork,amountData,parseAmount,submit,U128_MAX,type Deployment,type BuiltTransaction} from '../sdk/src/index.js';
assert(process.argv.slice(2).every(a=>a==='--execute'),'Only --execute is supported');
const file=new URL('../deployments/race-funding-consolidation.json',import.meta.url);
let journal:{hash?:ccc.Hex;inputCells?:number;tokenAmount?:string;checks?:unknown}={};
try{journal=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const deployment=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
const first=ccc.ClientPublicTestnet.open({urls:['https://testnet.ckb.dev']}),second=ccc.ClientPublicTestnet.open({urls:['https://testnet.ckbapp.dev']});
try{
 await Promise.all([assertNetwork(first.value,deployment),assertNetwork(second.value,deployment)]);assert.equal(deployment.network,'testnet');
 const signer=new ccc.SignerCkbPrivateKey(first.value,(await readFile(new URL('../.local/testnet-solver-key',import.meta.url),'utf8')).trim());
 const lock=(await signer.getRecommendedAddressObj()).script;
 const expected=JSON.parse(await readFile(new URL('../deployments/solver-wallet.json',import.meta.url),'utf8'));assert(lock.eq(expected.lock));
 const issuer=await ccc.Address.fromString('ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq',first.value);
 const token=await ccc.Script.fromKnownScript(first.value,ccc.KnownScript.XUdt,issuer.script.hash());
 if(!journal.hash){
  const cells:ccc.Cell[]=[];let scanned=0;
  for await(const cell of first.value.findCellsOnChain({script:lock,scriptType:'lock',scriptSearchMode:'exact',withData:true})){
   assert(++scanned<=256,'Wallet scan bound exceeded');
   if(cell.cellOutput.type?.eq(token)){assert.equal(ccc.bytesFrom(cell.outputData).length,16);cells.push(cell);}
  }
  assert(cells.length>=2&&cells.length<=64,'Consolidate 2..64 canonical token cells');
  const amount=cells.reduce((n,c)=>n+parseAmount(c.outputData),0n);assert(amount>0n&&amount<=U128_MAX);
  const tx=ccc.Transaction.from({inputs:cells});tx.addOutput({lock,type:token},amountData(amount));
  await tx.addCellDepsOfKnownScripts(first.value,ccc.KnownScript.XUdt);await tx.completeFeeBy(signer);
  assert.equal(tx.inputs.length,cells.length,'Do not collect additional funding');
  assert(tx.outputs.every(o=>o.lock.eq(lock)));assert.equal(tx.outputs.filter(o=>o.type).length,1);
  assert(tx.outputs[0]!.type?.eq(token));assert.equal(parseAmount(tx.outputsData[0]!),amount);
  assert(tx.outputs.slice(1).every((o,i)=>!o.type&&tx.outputsData[i+1]==='0x'));
  const fee=await tx.getFee(first.value);assert(fee>=0n&&fee<=1000000n);
  console.log('Prepared',cells.length,'token cells; token units',amount.toString(),'; fee shannons',fee.toString());
  if(!process.argv.includes('--execute')){console.log('Dry run: no signatures or broadcasts.');process.exitCode=0;}
  else{
   const hash=tx.hash(),built:BuiltTransaction={tx,deployment,assertLayout(candidate=tx){assert.equal(candidate.hash(),hash);}};
   journal={hash,inputCells:cells.length,tokenAmount:amount.toString()};await writeFile(file,JSON.stringify(journal,null,2)+'\n');
   assert.equal(await submit(built,signer),hash);console.log('Submitted',hash);
  }
 }
 if(journal.hash){
  const checks=[];
  for(const client of [first.value,second.value]){
   await client.waitTransaction(journal.hash,1,180000);
   const response=await client.getTransactionNoCache(journal.hash);assert.equal(response?.status,'committed');const tx=response!.transaction;
   let inputAmount=0n,inputCapacity=0n;
   for(const input of tx.inputs){const cell=await input.getCell(client);assert(cell.cellOutput.lock.eq(lock));assert(cell.cellOutput.type?.eq(token));inputAmount+=parseAmount(cell.outputData);inputCapacity+=cell.cellOutput.capacity;assert.equal(await client.getCellLive(cell.outPoint,true),undefined);}
   assert(tx.outputs.every(o=>o.lock.eq(lock)));assert.equal(tx.outputs.filter(o=>o.type).length,1);assert(tx.outputs[0]!.type?.eq(token));assert.equal(parseAmount(tx.outputsData[0]!),inputAmount);
   assert.equal(inputAmount.toString(),journal.tokenAmount);assert.equal(tx.inputs.length,journal.inputCells);
   const fee=await tx.getFee(client);assert(fee>=0n&&fee<=1000000n);
   const plainCapacity=tx.outputs.filter(o=>!o.type).reduce((n,o)=>n+o.capacity,0n);assert(plainCapacity>0n);
   checks.push({sameOwner:true,tokenConservation:true,inputCells:tx.inputs.length,tokenAmount:inputAmount.toString(),releasedPlainCapacityShannon:plainCapacity.toString(),feeShannon:fee.toString()});
  }
  assert.deepEqual(checks[0],checks[1]);journal.checks=checks;await writeFile(file,JSON.stringify(journal,null,2)+'\n');console.log('Consolidation verified on both nodes.');
 }
}finally{await first.dispose();await second.dispose();}
