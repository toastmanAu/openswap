/** Bounded, read-only JoyID aggregator adapter. No credentials or signing. */
import {ccc} from '@ckb-ccc/core';
import type {ReadOptions} from './pools.js';

export interface JoyIdProofRequest {lock:ccc.Hex;publicKey:ccc.Hex}
export type JoyIdProofSource=(request:JoyIdProofRequest,options:ReadOptions)=>Promise<ccc.Hex>;

export function validateJoyIdProof(value:unknown):ccc.Hex {
 if(typeof value!=='string'||value.length>6002)throw new Error('JoyID proof must be 1..3000 bytes');
 const bytes=value.startsWith('0x')?value.slice(2):value;
 if(bytes.length>6000||!/^(?:[0-9a-fA-F]{2})+$/.test(bytes))throw new Error('JoyID proof must be 1..3000 bytes');
 return `0x${bytes.toLowerCase()}`;
}

/** Exact RPC used by pinned CCC JoyID's secp256r1 subkey path (alg_index 1).
 * A syntactically valid response is not a verified SMT proof. Wallet/consensus
 * authentication remains required; this function only bounds and retrieves it.
 */
export function joyIdProofSource(endpoint:string):JoyIdProofSource {
 const url=new URL(endpoint);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw new Error('Explicit JoyID HTTP(S) URL without credentials or fragment required');
 let serial=0;
 return async(request,options={})=>{
  if(typeof request.lock!=='string'||request.lock.length>1026||!/^0x(?:[0-9a-fA-F]{2})+$/.test(request.lock))throw new Error('Invalid JoyID proof request');
  const lock=ccc.Script.fromBytes(request.lock);
  if(lock.toBytes().length>512||typeof request.publicKey!=='string'||!/^0x(?:[0-9a-fA-F]{2}){1,1024}$/.test(request.publicKey))throw new Error('Invalid JoyID proof request');
  const timeout=options.timeoutMs??15000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000)throw new Error('Invalid JoyID proof deadline');
  options.signal?.throwIfAborted();
  const controller=new AbortController(),abort=()=>controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(new Error('JoyID proof deadline exceeded')),timeout);
  const id=++serial;
  try{
   const response=await fetch(url,{method:'POST',redirect:'error',credentials:'omit',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method:'generate_subkey_unlock_smt',params:{alg_index:1,pubkey_hash:ccc.hashCkb(request.publicKey).slice(0,42),lock_script:ccc.hexFrom(lock.toBytes())}})});
   if(!response.ok||!response.body)throw new Error(`JoyID proof HTTP status ${response.status}`);
   const maxBytes=16384;
   if(Number(response.headers.get('content-length'))>maxBytes)throw new Error('JoyID proof response exceeds byte limit');
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
   while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>maxBytes)throw new Error('JoyID proof response exceeds byte limit');chunks.push(value);}
   const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   if(!result||typeof result!=='object'||Array.isArray(result)||result.jsonrpc!=='2.0'||result.id!==id||('result' in result)===('error' in result))throw new Error('Malformed JoyID proof envelope');
   if('error' in result)throw new Error('JoyID proof RPC rejected request');
   return validateJoyIdProof(result.result?.unlock_entry);
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);controller.abort();}
 };
}
