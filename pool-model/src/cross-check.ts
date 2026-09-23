/** Deterministic JSONL vectors; --emit prints the corpus for independent reuse. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createPool, swap, deposit, withdraw, sqrtFloor, ModelError, U64_MAX, RESERVE_MAX, SHARE_MAX, U256_MAX, type Parameters, type PoolState, type Result} from './model.js';

const vectors:object[]=[];
const p:Parameters={feeBps:30n,lockedShares:1n,backing:{state:20_000_000_000n,ckb:10_000_000_000n,token:20_000_000_000n}};
function record(kind:string,state:Parameters,args:bigint[],run:()=>Result):Result|undefined {
 let expected:Result|{error:string};
 try {expected=run();} catch(e) {if(!(e instanceof ModelError))throw e;expected={error:e.code};}
 vectors.push({kind,state,args,expected});
 return 'next' in expected?expected:undefined;
}
function genesis(q:Parameters,x:bigint,y:bigint,min=1n){return record('create',q,[x,y,min],()=>createPool(q,x,y,min));}
function trade(s:PoolState,d:'xToY'|'yToX',a:bigint,min=1n){return record(d,s,[a,min],()=>swap(s,d,a,min));}
function add(s:PoolState,x:bigint,y:bigint,min=1n){return record('deposit',s,[x,y,min],()=>deposit(s,x,y,min));}
function remove(s:PoolState,b:bigint,x=1n,y=1n){return record('withdraw',s,[b,x,y],()=>withdraw(s,b,x,y));}

for(const feeBps of [0n,30n,9999n])for(let x=2n;x<=20n;x++)for(let y=2n;y<=20n;y++) {
 const s=genesis({...p,feeBps},x,y)!.next;
 for(let a=1n;a<=12n;a++){trade(s,'xToY',a);trade(s,'yToX',a);}
 for(let a=1n;a<=5n;a++){add(s,a,6n-a);remove(s,a);}
}
const base=genesis(p,1_000_000n,4_000_000n)!.next;
for(const value of [0n,1n,2n,U64_MAX,RESERVE_MAX,SHARE_MAX,U256_MAX]) {
 genesis(p,value,4_000_000n);genesis(p,1_000_000n,value);genesis(p,1_000_000n,4_000_000n,value);
 trade(base,'xToY',value);trade(base,'yToX',value);trade(base,'xToY',10000n,value);
 add(base,value,100n);add(base,100n,value);add(base,100n,100n,value);
 remove(base,value);remove(base,1000n,value);remove(base,1000n,1n,value);
 genesis({...p,feeBps:value},10000n,10000n);genesis({...p,lockedShares:value},10000n,10000n);
 for(const key of ['state','ckb','token'] as const)genesis({...p,backing:{...p.backing,[key]:value}},10000n,10000n);
 for(const key of ['x','y','totalShares'] as const)trade({...base,[key]:value},'xToY',10n);
}
for(const x of [1n,1_000_000n,1n<<53n,(U64_MAX-p.backing.ckb)/2n,U64_MAX-p.backing.ckb-100n])
for(const y of [1n,1_000_000n,1n<<100n,RESERVE_MAX/2n,RESERVE_MAX-100n]) {
 const r=genesis(p,x,y);if(!r)continue;
 for(const a of [1n,100n,101n,x/7n+1n]){trade(r.next,'xToY',a);trade(r.next,'yToX',a);add(r.next,a,a);}
 remove(r.next,r.next.totalShares-p.lockedShares);
}
const drained=remove(base,base.totalShares-p.lockedShares)!.next;
remove(drained,1n);add(drained,500n,2000n);
let seed=0x746f617374n,s=base;
for(let i=0;i<3000;i++) {
 seed^=seed<<13n;seed^=seed>>7n;seed^=seed<<17n;seed&=U64_MAX;
 const a=1n+seed%10000n;
 const r=seed%3n===0n?trade(s,seed%2n===0n?'xToY':'yToX',a):seed%3n===1n?add(s,a,a*4n):remove(s,a);
 if(r)s=r.next;
}
for(let bit=0n;bit<256n;bit++)for(const n of [(1n<<bit)-1n,1n<<bit,(1n<<bit)+1n]) {
 vectors.push({kind:'sqrt',n,expected:{sqrt:sqrtFloor(n)}});
}
vectors.push({kind:'sqrt',n:U256_MAX,expected:{sqrt:sqrtFloor(U256_MAX)}});
const corpus=vectors.map(v=>JSON.stringify(v,(_,value:unknown)=>typeof value==='bigint'?value.toString():value)).join('\n')+'\n';
if(process.argv.includes('--emit'))process.stdout.write(corpus);
else {
 const result=spawnSync('cargo',['run','--locked','--quiet','-p','openswap-pool-arithmetic','--example','check_vectors'],
  {cwd:fileURLToPath(new URL('../../',import.meta.url)),input:corpus,encoding:'utf8',maxBuffer:32*1024*1024});
 if(result.error)throw result.error;
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 if(result.status!==0)throw new Error(`Rust vector checker failed: ${result.status ?? result.signal}`);
}
