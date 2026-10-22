// Bundles the P6 JoyID pool lifecycle into a CCC playground script. Requires the
// recorded pool deployment and issuer; never invents dependency OutPoints.
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
const read=async name=>{
 try{return JSON.parse(await readFile(new URL(`../deployments/${name}`,import.meta.url),'utf8'));}
 catch(error){if(error.code==='ENOENT')throw new Error(`deployments/${name} is missing: record the deployment/issuer first`);throw error;}
};
const manifest=await read('pool-testnet.json'),issuer=await read('pool-issuer.json');
if(!/^0x[0-9a-f]{64}$/.test(issuer.lockHash??''))throw new Error('pool-issuer.json lacks lockHash');
await build({entryPoints:['scripts/pool-lifecycle.entry.ts'],outfile:'deployments/pool-lifecycle.playground.ts',bundle:true,format:'esm',target:'es2022',
 alias:{'@ckb-ccc/core':'@ckb-ccc/ccc'},external:['@ckb-ccc/ccc','@ckb-ccc/playground'],
 define:{__POOL_MANIFEST__:JSON.stringify(manifest),__POOL_ISSUER__:JSON.stringify({lockHash:issuer.lockHash})},
 banner:{js:'// GENERATED OPENSWAP P6 POOL LIFECYCLE — TESTNET ONLY. Replace all Playground code with this file.'}});
console.log('Wrote deployments/pool-lifecycle.playground.ts');
