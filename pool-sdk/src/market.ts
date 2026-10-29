// Market data from committed transactions: order fills (v1 whole lots, v2 partial
// or final), pool swaps and liquidity changes, cancels and expiry returns. Pure
// functions over a transaction and its resolved input cells; no RPC here.
// Accounting mirrors the locks: v1 pays `capacityRefund + ask` (CKB) or the ask
// amount (UDT) at the order's index; v2 follows contracts/openswap-lock-v2 fill.rs.
import {ccc} from '@ckb-ccc/core';
import {decodeTerms,parseAmount} from '../../sdk/src/codec.js';
import {decodeTermsV2} from '../../sdk/src/v2/codec.js';
import {assetKey,CKB,udt,type AssetId} from '../../sdk/src/types.js';
import {parsePool,type PoolDeployment} from './pools.js';
import {decodeArgs,Role} from './codec.js';

export interface MarketSources {
 /** Order lock deployments by version. */
 orders:{version:1|2;codeHash:ccc.Hex}[];
 pools?:PoolDeployment;
}
export interface MarketTx {
 hash:ccc.Hex;block:bigint;/** Block timestamp, ms since the epoch. */time:bigint;
 tx:ccc.Transaction;/** Input cells, in input order. */inputs:ccc.Cell[];
}
/** One side of an exchange: the taker (or pool trader) received `got` and gave `gave`. */
export interface Trade {
 kind:'trade';venue:'order'|'pool';hash:ccc.Hex;block:bigint;time:bigint;
 /** Order outpoint (order fills) or pool id (swaps). */
 source:string;version?:1|2;final?:boolean;
 got:{asset:AssetId;amount:bigint};gave:{asset:AssetId;amount:bigint};
}
export interface OrderClose {kind:'cancel'|'return';hash:ccc.Hex;block:bigint;time:bigint;source:string;version:1|2}
export interface Liquidity {kind:'deposit'|'withdraw'|'create';hash:ccc.Hex;block:bigint;time:bigint;source:string;token:ccc.Script;ckb:bigint;tokenAmount:bigint}
export type MarketEvent=Trade|OrderClose|Liquidity;
/** Something in the transaction could not be interpreted; it is skipped, never guessed. */
export interface Skipped {hash:ccc.Hex;input:number;reason:string}

const key=(p:ccc.OutPointLike)=>{const o=ccc.OutPoint.from(p);return `${o.txHash}:${o.index}`;};
const amount=(asset:AssetId,cell:{cellOutput:ccc.CellOutput;outputData:ccc.Hex}|undefined)=>!cell?0n:asset.kind==='ckb'?cell.cellOutput.capacity:parseAmount(cell.outputData);

function orderEvent(m:MarketTx,i:number,version:1|2):Trade|OrderClose{
 const cell=m.inputs[i]!,lock=cell.cellOutput.lock,{tx}=m;
 const base={hash:m.hash,block:m.block,time:m.time,source:key(cell.outPoint),version};
 const terms=version===1?decodeTerms(lock.args):decodeTermsV2(lock.args);
 const offer:AssetId=cell.cellOutput.type?udt(cell.cellOutput.type):CKB;
 const out=tx.outputs[i],data=tx.outputsData[i];
 if(!out||data===undefined||!out.lock.eq(terms.ownerLock))throw new Error('No owner output at the order index');
 // Recovery (cancel or return) gives the owner the same asset back; a fill pays the ask asset.
 const sameType=(out.type?.hash()??null)===(cell.cellOutput.type?.hash()??null);
 if(sameType&&data===cell.outputData&&out.capacity>=cell.cellOutput.capacity)
  return {kind:version===2&&tx.inputs[i]!.since!==0n?'return':'cancel',...base};
 const askType=terms.askAsset.kind==='udt'?terms.askAsset.script:undefined;
 if((out.type?.hash()??null)!==(askType?.hash()??null))throw new Error('Owner output is neither recovery nor payment');
 const remainders=tx.outputs.flatMap((o,k)=>o.lock.eq(lock)?[{cellOutput:o,outputData:tx.outputsData[k]!}]:[]);
 if(remainders.length>1||(version===1&&remainders.length))throw new Error('Unexpected order recreation');
 const r=remainders[0],cIn=cell.cellOutput.capacity,cOut=r?.cellOutput.capacity??0n;
 let taken:bigint,paid:bigint;
 if(version===1){
  taken=offer.kind==='ckb'?cIn-terms.capacityRefund:parseAmount(cell.outputData);
  paid=terms.askAsset.kind==='ckb'?out.capacity-terms.capacityRefund:parseAmount(data);
 }else{
  const leaving=cIn-cOut;
  taken=offer.kind==='ckb'?leaving-out.capacity:parseAmount(cell.outputData)-(r?parseAmount(r.outputData):0n);
  paid=terms.askAsset.kind==='ckb'?out.capacity-leaving:parseAmount(data);
 }
 if(taken<=0n||paid<=0n)throw new Error('Non-positive fill');
 return {kind:'trade',venue:'order',...base,final:!r,got:{asset:offer,amount:taken},gave:{asset:terms.askAsset,amount:paid}};
}

function poolEvents(m:MarketTx,pools:PoolDeployment,skipped:Skipped[]):(Trade|Liquidity)[]{
 const {tx}=m,events:(Trade|Liquidity)[]=[];
 const isState=(t:ccc.Script|undefined)=>{if(!t||t.codeHash!==pools.codeHash||t.hashType!=='data1')return false;try{return decodeArgs(t.args).role===Role.StateType;}catch{return false;}};
 const outputCell=(index:number)=>ccc.Cell.from({outPoint:{txHash:m.hash,index},cellOutput:tx.outputs[index]!,outputData:tx.outputsData[index]!});
 for(const [k,o] of tx.outputs.entries()){
  if(!isState(o.type))continue;
  const poolId=decodeArgs(o.type!.args).poolId;
  try{
   const outState=outputCell(k);
   const outMeta=decodeStateIndexes(outState);
   const now=parsePool(pools,outState,outputCell(outMeta.rx),outputCell(outMeta.ry));
   const i=m.inputs.findIndex(c=>c.cellOutput.type?.eq(o.type!));
   if(i<0){events.push({kind:'create',hash:m.hash,block:m.block,time:m.time,source:poolId,token:now.token,ckb:now.accounting.x,tokenAmount:now.accounting.y});continue;}
   const inState=m.inputs[i]!,inMeta=decodeStateIndexes(inState);
   const sibling=(index:number)=>m.inputs.find(c=>c.outPoint.eq({txHash:inState.outPoint.txHash,index}));
   const ckbIn=sibling(inMeta.rx),tokenIn=sibling(inMeta.ry);
   if(!ckbIn||!tokenIn)throw new Error('Pool reserves not spent with the state');
   const before=parsePool(pools,inState,ckbIn,tokenIn);
   const dx=now.accounting.x-before.accounting.x,dy=now.accounting.y-before.accounting.y;
   const token=udt(now.token);
   if(dx>0n&&dy<0n)events.push({kind:'trade',venue:'pool',hash:m.hash,block:m.block,time:m.time,source:poolId,got:{asset:token,amount:-dy},gave:{asset:CKB,amount:dx}});
   else if(dx<0n&&dy>0n)events.push({kind:'trade',venue:'pool',hash:m.hash,block:m.block,time:m.time,source:poolId,got:{asset:CKB,amount:-dx},gave:{asset:token,amount:dy}});
   else if(dx>=0n&&dy>=0n&&now.accounting.totalShares>before.accounting.totalShares)events.push({kind:'deposit',hash:m.hash,block:m.block,time:m.time,source:poolId,token:now.token,ckb:dx,tokenAmount:dy});
   else if(dx<=0n&&dy<=0n&&now.accounting.totalShares<before.accounting.totalShares)events.push({kind:'withdraw',hash:m.hash,block:m.block,time:m.time,source:poolId,token:now.token,ckb:-dx,tokenAmount:-dy});
   else throw new Error('Pool transition is neither a swap nor a liquidity change');
  }catch(e){skipped.push({hash:m.hash,input:-1,reason:`pool ${poolId}: ${e instanceof Error?e.message:String(e)}`});}
 }
 return events;
}
/** Reserve output indexes recorded in a pool state cell (rx at byte 64, ry at 68). */
function decodeStateIndexes(state:ccc.Cell):{rx:number;ry:number}{
 const b=ccc.bytesFrom(state.outputData);
 if(b.length!==190)throw new Error('Not a pool state cell');
 const u32=(at:number)=>b[at]!|(b[at+1]!<<8)|(b[at+2]!<<16)|(b[at+3]!<<24);
 return {rx:u32(64)>>>0,ry:u32(68)>>>0};
}

/** Every market event in one committed transaction. */
export function marketEvents(m:MarketTx,sources:MarketSources):{events:MarketEvent[];skipped:Skipped[]}{
 if(m.inputs.length!==m.tx.inputs.length)throw new Error('Resolve every input cell first');
 const events:MarketEvent[]=[],skipped:Skipped[]=[];
 for(const [i,cell] of m.inputs.entries()){
  const lock=cell.cellOutput.lock;
  const source=lock.hashType==='data1'?sources.orders.find(o=>o.codeHash===lock.codeHash):undefined;
  if(!source)continue;
  try{events.push(orderEvent(m,i,source.version));}
  catch(e){skipped.push({hash:m.hash,input:i,reason:e instanceof Error?e.message:String(e)});}
 }
 if(sources.pools)events.push(...poolEvents(m,sources.pools,skipped));
 return {events,skipped};
}

// Pairs and prices -----------------------------------------------------------------------
/** A market: base priced in quote. CKB is always the quote; between two tokens the
 * quote is the one with the smaller script hash, so every trade maps to one market. */
export interface Pair {base:AssetId;quote:AssetId;key:string}
export function pairOf(a:AssetId,b:AssetId):Pair{
 if(assetKey(a)===assetKey(b))throw new Error('Same-asset pair');
 const [base,quote]=b.kind==='ckb'?[a,b]:a.kind==='ckb'?[b,a]:assetKey(a)>assetKey(b)?[a,b]:[b,a];
 return {base,quote,key:`${assetKey(base)}/${assetKey(quote)}`};
}
/** A trade seen from its market: the taker bought or sold base, and the exact price. */
export interface Print {pair:Pair;side:'buy'|'sell';base:bigint;quote:bigint;trade:Trade}
export function print(trade:Trade):Print{
 const pair=pairOf(trade.got.asset,trade.gave.asset);
 const buy=assetKey(trade.got.asset)===assetKey(pair.base);
 return {pair,side:buy?'buy':'sell',base:buy?trade.got.amount:trade.gave.amount,quote:buy?trade.gave.amount:trade.got.amount,trade};
}
