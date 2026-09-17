import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import { CKB, udt, type OpenSwapOrder } from '@openswap/sdk';
import { evaluate, match } from '../src/index.js';
const token = udt(ccc.Script.from({codeHash:'0x'+'02'.repeat(32),hashType:'data1',args:'0x'}));
function order(i: number, left: boolean, offer: bigint, ask: bigint): OpenSwapOrder {
  const lock=ccc.Script.from({codeHash:'0x'+'01'.repeat(32),hashType:'data1',args:ccc.hexFrom(new Uint8Array([i]))});
  return {outPoint:ccc.OutPoint.from({txHash:lock.hash(),index:0}),lock,offerAsset:left?CKB:token,askAsset:left?token:CKB,offerAmount:offer,askAmount:ask,supported:true,genesisHash:'0x'+'03'.repeat(32)} as OpenSwapOrder;
}
test('reciprocal pair with bigint spread',()=>{
  const result=match([order(1,true,200n,100n),order(2,false,110n,150n)]);
  assert.equal(result?.orders.length,2); assert.equal(result?.surplus.get('ckb'),50n);
});
test('multiple indivisible lots needed for a match',()=>{
  const result=match([order(1,true,6n,3n),order(2,true,6n,3n),order(3,false,6n,12n)]);
  assert.equal(result?.orders.length,3);
});
test('no rounding-down, duplicates, mixed network or unsupported assets',()=>{
  const a=order(1,true,6n,4n),b=order(2,false,3n,6n);
  assert.equal(match([a,b]),undefined); assert.equal(evaluate([a,a]),undefined);
  b.offerAmount=4n;b.genesisHash=ccc.hexFrom(new Uint8Array(32).fill(255)); assert.equal(match([a,b]),undefined);
  b.genesisHash=a.genesisHash;b.supported=false; assert.equal(match([a,b]),undefined);
});
test('search caps and exact arithmetic above Number precision',()=>{
  const n=1n<<100n; assert(match([order(1,true,n,n),order(2,false,n,n)]));
  assert.throws(()=>match([],{maxOrders:33}));
  assert.equal(match([order(1,true,6n,3n),order(2,true,6n,3n),order(3,false,6n,12n)],{maxOrders:2}),undefined);
});
