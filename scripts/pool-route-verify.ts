#!/usr/bin/env -S npx tsx
// Independent verification of a two-pool route signed with JoyID, through both
// testnet endpoints. Read-only. Usage: npx tsx scripts/pool-route-verify.ts <txHash>
import {ccc} from '@ckb-ccc/shell';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {transition,type PoolState} from '../pool-model/src/model.js';
import {decodeWitness} from '../pool-sdk/src/codec.js';
import {parseAmount} from '../sdk/src/codec.js';
import {parsePool,type PoolDeployment} from '../pool-sdk/src/pools.js';
import {ENDPOINTS,GENESIS,JOYID_PROFILE,MAX_FEE} from './lib/pool-live.js';

const hash=process.argv[2] as ccc.Hex;
assert(/^0x[0-9a-f]{64}$/.test(hash??''),'Usage: npx tsx scripts/pool-route-verify.ts <txHash>');
const manifest=JSON.parse(await readFile(new URL('../deployments/pool-testnet.json',import.meta.url),'utf8'));
const deployment:PoolDeployment={genesisHash:manifest.genesisHash,codeHash:manifest.codeHash,poolDep:manifest.poolDep,tokenDep:manifest.tokenDep};
const known=JSON.parse(await readFile(new URL('../deployments/pool-frontend.json',import.meta.url),'utf8')).pools as {poolId:string;label:string}[];
const json=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
const accounting=(s:PoolState)=>json({x:s.x,y:s.y,totalShares:s.totalShares,lockedShares:s.lockedShares,feeBps:s.feeBps,backing:s.backing});

const seen:string[]=[];let result:any;
for(const url of ENDPOINTS){
 const owned=ccc.ClientPublicTestnet.open({urls:[url]});
 try{
  const client=owned.value;
  assert.equal((await client.getHeaderByNumber(0))?.hash,GENESIS,`${url} is not testnet`);
  const response=await client.getTransactionNoCache(hash);
  assert.equal(response?.status,'committed',`not committed on ${url}`);
  const tx=response!.transaction,block=response!.blockNumber!;
  const inputs=await Promise.all(tx.inputs.map(i=>i.getCell(client)));
  const out=(i:number)=>ccc.Cell.from({outPoint:{txHash:hash,index:i},cellOutput:tx.outputs[i]!,outputData:tx.outputsData[i]!});
  const hops=[0,3].map(at=>{
   const before=parsePool(deployment,inputs[at]!,inputs[at+1]!,inputs[at+2]!),after=parsePool(deployment,out(at),out(at+1),out(at+2));
   assert.equal(after.poolId,before.poolId,`pool at input ${at} does not continue at output ${at}`);
   const label=known.find(p=>p.poolId===before.poolId)?.label;assert(label,`pool ${before.poolId} is not in the app's pool list`);
   const action=decodeWitness(tx.witnesses[at]!,false);assert(action.kind==='swap',`input ${at} action is ${action.kind}`);
   assert.equal(accounting(after.accounting),accounting(transition(before.accounting,action).next),`${label} next state differs from the model`);
   return {label,poolId:before.poolId,state:before.stateCell.outPoint,action,before:before.accounting,after:after.accounting,token:before.token};
  });
  assert.notEqual(hops[0]!.poolId,hops[1]!.poolId,'same pool twice');
  const [a,b]=hops as [typeof hops[0],typeof hops[0]];
  assert(a.action.kind==='swap'&&b.action.kind==='swap'&&a.action.direction==='yToX'&&b.action.direction==='xToY','not token -> CKB -> token');
  const hop=a.before.x-a.after.x;
  assert.equal(b.after.x-b.before.x,hop,'CKB out of pool 1 differs from CKB into pool 2');
  const paid=a.after.y-a.before.y,received=b.before.y-b.after.y;
  // Every non-pool cell in and out belongs to one JoyID lock; the receipt is the second token.
  const wallet=inputs[6]!.cellOutput.lock;
  assert(wallet.codeHash===JOYID_PROFILE.codeHash&&wallet.hashType===JOYID_PROFILE.hashType,'wallet is not JoyID');
  for(const c of inputs.slice(6))assert(c.cellOutput.lock.eq(wallet),'an input is not the wallet');
  for(const o of tx.outputs.slice(6))assert(o.lock.eq(wallet),'an output pays another lock');
  const receipt=tx.outputs[6]!;
  assert(receipt.type?.eq(b.token),'receipt is not the second token');assert.equal(parseAmount(tx.outputsData[6]!),received,'receipt differs from pool 2 output');
  assert(b.action.kind==='swap'&&received>=b.action.minOut,'received below the signed minimum');
  const fee=inputs.reduce((n,c)=>n+c.cellOutput.capacity,0n)-tx.outputs.reduce((n,o)=>n+o.capacity,0n);
  assert(fee>0n&&fee<=MAX_FEE,`fee ${fee} outside cap`);
  const r={hash,block:block.toString(),route:`${a.label} then ${b.label}`,pools:[a.poolId,b.poolId],states:[a.state,b.state],
   paid:paid.toString(),hop:hop.toString(),received:received.toString(),minOut:b.action.minOut.toString(),fee:fee.toString(),
   wallet:ccc.Address.fromScript(wallet,client).toString(),bytes:tx.toBytes().length};
  if(result)assert.equal(json(r),json(result),`${url} disagrees`);result=r;seen.push(url);
 }finally{await owned.dispose();}
}
console.log(json({...result,verifiedOn:seen}));
