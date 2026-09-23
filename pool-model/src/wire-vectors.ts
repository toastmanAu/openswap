/** Test-only independent sequential encoder; not a pool SDK or transaction builder. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const vectors:object[]=[];
function le(n:bigint,bytes:number):Buffer {
 assert(n>=0n&&n<(1n<<BigInt(bytes*8)));
 const out=Buffer.alloc(bytes);for(let i=0;i<bytes;i++){out[i]=Number(n&255n);n>>=8n;}return out;
}
const cat=(...parts:Uint8Array[])=>Buffer.concat(parts);
const header=(magic:string,tag:number)=>cat(Buffer.from(magic,'ascii'),Buffer.from([1,tag]));
const hash=(seed:number)=>Buffer.from(Array.from({length:32},(_,i)=>(seed+i*7)&255));
const args=(role:number,poolId:Buffer)=>cat(header('TPL1',role),poolId);
const action=(tag:number,values:bigint[])=>cat(header('TPA1',tag),Buffer.alloc(2),...values.map(n=>le(n,16)));
function table(fields:Buffer[]):Buffer {
 const base=4+4*fields.length;let offset=base;
 return cat(le(BigInt(base+fields.reduce((n,f)=>n+f.length,0)),4),...fields.map(f=>{const b=le(BigInt(offset),4);offset+=f.length;return b;}),...fields);
}
const bytes=(data:Buffer)=>cat(le(BigInt(data.length),4),data);
const script=(codeHash:Buffer,a:Buffer)=>table([codeHash,Buffer.from([2]),bytes(a)]);
const witness=(lock:Buffer|undefined,input:Buffer|undefined,output:Buffer|undefined)=>table([lock,input,output].map(v=>v===undefined?Buffer.alloc(0):bytes(v)));
function valid(kind:string,data:Buffer,ok:object){vectors.push({kind,hex:data.toString('hex'),expected:{ok}});}
function invalid(kind:string,data:Buffer,error:number){vectors.push({kind,hex:data.toString('hex'),expected:{error}});}
function changed(data:Buffer,offset:number,value:Buffer|number):Buffer {const out=Buffer.from(data);if(typeof value==='number')out[offset]=value;else value.copy(out,offset);return out;}
function truncations(kind:string,data:Buffer){for(let len=0;len<data.length;len++)invalid(kind,data.subarray(0,len),3);}

for(let role=0;role<5;role++)for(const seed of [0,1,127,255]) {
 const poolId=hash(seed),codeHash=hash(seed+1),a=args(role,poolId),expected={role,poolId:poolId.toString('hex')};
 valid('args',a,expected);valid('script',script(codeHash,a),{codeHash:codeHash.toString('hex'),args:expected});
}
const a=args(0,hash(0));truncations('args',a);invalid('args',cat(a,Buffer.from([0])),2);
invalid('args',changed(a,0,0),3);
for(let n=0;n<=255;n++){if(n!==1)invalid('args',changed(a,4,n),4);if(n>4)invalid('args',changed(a,5,n),4);}
const sc=script(hash(2),a);truncations('script',sc);invalid('script',cat(sc,Buffer.from([0])),3);
for(const at of [0,4,8,12,49])for(const n of [0n,1n,15n,17n,90n,92n,0xffffffffn])invalid('script',changed(sc,at,le(n,4)),3);
for(const n of [0,1,3,4,255])invalid('script',changed(sc,48,n),5);
invalid('script',Buffer.alloc(513),2);

const X=(1n<<64n)-2n,Y=(1n<<112n)-1n,L=(1n<<128n)-1n;
const records=[
 {fee:0n,locked:1n,shares:1n,backingState:1n,backingCkb:1n,backingToken:1n,rx:0n,ry:255n,tokenCodeHash:hash(10),tokenOwner:hash(11)},
 {fee:9999n,locked:L,shares:L,backingState:X+1n,backingCkb:X,backingToken:X+1n,rx:254n,ry:255n,tokenCodeHash:hash(12),tokenOwner:hash(13)},
 {fee:30n,locked:1000n,shares:1n<<100n,backingState:34000000000n,backingCkb:7900000000n,backingToken:16000000000n,rx:1n,ry:2n,tokenCodeHash:hash(14),tokenOwner:hash(15)},
];
function state(s:typeof records[number]):Buffer {
 return cat(header('TPS1',0),le(s.fee,2),le(s.locked,16),le(s.shares,16),le(s.backingState,8),le(s.backingCkb,8),le(s.backingToken,8),
  le(s.rx,4),le(s.ry,4),s.tokenCodeHash,Buffer.from([2,32]),s.tokenOwner,Buffer.alloc(52));
}
for(const s of records)valid('state',state(s),{...s,tokenCodeHash:s.tokenCodeHash.toString('hex'),tokenOwner:s.tokenOwner.toString('hex')});
const st=state(records[2]!);assert.equal(st.length,190);truncations('state',st);invalid('state',cat(st,Buffer.from([0])),2);
for(const at of [0,1,2,3])invalid('state',changed(st,at,0),3);
for(const at of [4,5,104])invalid('state',changed(st,at,255),4);
invalid('state',changed(st,105,31),3);
for(let at=138;at<190;at++)invalid('state',changed(st,at,1),3);
for(const [at,size] of [[8,16],[24,16],[40,8],[48,8],[56,8]] as const)invalid('state',changed(st,at,Buffer.alloc(size)),21);
invalid('state',changed(st,6,le(10000n,2)),21);invalid('state',changed(st,48,le(X+1n,8)),21);
for(const at of [64,68])for(const n of [256n,0xffffffffn])invalid('state',changed(st,at,le(n,4)),2);
invalid('state',changed(st,68,le(1n,4)),7);

const actions:[number,bigint[]][]=[[0,[1n]],[0,[L]],[1,[1n,Y]],[1,[X,1n]],[2,[Y,X]],[3,[X,Y,L]],[4,[L,X,Y]]];
for(const [tag,values] of actions) {
 const data=action(tag,values);valid('action',data,{tag,values});truncations('action',data);
 invalid('action',cat(data,Buffer.from([0])),data.length===56?2:3);
 invalid('action',changed(data,0,0),3);invalid('action',changed(data,4,0),4);
 for(const at of [6,7])invalid('action',changed(data,at,1),3);
 for(let at=8;at<data.length;at+=16)invalid('action',changed(data,at,Buffer.alloc(16)),21);
 for(let n=5;n<=255;n++)invalid('action',changed(data,5,n),4);
}
// A hand-written literal anchors magic, version, tag and little-endian value.
assert.equal(action(0,[1n]).toString('hex'),'54504131'+'01000000'+'01000000000000000000000000000000');
for(const [tag,values] of [[1,[X+1n,1n]],[1,[1n,Y+1n]],[2,[Y+1n,1n]],[2,[1n,X+1n]],
 [3,[X+1n,1n,1n]],[3,[1n,Y+1n,1n]],[4,[1n,X+1n,1n]],[4,[1n,1n,Y+1n]]] as [number,bigint[]][])invalid('action',action(tag,values),21);
invalid('action',Buffer.alloc(57),2);

const create=action(0,[1n]),swap=action(1,[100n,1n]);
const both=witness(undefined,swap,create);
for(const [kind,ok] of [['genesisWitness',{tag:0,values:[1n]}],['transitionWitness',{tag:1,values:[100n,1n]}]] as const) {
 valid(kind,both,ok);truncations(kind,both);invalid(kind,cat(both,Buffer.from([0])),3);
 for(const n of [0n,15n,17n,0xffffffffn])invalid(kind,changed(both,4,le(n,4)),3);
 invalid(kind,witness(undefined,undefined,undefined),3);invalid(kind,witness(Buffer.alloc(0),Buffer.alloc(0),Buffer.alloc(0)),3);
 invalid(kind,witness(undefined,create,swap),4);
 invalid(kind,table([Buffer.from([0]),bytes(swap),bytes(create)]),3);
 invalid(kind,table([Buffer.alloc(0),cat(bytes(swap),Buffer.from([0])),bytes(create)]),3);
 invalid(kind,Buffer.alloc(4097),2);
 const full=witness(Buffer.alloc(4096-both.length-4),swap,create);assert.equal(full.length,4096);valid(kind,full,ok);
}
// Selected Some(empty) and absent BytesOpt are distinct canonical containers,
// but neither supplies a valid action.
invalid('genesisWitness',witness(undefined,swap,Buffer.alloc(0)),3);
invalid('transitionWitness',witness(undefined,Buffer.alloc(0),create),3);
const corpus=vectors.map(v=>JSON.stringify(v,(_,value:unknown)=>typeof value==='bigint'?value.toString():value)).join('\n')+'\n';
if(process.argv.includes('--emit'))process.stdout.write(corpus);
else {
 const result=spawnSync('cargo',['run','--locked','--quiet','-p','openswap-pool-arithmetic','--example','check_wire_vectors'],
  {cwd:fileURLToPath(new URL('../../',import.meta.url)),input:corpus,encoding:'utf8',maxBuffer:16*1024*1024});
 if(result.error)throw result.error;
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 if(result.status!==0)throw new Error(`Rust wire checker failed: ${result.status??result.signal}`);
}
