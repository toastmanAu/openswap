#!/usr/bin/env -S npx tsx
// P6 pool code deployment (docs/research/POOL_TESTNET_RUN.md). TESTNET ONLY.
//   prepare      write deployments/pool-deploy.playground.ts for the user's JoyID to sign
//   record <tx>  verify the committed immutable code cell and every pinned dependency
//                through both endpoints, then write deployments/pool-testnet.json
import {ccc} from '@ckb-ccc/shell';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {ENDPOINTS,GENESIS,IMMUTABLE_LOCK,JOYID_PROFILE,POOL_BINARY,XUDT} from './lib/pool-live.js';

const [command,txHash]=process.argv.slice(2);
const binary=await readFile(new URL('../target/riscv64imac-unknown-none-elf/release/openswap-pool',import.meta.url));
assert(binary.length===POOL_BINARY.bytes&&ccc.hashCkb(binary)===POOL_BINARY.codeHash&&createHash('sha256').update(binary).digest('hex')===POOL_BINARY.sha256,
 'Pool binary differs from the pinned artifact; run make pool-build and scripts/check-pool-identity.py');

if(command==='prepare'){
 const script=`// GENERATED OPENSWAP POOL CODE DEPLOYMENT — TESTNET ONLY. Replace all Playground code with this file.
import { ccc } from "@ckb-ccc/ccc";
import { render, signer, client } from "@ckb-ccc/playground";
const GENESIS = ${JSON.stringify(GENESIS)};
const CODE_HASH = ${JSON.stringify(POOL_BINARY.codeHash)};
const JOYID_CODE_HASH = ${JSON.stringify(JOYID_PROFILE.codeHash)};
if (client.addressPrefix !== "ckt" || (await client.getHeaderByNumber(0))?.hash !== GENESIS) throw new Error("Select CKB TESTNET");
const addresses = await signer.getAddressObjs();
if (addresses.length !== 1 || addresses[0].script.codeHash !== JOYID_CODE_HASH || addresses[0].script.hashType !== "type") throw new Error("Connect exactly one JoyID testnet account");
const owner = addresses[0].script;
console.log("Deployer (JoyID):", addresses[0].toString());
const data = ${JSON.stringify(ccc.hexFrom(binary))};
if (ccc.hashCkb(data) !== CODE_HASH) throw new Error("Binary identity mismatch");
const lock = ccc.Script.from({ codeHash: "0x" + "00".repeat(32), hashType: "data1", args: "0x" });
const tx = ccc.Transaction.from({ outputs: [ccc.CellOutput.from({ lock }, data)], outputsData: [data] });
await tx.completeInputsByCapacity(signer);
await tx.completeFeeBy(signer);
if (!tx.outputs[0].lock.eq(lock) || tx.outputs[0].type || ccc.hashCkb(tx.outputsData[0]) !== CODE_HASH) throw new Error("Code output changed");
for (const output of tx.outputs.slice(1)) if (!output.lock.eq(owner) || output.type) throw new Error("Unexpected change destination");
const fee = await tx.getFee(client);
if (fee < 0n || fee > ccc.fixedPointFrom("1")) throw new Error("Fee exceeds 1 CKB ceiling");
console.log("Code storage (PERMANENTLY locked testnet CKB):", ccc.fixedPointToString(tx.outputs[0].capacity));
console.log("Network fee CKB:", ccc.fixedPointToString(fee));
await render(tx);
const txHash = await signer.sendTransaction(tx);
console.log("POOL DEPLOYMENT TX HASH:", txHash);
await client.waitTransaction(txHash, 1);
console.log("Committed. Record with: npm run pool:record --", txHash);
`;
 await writeFile(new URL('../deployments/pool-deploy.playground.ts',import.meta.url),script);
 console.log(`Wrote deployments/pool-deploy.playground.ts (${binary.length} byte pool binary, Data1 ${POOL_BINARY.codeHash}).`);
 console.log('Paste it into the CCC playground on TESTNET with your JoyID connected. It will lock ~42,300 testnet CKB permanently.');
}else if(command==='record'){
 assert(/^0x[0-9a-f]{64}$/.test(txHash??''),'Usage: npm run pool:record -- <committed-deployment-tx-hash>');
 const poolDep={outPoint:{txHash:txHash as ccc.Hex,index:0},depType:'code' as const};
 let deployer:string|undefined;
 for(const url of ENDPOINTS){
  const owned=ccc.ClientPublicTestnet.open({urls:[url]});
  try{
   const client=owned.value;
   assert.equal((await client.getHeaderByNumber(0))?.hash,GENESIS,`${url} is not CKB testnet`);
   const response=await client.getTransaction(txHash!);
   assert.equal(response?.status,'committed',`Deployment not committed on ${url}`);
   const code=await client.getCellLive(poolDep.outPoint,true);
   assert(code&&ccc.hashCkb(code.outputData)===POOL_BINARY.codeHash&&createHash('sha256').update(ccc.bytesFrom(code.outputData)).digest('hex')===POOL_BINARY.sha256,`Live code cell mismatch on ${url}`);
   assert(code.cellOutput.lock.eq(IMMUTABLE_LOCK)&&!code.cellOutput.type,`Code cell is not immutable on ${url}`);
   const xudt=await client.getCellLive(XUDT.dep.outPoint,true);
   assert(xudt&&ccc.hashCkb(xudt.outputData)===XUDT.codeHash,`xUDT dependency mismatch on ${url}`);
   for(const {dep,dataHash} of JOYID_PROFILE.codeDeps){
    const cell=await client.getCellLive(dep.outPoint,true);
    assert(cell&&ccc.hashCkb(cell.outputData)===dataHash,`JoyID dependency ${dep.outPoint.txHash}:${dep.outPoint.index} mismatch on ${url}`);
   }
   const funding=await response!.transaction.inputs[0]!.getCell(client);
   deployer??=ccc.Address.fromScript(funding.cellOutput.lock,client).toString();
  }finally{await owned.dispose();}
 }
 const manifest={network:'testnet',genesisHash:GENESIS,codeHash:POOL_BINARY.codeHash,hashType:'data1',poolDep,tokenDep:XUDT.dep,
  binarySha256:POOL_BINARY.sha256,binaryBytes:POOL_BINARY.bytes,deployer,joyIdProfile:JOYID_PROFILE,verifiedEndpoints:ENDPOINTS,recordedAt:new Date().toISOString()};
 await writeFile(new URL('../deployments/pool-testnet.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify(manifest,null,2));
}else throw new Error('Usage: npm run pool:deploy-prepare | npm run pool:record -- <tx-hash>');
