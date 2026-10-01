import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ccc} from '@ckb-ccc/core';
import {decodeArgs,encodeArgs,decodeState,encodeState,decodeAction,encodeAction,actionFields,decodePoolScript,poolScript,decodeWitness,PoolWireError} from '../src/codec.js';

test('SDK codecs match all 3291 independent vectors also checked against Rust',()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const corpus=execFileSync(process.execPath,['node_modules/tsx/dist/cli.mjs','pool-model/src/wire-vectors.ts','--emit'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024});
 let count=0;
 for(const line of corpus.trim().split('\n')){
  const v=JSON.parse(line) as {kind:string;hex:string;expected:unknown};const b=ccc.bytesFrom(`0x${v.hex}`);let got:unknown;
  try {
   let ok:unknown;
   switch(v.kind){
    case 'args':{const a=decodeArgs(b);assert.equal(encodeArgs(a),`0x${v.hex}`);ok={...a,poolId:a.poolId.slice(2)};break;}
    case 'state':{const s=decodeState(b);assert.equal(encodeState(s),`0x${v.hex}`);ok={...s,tokenCodeHash:s.tokenCodeHash.slice(2),tokenOwner:s.tokenOwner.slice(2)};break;}
    case 'action':{const a=decodeAction(b);assert.equal(encodeAction(a),`0x${v.hex}`);ok=actionFields(a);break;}
    case 'script':{const s=decodePoolScript(b);assert.equal(ccc.hexFrom(poolScript(s.codeHash,s.args.poolId,s.args.role).toBytes()),`0x${v.hex}`);ok={codeHash:s.codeHash.slice(2),args:{...s.args,poolId:s.args.poolId.slice(2)}};break;}
    case 'genesisWitness':case 'transitionWitness':ok=actionFields(decodeWitness(b,v.kind==='genesisWitness'));break;
    default:throw Error('unexpected vector kind');
   }
   got={ok};
  }catch(e){if(!(e instanceof PoolWireError))throw e;got={error:e.code};}
  const normalized=JSON.parse(JSON.stringify(got,(_,x:unknown)=>typeof x==='bigint'?x.toString():x));
  assert.deepEqual(normalized,v.expected,`vector ${count}: ${line}`);count++;
 }
 assert.equal(count,3291);
});
