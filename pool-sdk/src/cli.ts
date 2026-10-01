/** JSON stdin -> JSON stdout. Read-only RPC and unsigned bytes only. */
import {readSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {ccc} from '@ckb-ccc/core';
import {buildCreate,buildTransition,type Wallet,type Recipients,type CreateRequest} from './builders.js';
import {loadPool,liveCell,scanPools,assertPoolNetwork,type PoolClient,type PoolDeployment} from './pools.js';
import type {Operation} from '../../pool-model/src/model.js';
import {poolReadTransport} from './transport.js';

function integer(value:unknown):bigint {
 if(typeof value!=='string'||value.length>39||! /^(0|[1-9][0-9]*)$/.test(value))throw new Error('Amounts must be decimal strings of at most 39 digits');
 return BigInt(value);
}
function operation(a:Record<string,unknown>):Operation {
 if(a.kind==='swap'&&(a.direction==='xToY'||a.direction==='yToX'))return {kind:'swap',direction:a.direction,amountIn:integer(a.amountIn),minOut:integer(a.minOut)};
 if(a.kind==='deposit')return {kind:'deposit',maxX:integer(a.maxX),maxY:integer(a.maxY),minShares:integer(a.minShares)};
 if(a.kind==='withdraw')return {kind:'withdraw',shares:integer(a.shares),minX:integer(a.minX),minY:integer(a.minY)};
 throw new Error('Unsupported pool action');
}
export interface CliRequest {
 rpcUrl:string;deployment:PoolDeployment;command:'scan'|'create'|'transition';
 state?:ccc.OutPointLike;funding?:ccc.OutPointLike[];
 wallet?:{lock:ccc.ScriptLike;change:ccc.ScriptLike;deps:ccc.CellDepLike[];feeRate:string;maxFee:string};
 recipients?:Recipients;action?:Record<string,unknown>;
 create?:{feeBps:string;lockedShares:string;backing:{state:string;ckb:string;token:string};x:string;y:string;minShares:string;tokenOwner:ccc.Hex};
 scan?:{pageSize?:number;maxPages?:number;maxCandidates?:number};
}
export async function runRequest(request:CliRequest,client:PoolClient):Promise<unknown> {
 await assertPoolNetwork(client,request.deployment);
 if(request.command==='scan'){
  const pools=[],rejected:unknown[]=[];
  for await(const pool of scanPools(client,request.deployment,{...request.scan,onMalformed:(point,error)=>rejected.push({point,reason:error.message})}))pools.push({poolId:pool.poolId,state:pool.stateCell.outPoint,accounting:pool.accounting});
  return {pools,rejected,notice:'Bounded scan; absence is not proof that no pool exists.'};
 }
 if(request.command!=='create'&&request.command!=='transition')throw new Error('Expected scan, create or transition');
 if(!request.wallet||!request.recipients||!request.funding?.length||request.funding.length>256)throw new Error('Explicit wallet, recipients and bounded funding OutPoints required');
 const funding=[];for(const point of request.funding)funding.push(await liveCell(client,point));
 const wallet:Wallet={...request.wallet,feeRate:integer(request.wallet.feeRate),maxFee:integer(request.wallet.maxFee),funding};
 const built=await (async()=>{
  if(request.command==='create'){
   const r=request.create;if(!r)throw new Error('Missing create parameters');
   const create:CreateRequest={parameters:{feeBps:integer(r.feeBps),lockedShares:integer(r.lockedShares),backing:{state:integer(r.backing.state),ckb:integer(r.backing.ckb),token:integer(r.backing.token)}},x:integer(r.x),y:integer(r.y),minShares:integer(r.minShares),tokenOwner:r.tokenOwner};
   return buildCreate(request.deployment,wallet,request.recipients!,create);
  }
  if(!request.state||!request.action)throw new Error('Missing exact state OutPoint or action');
  return buildTransition(request.deployment,wallet,request.recipients!,await loadPool(client,request.deployment,request.state),operation(request.action));
 })();
 await built.assertFresh(client);
 return {unsigned:true,transaction:built.transaction,transactionBytes:ccc.hexFrom(built.transaction.toBytes()),poolId:built.poolId,
  fee:built.fee,ckbReceiptTopUp:built.ckbReceiptTopUp,walletWitnessIndex:built.walletWitnessIndex,result:built.result,
  warning:'Not signed or broadcast. Recheck live inputs and reviewed transaction before signing. Liveness is not a reservation.'};
}
async function main(){
 const buffer=Buffer.alloc(1_000_001);let size=0;
 while(size<buffer.length){const count=readSync(0,buffer,size,buffer.length-size,null);if(count===0)break;size+=count;}
 if(size>1_000_000)throw new Error('Request exceeds 1 MB');
 const source=buffer.subarray(0,size).toString('utf8');
 const request=JSON.parse(source) as CliRequest;
 // Only the supplied endpoint is used; no public fallback, known-script lookup or address parsing.
 const client=ccc.ClientPublicTestnet.new({transport:poolReadTransport(request.rpcUrl),maxConcurrent:1});
 console.log(JSON.stringify(await runRequest(request,client),(_,value)=>typeof value==='bigint'?value.toString():value,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(String(error));process.exitCode=1;});
