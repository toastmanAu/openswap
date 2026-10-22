/** Seeded differential campaign: random pool walks through the TypeScript model,
 * self-checked with validateTransition, then compared vector by vector against
 * the Rust arithmetic checker in chunks.
 *
 * Stops at the vector budget (stop=budget), the optional wall-clock budget
 * (stop=time) or the first mismatch/oracle failure (stop=failure). The same seed
 * regenerates the same vector stream, so a failure reproduces by seed alone.
 * Usage: tsx pool-model/src/campaign.ts --seed=N [--cases=N] [--seconds=N] [--chunk=N] */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createPool,transition,validateTransition,circulatingShares,ModelError,U64_MAX,RESERVE_MAX,SHARE_MAX,FEE_DENOMINATOR,type Operation,type Parameters,type PoolState,type Result} from './model.js';

const options=new Map(process.argv.slice(2).map(arg=>{
 const match=/^--(seed|cases|seconds|chunk)=(\d+)$/.exec(arg);if(!match)throw new Error(`Unknown or malformed option ${arg}`);
 return [match[1]!,BigInt(match[2]!)] as const;
}));
const seed=options.get('seed');if(seed===undefined)throw new Error('--seed=N is required');
const budget=Number(options.get('cases')??100_000n),seconds=options.has('seconds')?Number(options.get('seconds')):undefined,chunk=Number(options.get('chunk')??50_000n);
const started=Date.now(),deadline=seconds===undefined?undefined:started+seconds*1000;

// splitmix64-seeded xorshift64; identical seeds give identical vector streams.
let state=(seed+0x9e3779b97f4a7c15n)&U64_MAX;
state=((state^(state>>30n))*0xbf58476d1ce4e5b9n)&U64_MAX;state=((state^(state>>27n))*0x94d049bb133111ebn)&U64_MAX;state=(state^(state>>31n))||1n;
function next():bigint {state^=(state<<13n)&U64_MAX;state^=state>>7n;state^=(state<<17n)&U64_MAX;return state;}
const below=(n:bigint)=>n<=0n?0n:next()%n;
const chance=(percent:number)=>below(100n)<BigInt(percent);
const pick=<T>(values:readonly T[])=>values[Number(below(BigInt(values.length)))]!;
/** Log-uniform magnitude below 2^maxBits, with boundary specials. */
function magnitude(maxBits:number):bigint {
 if(chance(4))return pick([0n,1n,2n,U64_MAX,U64_MAX+1n,RESERVE_MAX,RESERVE_MAX+1n,SHARE_MAX]);
 const bits=below(BigInt(maxBits))+1n;return (next()<<64n|next())%(1n<<bits)||1n;
}
const fraction=(n:bigint)=>chance(10)?n:chance(10)?n+1n:below(n+1n);

const vectors:string[]=[],counts=new Map<string,number>();
let executed=0,checked=0,stop='budget';
const serialize=(value:object)=>JSON.stringify(value,(_,v:unknown)=>typeof v==='bigint'?v.toString():v);
function record(kind:string,before:Parameters|PoolState,args:bigint[],run:()=>Result,operation?:Operation):Result|undefined {
 let expected:Result|{error:string};
 try{expected=run();}catch(e){if(!(e instanceof ModelError))throw e;expected={error:e.code};}
 // Independent model oracle: every accepted transition must validate.
 if('next' in expected&&operation)validateTransition(before as PoolState,operation,expected);
 const outcome='next' in expected?'ok':expected.error;counts.set(`${kind}:${outcome}`,(counts.get(`${kind}:${outcome}`)??0)+1);
 vectors.push(serialize({kind,state:before,args,expected}));executed++;
 return 'next' in expected?expected:undefined;
}
function parameters():Parameters {
 const fee=chance(90)?below(FEE_DENOMINATOR):chance(50)?FEE_DENOMINATOR:magnitude(20);
 return {feeBps:fee,lockedShares:chance(70)?magnitude(40):magnitude(130),
  backing:{state:magnitude(chance(90)?40:66),ckb:magnitude(chance(90)?40:66),token:magnitude(chance(90)?40:66)}};
}
function operation(s:PoolState):Operation {
 const kind=pick(['xToY','yToX','deposit','withdraw'] as const);
 if(kind==='withdraw'){
  const circulating=circulatingShares(s),shares=chance(70)?fraction(circulating):magnitude(130);
  return {kind,shares,minX:chance(80)?1n:magnitude(112),minY:chance(80)?1n:magnitude(112)};
 }
 if(kind==='deposit'){
  const maxX=chance(70)?fraction(s.x):magnitude(113),maxY=chance(70)?fraction(s.y):magnitude(113);
  return {kind,maxX,maxY,minShares:chance(85)?1n:magnitude(129)};
 }
 const reserve=kind==='xToY'?s.x:s.y,amountIn=chance(70)?fraction(reserve):magnitude(113);
 return {kind:'swap',direction:kind,amountIn,minOut:1n};
}
function walk(){
 const p=parameters();
 const x=chance(80)?magnitude(64):magnitude(113),y=chance(80)?magnitude(112):magnitude(113);
 const minShares=chance(90)?1n:magnitude(129);
 let current=record('create',p,[x,y,minShares],()=>createPool(p,x,y,minShares))?.next;
 if(current===undefined)return;
 for(let step=0;step<64&&executed<budget;step++){
  let op=operation(current);
  if(op.kind==='swap'&&chance(30)){
   // Probe the quoted output, then set the minimum at or just above it.
   try{const quoted=transition(current,op).flows;const out=op.direction==='xToY'?quoted.receivedY:quoted.receivedX;op={...op,minOut:chance(50)?out:out+1n};}catch{}
  }
  const args=op.kind==='swap'?[op.amountIn,op.minOut]:op.kind==='deposit'?[op.maxX,op.maxY,op.minShares]:[op.shares,op.minX,op.minY];
  if(chance(3)){
   // Probe a corrupted predecessor without adopting it; both sides must reject alike.
   const key=pick(['x','y','totalShares','lockedShares'] as const),corrupt={...current,[key]:pick([0n,current[key]+1n,current[key]-1n,magnitude(130)])};
   record(op.kind==='swap'?op.direction:op.kind,corrupt,args,()=>transition(corrupt,op),op);
  }
  const result=record(op.kind==='swap'?op.direction:op.kind,current,args,()=>transition(current!,op),op);
  if(result)current=result.next;
 }
}
const root=fileURLToPath(new URL('../../',import.meta.url));
function flush(){
 if(!vectors.length)return;
 const result=spawnSync('cargo',['run','--locked','--quiet','-p','openswap-pool-arithmetic','--example','check_vectors'],{cwd:root,input:vectors.join('\n')+'\n',encoding:'utf8',maxBuffer:64*1024*1024});
 // A checker that panics early closes stdin; report its mismatch, not EPIPE.
 if(result.status!==0&&result.status!==null){process.stderr.write(result.stderr??'');throw new Error(`Rust checker mismatch within vectors ${checked}..${checked+vectors.length-1}`);}
 if(result.error)throw result.error;
 checked+=vectors.length;vectors.length=0;
}
const report=()=>console.log(`CAMPAIGN target=pool-model-diff seed=${seed} budget=${budget} executed=${checked} stop=${stop} elapsed_ms=${Date.now()-started} outcomes=${[...counts].sort().map(([k,v])=>`${k}:${v}`).join(',')}`);
try{
 while(executed<budget){
  if(deadline!==undefined&&Date.now()>=deadline){stop='time';break;}
  walk();if(vectors.length>=chunk)flush();
 }
 flush();
}catch(error){stop='failure';report();throw error;}
report();
