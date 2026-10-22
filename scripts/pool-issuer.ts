#!/usr/bin/env -S npx tsx
// P6 test-token issuer (docs/research/POOL_TESTNET_RUN.md). TESTNET ONLY.
//   prepare                         create the dedicated issuer key, print its address
//   mint <joyid-address> [--execute] mint the approved test supply once (dry run by default)
// The key stays in ignored .local/testnet-pool-issuer-key and is never printed.
import {ccc} from '@ckb-ccc/shell';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {amountData,parseAmount} from '../sdk/src/codec.js';
import {ENDPOINTS,GENESIS,JOYID_PROFILE,MAX_FEE,MINT_AMOUNT,XUDT,tokenScript} from './lib/pool-live.js';

const keyFile=new URL('../.local/testnet-pool-issuer-key',import.meta.url);
const configFile=new URL('../deployments/pool-issuer.json',import.meta.url);
const resultFile=new URL('../deployments/pool-mint-result.json',import.meta.url);
const [command,recipientText,...flags]=process.argv.slice(2);
for(const flag of flags)assert(flag==='--execute',`Unknown option ${flag}`);
const execute=flags.includes('--execute');

async function open(url:string){
 const owned=ccc.ClientPublicTestnet.open({urls:[url]});
 assert.equal((await owned.value.getHeaderByNumber(0))?.hash,GENESIS,`${url} is not CKB testnet`);
 return owned;
}
const exists=async(url:URL)=>readFile(url,'utf8').then(()=>true,(e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return false;throw e;});

if(command==='prepare'){
 await mkdir(new URL('../.local/',import.meta.url),{recursive:true,mode:0o700});
 try{await writeFile(keyFile,ccc.hexFrom(randomBytes(32)),{flag:'wx',mode:0o600});console.log('Created .local/testnet-pool-issuer-key (owner-only).');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;console.log('Issuer key already exists; reusing it.');}
 const owned=await open(ENDPOINTS[0]);
 try{
  const signer=new ccc.SignerCkbPrivateKey(owned.value,(await readFile(keyFile,'utf8')).trim());
  const address=await signer.getRecommendedAddressObj(),token=tokenScript(address.script.hash());
  await writeFile(configFile,ccc.stringify({network:'testnet',address:address.toString(),lock:address.script,lockHash:address.script.hash(),token,tokenHash:token.hash()})+'\n');
  console.log('Issuer address (fund with ~300 testnet CKB):',address.toString());
  console.log('Test token type hash:',token.hash());
 }finally{await owned.dispose();}
}else if(command==='mint'){
 assert(recipientText?.startsWith('ckt1'),'Usage: npm run pool:mint -- <joyid-testnet-address> [--execute]');
 const config=JSON.parse(await readFile(configFile,'utf8'));
 if(await exists(resultFile))throw new Error('deployments/pool-mint-result.json exists: the approved supply was already minted or is pending. Inspect it; do not mint twice.');
 const [primary,secondary]=[await open(ENDPOINTS[0]),await open(ENDPOINTS[1])];
 try{
  const client=primary.value;
  const signer=new ccc.SignerCkbPrivateKey(client,(await readFile(keyFile,'utf8')).trim());
  const issuer=await signer.getRecommendedAddressObj();
  assert.equal(issuer.toString(),config.address,'Issuer key does not match deployments/pool-issuer.json');
  const recipient=await ccc.Address.fromString(recipientText!,client);
  assert(recipient.script.codeHash===JOYID_PROFILE.codeHash&&recipient.script.hashType===JOYID_PROFILE.hashType,'Recipient must be a JoyID testnet address');
  assert(!recipient.script.eq(issuer.script),'Recipient must differ from the issuer');
  const token=tokenScript(issuer.script.hash());
  const xudt=await client.getCellLive(XUDT.dep.outPoint,true);
  assert(xudt&&ccc.hashCkb(xudt.outputData)===XUDT.codeHash,'xUDT code dependency changed');
  const tx=ccc.Transaction.from({cellDeps:[XUDT.dep]});
  tx.addOutput({lock:recipient.script,type:token},amountData(MINT_AMOUNT));
  await tx.completeInputsByCapacity(signer);await tx.completeFeeBy(signer,1000n);
  for(const input of tx.inputs)assert((await input.getCell(client)).cellOutput.lock.eq(issuer.script),'Mint inputs must all belong to the issuer');
  const fee=await tx.getFee(client);
  assert(fee>0n&&fee<=MAX_FEE,`Mint fee ${fee} exceeds cap ${MAX_FEE}`);
  assert(tx.outputs[0]!.lock.eq(recipient.script)&&tx.outputs[0]!.type?.eq(token)&&tx.outputsData[0]===amountData(MINT_AMOUNT),'Mint output changed');
  for(const output of tx.outputs.slice(1))assert(output.lock.eq(issuer.script)&&!output.type,'Unexpected change output');
  console.log(ccc.stringify({recipient:recipient.toString(),token,tokenHash:token.hash(),amount:MINT_AMOUNT,tokenCellCapacity:tx.outputs[0]!.capacity,fee}));
  if(!execute){console.log('Dry run: nothing signed or sent. Add --execute to mint once.');process.exit(0);}
  const signed=await signer.signTransaction(tx),hash=signed.hash();
  // Persist the exact signed bytes before sending: a lost reply must not lead to a second mint.
  await writeFile(resultFile,ccc.stringify({status:'sent',hash,transaction:ccc.hexFrom(signed.toBytes()),recipient:recipient.toString(),token,amount:MINT_AMOUNT,fee})+'\n',{flag:'wx'});
  try{assert.equal(await client.sendTransaction(signed),hash);}catch(error){console.error('Send outcome unknown; do not retry blindly. Check status of',hash);throw error;}
  console.log('MINT TX HASH:',hash);
  await client.waitTransaction(hash,1,600000);
  for(const other of [client,secondary.value]){
   const seen=await other.getTransaction(hash);
   assert.equal(seen?.status,'committed','Mint not committed on every endpoint');
   const cell=await other.getCellLive({txHash:hash,index:0},true);
   assert(cell&&cell.cellOutput.lock.eq(recipient.script)&&cell.cellOutput.type?.eq(token)&&parseAmount(cell.outputData)===MINT_AMOUNT,'Minted cell mismatch');
  }
  await writeFile(resultFile,ccc.stringify({status:'committed',hash,recipient:recipient.toString(),token,tokenHash:token.hash(),amount:MINT_AMOUNT,fee,verifiedEndpoints:ENDPOINTS})+'\n');
  console.log('Mint committed and verified on both endpoints.');
 }finally{await primary.dispose();await secondary.dispose();}
}else throw new Error('Usage: npm run pool:issuer | npm run pool:mint -- <joyid-address> [--execute]');
