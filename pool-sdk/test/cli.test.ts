import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
function cli(source:string):Promise<{code:number|null;out:string;error:string}>{
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','pool-sdk/src/cli.ts'],{cwd:new URL('../../',import.meta.url),stdio:['pipe','pipe','pipe']});
  let out='',error='';const timer=setTimeout(()=>{child.kill();reject(new Error('CLI test exceeded 10 seconds'));},10000);
  child.stdout.on('data',chunk=>{out+=chunk;});child.stderr.on('data',chunk=>{error+=chunk;});
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);resolve({code,out,error});});
  child.stdin.on('error',()=>{});child.stdin.end(source);
 });
}
test('real CLI uses only supplied local read-only RPC and fails closed for network/response errors',async()=>{
 const hash=`0x${'11'.repeat(32)}`,calls:string[]=[];
 let mode:'valid'|'wrong-network'|'malformed'='valid';
 const server=createServer((request,response)=>{
  let body='';request.on('data',chunk=>{body+=chunk;});request.on('end',()=>{
   const rpc=JSON.parse(body);calls.push(rpc.method);
   const header={hash:mode==='wrong-network'?`0x${'22'.repeat(32)}`:hash,version:'0x0',compact_target:'0x0',timestamp:'0x0',number:'0x0',epoch:'0x0',parent_hash:hash,transactions_root:hash,proposals_hash:hash,extra_hash:hash,dao:hash,nonce:'0x0'};
   const result=rpc.method==='get_header_by_number'?header:mode==='malformed'?{objects:[],last_cursor:'not hex'}:{objects:[],last_cursor:'0x'};
   response.setHeader('content-type','application/json');response.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const dep={outPoint:{txHash:hash,index:0},depType:'code'};
  const request={rpcUrl:`http://127.0.0.1:${address.port}`,command:'scan',deployment:{genesisHash:hash,codeHash:hash,poolDep:dep,tokenDep:dep}};
  const good=await cli(JSON.stringify(request));assert.equal(good.code,0,good.error);assert.deepEqual(JSON.parse(good.out).pools,[]);
  assert.ok(calls.includes('get_cells'));assert.ok(calls.every(method=>['get_header_by_number','get_cells'].includes(method)));
  mode='wrong-network';calls.length=0;const wrong=await cli(JSON.stringify(request));assert.equal(wrong.code,1);assert.match(wrong.error,/genesis mismatch/);assert.deepEqual(calls,['get_header_by_number']);
  mode='malformed';const malformed=await cli(JSON.stringify(request));assert.equal(malformed.code,1);assert.match(malformed.error,/cursor/);
  calls.length=0;const oversized=await cli(' '.repeat(1_000_001));assert.equal(oversized.code,1);assert.match(oversized.error,/1 MB/);assert.equal(calls.length,0);
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
