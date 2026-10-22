import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';

test('public pool SDK bundles and initializes without Node globals or polyfills',async()=>{
 const result=await build({entryPoints:['pool-sdk/src/index.ts'],bundle:true,write:false,platform:'browser',format:'iife',globalName:'PoolSdk',target:'es2022',metafile:true});
 assert.ok(result.outputFiles.length===1);
 // A JS realm smoke test, not browser/wallet acceptance. Do not expose require,
 // process or Buffer; browser primitives are supplied explicitly.
 const context={TextEncoder,TextDecoder,URL,AbortController,Uint8Array,console,setTimeout,clearTimeout,performance,crypto:globalThis.crypto,
  fetch:async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:'bounded café response'}))};
 const sdk=runInNewContext(`${result.outputFiles[0]!.text}\nPoolSdk;`,context,{timeout:10000});
 assert.equal(typeof sdk.reviewPoolTransaction,'function');
 assert.equal(typeof sdk.resolveJoyIdWallet,'function');
 assert.equal(typeof sdk.fundPoolTransaction,'function');
 const reply=await sdk.poolReadTransport('https://rpc.invalid').request({jsonrpc:'2.0',id:1,method:'get_cells',params:[]});
 assert.equal(reply.result,'bounded café response');
 for(const input of Object.keys(result.metafile!.inputs))assert.equal(input.startsWith('node:'),false);
});
