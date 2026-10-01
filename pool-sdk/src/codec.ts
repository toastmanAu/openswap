/** Draft pool ABI. Decoding proves byte shape, not chain authenticity. */
import {ccc} from '@ckb-ccc/core';
import {readLE,writeLE} from '../../sdk/src/codec.js';
import type {Operation} from '../../pool-model/src/model.js';

export enum Role {StateType=0,StateLock=1,CkbLock=2,TokenLock=3,LpType=4}
export interface PoolArgs {role:Role;poolId:ccc.Hex}
export interface StateData {
 fee:bigint;locked:bigint;shares:bigint;
 backingState:bigint;backingCkb:bigint;backingToken:bigint;
 rx:bigint;ry:bigint;tokenCodeHash:ccc.Hex;tokenOwner:ccc.Hex;
}
export type Action=Operation|{kind:'create';minShares:bigint};
export const XUDT_CODE_HASH:ccc.Hex='0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95';
const U64=(1n<<64n)-1n,U128=(1n<<128n)-1n,Y_MAX=(1n<<112n)-1n;
export class PoolWireError extends Error {
 constructor(readonly code:number){super(`Pool wire error ${code}`);this.name='PoolWireError';}
}
function check(ok:unknown,code:number):asserts ok {if(!ok)throw new PoolWireError(code);}
function bounded(input:Uint8Array|ccc.Hex,max:number):Uint8Array {
 const size=typeof input==='string'?(input.length-2)/2:input.length;check(size<=max,2);
 if(typeof input==='string'){check(/^0x(?:[0-9a-fA-F]{2})*$/.test(input),3);return ccc.bytesFrom(input);}
 return input;
}
function exact(input:Uint8Array|ccc.Hex,size:number):Uint8Array {const b=bounded(input,size);check(b.length===size,3);return b;}
function header(b:Uint8Array,magic:string){check(b.length>=6&&new TextDecoder().decode(b.subarray(0,4))===magic,3);check(b[4]===1,4);}
function range(n:bigint,lo:bigint,hi:bigint){check(typeof n==='bigint'&&n>=lo&&n<=hi,21);}
function hash(h:ccc.Hex){return exact(h,32);}
export function decodeArgs(input:Uint8Array|ccc.Hex):PoolArgs {
 const b=exact(input,38);header(b,'TPL1');check(b[5]!<=4,4);
 return {role:b[5]!,poolId:ccc.hexFrom(b.subarray(6))};
}
export function encodeArgs(a:PoolArgs):ccc.Hex {
 check(Number.isInteger(a.role)&&a.role>=0&&a.role<=4,4);
 return ccc.hexFrom(ccc.bytesConcat(new TextEncoder().encode('TPL1'),[1,a.role],hash(a.poolId)));
}
export function validateStateData(s:StateData):void {
 range(s.fee,0n,9999n);range(s.locked,1n,U128);range(s.shares,s.locked,U128);
 range(s.backingState,1n,U64);range(s.backingCkb,1n,U64-1n);range(s.backingToken,1n,U64);
 range(s.rx,0n,(1n<<32n)-1n);range(s.ry,0n,(1n<<32n)-1n);
 check(s.rx<256n&&s.ry<256n,2);check(s.rx!==s.ry,7);hash(s.tokenCodeHash);hash(s.tokenOwner);
}
export function decodeState(input:Uint8Array|ccc.Hex):StateData {
 const b=exact(input,190);header(b,'TPS1');check(b[5]===0&&b[104]===2,4);
 check(b[105]===32&&b.subarray(138).every(v=>v===0),3);
 const n=(at:number,size:number)=>readLE(b.subarray(at,at+size));
 const s={fee:n(6,2),locked:n(8,16),shares:n(24,16),backingState:n(40,8),backingCkb:n(48,8),backingToken:n(56,8),
  rx:n(64,4),ry:n(68,4),tokenCodeHash:ccc.hexFrom(b.subarray(72,104)),tokenOwner:ccc.hexFrom(b.subarray(106,138))};
 validateStateData(s);return s;
}
export function encodeState(s:StateData):ccc.Hex {
 validateStateData(s);const b=new Uint8Array(190);b.set(new TextEncoder().encode('TPS1'));b[4]=1;
 for(const [at,n,size] of [[6,s.fee,2],[8,s.locked,16],[24,s.shares,16],[40,s.backingState,8],[48,s.backingCkb,8],
  [56,s.backingToken,8],[64,s.rx,4],[68,s.ry,4]] as const)b.set(writeLE(n,size),at);
 b.set(hash(s.tokenCodeHash),72);b[104]=2;b[105]=32;b.set(hash(s.tokenOwner),106);return ccc.hexFrom(b);
}
export function actionFields(a:Action):{tag:number;values:bigint[]} {
 switch(a.kind){
  case 'create':return {tag:0,values:[a.minShares]};
  case 'swap':check(a.direction==='xToY'||a.direction==='yToX',4);return {tag:a.direction==='xToY'?1:2,values:[a.amountIn,a.minOut]};
  case 'deposit':return {tag:3,values:[a.maxX,a.maxY,a.minShares]};
  case 'withdraw':return {tag:4,values:[a.shares,a.minX,a.minY]};
  default:throw new PoolWireError(4);
 }
}
export function validateAction(a:Action):void {
 const {tag,values}=actionFields(a);
 const limits=[[U128],[U64-1n,Y_MAX],[Y_MAX,U64-1n],[U64-1n,Y_MAX,U128],[U128,U64-1n,Y_MAX]][tag]!;
 values.forEach((v,i)=>range(v,1n,limits[i]!));
}
export function decodeAction(input:Uint8Array|ccc.Hex):Action {
 const b=bounded(input,56);header(b,'TPA1');const tag=b[5]!;check(tag<=4,4);
 const count=[1,2,2,3,3][tag]!;check(b.length===8+16*count,3);check(b[6]===0&&b[7]===0,3);
 const n=(at:number)=>readLE(b.subarray(at,at+16));
 const a:Action=tag===0?{kind:'create',minShares:n(8)}:tag<=2?{kind:'swap',direction:tag===1?'xToY':'yToX',amountIn:n(8),minOut:n(24)}:
  tag===3?{kind:'deposit',maxX:n(8),maxY:n(24),minShares:n(40)}:{kind:'withdraw',shares:n(8),minX:n(24),minY:n(40)};
 validateAction(a);return a;
}
export function encodeAction(a:Action):ccc.Hex {
 validateAction(a);const {tag,values}=actionFields(a);
 return ccc.hexFrom(ccc.bytesConcat(new TextEncoder().encode('TPA1'),[1,tag,0,0],...values.map(n=>writeLE(n,16))));
}
function table3(input:Uint8Array|ccc.Hex,max:number):Uint8Array[] {
 const b=bounded(input,max);check(b.length>=16&&readLE(b.subarray(0,4))===BigInt(b.length),3);
 const [a,c,d]=[4,8,12].map(i=>Number(readLE(b.subarray(i,i+4))));
 check(a===16&&a<=c!&&c!<=d!&&d!<=b.length,3);return [b.subarray(a,c),b.subarray(c,d),b.subarray(d)];
}
function bytes(b:Uint8Array):Uint8Array {check(b.length>=4&&readLE(b.subarray(0,4))===BigInt(b.length-4),3);return b.subarray(4);}
export function decodePoolScript(input:Uint8Array|ccc.Hex):{codeHash:ccc.Hex;args:PoolArgs} {
 const [h,t,a]=table3(input,512);check(h!.length===32&&t!.length===1,3);check(t![0]===2,5);
 return {codeHash:ccc.hexFrom(h!),args:decodeArgs(bytes(a!))};
}
export function poolScript(codeHash:ccc.Hex,poolId:ccc.Hex,role:Role):ccc.Script {
 hash(codeHash);return ccc.Script.from({codeHash,hashType:'data1',args:encodeArgs({role,poolId})});
}
export function decodeWitness(input:Uint8Array|ccc.Hex,genesis:boolean):Action {
 const fields=table3(input,4096).map(b=>b.length?bytes(b):undefined);
 const selected=fields[genesis?2:1];check(selected!==undefined,3);const a=decodeAction(selected);
 check(genesis===(a.kind==='create'),4);return a;
}
export function actionWitness(a:Action):ccc.Hex {
 const data=encodeAction(a);
 return ccc.hexFrom(ccc.WitnessArgs.from(a.kind==='create'?{outputType:data}:{inputType:data}).toBytes());
}
