// Testnet only: mint a wallet-owned xUDT, create two CKB lots, and fill both.
import {ccc} from '@ckb-ccc/ccc';
import {signer,client,render} from '@ckb-ccc/playground';
import {CKB,udt,amountData,assertNetwork,createOrder,fillOrders,submit,type Deployment,type BuiltTransaction} from '../sdk/src/index.js';
import deploymentJson from '../deployments/testnet.json';
const deployment=deploymentJson as Deployment;
// If interrupted, copy printed hashes here to skip completed steps.
const resumeMintTxHash='';
const resumeCreateTxHash='';
await assertNetwork(client,deployment);
const owner=await ccc.Address.fromString('ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq',client);
if(!(await signer.getAddressObjs()).some(a=>a.script.eq(owner.script))) throw new Error('Connect JoyID wallet ending svl02uvq');
const token=await ccc.Script.fromKnownScript(client,ccc.KnownScript.XUdt,owner.script.hash());
console.log('OPENSWAP JOYID TWO-LOT FILL TEST — up to three wallet signatures');
console.log('Test xUDT:',token);
if(!resumeMintTxHash && !resumeCreateTxHash){
  const tx=ccc.Transaction.from({});
  tx.addOutput({lock:owner.script,type:token},amountData(1000n));
  await tx.addCellDepsOfKnownScripts(client,ccc.KnownScript.XUdt);
  await tx.completeInputsByCapacity(signer);await tx.completeFeeBy(signer);
  if(!tx.outputs[0]?.lock.eq(owner.script)||!tx.outputs[0]?.type?.eq(token)||tx.outputsData[0]!==amountData(1000n))throw new Error('Mint output changed');
  let authorized=false;
  for(const input of tx.inputs) if((await input.getCell(client)).cellOutput.lock.eq(owner.script))authorized=true;
  if(!authorized)throw new Error('Mint needs the token owner input');
  const fee=await tx.getFee(client);if(fee<0n||fee>100000000n)throw new Error('Mint fee exceeds 1 CKB');
  const expected=tx.hash();
  const built:BuiltTransaction={tx,deployment,assertLayout(candidate=tx){if(candidate.hash()!==expected)throw new Error('Mint transaction changed');}};
  console.log('Mint token-cell capacity CKB:',ccc.fixedPointToString(tx.outputs[0]!.capacity));
  console.log('Mint fee CKB:',ccc.fixedPointToString(fee));await render(tx);
  console.log('REQUESTING MINT SIGNATURE');const hash=await submit(built,signer);console.log('MINT TX HASH:',hash);await client.waitTransaction(hash,1);
}else if(resumeMintTxHash){
  const mint=await client.getTransaction(resumeMintTxHash);
  if(mint?.status!=='committed'||!mint.transaction.outputs.some(o=>o.lock.eq(owner.script)&&o.type?.eq(token)))throw new Error('Resume mint does not match this wallet and token');
}
let createHash:ccc.Hex;
if(resumeCreateTxHash){
  const created=await client.getTransaction(resumeCreateTxHash);if(created?.status!=='committed')throw new Error('Resume create is not committed');
  createHash=ccc.hexFrom(resumeCreateTxHash);
}else{
  const built=await createOrder({signer,deployment},{offerAsset:CKB,askAsset:udt(token),lots:[{offerAmount:1n,askAmount:1n},{offerAmount:2n,askAmount:2n}]});
  console.log('Order storage CKB:',ccc.fixedPointToString(built.tx.outputs[0]!.capacity+built.tx.outputs[1]!.capacity));
  console.log('Create fee CKB:',ccc.fixedPointToString(await built.tx.getFee(client)));await render(built.tx);
  console.log('REQUESTING CREATE SIGNATURE');createHash=await submit(built,signer);console.log('FILL CREATE TX HASH:',createHash);await client.waitTransaction(createHash,1);
}
const points=[0,1].map(index=>ccc.OutPoint.from({txHash:createHash,index}));
// Refuse unrelated resumed orders before any signature request.
const created=(await client.getTransaction(createHash))!.transaction;
for(const index of [0,1]){
  const output=created.outputs[index];
  if(!output||output.lock.codeHash!==deployment.codeHash||output.lock.hashType!=='data1')throw new Error('Resume transaction does not contain the expected orders');
}
const filled=await fillOrders({signer,deployment},points);
for(const i of [0,1]){
  if(!filled.tx.outputs[i]!.lock.eq(owner.script)||!filled.tx.outputs[i]!.type?.eq(token)||filled.tx.outputsData[i]!==amountData(BigInt(i+1)))throw new Error('Maker payment mismatch');
}
console.log('Fill fee CKB:',ccc.fixedPointToString(await filled.tx.getFee(client)));await render(filled.tx);
console.log('REQUESTING FILL SIGNATURE');const fillHash=await submit(filled,signer);console.log('FILL TX HASH:',fillHash);await client.waitTransaction(fillHash,1);
for(const point of points)if(await client.getCellLive(point,true))throw new Error('Filled order still live');
console.log('JOYID TWO-LOT FILL COMMITTED:',createHash,fillHash);
