import {ccc} from '@ckb-ccc/shell';import {readFile,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
import {assertNetwork,decodeTerms,payment,parseAmount,type Deployment} from '../sdk/src/index.js';
const deployment=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
const journal=JSON.parse(await readFile(new URL('../deployments/frontend-live-result.json',import.meta.url),'utf8'));
assert(journal.finishedAt,'UI test has not completed');
const hashes=new Map<string,string>(journal.steps.map((step:{name:string;hash:string})=>[step.name,step.hash]));const checks=[];
for(const endpoint of ['https://testnet.ckb.dev','https://testnet.ckbapp.dev']){
 const owned=ccc.ClientPublicTestnet.open({urls:[endpoint]});try{
  const client=owned.value;await assertNetwork(client,deployment);let fees=0n;const txs=new Map<string,ccc.Transaction>();
  for(const name of ['create_cancel','cancel','create_swap','swap']){const hash=hashes.get(name)!;assert(hash);const response=await client.getTransaction(hash);assert.equal(response?.status,'committed');assert.equal(response!.transaction.hash(),hash);txs.set(name,response!.transaction);fees+=await response!.transaction.getFee(client);}
  const created=txs.get('create_cancel')!,cancel=txs.get('cancel')!,terms=decodeTerms(created.outputs[0]!.lock.args);
  const index=cancel.inputs.findIndex(i=>i.previousOutput.eq({txHash:hashes.get('create_cancel')!,index:0}));assert(index>=0);
  assert(cancel.outputs[index]!.lock.eq(terms.ownerLock));assert.equal(cancel.outputs[index]!.type?.hash(),created.outputs[0]!.type?.hash());assert.equal(cancel.outputsData[index],created.outputsData[0]);assert(cancel.outputs[index]!.capacity>=created.outputs[0]!.capacity);
  let proof=false;for(let i=0;i<cancel.inputs.length;i++){if(i===index)continue;const before=await cancel.inputs[i]!.getCell(client),after=cancel.outputs[i];if(after&&before.cellOutput.lock.eq(terms.ownerLock)&&after.lock.eq(terms.ownerLock)&&!before.cellOutput.type&&!after.type&&before.outputData==='0x'&&cancel.outputsData[i]==='0x'&&after.capacity<before.cellOutput.capacity)proof=true;}assert(proof);
  const order=txs.get('create_swap')!.outputs[0]!,fill=txs.get('swap')!;assert.equal(order.lock.codeHash,deployment.codeHash);assert.equal(order.lock.hashType,'data1');const fillIndex=fill.inputs.findIndex(i=>i.previousOutput.eq({txHash:hashes.get('create_swap')!,index:0}));assert(fillIndex>=0);
  const expected=payment(decodeTerms(order.lock.args));assert.equal(ccc.hexFrom(fill.outputs[fillIndex]!.toBytes()),ccc.hexFrom(expected.cellOutput.toBytes()));assert.equal(fill.outputsData[fillIndex],expected.outputData);
  const balance=new Map<string,bigint>();const tally=(type:ccc.Script|undefined,data:ccc.Hex,sign:bigint)=>{if(type)balance.set(type.hash(),(balance.get(type.hash())??0n)+sign*parseAmount(data));};
  for(const input of fill.inputs){const cell=await input.getCell(client);tally(cell.cellOutput.type,cell.outputData,1n);}fill.outputs.forEach((o,i)=>tally(o.type,fill.outputsData[i]!,-1n));assert(balance.size>0);for(const value of balance.values())assert.equal(value,0n);
  for(const name of ['create_cancel','create_swap'])assert.equal(await client.getCellLive({txHash:hashes.get(name)!,index:0},true),undefined);
  checks.push({endpoint,createCancel:true,routedSwap:true,indexedMakerPayment:true,tokenConservation:true,ordersSpent:true,totalFeeShannon:fees.toString()});
 }finally{await owned.dispose();}
}
assert.deepEqual({...checks[0],endpoint:undefined},{...checks[1],endpoint:undefined});await writeFile(new URL('../deployments/frontend-live-verification.json',import.meta.url),JSON.stringify({verifiedAt:new Date().toISOString(),transactions:Object.fromEntries(hashes),checks},null,2)+'\n');console.log(JSON.stringify(checks,null,2));
