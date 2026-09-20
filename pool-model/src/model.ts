/** Executable draft accounting model, not a transaction builder or consensus contract. */
import {isDeepStrictEqual} from 'node:util';
export const U64_MAX=(1n<<64n)-1n;
export const RESERVE_MAX=(1n<<112n)-1n;
export const SHARE_MAX=(1n<<128n)-1n;
export const U256_MAX=(1n<<256n)-1n;
export const FEE_DENOMINATOR=10_000n;
export interface Backing {readonly state:bigint;readonly ckb:bigint;readonly token:bigint}
export interface Parameters {
 readonly feeBps:bigint;
 /** Virtual shares: counted in totalShares, never issued to a wallet or redeemable. */
 readonly lockedShares:bigint;
 readonly backing:Backing;
}
export interface PoolState extends Parameters {readonly x:bigint;readonly y:bigint;readonly totalShares:bigint}
export type Operation =
 | {kind:'swap';direction:'xToY'|'yToX';amountIn:bigint;minOut:bigint}
 | {kind:'deposit';maxX:bigint;maxY:bigint;minShares:bigint}
 | {kind:'withdraw';shares:bigint;minX:bigint;minY:bigint};
export interface Flows {
 readonly paidX:bigint;readonly paidY:bigint;readonly receivedX:bigint;readonly receivedY:bigint;
 readonly mintedShares:bigint;readonly burnedShares:bigint;
 /** Unused budget, not a token input or automatic on-chain refund. */
 readonly unusedX:bigint;readonly unusedY:bigint;
}
export interface Result {readonly next:PoolState;readonly flows:Flows}
export type ErrorCode='INTEGER'|'RANGE'|'OVERFLOW'|'PARAMETERS'|'STATE'|'ZERO_OUTPUT'|'SLIPPAGE'|'SHARES'|'OPERATION'|'TRANSITION';
export class ModelError extends Error {
 constructor(readonly code:ErrorCode){super(code);this.name='ModelError';}
}
function requireCondition(condition:unknown,code:ErrorCode):asserts condition {if(!condition)throw new ModelError(code);}
function integer(value:bigint,min:bigint,max:bigint):void {
 requireCondition(typeof value==='bigint','INTEGER');requireCondition(value>=min&&value<=max,'RANGE');
}
function add(a:bigint,b:bigint):bigint {const value=a+b;requireCondition(value<=U256_MAX,'OVERFLOW');return value;}
function mul(a:bigint,b:bigint):bigint {const value=a*b;requireCondition(value<=U256_MAX,'OVERFLOW');return value;}
function ceilDiv(a:bigint,b:bigint):bigint {return a/b+(a%b===0n?0n:1n);}
/** Floor square root, using only bounded integer division and addition. */
export function sqrtFloor(n:bigint):bigint {
 integer(n,0n,U256_MAX);if(n<2n)return n;
 let x=n,y=n/2n+n%2n;
 while(y<x){x=y;y=add(x,n/x)/2n;}
 return x;
}
function validateParameters(p:Parameters):void {
 integer(p.feeBps,0n,FEE_DENOMINATOR-1n);integer(p.lockedShares,1n,SHARE_MAX);
 integer(p.backing.state,1n,U64_MAX);integer(p.backing.ckb,1n,U64_MAX-1n);integer(p.backing.token,1n,U64_MAX);
}
export function maxCkbReserve(p:Parameters):bigint {validateParameters(p);return U64_MAX-p.backing.ckb;}
export function validateState(s:PoolState):void {
 validateParameters(s);integer(s.x,1n,maxCkbReserve(s));integer(s.y,1n,RESERVE_MAX);
 integer(s.totalShares,s.lockedShares,SHARE_MAX);
 // Preserved from geometric-mean genesis by all supported transitions.
 requireCondition(mul(s.totalShares,s.totalShares)<=mul(s.x,s.y),'STATE');
}
function state(p:Parameters,x:bigint,y:bigint,totalShares:bigint):PoolState {
 const next={feeBps:p.feeBps,lockedShares:p.lockedShares,backing:{...p.backing},x,y,totalShares};validateState(next);return next;
}
function flows(values:Partial<Flows>):Flows {
 return {paidX:0n,paidY:0n,receivedX:0n,receivedY:0n,mintedShares:0n,burnedShares:0n,unusedX:0n,unusedY:0n,...values};
}
export function circulatingShares(s:PoolState):bigint {validateState(s);return s.totalShares-s.lockedShares;}
/** Each capacity is a u64; x alone is the tradeable CKB reserve. */
export function capacities(s:PoolState):Backing {
 validateState(s);return {state:s.backing.state,ckb:add(s.backing.ckb,s.x),token:s.backing.token};
}
export function createPool(p:Parameters,x:bigint,y:bigint,minShares:bigint):Result {
 validateParameters(p);integer(x,1n,maxCkbReserve(p));integer(y,1n,RESERVE_MAX);integer(minShares,1n,SHARE_MAX);
 const totalShares=sqrtFloor(mul(x,y));requireCondition(totalShares>p.lockedShares,'SHARES');
 const mintedShares=totalShares-p.lockedShares;requireCondition(mintedShares>=minShares,'SLIPPAGE');
 return {next:state(p,x,y,totalShares),flows:flows({paidX:x,paidY:y,mintedShares})};
}
export function swap(s:PoolState,direction:'xToY'|'yToX',amountIn:bigint,minOut:bigint):Result {
 validateState(s);requireCondition(direction==='xToY'||direction==='yToX','OPERATION');
 const forward=direction==='xToY',input=forward?s.x:s.y,output=forward?s.y:s.x;
 integer(amountIn,1n,forward?maxCkbReserve(s):RESERVE_MAX);integer(minOut,1n,forward?RESERVE_MAX:maxCkbReserve(s));
 const updatedInput=add(input,amountIn);requireCondition(updatedInput<=(forward?maxCkbReserve(s):RESERVE_MAX),'RANGE');
 const effective=mul(amountIn,FEE_DENOMINATOR-s.feeBps);
 const amountOut=mul(effective,output)/add(mul(input,FEE_DENOMINATOR),effective);
 requireCondition(amountOut>0n&&amountOut<output,'ZERO_OUTPUT');requireCondition(amountOut>=minOut,'SLIPPAGE');
 return {
  next:state(s,forward?updatedInput:output-amountOut,forward?output-amountOut:updatedInput,s.totalShares),
  flows:flows(forward?{paidX:amountIn,receivedY:amountOut}:{paidY:amountIn,receivedX:amountOut}),
 };
}
export function deposit(s:PoolState,maxX:bigint,maxY:bigint,minShares:bigint):Result {
 validateState(s);integer(maxX,1n,maxCkbReserve(s));integer(maxY,1n,RESERVE_MAX);integer(minShares,1n,SHARE_MAX);
 const byX=mul(maxX,s.totalShares)/s.x,byY=mul(maxY,s.totalShares)/s.y;
 const mintedShares=byX<byY?byX:byY;requireCondition(mintedShares>0n,'SHARES');
 requireCondition(mintedShares>=minShares,'SLIPPAGE');
 // Mint first, then charge the minimum whole base units backing those shares.
 const paidX=ceilDiv(mul(mintedShares,s.x),s.totalShares),paidY=ceilDiv(mul(mintedShares,s.y),s.totalShares);
 requireCondition(paidX<=maxX&&paidY<=maxY,'STATE');
 return {next:state(s,add(s.x,paidX),add(s.y,paidY),add(s.totalShares,mintedShares)),
  flows:flows({paidX,paidY,mintedShares,unusedX:maxX-paidX,unusedY:maxY-paidY})};
}
export function withdraw(s:PoolState,shares:bigint,minX:bigint,minY:bigint):Result {
 validateState(s);integer(shares,1n,SHARE_MAX);integer(minX,1n,maxCkbReserve(s));integer(minY,1n,RESERVE_MAX);
 requireCondition(shares<=s.totalShares-s.lockedShares,'SHARES');
 const receivedX=mul(shares,s.x)/s.totalShares,receivedY=mul(shares,s.y)/s.totalShares;
 requireCondition(receivedX>0n&&receivedY>0n,'ZERO_OUTPUT');requireCondition(receivedX>=minX&&receivedY>=minY,'SLIPPAGE');
 return {next:state(s,s.x-receivedX,s.y-receivedY,s.totalShares-shares),flows:flows({receivedX,receivedY,burnedShares:shares})};
}
export function transition(s:PoolState,operation:Operation):Result {
 switch(operation.kind){
  case 'swap':return swap(s,operation.direction,operation.amountIn,operation.minOut);
  case 'deposit':return deposit(s,operation.maxX,operation.maxY,operation.minShares);
  case 'withdraw':return withdraw(s,operation.shares,operation.minX,operation.minY);
  default:throw new ModelError('OPERATION');
 }
}
/** Strict draft accounting relation; does not verify cell identity or wallet signatures. */
export function validateTransition(before:PoolState,operation:Operation,claimed:Result):void {
 requireCondition(isDeepStrictEqual(transition(before,operation),claimed),'TRANSITION');
}
