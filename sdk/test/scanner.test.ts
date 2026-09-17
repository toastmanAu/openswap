import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import { setup, a, b, deployment, hex } from './fixture.js';
import { scan, defaultResolver, udt } from '../src/index.js';
async function collect<T>(iter:AsyncIterable<T>){const result:T[]=[];for await(const item of iter) result.push(item);return result;}
test('scanner requests Data1 prefix and data; malformed cells do not hide valid orders',async()=>{
  const f=setup();const bad=f.order(udt(a),udt(b)),good=f.order(udt(a),udt(b));bad.cellOutput.lock.args='0x';let malformed=0;
  f.client.findCells=async function* (search){assert.equal(search.scriptSearchMode,'prefix');assert.equal(search.script.hashType,'data1');assert.equal(search.withData,true);yield bad;yield good;};
  const orders=await collect(scan(f.client,deployment,defaultResolver(f.client),{onMalformed:()=>malformed++}));
  assert.equal(malformed,1);assert.equal(orders.length,1);assert(orders[0]!.outPoint.eq(good.outPoint));
});
test('unknown tokens remain inspectable but are excluded from default books',async()=>{
  const f=setup();const unknown=ccc.Script.from({codeHash:hex(88),hashType:'data1',args:hex(1)}),cell=f.order(udt(unknown),udt(b));
  f.client.findCells=async function* () {yield cell;};
  assert.equal((await collect(scan(f.client,deployment,defaultResolver(f.client)))).length,0);
  const orders=await collect(scan(f.client,deployment,defaultResolver(f.client),{includeUnsupported:true}));
  assert.equal(orders.length,1);assert.equal(orders[0]!.supported,false);
});
test('scanner bounds malformed spam and rejects invalid limits',async()=>{
  const f=setup();const bad=f.order(udt(a),udt(b));bad.cellOutput.lock.args='0x';let malformed=0;
  f.client.findCells=async function* () {for(let i=0;i<100;i++)yield bad;};
  await collect(scan(f.client,deployment,defaultResolver(f.client),{maxCells:3,onMalformed:()=>malformed++}));assert.equal(malformed,3);
  for(const maxCells of [NaN,Infinity,-1,0,1.5]) await assert.rejects(()=>collect(scan(f.client,deployment,defaultResolver(f.client),{maxCells})),/positive safe integer/);
});
test('wrong network and pre-aborted scans stop before indexer access',async()=>{
  const f=setup();let accessed=false;f.client.findCells=async function* () {accessed=true;};
  await assert.rejects(()=>collect(scan(f.client,{...deployment,genesisHash:hex(99)},defaultResolver(f.client))),/network mismatch/);
  await assert.rejects(()=>collect(scan(f.client,deployment,defaultResolver(f.client),{signal:AbortSignal.abort()})));
  assert.equal(accessed,false);
});

test('scan excludes speculative cached orders by using the on-chain iterator',async()=>{
 const f=setup();const phantom=f.order(udt(a),udt(b));
 f.client.findCells=async function* (){yield phantom;};
 f.client.findCellsOnChain=async function* (){};
 assert.equal((await collect(scan(f.client,deployment,defaultResolver(f.client)))).length,0);
});
