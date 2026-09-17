#!/usr/bin/env -S npx tsx
// Read-only verification of a committed create/cancel pair on two testnet nodes.
import { ccc } from '@ckb-ccc/shell';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { assertNetwork, decodeTerms, type Deployment } from '../sdk/src/index.js';
const [createHash,cancelHash]=process.argv.slice(2);
for (const hash of [createHash,cancelHash]) assert.match(hash ?? '',/^0x[0-9a-fA-F]{64}$/,'Supply create and cancel transaction hashes');
const deployment=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
const endpoints=['https://testnet.ckb.dev','https://testnet.ckbapp.dev'];
const checks=[];
for (const endpoint of endpoints) {
  const owned=ccc.ClientPublicTestnet.open({urls:[endpoint]});
  try {
    const client=owned.value;
    await assertNetwork(client,deployment);
    const [created,cancelled]=await Promise.all([client.getTransaction(createHash!),client.getTransaction(cancelHash!)]);
    assert.equal(created?.status,'committed'); assert.equal(cancelled?.status,'committed');
    const create=created!.transaction,cancel=cancelled!.transaction;
    assert.equal(create.hash(),createHash); assert.equal(cancel.hash(),cancelHash);
    const order=create.outputs[0]!;
    assert.equal(order.lock.codeHash,deployment.codeHash); assert.equal(order.lock.hashType,'data1');
    const terms=decodeTerms(order.lock.args);
    const expectedOwner=await ccc.Address.fromString('ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq',client);
    assert(terms.ownerLock.eq(expectedOwner.script));
    const known=await client.getKnownScript(ccc.KnownScript.JoyId);
    assert.equal(terms.ownerLock.codeHash,known.codeHash); assert.equal(terms.ownerLock.hashType,known.hashType);
    const point=ccc.OutPoint.from({txHash:createHash!,index:0});
    const i=cancel.inputs.findIndex(input=>input.previousOutput.eq(point)); assert(i>=0,'Cancellation must consume created order');
    const recovery=cancel.outputs[i]!;
    assert(recovery.lock.eq(terms.ownerLock));
    assert.equal(recovery.type?.hash(),order.type?.hash());
    assert.equal(cancel.outputsData[i],create.outputsData[0]);
    assert(recovery.capacity>=order.capacity);
    assert.equal(await client.getCellLive(point,true),undefined,'Order must be spent');
    assert(cancel.cellDeps.some(dep=>dep.outPoint.eq(deployment.cellDep.outPoint)),'Deployed contract dependency missing');
    let proofIndex=-1,proofDecrease=0n;
    for(let j=0;j<cancel.inputs.length;j++) {
      if(j===i) continue;
      const input=await cancel.inputs[j]!.getCell(client),output=cancel.outputs[j];
      if(output && input.cellOutput.lock.eq(terms.ownerLock) && output.lock.eq(terms.ownerLock) && !input.cellOutput.type && !output.type && input.outputData==='0x' && cancel.outputsData[j]==='0x' && output.capacity<input.cellOutput.capacity) {
        proofIndex=j; proofDecrease=input.cellOutput.capacity-output.capacity; break;
      }
    }
    assert(proofIndex>=0,'Separate same-index owner capacity-decrease proof missing');
    checks.push({endpoint,createHash,cancelHash,orderInputIndex:i,ownerProofIndex:proofIndex,orderCapacityShannon:order.capacity.toString(),recoveredCapacityShannon:recovery.capacity.toString(),proofDecreaseShannon:proofDecrease.toString(),createFeeShannon:(await create.getFee(client)).toString(),cancelFeeShannon:(await cancel.getFee(client)).toString(),status:'committed'});
  } finally {await owned.dispose();}
}
assert.deepEqual({...checks[0],endpoint:undefined},{...checks[1],endpoint:undefined},'Nodes disagree');
const report={network:'testnet',verifiedAt:new Date().toISOString(),deploymentTxHash:deployment.cellDep.outPoint.txHash,checks};
await writeFile(new URL('../deployments/joyid-smoke-result.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
