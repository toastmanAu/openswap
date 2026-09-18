// Read-only: verify four human-signed transactions; an origin cannot be proven on chain.
import {ccc} from '@ckb-ccc/core';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {assertNetwork,decodeTerms,payment,parseAmount,type Deployment} from '../sdk/src/index.js';
const [createFillHash,fillHash,createCancelHash,cancelHash,...extra]=process.argv.slice(2);
assert.equal(extra.length,0,'Usage: verify-public-wallet.ts <create-for-fill> <fill> <create-for-cancel> <cancel>');
const hashes=[createFillHash,fillHash,createCancelHash,cancelHash];
for(const hash of hashes)assert.match(hash??'',/^0x[0-9a-f]{64}$/,'Four lowercase public transaction hashes required');
assert.equal(new Set(hashes).size,4,'Four distinct transactions required');
const deployment=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
const checks=[];
for(const endpoint of ['https://testnet.ckb.dev','https://testnet.ckbapp.dev']){
 const owned=ccc.ClientPublicTestnet.open({urls:[endpoint]});
 try{
  const client=owned.value;await assertNetwork(client,deployment);
  const txs=await Promise.all(hashes.map(async hash=>{
   const response=await client.getTransactionNoCache(hash!);assert.equal(response?.status,'committed');
   assert.equal(response!.transaction.hash(),hash);return response!.transaction;
  }));
  const [created,fill,createdCancel,cancel]=txs as [ccc.Transaction,ccc.Transaction,ccc.Transaction,ccc.Transaction];
  const orderFrom=(tx:ccc.Transaction)=>{
   const indexes=tx.outputs.flatMap((out,i)=>out.lock.codeHash===deployment.codeHash&&out.lock.hashType==='data1'?[i]:[]);
   assert.equal(indexes.length,1,'Acceptance recipe requires exactly one lot per creation');
   const index=indexes[0]!,output=tx.outputs[index]!;
   return {index,output,terms:decodeTerms(output.lock.args),point:ccc.OutPoint.from({txHash:tx.hash(),index})};
  };
  const traded=orderFrom(created),rescued=orderFrom(createdCancel);
  assert(traded.terms.ownerLock.eq(rescued.terms.ownerLock),'Both creations must use wallet A');
  const owner=traded.terms.ownerLock,joyid=await client.getKnownScript(ccc.KnownScript.JoyId);
  assert.equal(owner.codeHash,joyid.codeHash,'Maker must use JoyID for this acceptance check');assert.equal(owner.hashType,joyid.hashType);
  for(const tx of [fill,cancel])assert(tx.cellDeps.some(dep=>dep.outPoint.eq(deployment.cellDep.outPoint)),'Deployment dependency missing');
  const fillIndex=fill.inputs.findIndex(input=>input.previousOutput.eq(traded.point));assert(fillIndex>=0,'Fill does not consume the supplied order');
  const expected=payment(traded.terms);
  assert.equal(ccc.hexFrom(fill.outputs[fillIndex]!.toBytes()),ccc.hexFrom(expected.cellOutput.toBytes()));
  assert.equal(fill.outputsData[fillIndex],expected.outputData);
  assert(!fill.outputs.some(output=>output.lock.eq(traded.output.lock)),'Order recreated');
  const balances=new Map<string,bigint>(),funders=new Set<string>();
  const tally=(type:ccc.Script|undefined,data:ccc.Hex,sign:bigint)=>{
   if(type)balances.set(type.hash(),(balances.get(type.hash())??0n)+sign*parseAmount(data));
  };
  for(let i=0;i<fill.inputs.length;i++){
   const cell=await fill.inputs[i]!.getCell(client);tally(cell.cellOutput.type,cell.outputData,1n);
   if(i===fillIndex)continue;
   assert.notEqual(cell.cellOutput.lock.codeHash,deployment.codeHash,'Use a single-order fill for acceptance');
   assert(!cell.cellOutput.lock.eq(owner),'Maker funding in fill: cannot establish a separate taker');
   funders.add(cell.cellOutput.lock.hash());
  }
  assert(funders.size>0,'Separate taker funding required');
  fill.outputs.forEach((output,i)=>tally(output.type,fill.outputsData[i]!,-1n));
  assert(balances.size>0,'Use a CKB/token or token/token trade');
  for(const balance of balances.values())assert.equal(balance,0n,'Token totals differ');
  const cancelIndex=cancel.inputs.findIndex(input=>input.previousOutput.eq(rescued.point));assert(cancelIndex>=0);
  const recovery=cancel.outputs[cancelIndex]!;
  assert(recovery.lock.eq(owner));assert.equal(recovery.type?.hash(),rescued.output.type?.hash());
  assert.equal(cancel.outputsData[cancelIndex],createdCancel.outputsData[rescued.index]);assert(recovery.capacity>=rescued.output.capacity);
  let proofIndex=-1;
  for(let i=0;i<cancel.inputs.length;i++){
   if(i===cancelIndex)continue;
   const before=await cancel.inputs[i]!.getCell(client),after=cancel.outputs[i];
   if(after&&before.cellOutput.lock.eq(owner)&&after.lock.eq(owner)&&!before.cellOutput.type&&!after.type&&before.outputData==='0x'&&cancel.outputsData[i]==='0x'&&after.capacity<before.cellOutput.capacity){proofIndex=i;break;}
  }
  assert(proofIndex>=0,'Separate indexed owner capacity-decrease proof missing');
  for(const order of [traded,rescued])assert.equal(await client.getCellLive(order.point,true),undefined,'Order is still live');
  checks.push({endpoint,makerLockHash:owner.hash(),takerFundingLockHashes:[...funders].sort(),fillIndex,cancelIndex,ownerProofIndex:proofIndex,indexedMakerPayment:true,tokenConservation:true,distinctTakerFunding:true,ownerCancellation:true,ordersSpent:true,feesShannon:await Promise.all(txs.map(async tx=>(await tx.getFee(client)).toString()))});
 }finally{await owned.dispose();}
}
assert.deepEqual({...checks[0],endpoint:undefined},{...checks[1],endpoint:undefined},'Nodes disagree');
const report={network:'testnet',verifiedAt:new Date().toISOString(),originAcceptance:'Requires separate human confirmation of toastdex.org; transaction data cannot establish browser origin or passkey UX.',hashes:{createFillHash,fillHash,createCancelHash,cancelHash},checks};
await writeFile(new URL('../deployments/public-wallet-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
