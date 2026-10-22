import {ccc} from '@ckb-ccc/core';
type Transport=Parameters<typeof ccc.ClientPublicTestnet.new>[0]['transport'];
/** Browser/CLI transport: no writes, redirects, fallbacks or unbounded JSON bodies. */
export function poolReadTransport(endpoint:string,options:{maxBytes?:number;timeoutMs?:number;signal?:AbortSignal}={}):Transport {
 const url=new URL(endpoint);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Explicit HTTP(S) RPC URL without credentials required');
 const maxBytes=options.maxBytes??4*1024*1024,timeout=options.timeoutMs??15000,signal=options.signal;
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8*1024*1024||!Number.isSafeInteger(timeout)||timeout<1||timeout>60000)throw new Error('Invalid transport bound');
 return {async request(payload){
  if(!['get_header_by_number','get_live_cell','get_cells'].includes(payload.method))throw new Error('Pool transport permits only required read-only RPC methods');
  signal?.throwIfAborted();const controller=new AbortController();
  const abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(new Error('Pool transport deadline exceeded')),timeout);
  try{
   const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:controller.signal,redirect:'error'});
   if(!response.ok||!response.body)throw new Error(`Pool RPC HTTP status ${response.status}`);
   const length=response.headers.get('content-length');
   if(length&&Number(length)>maxBytes)throw new Error('Pool RPC response exceeds byte limit');
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
   while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw new Error('Pool RPC response exceeds byte limit');chunks.push(value);}
   const bytes=new Uint8Array(size);let offset=0;
   for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   const decoded=JSON.parse(new TextDecoder().decode(bytes));
   if(!decoded||typeof decoded!=='object'||Array.isArray(decoded)||decoded.jsonrpc!=='2.0'||decoded.id!==payload.id||('result' in decoded)===('error' in decoded))throw new Error('Malformed or mismatched JSON-RPC envelope');
   if('error' in decoded&&(!decoded.error||!Number.isInteger(decoded.error.code)||typeof decoded.error.message!=='string'))throw new Error('Malformed JSON-RPC error');
   return decoded;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
 }};
}
