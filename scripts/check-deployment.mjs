#!/usr/bin/env node
// Validate the prepared transaction and exercise the generated wallet script
// through the last pre-signing step. This tool cannot sign or broadcast.
import { ccc } from '@ckb-ccc/shell';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const summary = JSON.parse(await readFile(new URL('../deployments/testnet-candidate.json', import.meta.url),'utf8'));
const tx = ccc.Transaction.from(JSON.parse(await readFile(new URL('../deployments/testnet-unsigned.json', import.meta.url),'utf8')));
const source = await readFile(new URL('../deployments/deploy-testnet.playground.ts',import.meta.url),'utf8');
const owned = ccc.ClientPublicTestnet.open({urls:[process.env.CKB_RPC_URL ?? summary.rpc]});
try {
  const client = owned.value;
  const address = await ccc.Address.fromString(summary.fundingAddress,client);
  const joy = await client.getKnownScript(ccc.KnownScript.JoyId);
  const kind = address.script.codeHash === joy.codeHash ? ccc.KnownScript.JoyId : ccc.KnownScript.Secp256k1Blake160;
  assert.equal((await client.getHeaderByNumber(0))?.hash,summary.genesisHash);
  assert.equal(tx.hash(),summary.unsignedTxHash);
  assert.equal(ccc.hashCkb(tx.outputsData[0]),summary.codeHash);
  assert.equal(tx.outputs[0].capacity.toString(),summary.codeCellCapacity);
  assert.equal((await tx.getFee(client)).toString(),summary.estimatedFee);
  assert.equal(tx.outputs[0].lock.codeHash,'0x'+'00'.repeat(32));
  assert.equal(tx.outputs[0].lock.hashType,'data1');
  assert.equal(tx.outputs[0].lock.args,'0x');
  for (let i=0;i<tx.outputs.length;i++) {
    assert.equal(tx.outputs[i].type,undefined);
    assert(tx.outputs[i].capacity >= ccc.CellOutput.from({lock:tx.outputs[i].lock},tx.outputsData[i]).capacity);
    if (i>0) assert(tx.outputs[i].lock.eq(address.script));
  }
  for (const input of tx.inputs) {
    const live = await client.getCellLive(input.previousOutput,true);
    assert(live?.cellOutput.lock.eq(address.script));
    assert.equal(live.cellOutput.type,undefined);
    assert.equal(live.outputData,'0x');
  }
  const stop = new Error('Reached wallet signing boundary');
  let reached = false;
  class ReadOnlyWallet extends ccc.SignerDummy {
    constructor() { super(client,ccc.SignerType.CKB); }
    async getAddressObjs() { return [address]; }
    async getInternalAddress() { return summary.fundingAddress; }
    async prepareTransaction(txLike) {
      const prepared = ccc.Transaction.from(txLike);
      await prepared.addCellDepsOfKnownScripts(client,kind);
      const index = await prepared.findInputIndexByLock(address.script,client);
      const witness = prepared.getWitnessArgs(index) ?? ccc.WitnessArgs.from({});
      witness.lock = ccc.hexFrom(new Uint8Array(kind === ccc.KnownScript.JoyId ? 1000 : 65));
      prepared.setWitnessArgs(index,witness);
      return prepared;
    }
    async sendTransaction(prepared) {
      assert.equal(ccc.hashCkb(prepared.outputsData[0]),summary.codeHash);
      assert(prepared.outputs[1].lock.eq(address.script));
      reached = true;
      throw stop;
    }
  }
  const body = source.split('\n').filter(line=>!line.startsWith('import ')).join('\n');
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  try { await new AsyncFunction('ccc','render','signer','client',body)(ccc,async()=>{},new ReadOnlyWallet(),client); }
  catch (error) { if (error !== stop) throw error; }
  assert(reached);
  console.log('Candidate and generated wallet script verified through signing boundary. Nothing was signed or broadcast.');
} finally { await owned.dispose(); }
