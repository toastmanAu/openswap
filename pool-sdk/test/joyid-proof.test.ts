import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {ccc} from '@ckb-ccc/core';
import {joyIdProofSource} from '../src/joyid-proof.js';

test('JoyID proof HTTP adapter sends only the pinned read request and bounds responses/cancellation',async()=>{
 const lock=ccc.Script.from({codeHash:`0x${'11'.repeat(32)}`,hashType:'type',args:'0x00012233'});
 const request={lock:ccc.hexFrom(lock.toBytes()),publicKey:`0x${'77'.repeat(64)}` as ccc.Hex};
 let mode='valid',requests=0;
 const server=createServer((req,res)=>{
  requests++;let body='';req.on('data',chunk=>{body+=chunk;});
  req.on('end',()=>{
   const rpc=JSON.parse(body);assert.equal(req.method,'POST');assert.equal(req.headers.authorization,undefined);
   assert.equal(rpc.method,'generate_subkey_unlock_smt');assert.equal(rpc.jsonrpc,'2.0');
   assert.deepEqual(rpc.params,{alg_index:1,pubkey_hash:ccc.hashCkb(request.publicKey).slice(0,42),lock_script:request.lock});
   if(mode==='hang')return;
   if(mode==='redirect'){res.writeHead(302,{location:'/redirected'});res.end();return;}
   if(mode==='status'){res.writeHead(503);res.end();return;}
   if(mode==='declared'){res.writeHead(200,{'content-length':'16385'});res.flushHeaders();return;}
   if(mode==='chunked'){res.write(' '.repeat(10000));res.end(' '.repeat(10000));return;}
   if(mode==='body-hang'){res.write('{');return;}
   if(mode==='malformed'){res.end('{');return;}
   if(mode==='error'){res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:{code:-1,message:'rejected'}}));return;}
   if(mode==='both'){res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{unlock_entry:'0x11'},error:{code:-1,message:'bad'}}));return;}
   res.end(JSON.stringify({jsonrpc:'2.0',id:mode==='wrong-id'?rpc.id+1:rpc.id,result:{unlock_entry:mode==='empty'?'0x':mode==='oversize'?`0x${'aa'.repeat(3001)}`:mode==='odd'?'0x123':mode==='bare'?'ABCD':'0x1234',block_number:'0x1'}}));
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');const endpoint=`http://127.0.0.1:${address.port}`;
  const source=joyIdProofSource(endpoint);
  assert.equal(await source(request,{}),'0x1234');mode='bare';assert.equal(await source(request,{}),'0xabcd');
  for(const current of ['redirect','status','declared','chunked','malformed','error','both','wrong-id','empty','oversize','odd']){
   mode=current;await assert.rejects(source(request,{}),/.+/,current);
  }
  assert.equal(requests,13,'no redirect following or retries');
  for(const current of ['hang','body-hang']){mode=current;await assert.rejects(source(request,{timeoutMs:30}),/deadline/);}
  const controller=new AbortController();controller.abort(new Error('cancelled'));const before=requests;
  await assert.rejects(source(request,{signal:controller.signal}),/cancelled/);assert.equal(requests,before);
  const active=new AbortController();mode='hang';const pending=source(request,{signal:active.signal});active.abort(new Error('cancelled active'));await assert.rejects(pending,/cancelled active/);
  assert.throws(()=>joyIdProofSource('https://user:secret@example.invalid'),/credentials/);
  assert.throws(()=>joyIdProofSource('https://example.invalid/#fragment'),/fragment/);
  assert.throws(()=>joyIdProofSource('file:///tmp/proof'),/HTTP/);
  await assert.rejects(source(request,{timeoutMs:Infinity}),/deadline/);
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
