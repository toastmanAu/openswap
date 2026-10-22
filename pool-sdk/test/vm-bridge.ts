// Invoked by Rust CKB-VM tests. Only public deterministic in-memory fixture cells.
import {readFileSync} from 'node:fs';
import {ccc} from '@ckb-ccc/core';
import {buildCreate,buildTransition} from '../src/builders.js';
import {parsePool} from '../src/pools.js';
import type {Operation} from '../../pool-model/src/model.js';
const input=JSON.parse(readFileSync(0,'utf8'));
const dep=(s:ccc.Hex)=>({outPoint:ccc.OutPoint.fromBytes(s),depType:'code' as const});
const cell=(s:{point:ccc.Hex;output:ccc.Hex;data:ccc.Hex})=>ccc.Cell.from({outPoint:ccc.OutPoint.fromBytes(s.point),cellOutput:ccc.CellOutput.fromBytes(s.output),outputData:s.data});
const deployment={genesisHash:`0x${'00'.repeat(32)}` as ccc.Hex,codeHash:input.codeHash,poolDep:dep(input.poolDep),tokenDep:dep(input.tokenDep)};
const lock=ccc.Script.fromBytes(input.lock);
const wallet={lock,change:lock,deps:input.lockDeps.map(dep),funding:input.funding.map(cell),feeRate:1000n,maxFee:10000n,witness:input.walletWitness};
const recipients={ckb:lock,token:lock,lp:input.lpRecipient?ccc.Script.fromBytes(input.lpRecipient):lock};
const pool=input.previous?parsePool(deployment,...(input.previous.map(cell) as [ccc.Cell,ccc.Cell,ccc.Cell])):undefined;
const actions={xToY:{kind:'swap',direction:'xToY',amountIn:10000000000n,minOut:1n},yToX:{kind:'swap',direction:'yToX',amountIn:10000000000n,minOut:1n},deposit:{kind:'deposit',maxX:10000000000n,maxY:40000000000n,minShares:1n},withdraw:{kind:'withdraw',shares:pool?pool.accounting.totalShares-pool.accounting.lockedShares:1n,minX:1n,minY:1n}} satisfies Record<string,Operation>;
if(input.random!==undefined&&pool){
 const random=BigInt(input.random),x=(random%10000n+1n)*1000000n,y=((random>>12n)%10000n+1n)*4000000n;
 actions.xToY.amountIn=x;actions.yToX.amountIn=y;actions.deposit.maxX=x;actions.deposit.maxY=y;
 actions.withdraw.shares=(pool.accounting.totalShares-pool.accounting.lockedShares)*(random%999n+1n)/10000n;
}
// Regime tests size operations relative to current reserves, including after a
// full withdrawal. No production builder or accounting rule is substituted.
if(input.relativeRandom!==undefined&&pool){
 const r=BigInt(input.relativeRandom),divisor=20n+r%80n;
 const x=pool.accounting.x/divisor||1n,y=pool.accounting.y/divisor||1n;
 actions.xToY.amountIn=x;actions.yToX.amountIn=y;
 actions.deposit.maxX=x;actions.deposit.maxY=y;
 actions.withdraw.shares=(pool.accounting.totalShares-pool.accounting.lockedShares)/divisor||1n;
}
if(input.fullWithdraw&&pool)actions.withdraw.shares=pool.accounting.totalShares-pool.accounting.lockedShares;
if(input.reenter){actions.deposit.maxX=BigInt(input.reenter.x);actions.deposit.maxY=BigInt(input.reenter.y);}
const initial=input.initial??{fee:'30',locked:'1000',x:'1000000000000',y:'4000000000000'};
const built=pool?buildTransition(deployment,wallet,recipients,pool,actions[input.action as keyof typeof actions]):buildCreate(deployment,wallet,recipients,{parameters:{feeBps:BigInt(initial.fee),lockedShares:BigInt(initial.locked),backing:{state:34000000000n,ckb:8000000000n,token:16000000000n}},x:BigInt(initial.x),y:BigInt(initial.y),minShares:1n,tokenOwner:`0x${'11'.repeat(32)}`});
built.assertIntegrity();
console.log(JSON.stringify({transaction:ccc.hexFrom(built.transaction.toBytes()),walletWitnessIndex:built.walletWitnessIndex}));
