#!/usr/bin/env -S npx tsx
// Order lock v2 code deployment (docs/research/ORDER_LOCK_V2.md step 6). TESTNET ONLY.
//   balances        plain CKB of the local test wallets (no keys printed)
//   prepare [key]   dry run: build and check the deployment transaction, sign nothing
//   send [key]      build, sign with .local/<key>, send and wait for commitment
//   record <tx>     verify the immutable code cell through both endpoints, then write
//                   deployments/testnet-v2.json
import {ccc} from '@ckb-ccc/core';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {ENDPOINTS,GENESIS,IMMUTABLE_LOCK} from './lib/pool-live.js';

/** Pinned in docs/research/ORDER_LOCK_V2.md and the v2 tests. */
const LOCK_V2={codeHash:'0x71027f76a5667e2b7c3294164e3171e582f4ffb17eea445a534b257bba5b3ede' as ccc.Hex,bytes:30000};
const V1=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8'));
const KEYS=['testnet-solver-key','testnet-race-key','testnet-contention-key','testnet-split-maker-key','testnet-pool-issuer-key','testnet-token-test2-key','testnet-token-test3-key'];
const MAX_FEE=ccc.fixedPointFrom('1');

const [command,argument]=process.argv.slice(2);
const binary=await readFile(new URL('../target/riscv64imac-unknown-none-elf/release/openswap-lock-v2',import.meta.url));
const sha256=createHash('sha256').update(binary).digest('hex');
assert(binary.length===LOCK_V2.bytes&&ccc.hashCkb(binary)===LOCK_V2.codeHash,'Lock v2 binary differs from the pinned artifact; run scripts/build-lock-v2.sh');

const open=(url:string)=>new ccc.ClientPublicTestnet({url});
const signerFor=async(client:ccc.Client,name:string)=>{
 assert(KEYS.includes(name),`Unknown key ${name}; expected one of ${KEYS.join(', ')}`);
 return new ccc.SignerCkbPrivateKey(client,(await readFile(new URL(`../.local/${name}`,import.meta.url),'utf8')).trim());
};
async function plain(client:ccc.Client,lock:ccc.Script){
 let total=0n,cells=0;
 for await(const cell of client.findCells({script:lock,scriptType:'lock',scriptSearchMode:'exact',filter:{scriptLenRange:[0,1],outputDataLenRange:[0,1]}})){total+=cell.cellOutput.capacity;cells++;}
 return {total,cells};
}
async function build(client:ccc.Client,signer:ccc.SignerCkbPrivateKey){
 assert.equal((await client.getHeaderByNumber(0))?.hash,GENESIS,'Not CKB testnet');
 const owner=(await signer.getRecommendedAddressObj()).script;
 const data=ccc.hexFrom(binary);
 const tx=ccc.Transaction.from({outputs:[ccc.CellOutput.from({lock:IMMUTABLE_LOCK},data)],outputsData:[data]});
 await tx.completeInputsByCapacity(signer);
 await tx.completeFeeBy(signer,1000);
 assert(tx.outputs[0]!.lock.eq(IMMUTABLE_LOCK)&&!tx.outputs[0]!.type&&ccc.hashCkb(tx.outputsData[0]!)===LOCK_V2.codeHash,'Code output changed');
 for(const output of tx.outputs.slice(1))assert(output.lock.eq(owner)&&!output.type,'Unexpected change destination');
 for(const input of tx.inputs){const cell=await input.getCell(client);assert(cell.cellOutput.lock.eq(owner)&&!cell.cellOutput.type,'Unexpected input');}
 const fee=await tx.getFee(client);
 assert(fee>0n&&fee<=MAX_FEE,'Fee exceeds 1 CKB ceiling');
 return {tx,fee,owner};
}
function describe(tx:ccc.Transaction,fee:bigint,address:string){
 console.log('Deployer (local test key):',address);
 console.log('Inputs:',tx.inputs.length,'plain cells');
 console.log('Code cell: always-fail lock, no type, Data1',LOCK_V2.codeHash);
 console.log('Code storage (PERMANENTLY locked testnet CKB):',ccc.fixedPointToString(tx.outputs[0]!.capacity));
 console.log('Change back to deployer:',ccc.fixedPointToString(tx.outputs.slice(1).reduce((s,o)=>s+o.capacity,0n)));
 console.log('Network fee CKB:',ccc.fixedPointToString(fee),`(${tx.toBytes().length} bytes)`);
}

if(command==='balances'){
 const client=open(ENDPOINTS[0]);
 for(const name of KEYS){
  const signer=await signerFor(client,name);const address=await signer.getRecommendedAddressObj();
  const {total,cells}=await plain(client,address.script);
  console.log(name.padEnd(26),address.toString(),ccc.fixedPointToString(total),'CKB in',cells,'plain cells');
 }
}else if(command==='prepare'||command==='send'){
 const client=open(ENDPOINTS[0]);
 const signer=await signerFor(client,argument??'testnet-solver-key');
 const {tx,fee}=await build(client,signer);
 describe(tx,fee,(await signer.getRecommendedAddressObj()).toString());
 if(command==='prepare'){console.log('Dry run only: nothing signed or sent.');}
 else{
  const txHash=await signer.sendTransaction(tx);
  console.log('LOCK V2 DEPLOYMENT TX HASH:',txHash);
  await client.waitTransaction(txHash,1,600_000);
  console.log('Committed. Record with: npx tsx scripts/lock-v2-deploy.ts record',txHash);
 }
}else if(command==='record'){
 assert(/^0x[0-9a-f]{64}$/.test(argument??''),'Usage: record <committed-deployment-tx-hash>');
 const txHash=argument as ccc.Hex;
 const cellDep={outPoint:{txHash,index:'0x0'},depType:'code' as const};
 let deployer:string|undefined,blockNumber:string|undefined;
 for(const url of ENDPOINTS){
  const client=open(url);
  assert.equal((await client.getHeaderByNumber(0))?.hash,GENESIS,`${url} is not CKB testnet`);
  const response=await client.getTransaction(txHash);
  assert.equal(response?.status,'committed',`Deployment not committed on ${url}`);
  const code=await client.getCellLive({txHash,index:0},true);
  assert(code&&ccc.hashCkb(code.outputData)===LOCK_V2.codeHash&&createHash('sha256').update(ccc.bytesFrom(code.outputData)).digest('hex')===sha256,`Live code cell mismatch on ${url}`);
  assert(code.cellOutput.lock.eq(IMMUTABLE_LOCK)&&!code.cellOutput.type,`Code cell is not immutable on ${url}`);
  const v1=await client.getCellLive(V1.cellDep.outPoint,true);
  assert(v1&&ccc.hashCkb(v1.outputData)===V1.codeHash,`v1 order lock dependency mismatch on ${url}`);
  const funding=await response!.transaction.inputs[0]!.getCell(client);
  deployer??=ccc.Address.fromScript(funding.cellOutput.lock,client).toString();
  blockNumber??=response!.blockNumber?.toString();
 }
 const manifest={network:'testnet',genesisHash:GENESIS,codeHash:LOCK_V2.codeHash,hashType:'data1',cellDep,
  binarySha256:sha256,binaryBytes:binary.length,deployer,blockNumber,v1:{codeHash:V1.codeHash,cellDep:V1.cellDep},verifiedEndpoints:ENDPOINTS,recordedAt:new Date().toISOString()};
 await writeFile(new URL('../deployments/testnet-v2.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify(manifest,null,2));
}else throw new Error('Usage: lock-v2-deploy.ts balances | prepare [key] | send [key] | record <tx-hash>');
process.exit(0);
