#!/usr/bin/env -S npx tsx
// Read-only check that a JoyID-signed order-book transaction from the app (create, fill,
// cancel or return; v1 or v2) paid a fee within ORDER_FEE_POLICY (frontend/src/fees.ts):
// at most 0.01 CKB, built at 1,000–5,000 shannons/KB. CCC sets the fee before signing,
// as ceil((serialized size + 4) × rate / 1000), and the JoyID signer reserves a
// 1,000-byte placeholder for its signature then (@ckb-ccc/joy-id prepareTransaction), so
// the check rebuilds that pre-signing size and requires the fee to be CCC's estimate at
// a policy rate. The committed rate is higher by the unused placeholder bytes; it is
// reported, not judged. Checked on both endpoints: committed in the same
// block, touches an order lock and no pool cell, and every input that is not an order
// belongs to one JoyID wallet, which therefore paid the fee. Also records the nodes'
// current fee-rate estimate, to show what an uncapped build would have paid.
// Adds the check to deployments/fee-cap-joyid.json, one entry per transaction.
//   npx tsx scripts/fee-cap-joyid-verify.ts <tx-hash>
import {ccc} from '@ckb-ccc/core';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {ORDER_FEE_POLICY} from '../frontend/src/fees.js';
import {ENDPOINTS,GENESIS,JOYID_PROFILE} from './lib/pool-live.js';

const txHash=process.argv[2] as ccc.Hex;
assert(/^0x[0-9a-f]{64}$/.test(txHash??''),'Usage: fee-cap-joyid-verify.ts <tx-hash>');
const json=async(path:string)=>JSON.parse(await readFile(new URL(`../${path}`,import.meta.url),'utf8'));
const v1=await json('deployments/testnet.json'),v2=await json('deployments/testnet-v2.json'),pools=(await json('deployments/pool-frontend.json')).deployment;
const orderCode=new Map<string,string>([[v1.codeHash,'v1'],[v2.codeHash,'v2']]);
const show=(a:bigint)=>ccc.fixedPointToString(a);
/** Signature placeholder the JoyID signer adds before CCC estimates the fee. */
const JOYID_PLACEHOLDER=1000;

const results=[];
for(const url of ENDPOINTS){
 const client=new ccc.ClientPublicTestnet({url});
 assert.equal((await client.getHeaderByNumber(0))?.hash,GENESIS,`${url} is not CKB testnet`);
 const response=await client.getTransactionNoCache(txHash);
 assert.equal(response?.status,'committed',`Not committed on ${url}`);
 const tx=response!.transaction,inputs=await Promise.all(tx.inputs.map(i=>i.getCell(client)));
 const isOrder=(lock:ccc.Script)=>lock.hashType==='data1'&&orderCode.has(lock.codeHash);
 const orderIn=inputs.filter(c=>isOrder(c.cellOutput.lock)),orderOut=tx.outputs.filter(o=>isOrder(o.lock));
 assert(orderIn.length+orderOut.length>0,'Not an order-book transaction');
 assert(![...inputs.map(c=>c.cellOutput),...tx.outputs].some(o=>o.type?.codeHash===pools.codeHash),'Touches a pool cell: pools use their own fee policy');
 const wallet=inputs.filter(c=>!isOrder(c.cellOutput.lock));
 assert(wallet.length>0,'No wallet input paid the fee');
 const signer=wallet[0]!.cellOutput.lock;
 assert(signer.codeHash===JOYID_PROFILE.codeHash&&signer.hashType===JOYID_PROFILE.hashType,'Fee payer is not a JoyID lock');
 assert(wallet.every(c=>c.cellOutput.lock.eq(signer)),'Wallet inputs from more than one lock');
 // CCC's measure: fee × 1000 / (serialized transaction + 4 bytes of its offset in the block).
 const fee=inputs.reduce((s,c)=>s+c.cellOutput.capacity,0n)-tx.outputs.reduce((s,o)=>s+o.capacity,0n);
 const size=BigInt(tx.toBytes().length+4),committedRate=fee*1000n/size;
 assert(fee>0n&&fee<=ORDER_FEE_POLICY.maxFee,`Fee ${show(fee)} CKB exceeds the ${show(ORDER_FEE_POLICY.maxFee)} CKB cap`);
 // The transaction as CCC priced it: the signer's first input's witness lock back to the placeholder.
 const at=inputs.findIndex(c=>c.cellOutput.lock.eq(signer)),priced=tx.clone(),witness=priced.getWitnessArgs(at);
 assert(witness?.lock,'JoyID witness has no lock field');
 const signature=ccc.bytesFrom(witness.lock).length;
 witness.lock=ccc.hexFrom('00'.repeat(JOYID_PLACEHOLDER));priced.setWitnessArgs(at,witness);
 const pricedSize=BigInt(priced.toBytes().length+4);
 // The highest whole rate whose CCC estimate is this fee; the estimate must match it exactly.
 const builtRate=fee*1000n/pricedSize;
 assert.equal(priced.estimateFee(builtRate),fee,`Fee ${fee} is not CCC's estimate at any whole rate for ${pricedSize} bytes`);
 assert(builtRate>=ORDER_FEE_POLICY.minRate&&builtRate<=ORDER_FEE_POLICY.maxRate,`Built at ${builtRate} shannons/KB, outside ${ORDER_FEE_POLICY.minRate}–${ORDER_FEE_POLICY.maxRate}`);
 const stats=await client.getFeeRateStatistics();
 const uncapped=(size*stats.median+999n)/1000n;
 const kind=orderOut.length&&!orderIn.length?'create':orderIn.length&&orderOut.length?'partial fill':'fill, cancel or return';
 results.push({endpoint:url,block:response!.blockNumber!.toString(),kind,orderLocks:[...new Set([...orderIn.map(c=>c.cellOutput.lock),...orderOut.map(o=>o.lock)].map(l=>orderCode.get(l.codeHash)))],
  signer:signer.hash(),fee:show(fee),builtRate:builtRate.toString(),pricedBytes:pricedSize.toString(),
  committed:{bytes:size.toString(),rate:committedRate.toString(),signatureBytes:signature,placeholderBytes:JOYID_PLACEHOLDER},
  nodeEstimateNow:{median:stats.median.toString(),feeAtThatRate:show(uncapped>ORDER_FEE_POLICY.maxFee?ORDER_FEE_POLICY.maxFee:uncapped)+(uncapped>ORDER_FEE_POLICY.maxFee?' (capped)':'')}});
}
assert.equal(results[0]!.block,results[1]!.block,'Endpoints disagree on the block');
for(const k of ['fee','builtRate','pricedBytes','signer','kind'] as const)assert.equal(results[0]![k],results[1]![k],`Endpoints disagree on ${k}`);
const check={tx:txHash,checkedAt:new Date().toISOString(),results};
const prior=await json('deployments/fee-cap-joyid.json').catch(()=>undefined);
const checks=[...(prior?.checks??[]).filter((c:{tx:string})=>c.tx!==txHash),check];
const record={network:'testnet',policy:{minRate:ORDER_FEE_POLICY.minRate.toString(),maxRate:ORDER_FEE_POLICY.maxRate.toString(),maxFee:show(ORDER_FEE_POLICY.maxFee)},checks};
await writeFile(new URL('../deployments/fee-cap-joyid.json',import.meta.url),ccc.stringify(record)+'\n');
console.log(ccc.stringify(check),'\nFee within the order fee policy on both endpoints.');
process.exit(0);
