import {test} from 'node:test';import assert from 'node:assert/strict';
import {ccc} from '@ckb-ccc/core';
import {setup,a,b,deployment,owner} from './fixture.js';import {udt,parse,defaultResolver,quoteSwap,prepareSwap,amountData} from '../src/index.js';
async function book(lots:[bigint,bigint][]){const f=setup();f.fund();const orders=[];for(const [off,ask]of lots)orders.push(await parse(f.order(udt(a),udt(b),off,ask),deployment,defaultResolver(f.client)));return{f,orders};}
const request={assetIn:udt(b),assetOut:udt(a),amountOut:10n,maxAmountIn:100n,tipBlock:1n,genesisHash:deployment.genesisHash};
test('tail search avoids expensive greedy overfill and reports exact rational',async()=>{const {orders}=await book([[100n,50n],[10n,10n]]);const q=quoteSwap(orders,request);assert.equal(q.amountIn,10n);assert.equal(q.amountOut,10n);assert.equal(q.overfill,0n);assert.equal(q.networkFeeEstimate,undefined);});
test('whole lots overfill without weakening maker limits',async()=>{const {orders}=await book([[7n,4n],[7n,4n]]);const q=quoteSwap(orders,request);assert.equal(q.amountOut,14n);assert.equal(q.amountIn,8n);assert.equal(q.overfill,4n);assert.equal(q.selectedOrders.length,2);});
test('budget, duplicates, unsupported assets, network and lot caps are enforced',async()=>{const {orders}=await book([[7n,4n]]);assert.throws(()=>quoteSwap([...orders,...orders],request),/No whole-lot/);assert.throws(()=>quoteSwap(orders,{...request,maxAmountIn:3n}),/No whole-lot/);assert.throws(()=>quoteSwap(orders,{...request,maxLots:33}),/bounds/);assert.throws(()=>quoteSwap(orders.map(o=>({...o,supported:false})),request),/No whole-lot/);assert.throws(()=>quoteSwap(orders,{...request,genesisHash:'wrong'}),/No whole-lot/);});
test('integer precision is retained beyond Number safe range',async()=>{const huge=2n**70n;const {orders}=await book([[huge,huge+1n]]);const q=quoteSwap(orders,{...request,amountOut:huge,maxAmountIn:huge+1n});assert.equal(q.amountIn,huge+1n);});
test('spent quote fails before transaction signing',async()=>{const {f,orders}=await book([[10n,10n]]);const q=quoteSwap(orders,request);f.cells.length=0;await assert.rejects(()=>prepareSwap(f.context,q,{maxAmountIn:10n,minAmountOut:10n}),/stale/);assert.equal(f.signed(),false);});
test('mutated quote totals cannot bypass limits checked against live cells',async()=>{const {f,orders}=await book([[10n,10n]]);const q=quoteSwap(orders,request);q.amountIn=1n;await assert.rejects(()=>prepareSwap(f.context,q,{maxAmountIn:1n,minAmountOut:10n}),/input limit/);});

test('prepared route funds asks, preserves maker output and supplies an actual fee',async()=>{
 const {f,orders}=await book([[10n,10n]]);
 f.add(ccc.CellAny.from({cellOutput:{lock:owner,type:b},outputData:amountData(20n)}));
 const routed=quoteSwap(orders,request);
 const {built,quote}=await prepareSwap(f.context,routed,{maxAmountIn:10n,minAmountOut:10n});built.assertLayout();
 assert(built.tx.inputs[0]!.previousOutput.eq(orders[0]!.outPoint));
 assert.equal(built.tx.outputsData[0],amountData(10n));assert.equal(quote.amountIn,10n);assert(quote.networkFeeEstimate!>0n);
 assert.equal(built.tx.getOutputsUdtBalance(a),10n);assert.equal(built.tx.getOutputsUdtBalance(b),20n);
});
