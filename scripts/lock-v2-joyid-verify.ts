#!/usr/bin/env -S npx tsx
// Read-only check of a JoyID partial fill of the createJ order (scripts/lock-v2-live.ts)
// on both endpoints: the reference model accepts the committed fill, the maker is paid
// at the order's price at the order index, the remainder keeps identical args, every
// other input belongs to one JoyID wallet, and that wallet receives exactly the taken
// TEST3. Writes deployments/lock-v2-joyid.json.
//   npx tsx scripts/lock-v2-joyid-verify.ts <tx-hash>
import {ccc} from '@ckb-ccc/core';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {checkFill,decodeTermsV2,parseAmount,type ModelCell} from '../sdk/src/index.js';
import {ENDPOINTS,GENESIS,JOYID_PROFILE} from './lib/pool-live.js';
/** The app's order builders use the node's fee-rate estimate under the SDK's default 1 CKB cap. */
const APP_MAX_FEE=ccc.fixedPointFrom('1');

const txHash=process.argv[2] as ccc.Hex;
assert(/^0x[0-9a-f]{64}$/.test(txHash??''),'Usage: lock-v2-joyid-verify.ts <tx-hash>');
const v2=JSON.parse(await readFile(new URL('../deployments/testnet-v2.json',import.meta.url),'utf8'));
const live=JSON.parse(await readFile(new URL('../deployments/lock-v2-live.json',import.meta.url),'utf8'));
const orderLock=ccc.Script.from(live.steps.createJ.orderLock);
const terms=decodeTermsV2(orderLock.args);
assert(terms.askAsset.kind==='ckb','createJ asks for CKB');
const show=(a:bigint)=>ccc.fixedPointToString(a);
const model=(o:ccc.CellOutput,d:ccc.Hex):ModelCell=>({lock:o.lock.hash(),type:o.type?o.type.hash():null,capacity:o.capacity,data:ccc.bytesFrom(d)});

const results=[];
for(const url of ENDPOINTS){
 const client=new ccc.ClientPublicTestnet({url});
 assert.equal((await client.getHeaderByNumber(0))?.hash,GENESIS,`${url} is not CKB testnet`);
 const response=await client.getTransactionNoCache(txHash);
 assert.equal(response?.status,'committed',`Not committed on ${url}`);
 const tx=response!.transaction,inputs=await Promise.all(tx.inputs.map(i=>i.getCell(client)));
 const orderIndexes=inputs.flatMap((c,i)=>c.cellOutput.lock.codeHash===v2.codeHash?[i]:[]);
 assert.equal(orderIndexes.length,1,'Expected exactly one v2 order input');
 const i=orderIndexes[0]!,order=inputs[i]!;
 assert(order.cellOutput.lock.eq(orderLock),'Filled order is not the createJ order');
 const offerType=order.cellOutput.type!;
 const code=checkFill({owner:terms.ownerLock.hash(),capacityRefund:terms.capacityRefund,ask:null,askAmount:terms.askAmount,offerAmount:terms.offerAmount,minFill:terms.minFill},
  orderLock.hash(),model(order.cellOutput,order.outputData),i,tx.outputs.map((o,k)=>model(o,tx.outputsData[k]!)));
 assert.equal(code,0,`Reference model rejects the committed fill (code ${code})`);
 const remainders=tx.outputs.flatMap((o,k)=>o.lock.eq(orderLock)?[k]:[]);
 assert.equal(remainders.length,1,'Expected a partial fill with one remainder');
 const r=remainders[0]!;
 assert(tx.outputs[r]!.type?.eq(offerType),'Remainder type changed');
 const amountIn=parseAmount(order.outputData),amountLeft=parseAmount(tx.outputsData[r]!);
 const taken=amountIn-amountLeft,leaving=order.cellOutput.capacity-tx.outputs[r]!.capacity;
 const payment=tx.outputs[i]!;
 assert(payment.lock.eq(terms.ownerLock)&&!payment.type&&tx.outputsData[i]==='0x','Payment is not plain CKB to the maker at the order index');
 const paid=payment.capacity-leaving;
 assert(paid*terms.offerAmount>=taken*terms.askAmount,'Maker underpaid');
 assert(taken>=terms.minFill&&amountLeft>=terms.minFill,'Partial fill below the minimum');
 const remainderLive=await client.getCellLive({txHash,index:r},true);
 // Taker: every other input is one JoyID lock, and it receives exactly the taken TEST3.
 const others=inputs.filter((_,k)=>k!==i);
 const taker=others[0]!.cellOutput.lock;
 assert(taker.codeHash===JOYID_PROFILE.codeHash&&taker.hashType===JOYID_PROFILE.hashType,'Taker is not a JoyID lock');
 assert(others.every(c=>c.cellOutput.lock.eq(taker)),'Inputs from more than one wallet');
 const test3=(cells:{lock:ccc.Script;type?:ccc.Script;data:ccc.Hex}[])=>cells.filter(c=>c.lock.eq(taker)&&c.type?.eq(offerType)).reduce((s,c)=>s+parseAmount(c.data),0n);
 const received=test3(tx.outputs.map((o,k)=>({lock:o.lock,type:o.type,data:tx.outputsData[k]!})))-test3(others.map(c=>({lock:c.cellOutput.lock,type:c.cellOutput.type,data:c.outputData})));
 assert.equal(received,taken,'Taker did not receive exactly the taken TEST3');
 for(const [k,o] of tx.outputs.entries())if(k!==i&&k!==r)assert(o.lock.eq(taker),`Output ${k} goes to an unexpected lock`);
 const fee=await tx.getFee(client);
 assert(fee>0n&&fee<=APP_MAX_FEE,'Fee outside the app cap');
 results.push({url,blockNumber:response!.blockNumber?.toString(),orderIndex:i,taken:show(taken),paid:show(paid),pricePerTest3:(Number(paid)/Number(taken)).toFixed(8),
  remainder:{index:r,test3:show(amountLeft),identicalArgs:true,live:!!remainderLive},makerPaymentCapacity:show(payment.capacity),taker:ccc.Address.fromScript(taker,client).toString(),received:show(received),fee:show(fee),bytes:tx.toBytes().length,feeRateShannonsPerKB:(fee*1000n/BigInt(tx.toBytes().length+4)).toString()});
}
assert.equal(ccc.stringify({...results[0],url:''}),ccc.stringify({...results[1],url:''}),'Endpoints disagree');
const record={network:'testnet',tx:txHash,order:live.steps.createJ.hash,site:'https://toastdex.org',signer:'JoyID (main key)',results,verifiedAt:new Date().toISOString()};
await writeFile(new URL('../deployments/lock-v2-joyid.json',import.meta.url),JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify(record,null,2));
process.exit(0);
