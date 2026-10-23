#!/usr/bin/env -S npx tsx
// Derives the pool UI manifest from the recorded P6 deployment and the verified
// lifecycle (which supplies the live pool ID). Validated by the UI's own parser.
import {readFile,writeFile} from 'node:fs/promises';
import {parsePoolManifest} from '../frontend/src/pools/manifest.js';
import {FEE_RATE,MAX_FEE} from './lib/pool-live.js';

const read=async(name:string)=>{
 try{return JSON.parse(await readFile(new URL(`../deployments/${name}`,import.meta.url),'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error(`deployments/${name} is missing: record and verify the P6 run first`);throw error;}
};
const deployment=await read('pool-testnet.json'),lifecycle=await read('pool-lifecycle-result.json'),issuer=await read('pool-issuer.json');
const poolIds=[...new Set(lifecycle.steps.map((s:{poolId:string})=>s.poolId))];
if(poolIds.length!==1)throw new Error('Verified lifecycle must describe exactly one pool');
const dep=(d:{outPoint:{txHash:string;index:number|string};depType:string})=>({outPoint:{txHash:d.outPoint.txHash,index:String(d.outPoint.index)},depType:d.depType});
const manifest={version:1,network:'testnet',
 deployment:{genesisHash:deployment.genesisHash,codeHash:deployment.codeHash,poolDep:dep(deployment.poolDep),tokenDep:dep(deployment.tokenDep)},
 // The P6 test token uses 8 decimals (scripts/lib/pool-live.ts); bound to its type hash.
 pools:[{label:'P6 test pool',poolId:poolIds[0],token:{symbol:'TEST',decimals:8,typeHash:issuer.tokenHash}}],
 joyid:{codeHash:deployment.joyIdProfile.codeHash,hashType:deployment.joyIdProfile.hashType,codeDeps:deployment.joyIdProfile.codeDeps.map((c:{dep:never;dataHash:string})=>({dep:dep(c.dep),dataHash:c.dataHash}))},
 policy:{feeRate:FEE_RATE.toString(),maxFee:MAX_FEE.toString(),slippageBps:100,reviewTtlMs:120000}};
parsePoolManifest(manifest);
await writeFile(new URL('../deployments/pool-frontend.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n');
console.log('Wrote deployments/pool-frontend.json for pool',poolIds[0]);
