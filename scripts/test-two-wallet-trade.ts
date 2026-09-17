// Two transactions maximum, dedicated local testnet keys only. Dry run unless --execute.
import {ccc} from '@ckb-ccc/core';import {readFile,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
import {CKB,udt,createOrder,fillOrders,submit,assertNetwork,payment,decodeTerms,parseAmount,type Deployment} from '../sdk/src/index.js';
const deployment=JSON.parse(await readFile('deployments/testnet.json','utf8')) as Deployment;
const file='deployments/two-wallet-trade-result.json';
let journal:{create?:ccc.Hex;fill?:ccc.Hex;maker?:string;taker?:string;checks?:unknown;completedAt?:string}={};try{journal=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const save=()=>writeFile(file,JSON.stringify(journal,null,2)+'\n');
const first=ccc.ClientPublicTestnet.open({urls:['https://testnet.ckb.dev']}),second=ccc.ClientPublicTestnet.open({urls:['https://testnet.ckbapp.dev']});
try{
 await Promise.all([assertNetwork(first.value,deployment),assertNetwork(second.value,deployment)]);assert.equal(deployment.network,'testnet');
 if(!process.argv.includes('--execute')){console.log('Dry run: maker offers 1 test-token base unit for 1 shannon; separate taker fills. Maximum two transactions, fee <= 0.01 CKB each.');}
 else{
 const maker=new ccc.SignerCkbPrivateKey(first.value,(await readFile('.local/testnet-solver-key','utf8')).trim()),taker=new ccc.SignerCkbPrivateKey(second.value,(await readFile('.local/testnet-race-key','utf8')).trim());
 const makerLock=(await maker.getRecommendedAddressObj()).script,takerLock=(await taker.getRecommendedAddressObj()).script;assert(!makerLock.eq(takerLock));
 const issuer=await ccc.Address.fromString('ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq',first.value);
 const token=await ccc.Script.fromKnownScript(first.value,ccc.KnownScript.XUdt,issuer.script.hash());
 journal.maker=await maker.getRecommendedAddress();journal.taker=await taker.getRecommendedAddress();
 if(!journal.create){const built=await createOrder({signer:maker,deployment,maxFee:1000000n},{offerAsset:udt(token),askAsset:CKB,lots:[{offerAmount:1n,askAmount:1n}]});journal.create=built.tx.hash();await save();assert.equal(await submit(built,maker),journal.create);console.log('Created',journal.create);}
 await first.value.waitTransaction(journal.create,1,180000);
 if(!journal.fill){const built=await fillOrders({signer:taker,deployment,maxFee:1000000n},[{txHash:journal.create,index:0}]);journal.fill=built.tx.hash();await save();assert.equal(await submit(built,taker),journal.fill);console.log('Filled',journal.fill);}
 await second.value.waitTransaction(journal.fill,1,180000);
 const checks=[];
 for(const client of [first.value,second.value]){
 const response=await client.getTransactionNoCache(journal.fill);assert.equal(response?.status,'committed');const tx=response!.transaction;
 const inputs=await Promise.all(tx.inputs.map(i=>i.getCell(client)));const index=inputs.findIndex(c=>c.outPoint.txHash===journal.create);assert.equal(index,0);
 const order=inputs[index]!,terms=decodeTerms(order.cellOutput.lock.args);assert(terms.ownerLock.eq(makerLock));assert(terms.askAsset.kind==='ckb');assert.equal(terms.askAmount,1n);
 const expected=payment(terms);assert.equal(ccc.hexFrom(tx.outputs[index]!.toBytes()),ccc.hexFrom(expected.cellOutput.toBytes()));assert.equal(tx.outputsData[index],expected.outputData);
 let totalIn=0n,totalOut=0n,takerIn=0n,takerOut=0n,takerCkbIn=0n,takerCkbOut=0n;
 for(const c of inputs){assert(!c.cellOutput.lock.eq(issuer.script));if(c.cellOutput.type?.eq(token)){totalIn+=parseAmount(c.outputData);if(c.cellOutput.lock.eq(takerLock))takerIn+=parseAmount(c.outputData);}if(c.cellOutput.lock.eq(takerLock))takerCkbIn+=c.cellOutput.capacity;}
 tx.outputs.forEach((o,i)=>{if(o.type?.eq(token)){totalOut+=parseAmount(tx.outputsData[i]!);if(o.lock.eq(takerLock))takerOut+=parseAmount(tx.outputsData[i]!);}if(o.lock.eq(takerLock))takerCkbOut+=o.capacity;});
 assert.equal(totalIn,totalOut);assert.equal(takerOut-takerIn,1n);const fee=await tx.getFee(client);assert(fee<=1000000n);assert(takerCkbIn-takerCkbOut>=1n+fee);assert.equal(await client.getCellLive(order.outPoint,true),undefined);
 checks.push({makerAndTakerDiffer:true,indexedMakerPayment:true,tokenConservation:true,takerTokenIncrease:'1',takerCkbDebitShannon:(takerCkbIn-takerCkbOut).toString(),feeShannon:fee.toString(),issuerInputAbsent:true,orderSpent:true});
 }
 assert.deepEqual(checks[0],checks[1]);journal.checks=checks;journal.completedAt=new Date().toISOString();await save();console.log('Two-wallet trade verified on both testnet nodes.');
 }
}finally{await first.dispose();await second.dispose();}
