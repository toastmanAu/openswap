// Fixtures use CCC only for Molecule Script bytes; tail construction is independent of the SDK.
import { ccc } from '@ckb-ccc/shell';
import { writeFile } from 'node:fs/promises';
const owner = ccc.Script.from({codeHash:'0x'+'11'.repeat(32),hashType:'type',args:'0x'+'33'.repeat(20)});
const ask = ccc.Script.from({codeHash:'0x'+'22'.repeat(32),hashType:'data1',args:'0x'+'44'.repeat(32)});
function le(n,size){const b=new Uint8Array(size);for(let i=0;i<size;i++,n>>=8n)b[i]=Number(n&255n);return b;}
function vector(name,requested,amount=100n){const a=requested?.toBytes()??new Uint8Array();const o=owner.toBytes();const b=new Uint8Array(o.length+48+a.length);b.set(o);let t=b.subarray(o.length);t[0]=1;t.set(new Uint8Array(16).fill(1),4);t.set(le(100000000000n,8),20);t.set(le(BigInt(a.length),4),28);t.set(a,32);t.set(le(amount,16),32+a.length);return {name,ownerScriptHex:ccc.hexFrom(o),nonceHex:'0x'+'01'.repeat(16),capacityRefund:'100000000000',askScriptHex:requested?ccc.hexFrom(a):null,askAmount:String(amount),expectedArgsHex:ccc.hexFrom(b)};}
const vectors=[vector('ckb_ask',null),vector('udt_ask',ask),vector('max_u128',ask,(1n<<128n)-1n)];
const base=vectors[1], o=owner.toBytes().length;
function bad(name,errorCode,change){const b=ccc.bytesFrom(base.expectedArgsHex);const changed=change(b)??b;vectors.push({...base,name,errorCode,expectedArgsHex:ccc.hexFrom(changed)});}
bad('zero_nonce',30,b=>{b.fill(0,o+4,o+20)});bad('unsupported_version',27,b=>{b[o]=2});bad('flags',28,b=>{b[o+1]=1});bad('reserved',29,b=>{b[o+2]=1});bad('invalid_owner',23,b=>{b[4]=15});bad('oversized_owner',22,b=>{b.set(le(1025n,4),0)});bad('invalid_ask',25,b=>{b[o+36]=15});bad('oversized_ask',24,b=>{b.set(le(1025n,4),o+28)});bad('zero_amount',31,b=>{b.fill(0,b.length-16)});bad('trailing_bytes',26,b=>new Uint8Array([...b,0]));bad('short_args',21,b=>b.slice(0,3));bad('short_tail',21,b=>b.slice(0,o+47));
await writeFile('tests/vectors/wire.json',JSON.stringify(vectors,null,2)+'\n');
