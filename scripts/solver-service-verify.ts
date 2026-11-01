#!/usr/bin/env -S npx tsx
// Read-only check of transactions sent by the solver service (scripts/solver-service.ts),
// on both endpoints. Requires: committed in the same block; every order input a v2 order;
// every other input and output the solver wallet's; fee within the 0.01 CKB cap.
// A keeper return must give each order back to its owner unchanged (same index,
// capacity, type and data) after its expiry. A settlement must be accepted by the
// reference model at every order input, pay each maker at its order index, and pay
// out no more of any asset than the orders held. Adds each check to
// deployments/solver-service.json, one entry per transaction.
//   npx tsx scripts/solver-service-verify.ts <tx-hash>...
import {ccc} from '@ckb-ccc/core';
import {readFile,rename,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {checkFill,decodeTermsV2,orderKey,parseAmount,type Deployment,type ModelCell} from '../sdk/src/index.js';
import {ORDER_FEE_POLICY} from '../frontend/src/fees.js';
import {ENDPOINTS,GENESIS} from './lib/pool-live.js';

const hashes=process.argv.slice(2) as ccc.Hex[];
assert(hashes.length&&hashes.every(h=>/^0x[0-9a-f]{64}$/.test(h)),'Usage: solver-service-verify.ts <tx-hash>...');
const root=new URL('../',import.meta.url);
const json=async(path:string)=>JSON.parse(await readFile(new URL(path,root),'utf8'));
const v2=await json('deployments/testnet-v2.json') as Deployment,solver=ccc.Script.from((await json('deployments/solver-wallet.json')).lock);
const markets=await json('deployments/pool-markets.json');
const symbol=(type?:ccc.Script)=>type?markets.tokens.find((t:{token:ccc.ScriptLike})=>ccc.Script.from(t.token).eq(type))?.symbol??type.hash().slice(0,10):'CKB';
const show=(a:bigint)=>ccc.fixedPointToString(a);
const clients=ENDPOINTS.map(url=>new ccc.ClientPublicTestnet({url}));
for(const c of clients)assert.equal((await c.getHeaderByNumber(0))?.hash,GENESIS,'Not CKB testnet');
const model=(o:ccc.CellOutput,d:ccc.Hex):ModelCell=>({lock:o.lock.hash(),type:o.type?o.type.hash():null,capacity:o.capacity,data:ccc.bytesFrom(d)});
const asset=(o:ccc.CellOutput)=>o.type?o.type.hash():'ckb';

const file=new URL('deployments/solver-service.json',root);
let record:{network:'testnet';solver:string;checks:{tx:ccc.Hex;checkedAt:string;results:unknown[]}[]};
try{record=await json('deployments/solver-service.json');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;record={network:'testnet',solver:ccc.Address.fromScript(solver,clients[0]!).toString(),checks:[]};}

for(const hash of hashes){
 const results=[];
 for(const [n,c] of clients.entries()){
  const r=await c.getTransactionNoCache(hash);
  assert.equal(r?.status,'committed',`${hash} not committed on ${ENDPOINTS[n]}`);
  const tx=r!.transaction,inputs=await Promise.all(tx.inputs.map(i=>i.getCell(c)));
  const orderIdx=inputs.flatMap((cell,i)=>cell.cellOutput.lock.codeHash===v2.codeHash?[i]:[]);
  assert(orderIdx.length,'No v2 order inputs');
  for(const [i,cell] of inputs.entries())if(!orderIdx.includes(i))assert(cell.cellOutput.lock.eq(solver),`Input ${i} is neither an order nor the solver's`);
  const orderLocks=new Set(orderIdx.map(i=>inputs[i]!.cellOutput.lock.hash()));
  const remainders=tx.outputs.flatMap((o,k)=>orderLocks.has(o.lock.hash())?[k]:[]);
  const makerOuts=new Set([...orderIdx,...remainders]);
  for(const [k,o] of tx.outputs.entries())if(!makerOuts.has(k))assert(o.lock.eq(solver),`Output ${k} is not the solver's`);
  const fee=await tx.getFee(c);
  assert(fee>0n&&fee<=ORDER_FEE_POLICY.maxFee,`Fee ${show(fee)} outside the cap`);
  const outputs=tx.outputs.map((o,k)=>model(o,tx.outputsData[k]!));
  const terms=orderIdx.map(i=>decodeTermsV2(inputs[i]!.cellOutput.lock.args));
  const isReturn=!remainders.length&&orderIdx.every((i,j)=>{
   const cell=inputs[i]!,out=tx.outputs[i]!;
   return terms[j]!.expiry!==0n&&tx.inputs[i]!.since===terms[j]!.expiry&&out.lock.eq(terms[j]!.ownerLock)&&out.capacity===cell.cellOutput.capacity
    &&(out.type?.eq(cell.cellOutput.type!)??!cell.cellOutput.type)&&tx.outputsData[i]===cell.outputData;
  });
  const orders=orderIdx.map((i,j)=>{
   const cell=inputs[i]!,t=terms[j]!;
   return {input:i,order:orderKey(cell),owner:ccc.Address.fromScript(t.ownerLock,c).toString(),offer:`${show(cell.cellOutput.type?parseAmount(cell.outputData):cell.cellOutput.capacity)} ${symbol(cell.cellOutput.type)}`};
  });
  let kind:'return'|'settlement',spread:Record<string,string>|undefined;
  if(isReturn)kind='return';
  else{
   kind='settlement';
   for(const [j,i] of orderIdx.entries()){
    const cell=inputs[i]!,lock=cell.cellOutput.lock,t=terms[j]!;
    const code=checkFill({owner:t.ownerLock.hash(),capacityRefund:t.capacityRefund,ask:t.askAsset.kind==='udt'?t.askAsset.scriptHash:null,askAmount:t.askAmount,offerAmount:t.offerAmount,minFill:t.minFill},lock.hash(),model(cell.cellOutput,cell.outputData),i,outputs);
    assert.equal(code,0,`Reference model rejects order input ${i} (code ${code})`);
    assert(tx.outputs[i]!.lock.eq(t.ownerLock),`Payment ${i} not at its order index`);
   }
   // Conservation from the cells, per asset: makers are paid no more than the orders held.
   const totals=new Map<string,bigint>();
   const add=(o:ccc.CellOutput,d:ccc.Hex,sign:bigint)=>{
    totals.set('ckb',(totals.get('ckb')??0n)+sign*o.capacity);
    if(o.type)totals.set(asset(o),(totals.get(asset(o))??0n)+sign*parseAmount(d));
   };
   for(const i of orderIdx)add(inputs[i]!.cellOutput,inputs[i]!.outputData,1n);
   for(const k of makerOuts)add(tx.outputs[k]!,tx.outputsData[k]!,-1n);
   for(const [a,v] of totals)assert(v>=0n,`${a} paid to makers exceeds what the orders held`);
   spread=Object.fromEntries([...totals].map(([a,v])=>[a==='ckb'?'CKB':symbol(tx.outputs.find(o=>o.type?.hash()===a)?.type??inputs.find(x=>x.cellOutput.type?.hash()===a)!.cellOutput.type),show(v)]));
  }
  results.push({endpoint:ENDPOINTS[n],block:r!.blockNumber!.toString(),kind,fee:show(fee),orders,...(spread?{solverSpread:spread}:{})});
 }
 assert.equal(results[0]!.block,results[1]!.block,'Endpoints disagree on the block');
 assert.equal(results[0]!.kind,results[1]!.kind);
 record.checks=[...record.checks.filter(x=>x.tx!==hash),{tx:hash,checkedAt:new Date().toISOString(),results}];
 console.log(ccc.stringify(results[0]),`\n${results[0]!.kind} ${hash} verified on both endpoints.`);
}
const t=new URL(file.href+'.tmp');await writeFile(t,ccc.stringify(record)+'\n');await rename(t,file);
process.exit(0);
