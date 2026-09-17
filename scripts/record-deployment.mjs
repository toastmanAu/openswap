#!/usr/bin/env node
// Verify the committed, live immutable code cell before publishing a deployment identity.
import { ccc } from '@ckb-ccc/shell';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = process.argv[2];
if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) throw new Error('Usage: npm run deploy:record -- <committed-tx-hash>');
const expected = JSON.parse(await readFile(path.join(root,'docs/binary-identity.json'),'utf8'));
const owned = ccc.ClientPublicTestnet.open({urls:[process.env.CKB_RPC_URL ?? 'https://testnet.ckb.dev']});
try {
  const client = owned.value;
  const genesisHash = (await client.getHeaderByNumber(0))?.hash;
  if (genesisHash !== '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606') throw new Error('Wrong network');
  const response = await client.getTransaction(hash);
  if (response?.status !== 'committed') throw new Error('Deployment is not committed');
  const outPoint = {txHash:hash,index:'0x0'};
  const live = await client.getCellLive(outPoint,true);
  if (!live || ccc.hashCkb(live.outputData) !== expected.codeHash) throw new Error('Live code cell does not match measured binary');
  const lock = live.cellOutput.lock;
  if (lock.codeHash !== '0x'+'00'.repeat(32) || lock.hashType !== 'data1' || lock.args !== '0x' || live.cellOutput.type) throw new Error('Code cell is not the immutable deployment');
  const deployment = {network:'testnet',genesisHash,codeHash:expected.codeHash,hashType:'data1',cellDep:{outPoint,depType:'code'},binarySha256:expected.sha256,binaryBytes:expected.bytes};
  await writeFile(path.join(root,'deployments/testnet.json'),JSON.stringify(deployment,null,2)+'\n');
  console.log(JSON.stringify(deployment,null,2));
} finally { await owned.dispose(); }
