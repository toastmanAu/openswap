import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {poolReadTransport} from '../src/transport.js';
test('bounded transport rejects redirects, writes, oversized bodies, bad envelopes, HTTP failures and hanging reads',async()=>{
 let mode='valid',requests=0;
 const server=createServer((request,response)=>{
  requests++;request.resume();
  if(mode==='hang')return;
  if(mode==='redirect'){response.writeHead(302,{location:'/redirected'});response.end();return;}
  if(mode==='status'){response.writeHead(503);response.end('unavailable');return;}
  if(mode==='declared'){response.writeHead(200,{'content-length':'2048'});response.flushHeaders();return;}
  if(mode==='chunked'){response.write(' '.repeat(600));response.end(' '.repeat(600));return;}
  if(mode==='malformed'){response.end('{');return;}
  if(mode==='wrong-id'){response.end(JSON.stringify({jsonrpc:'2.0',id:99,result:[]}));return;}
  if(mode==='both'){response.end(JSON.stringify({jsonrpc:'2.0',id:1,result:[],error:{code:1,message:'bad'}}));return;}
  response.end(JSON.stringify({jsonrpc:'2.0',id:1,result:[]}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
  const payload={id:1,jsonrpc:'2.0' as const,method:'get_cells',params:[]};
  const transport=poolReadTransport(url,{maxBytes:1024,timeoutMs:1000});
  assert.deepEqual((await transport.request(payload)).result,[]);
  for(const method of ['send_transaction','send_alert','estimate_cycles'])await assert.rejects(transport.request({...payload,method}),/read-only/);
  assert.equal(requests,1);
  for(const current of ['redirect','status','declared','chunked','malformed','wrong-id','both']){mode=current;await assert.rejects(transport.request(payload),/.+/,current);}
  assert.equal(requests,8,'redirect was not followed');
  mode='hang';await assert.rejects(poolReadTransport(url,{timeoutMs:30}).request(payload),/deadline/);
  const controller=new AbortController();controller.abort(new Error('cancelled'));
  const before=requests;await assert.rejects(poolReadTransport(url,{signal:controller.signal}).request(payload),/cancelled/);assert.equal(requests,before);
  const active=new AbortController(),pending=poolReadTransport(url,{signal:active.signal}).request(payload);active.abort(new Error('cancelled active'));await assert.rejects(pending,/cancelled active/);
  assert.throws(()=>poolReadTransport('https://user:secret@example.invalid'),/credentials/);
  assert.throws(()=>poolReadTransport(url,{maxBytes:Infinity}),/bound/);
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
