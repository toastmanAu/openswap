// OpenSwap live JoyID cancellation test. Creates one tiny lot, then cancels it.
import { ccc } from '@ckb-ccc/ccc';
import { signer, client, render } from '@ckb-ccc/playground';
import { CKB, udt, createOrder, cancelOrders, submit, defaultResolver, parse, type Deployment } from '../sdk/src/index.js';
import deploymentJson from '../deployments/testnet.json';
const deployment = deploymentJson as Deployment;
const expectedAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq';
// To resume after create succeeds but cancellation is interrupted, paste CREATE TX HASH here.
const resumeCreateTxHash = '';
if (client.addressPrefix !== 'ckt') throw new Error('Select Testnet');
const owner = await ccc.Address.fromString(expectedAddress,client);
if (!(await signer.getAddressObjs()).some(a=>a.script.eq(owner.script))) throw new Error('Connect the replacement JoyID account ending svl02uvq');
console.log('OPENSWAP JOYID CREATE/CANCEL TEST — two wallet signatures, testnet only');
let createHash: ccc.Hex;
if (resumeCreateTxHash) createHash = ccc.hexFrom(resumeCreateTxHash);
else {
  // An unissued canonical xUDT avoids trading against an existing market.
  const askScript = await ccc.Script.fromKnownScript(client,ccc.KnownScript.XUdt,ccc.hashCkb(crypto.getRandomValues(new Uint8Array(32))));
  const created = await createOrder({ signer, deployment },{offerAsset:CKB,askAsset:udt(askScript),lots:[{offerAmount:1n,askAmount:1n}]});
  console.log('Order capacity temporarily locked (CKB):',ccc.fixedPointToString(created.tx.outputs[0]!.capacity));
  console.log('Create network fee (CKB):',ccc.fixedPointToString(await created.tx.getFee(client)));
  await render(created.tx);
  console.log('REQUESTING CREATE SIGNATURE');
  createHash = await submit(created,signer);
  console.log('CREATE TX HASH:',createHash);
  await client.waitTransaction(createHash,1);
}
const point = ccc.OutPoint.from({txHash:createHash,index:0});
const live = await client.getCellLive(point,true);
if (!live) throw new Error('Created order is not live; check whether it was already cancelled');
const order = await parse(live,deployment,defaultResolver(client));
if (!order.ownerLock.eq(owner.script)) throw new Error('Resume transaction belongs to another owner');
const cancelled = await cancelOrders({signer,deployment},[point]);
console.log('Cancel network fee (CKB):',ccc.fixedPointToString(await cancelled.tx.getFee(client)));
await render(cancelled.tx);
console.log('REQUESTING CANCEL SIGNATURE');
const cancelHash = await submit(cancelled,signer);
console.log('CANCEL TX HASH:',cancelHash);
await client.waitTransaction(cancelHash,1);
if (await client.getCellLive(point,true)) throw new Error('Order is unexpectedly still live');
console.log('JOYID CREATE/CANCEL COMMITTED:',createHash,cancelHash);
