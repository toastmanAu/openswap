/** Offline single-owner create fixture shared by funding and recovery tests. */
import {readFileSync} from 'node:fs';
import {ccc} from '@ckb-ccc/core';
import {writeLE} from '../../sdk/src/codec.js';
import {fundPoolTransaction,PoolFundingReservations,type FundingOptions} from '../src/funding.js';
import {pointKey,type PoolClient,type PoolDeployment} from '../src/pools.js';
import {XUDT_CODE_HASH} from '../src/codec.js';

export const hash=(n:number)=>`0x${n.toString(16).padStart(2,'0').repeat(32)}` as ccc.Hex;
export const dep=(n:number)=>({outPoint:{txHash:hash(n),index:0},depType:'code' as const});
export const request={parameters:{feeBps:30n,lockedShares:1000n,backing:{state:34_000_000_000n,ckb:8_000_000_000n,token:16_000_000_000n}},x:10n**12n,y:4n*10n**12n,minShares:1n,tokenOwner:hash(7)};
export function fixture(){
 const lock=ccc.Script.from({codeHash:hash(8),hashType:'type',args:'0x0001'});
 const token=ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:hash(7)});
 const cell=(n:number,capacity:bigint,data:ccc.Hex='0x',type?:ccc.Script)=>ccc.Cell.from({outPoint:dep(n).outPoint,cellOutput:{capacity,lock:lock.clone(),type:type?.clone()},outputData:data});
 const asset=cell(10,20_000_000_000n,ccc.hexFrom(writeLE(request.y,16)),token);
 const cash=cell(11,2n*10n**12n),small=cell(12,100_000_000_000n);
 const deployment:PoolDeployment={genesisHash:hash(1),codeHash:ccc.hashCkb('0x1234'),poolDep:dep(3),tokenDep:dep(4)};
 const cells=new Map([asset,cash,small,cell(3,10n**14n,'0x1234'),cell(4,10n**14n,ccc.hexFrom(readFileSync(new URL('../../tests/fixtures/xudt',import.meta.url))))].map(c=>[pointKey(c.outPoint),c]));
 let page=[small,asset,cash],cursor='0x01',reads=0;
 const client={getHeaderByNumberNoCache:async()=>({hash:deployment.genesisHash}),getCellLiveNoCache:async(p:ccc.OutPointLike)=>{reads++;return cells.get(pointKey(p))?.clone();},findCellsPagedNoCache:async()=>({cells:page.map(c=>c.clone()),lastCursor:cursor})} as unknown as PoolClient;
 const wallet={lock,change:lock,deps:[dep(9)],witness:{kind:'joyid' as const},feeRate:1000n,maxFee:10000n};
 const reservations=new PoolFundingReservations();
 const run=(options:Partial<FundingOptions>={})=>fundPoolTransaction(client,deployment,wallet,{ckb:lock,token:lock,lp:lock},{kind:'create',request},{reservations,...options});
 return {asset,cash,small,cell,token,lock,cells,client,deployment,wallet,reservations,run,setPage:(p:ccc.Cell[],c='0x01')=>{page=p;cursor=c;},reads:()=>reads};
}
