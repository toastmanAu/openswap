import {ccc} from '@ckb-ccc/shell';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {assertNetwork,decodeTerms,payment,parseAmount,type Deployment} from '../sdk/src/index.js';
const journal=JSON.parse(await readFile(new URL('../deployments/solver-integration-result.json',import.meta.url),'utf8'));
const deployment=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
const config=JSON.parse(await readFile(new URL('../deployments/solver-wallet.json',import.meta.url),'utf8'));
const solverLock=ccc.Script.from(config.lock),checks=[];
for(const endpoint of ['https://testnet.ckb.dev','https://testnet.ckbapp.dev']){
 const owned=ccc.ClientPublicTestnet.open({urls:[endpoint]});
 try{
  const client=owned.value;await assertNetwork(client,deployment);
  const transactions=new Map<string,ccc.Transaction>();let fees=0n;
  for(const name of ['setupHash','secpCreate','secpCancel','reciprocalCreate','solverFill']){
   assert.match(journal[name]??'',/^0x[0-9a-fA-F]{64}$/);
   const response=await client.getTransaction(journal[name]);assert.equal(response?.status,'committed');
   const tx=response!.transaction;assert.equal(tx.hash(),journal[name]);transactions.set(name,tx);fees+=await tx.getFee(client);
  }
  const created=transactions.get('secpCreate')!,cancel=transactions.get('secpCancel')!;
  assert.equal(created.outputs[0]!.lock.codeHash,deployment.codeHash);assert.equal(created.outputs[0]!.lock.hashType,'data1');
  assert(decodeTerms(created.outputs[0]!.lock.args).ownerLock.eq(solverLock));
  const point=ccc.OutPoint.from({txHash:journal.secpCreate,index:0});
  const index=cancel.inputs.findIndex(i=>i.previousOutput.eq(point));assert(index>=0);
  assert(cancel.outputs[index]!.lock.eq(solverLock));assert.equal(cancel.outputs[index]!.type?.hash(),created.outputs[0]!.type?.hash());
  assert.equal(cancel.outputsData[index],created.outputsData[0]);assert(cancel.outputs[index]!.capacity>=created.outputs[0]!.capacity);
  let proof=false;
  for(let i=0;i<cancel.inputs.length;i++){
   if(i===index)continue;const before=await cancel.inputs[i]!.getCell(client),after=cancel.outputs[i];
   if(after&&before.cellOutput.lock.eq(solverLock)&&after.lock.eq(solverLock)&&!before.cellOutput.type&&!after.type&&before.outputData==='0x'&&cancel.outputsData[i]==='0x'&&after.capacity<before.cellOutput.capacity)proof=true;
  }
  assert(proof);assert.equal(await client.getCellLive(point,true),undefined);
  const fill=transactions.get('solverFill')!,setup=transactions.get('setupHash')!;
  const maker=decodeTerms(setup.outputs[0]!.lock.args).ownerLock;assert(!maker.eq(solverLock));
  const token=await ccc.Script.fromKnownScript(client,ccc.KnownScript.XUdt,maker.hash());
  const balances=new Map<string,bigint>();let orderCount=0;
  const add=(type:ccc.Script|undefined,data:ccc.Hex,sign:bigint)=>{if(type)balances.set(type.hash(),(balances.get(type.hash())??0n)+sign*parseAmount(data));};
  for(let i=0;i<fill.inputs.length;i++){
   const cell=await fill.inputs[i]!.getCell(client);
   assert(!cell.cellOutput.lock.eq(maker),'Issuer input bypasses non-owner conservation');add(cell.cellOutput.type,cell.outputData,1n);
   if(cell.cellOutput.lock.codeHash===deployment.codeHash){
    assert.equal(cell.cellOutput.lock.hashType,'data1');orderCount++;
    const expected=payment(decodeTerms(cell.cellOutput.lock.args));
    assert.equal(ccc.hexFrom(fill.outputs[i]!.toBytes()),ccc.hexFrom(expected.cellOutput.toBytes()));assert.equal(fill.outputsData[i],expected.outputData);
    assert(!fill.outputs.some(o=>o.lock.eq(cell.cellOutput.lock)));assert.equal(await client.getCellLive(cell.outPoint,true),undefined);
   }
  }
  assert.equal(orderCount,2);
  for(const txHash of [journal.setupHash,journal.reciprocalCreate])assert(fill.inputs.some(i=>i.previousOutput.eq({txHash,index:0})));
  fill.outputs.forEach((out,i)=>add(out.type,fill.outputsData[i]!,-1n));assert(balances.has(token.hash()));for(const balance of balances.values())assert.equal(balance,0n);
  assert(fill.cellDeps.some(d=>d.outPoint.eq(deployment.cellDep.outPoint)));
  checks.push({endpoint,secpCancellation:true,distinctMakerAndSolver:true,issuerInputAbsent:true,tokenConservation:true,filledOrders:orderCount,totalScenarioFeeShannon:fees.toString()});
 }finally{await owned.dispose();}
}
assert.deepEqual({...checks[0],endpoint:undefined},{...checks[1],endpoint:undefined});
const report={verifiedAt:new Date().toISOString(),transactions:journal,checks};
await writeFile(new URL('../deployments/solver-integration-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
