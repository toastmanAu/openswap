// No signing or broadcasting. Checks SDK create completion against real testnet cells.
import {ccc} from '@ckb-ccc/shell';
import {readFile} from 'node:fs/promises';
import {buildSolverSetup} from './lib/solver-setup.js';
import {createOrder,CKB,udt,amountData,type Deployment} from '../sdk/src/index.js';
const deployment=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
const owned=ccc.ClientPublicTestnet.open({urls:[process.env.CKB_RPC_URL ?? 'https://testnet.ckb.dev']});
try {
  const client=owned.value;
  const address=await ccc.Address.fromString('ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq',client);
  class ReadOnly extends ccc.SignerDummy {
    constructor(){super(client,ccc.SignerType.CKB);}
    async connect(){}
    async getInternalAddress(){return address.toString();}
    async getAddressObjs(){return [address];}
    async prepareTransaction(txLike: ccc.TransactionLike){const tx=ccc.Transaction.from(txLike);await tx.addCellDepsOfKnownScripts(client,ccc.KnownScript.JoyId);await tx.prepareSighashAllWitness(address.script,1000,client);return tx;}
  }
  const signer=new ReadOnly();
  const solverConfig=JSON.parse(await readFile(new URL('../deployments/solver-wallet.json',import.meta.url),'utf8'));
  const setup=await buildSolverSetup({signer,deployment},ccc.Script.from(solverConfig.lock));
  setup.assertLayout();setup.assertLayout(await signer.prepareTransaction(setup.tx.clone()));
  console.log('Separate solver setup verified; no signing or broadcast.');
  console.log('Solver token storage CKB:',ccc.fixedPointToString(setup.tx.outputs[2]!.capacity));
  console.log('Solver setup fee CKB:',ccc.fixedPointToString(await setup.tx.getFee(client)));
  const ask=await ccc.Script.fromKnownScript(client,ccc.KnownScript.XUdt,ccc.hashCkb(crypto.getRandomValues(new Uint8Array(32))));
  const built=await createOrder({signer,deployment},{offerAsset:CKB,askAsset:udt(ask),lots:[{offerAmount:1n,askAmount:1n}]});
  built.assertLayout();built.assertLayout(await signer.prepareTransaction(built.tx.clone()));
  const mintToken=await ccc.Script.fromKnownScript(client,ccc.KnownScript.XUdt,address.script.hash());
  const mint=ccc.Transaction.from({});
  mint.addOutput({lock:address.script,type:mintToken},amountData(1000n));
  await mint.addCellDepsOfKnownScripts(client,ccc.KnownScript.XUdt);
  await mint.completeInputsByCapacity(signer);await mint.completeFeeBy(signer);
  const mintFee=await mint.getFee(client);
  if(mintFee<0n||mintFee>100000000n)throw new Error('Mint fee invalid');
  if(!mint.outputs[0]!.lock.eq(address.script)||!mint.outputs[0]!.type?.eq(mintToken)||mint.outputsData[0]!==amountData(1000n))throw new Error('Mint output changed');
  console.log('Mint token storage CKB:',ccc.fixedPointToString(mint.outputs[0]!.capacity));
  console.log('Mint estimated fee CKB:',ccc.fixedPointToString(mintFee));
  console.log('Live mint/create completion verified; nothing signed or broadcast.');
  console.log('Order capacity CKB:',ccc.fixedPointToString(built.tx.outputs[0]!.capacity));
  console.log('Estimated fee CKB:',ccc.fixedPointToString(await built.tx.getFee(client)));
} finally {await owned.dispose();}
