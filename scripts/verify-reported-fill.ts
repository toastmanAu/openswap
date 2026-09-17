// Read-only audit of the user-reported fill. No signer or private key is used.
import {ccc} from '@ckb-ccc/core';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {assertNetwork,decodeTerms,payment,parseAmount,type Deployment} from '../sdk/src/index.js';
import {formatUnits} from '../frontend/src/amounts.js';
const hash='0xbab0973b321182b2fed969030ebafb092d051de9d173e942db0deb975fe66a90';
const deployment=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
const checks=[];
for(const endpoint of ['https://testnet.ckb.dev','https://testnet.ckbapp.dev']){
 const owned=ccc.ClientPublicTestnet.open({urls:[endpoint]});try{
 const client=owned.value;await assertNetwork(client,deployment);
 const response=await client.getTransaction(hash);assert.equal(response?.status,'committed');const tx=response!.transaction;assert.equal(tx.hash(),hash);
 const inputs=await Promise.all(tx.inputs.map(i=>i.getCell(client)));
 const index=inputs.findIndex(c=>c.cellOutput.lock.codeHash===deployment.codeHash);assert(index>=0);
 const order=inputs[index]!,terms=decodeTerms(order.cellOutput.lock.args),expected=payment(terms);
 assert.equal(ccc.hexFrom(tx.outputs[index]!.toBytes()),ccc.hexFrom(expected.cellOutput.toBytes()));assert.equal(tx.outputsData[index],expected.outputData);
 assert(terms.askAsset.kind==='udt');const type=terms.askAsset.script;
 const tokenInputs=inputs.filter(c=>c.cellOutput.type?.eq(type));assert(tokenInputs.length>0);assert(tokenInputs.every(c=>c.cellOutput.lock.eq(terms.ownerLock)));
 assert(tx.outputs.every(o=>o.lock.eq(terms.ownerLock)));
 const before=tokenInputs.reduce((n,c)=>n+parseAmount(c.outputData),0n);
 const after=tx.outputs.reduce((n,o,i)=>n+(o.type?.eq(type)?parseAmount(tx.outputsData[i]!):0n),0n);assert.equal(before,after);
 assert(!order.cellOutput.type);assert(tx.outputs[index]!.type); // This is settlement, not the unchanged-data recovery branch.
 checks.push({endpoint,status:'committed',makerAddress:ccc.Address.fromScript(terms.ownerLock,client).toString(),makerLockHash:terms.ownerLock.hash(),indexedMakerPayment:true,ownerRecovery:false,funderEqualsMaker:true,allOutputsBelongToMaker:true,ckbOffer:formatUnits(order.cellOutput.capacity-terms.capacityRefund,8),ickbPayment:formatUnits(terms.askAmount,8),ickbBefore:formatUnits(before,8),ickbAfter:formatUnits(after,8),ickbChange:formatUnits(after-terms.askAmount,8),feeCKB:formatUnits(await tx.getFee(client),8)});
 }finally{await owned.dispose();}
}
assert.deepEqual({...checks[0],endpoint:undefined},{...checks[1],endpoint:undefined});
await writeFile(new URL('../deployments/reported-fill-verification.json',import.meta.url),JSON.stringify({verifiedAt:new Date().toISOString(),hash,checks},null,2)+'\n');console.log(JSON.stringify(checks,null,2));
