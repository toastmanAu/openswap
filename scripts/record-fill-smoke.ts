#!/usr/bin/env -S npx tsx
import {ccc} from '@ckb-ccc/shell';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {assertNetwork,decodeTerms,parseAmount,payment,type Deployment} from '../sdk/src/index.js';
const [createHash,fillHash]=process.argv.slice(2);
for(const hash of [createHash,fillHash])assert.match(hash??'',/^0x[0-9a-fA-F]{64}$/,'Supply create and fill transaction hashes');
const deployment=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
const checks=[];
for(const endpoint of ['https://testnet.ckb.dev','https://testnet.ckbapp.dev']){
  const owned=ccc.ClientPublicTestnet.open({urls:[endpoint]});
  try{
    const client=owned.value;await assertNetwork(client,deployment);
    const [created,filled]=await Promise.all([client.getTransaction(createHash!),client.getTransaction(fillHash!)]);
    assert.equal(created?.status,'committed');assert.equal(filled?.status,'committed');
    const create=created!.transaction,fill=filled!.transaction;assert.equal(create.hash(),createHash);assert.equal(fill.hash(),fillHash);
    assert(fill.cellDeps.some(dep=>dep.outPoint.eq(deployment.cellDep.outPoint)));
    const indexes=[];
    for(const index of [0,1]){
      const output=create.outputs[index]!;
      assert.equal(output.lock.codeHash,deployment.codeHash);assert.equal(output.lock.hashType,'data1');
      const point=ccc.OutPoint.from({txHash:createHash!,index});
      const i=fill.inputs.findIndex(input=>input.previousOutput.eq(point));assert(i>=0);
      const expected=payment(decodeTerms(output.lock.args));
      assert.equal(ccc.hexFrom(fill.outputs[i]!.toBytes()),ccc.hexFrom(expected.cellOutput.toBytes()));
      assert.equal(fill.outputsData[i],expected.outputData);
      assert.equal(await client.getCellLive(point,true),undefined);
      assert(!fill.outputs.some(o=>o.lock.eq(output.lock)));indexes.push(i);
    }
    const balances=new Map<string,bigint>();
    const add=(type:ccc.Script|undefined,data:ccc.Hex,sign:bigint)=>{if(type)balances.set(type.hash(),(balances.get(type.hash())??0n)+sign*parseAmount(data));};
    for(const input of fill.inputs){const cell=await input.getCell(client);add(cell.cellOutput.type,cell.outputData,1n);}
    fill.outputs.forEach((out,i)=>add(out.type,fill.outputsData[i]!,-1n));
    assert(balances.size>0);for(const balance of balances.values())assert.equal(balance,0n,'Token conservation mismatch');
    checks.push({endpoint,createHash,fillHash,orderInputIndexes:indexes,tokenConservation:true,createFeeShannon:(await create.getFee(client)).toString(),fillFeeShannon:(await fill.getFee(client)).toString(),status:'committed'});
  }finally{await owned.dispose();}
}
assert.deepEqual({...checks[0],endpoint:undefined},{...checks[1],endpoint:undefined});
const report={network:'testnet',verifiedAt:new Date().toISOString(),checks};
await writeFile(new URL('../deployments/fill-smoke-result.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
