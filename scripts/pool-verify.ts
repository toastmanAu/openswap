#!/usr/bin/env -S npx tsx
// Independent P6 lifecycle verification through both testnet endpoints. Read-only.
// Usage: npm run pool:verify -- <create> <xToY> <yToX> <deposit> <partialWithdraw> <fullWithdraw> <reenter>
import {ccc} from '@ckb-ccc/shell';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createPool,transition,type PoolState} from '../pool-model/src/model.js';
import {decodeWitness} from '../pool-sdk/src/codec.js';
import {parsePool,type PoolDeployment} from '../pool-sdk/src/pools.js';
import {ENDPOINTS,GENESIS,INITIAL_LIQUIDITY,JOYID_PROFILE,MAX_FEE,POOL_PARAMETERS} from './lib/pool-live.js';

const STEPS=['create','xToY','yToX','deposit','partialWithdraw','fullWithdraw','reenter'];
const hashes=process.argv.slice(2);
assert(hashes.length===STEPS.length&&hashes.every(h=>/^0x[0-9a-f]{64}$/.test(h)),`Usage: npm run pool:verify -- <${STEPS.join('> <')}>`);
const manifest=JSON.parse(await readFile(new URL('../deployments/pool-testnet.json',import.meta.url),'utf8'));
const deployment:PoolDeployment={genesisHash:manifest.genesisHash,codeHash:manifest.codeHash,poolDep:manifest.poolDep,tokenDep:manifest.tokenDep};
const json=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
const accounting=(s:PoolState)=>json({x:s.x,y:s.y,totalShares:s.totalShares,lockedShares:s.lockedShares,feeBps:s.feeBps,backing:s.backing});

const results:object[]=[];
for(const url of ENDPOINTS){
 const owned=ccc.ClientPublicTestnet.open({urls:[url]});
 try{
  const client=owned.value;
  assert.equal((await client.getHeaderByNumber(0))?.hash,GENESIS,`${url} is not testnet`);
  let previous:{state:PoolState;points:ccc.OutPoint[]}|undefined,owner:ccc.Script|undefined;
  for(const [index,hash] of hashes.entries()){
   const step=STEPS[index]!,response=await client.getTransaction(hash);
   assert.equal(response?.status,'committed',`${step} not committed on ${url}`);
   const tx=response!.transaction,genesis=index===0;
   const stateIndex=genesis?1:0;// JoyID genesis layout puts LP at 0 and state at 1.
   const cell=(i:number)=>ccc.Cell.from({outPoint:{txHash:hash,index:i},cellOutput:tx.outputs[i]!,outputData:tx.outputsData[i]!});
   const pool=parsePool(deployment,cell(stateIndex),cell(stateIndex+1),cell(stateIndex+2));
   const action=decodeWitness(tx.witnesses[genesis?stateIndex:0]!,genesis);
   if(action.kind==='create'){
    assert.equal(accounting(pool.accounting),accounting(createPool(POOL_PARAMETERS,INITIAL_LIQUIDITY.x,INITIAL_LIQUIDITY.y,action.minShares).next),'genesis differs from approved parameters/liquidity');
   }else{
    assert(previous,'transition without predecessor');
    for(const point of previous.points)assert(tx.inputs.some(i=>i.previousOutput.eq(point)),`${step} does not spend the previous pool cells`);
    assert.equal(accounting(pool.accounting),accounting(transition(previous.state,action).next),`${step} next state differs from the model`);
   }
   let inputCapacity=0n;
   for(const input of tx.inputs)inputCapacity+=(await input.getCell(client)).cellOutput.capacity;
   const fee=inputCapacity-tx.outputs.reduce((n,o)=>n+o.capacity,0n);
   assert(fee>0n&&fee<=MAX_FEE,`${step} fee ${fee} outside cap`);
   const walletOutputs=tx.outputs.filter((_,i)=>i<stateIndex||i>stateIndex+2);
   owner??=walletOutputs[0]?.lock;
   assert(owner&&owner.codeHash===JOYID_PROFILE.codeHash,'wallet outputs are not JoyID');
   for(const output of walletOutputs)assert(output.lock.eq(owner),`${step} pays a lock other than the user's JoyID`);
   if(url===ENDPOINTS[0])results.push({step,hash,action:json(action),fee:fee.toString(),poolId:pool.poolId,next:JSON.parse(accounting(pool.accounting))});
   previous={state:pool.accounting,points:[0,1,2].map(i=>ccc.OutPoint.from({txHash:hash,index:stateIndex+i}))};
  }
 }finally{await owned.dispose();}
}
await writeFile(new URL('../deployments/pool-lifecycle-result.json',import.meta.url),JSON.stringify({network:'testnet',verifiedEndpoints:ENDPOINTS,steps:results,verifiedAt:new Date().toISOString()},null,2)+'\n');
console.log(`All ${STEPS.length} lifecycle transactions verified on ${ENDPOINTS.length} endpoints; wrote deployments/pool-lifecycle-result.json`);
