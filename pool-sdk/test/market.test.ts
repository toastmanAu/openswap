import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ccc} from '@ckb-ccc/core';
import {marketEvents,pairOf,print,type MarketSources,type MarketTx,type Trade} from '../src/market.js';
import {candles,depth,marketStats,priceOf,settlements} from '../src/market-stats.js';
import {assetKey} from '../../sdk/src/types.js';
import {decodeWitness} from '../src/codec.js';
import {decodeTerms,parseAmount} from '../../sdk/src/codec.js';
import {decodeTermsV2} from '../../sdk/src/v2/codec.js';
import {CKB,udt,type AssetId} from '../../sdk/src/types.js';

// Real committed testnet transactions (scripts/market-fixtures.ts), with resolved inputs.
const raw=JSON.parse(readFileSync(new URL('./fixtures/market.json',import.meta.url),'utf8'));
const sources=raw.sources as MarketSources;
/** Fixtures resolve every input, as a full resolution would. */
const fixture=(name:string):Omit<MarketTx,'inputs'>&{inputs:ccc.Cell[]}=>{
 const f=raw.fixtures[name];assert(f,`missing fixture ${name}`);
 return {hash:f.hash,block:BigInt(f.block),time:BigInt(f.time),tx:ccc.Transaction.fromBytes(f.tx),inputs:f.inputs.map((c:ccc.CellLike)=>ccc.Cell.from(c))};
};
const trades=(m:MarketTx)=>{const r=marketEvents(m,sources);assert.deepEqual(r.skipped,[]);return r.events.filter((e):e is Trade=>e.kind==='trade');};
const orderInputs=(m:MarketTx,version:1|2)=>m.inputs.flatMap((c,i)=>c?.cellOutput.lock.codeHash===sources.orders.find(o=>o.version===version)!.codeHash?[i]:[]);

test('every fixture extracts the recorded event kinds with nothing skipped',()=>{
 for(const name of Object.keys(raw.fixtures)){
  const r=marketEvents(fixture(name),sources);
  assert.deepEqual(r.skipped,[],name);
  assert.deepEqual(r.events.map(e=>e.kind),raw.fixtures[name].expected,name);
 }
});

test('v1 fills pay exactly the ask in the lock args and take the whole lot',()=>{
 for(const name of ['v1-fill-udt-offer','v1-fill-ckb-offer']){
  const m=fixture(name),[t]=trades(m),i=orderInputs(m,1)[0]!,cell=m.inputs[i]!,terms=decodeTerms(cell.cellOutput.lock.args);
  assert.equal(t!.gave.amount,terms.askAmount,name);
  assert.equal(t!.got.amount,cell.cellOutput.type?parseAmount(cell.outputData):cell.cellOutput.capacity-terms.capacityRefund,name);
  assert.equal(t!.version,1);
 }
});

test('v2 fills meet the maker price, and partial fills leave an identical-args remainder',()=>{
 for(const name of ['v2-partial-udt-offer','v2-partial-ckb-offer','v2-final-udt-offer','v2-final-ckb-offer']){
  const m=fixture(name),[t]=trades(m),i=orderInputs(m,2)[0]!,lock=m.inputs[i]!.cellOutput.lock,terms=decodeTermsV2(lock.args);
  assert(t!.gave.amount*terms.offerAmount>=t!.got.amount*terms.askAmount,`${name}: below the maker price`);
  assert.equal(t!.final,name.includes('final'),name);
  assert.equal(m.tx.outputs.some(o=>o.lock.eq(lock)),!t!.final,name);
  if(!t!.final)assert(t!.got.amount>=terms.minFill,`${name}: below min fill`);
 }
});

test('pool swaps match the signed action, and a route carries the same CKB between pools',()=>{
 const m=fixture('pool-swap'),[t]=trades(m);
 const i=m.inputs.findIndex(c=>c.cellOutput.type?.codeHash===sources.pools!.codeHash&&c.outputData.length===2+380);
 const action=decodeWitness(m.tx.witnesses[i]!,false);
 assert.equal(action.kind,'swap');
 if(action.kind==='swap'){assert.equal(t!.gave.amount,action.amountIn);assert(t!.got.amount>=action.minOut);assert.equal(t!.gave.asset.kind==='ckb',action.direction==='xToY');}
 const route=trades(fixture('pool-route'));
 assert.equal(route.length,2);
 const sell=route.find(r=>r.got.asset.kind==='ckb')!,buy=route.find(r=>r.gave.asset.kind==='ckb')!;
 assert.equal(sell.got.amount,buy.gave.amount,'hop CKB');
 assert.notEqual(sell.source,buy.source,'two different pools');
});

test('a solver match is two order fills whose amounts net, leaving the spread',()=>{
 const t=trades(fixture('solver-match'));
 assert.equal(t.length,2);
 const [a,b]=t as [Trade,Trade];
 assert.equal(a.got.asset.kind===b.gave.asset.kind,true);
 const ckbOut=[a,b].reduce((s,x)=>s+(x.got.asset.kind==='ckb'?x.got.amount:0n),0n),ckbIn=[a,b].reduce((s,x)=>s+(x.gave.asset.kind==='ckb'?x.gave.amount:0n),0n);
 assert(ckbOut>=ckbIn,'the solver never pays out more CKB than it receives');
});

test('extraction needs only order and pool inputs: funding inputs may stay unresolved',()=>{
 for(const name of Object.keys(raw.fixtures)){
  const m=fixture(name),full=marketEvents(m,sources);
  const relevant=(c:ccc.Cell)=>sources.orders.some(o=>o.codeHash===c.cellOutput.lock.codeHash)||
   (!!sources.pools&&[c.cellOutput.lock.codeHash,c.cellOutput.type?.codeHash].includes(sources.pools.codeHash));
  const sparse=marketEvents({...m,inputs:m.inputs.map(c=>relevant(c)?c:undefined)},sources);
  assert.deepEqual(ccc.stringify(sparse),ccc.stringify(full),name);
 }
});

test('tampered transactions are skipped with a reason, never misread',()=>{
 const m=fixture('v2-partial-udt-offer'),i=orderInputs(m,2)[0]!;
 const moved=m.tx.clone();moved.outputs[i]=ccc.CellOutput.from({...moved.outputs[i]!,lock:ccc.Script.from({codeHash:`0x${'11'.repeat(32)}`,hashType:'type',args:'0x'})});
 let r=marketEvents({...m,tx:moved},sources);
 assert.equal(r.events.length,0);assert.match(r.skipped[0]!.reason,/owner output/);
 const doubled=m.tx.clone();const rem=doubled.outputs.findIndex(o=>o.lock.eq(m.inputs[i]!.cellOutput.lock));
 doubled.outputs.push(doubled.outputs[rem]!);doubled.outputsData.push(doubled.outputsData[rem]!);
 r=marketEvents({...m,tx:doubled},sources);
 assert.equal(r.events.length,0);assert.match(r.skipped[0]!.reason,/recreation/);
 const swap=fixture('pool-swap'),s=swap.inputs.findIndex(c=>c.outputData.length===2+380);
 r=marketEvents({...swap,inputs:swap.inputs.map((c,k)=>k===s?c:ccc.Cell.from({...c,outPoint:{txHash:`0x${'22'.repeat(32)}`,index:k}}))},sources);
 assert.equal(r.events.length,0);assert.match(r.skipped[0]!.reason,/reserves/);
 assert.throws(()=>marketEvents({...m,inputs:m.inputs.slice(1)},sources),/Inputs must align/);
});

// Aggregation -------------------------------------------------------------------------------
const TOKEN=udt(ccc.Script.from({codeHash:`0x${'33'.repeat(32)}`,hashType:'data1',args:'0x01'}));
const OTHER=udt(ccc.Script.from({codeHash:`0x${'33'.repeat(32)}`,hashType:'data1',args:'0x02'}));
const dec=(a:AssetId)=>a.kind==='ckb'?8:6;
const H=3_600_000n,NOW=1_800_000_000_000n;
let n=0;
const trade=(time:bigint,got:[AssetId,bigint],gave:[AssetId,bigint]):Trade=>({kind:'trade',venue:'order',hash:`0x${(n++).toString(16).padStart(64,'0')}` as ccc.Hex,block:BigInt(n),time,source:'x',got:{asset:got[0],amount:got[1]},gave:{asset:gave[0],amount:gave[1]}});
// price p CKB per token: buying `t` tokens (6 decimals) for t*p CKB (8 decimals)
const buy=(time:bigint,tokens:number,price:number)=>trade(time,[TOKEN,BigInt(tokens*1e6)],[CKB,BigInt(Math.round(tokens*price*1e8))]);
const sell=(time:bigint,tokens:number,price:number)=>trade(time,[CKB,BigInt(Math.round(tokens*price*1e8))],[TOKEN,BigInt(tokens*1e6)]);

test('pairs: CKB is always the quote, token pairs are canonical, sides follow the taker',()=>{
 assert.equal(pairOf(CKB,TOKEN).key,pairOf(TOKEN,CKB).key);
 assert.equal(pairOf(TOKEN,CKB).quote.kind,'ckb');
 assert.equal(pairOf(TOKEN,OTHER).key,pairOf(OTHER,TOKEN).key);
 assert.throws(()=>pairOf(CKB,CKB),/Same-asset/);
 const b=print(buy(NOW,10,2)),s=print(sell(NOW,10,2));
 assert.equal(b.side,'buy');assert.equal(s.side,'sell');assert.equal(b.base,10_000_000n);assert.equal(s.quote,2_000_000_000n);
 assert.equal(priceOf(b,dec),2);
});

test('24 h stats use block time, compare with the last price before the window',()=>{
 const prints=[buy(NOW-30n*H,5,1),buy(NOW-20n*H,5,2),sell(NOW-10n*H,4,1.5),buy(NOW-1n*H,1,3)].map(print);
 const s=[...marketStats(prints,dec,NOW).values()][0]!;
 assert.equal(s.trades,4);assert.equal(s.day.trades,3);
 assert.equal(s.day.open,1,'open is the last price before the window');
 assert.equal(s.day.high,3);assert.equal(s.day.low,1.5);
 assert.equal(s.last!.price,3);assert.equal(s.day.change,2);
 assert.equal(s.day.base,10);assert.equal(s.day.quote,2*5+1.5*4+3);
});

test('candles: first and last trade per bucket, empty buckets repeat the close',()=>{
 const prints=[buy(NOW-5n*H+1n,1,1),buy(NOW-5n*H+2n,1,4),sell(NOW-5n*H+3n,1,2),buy(NOW-2n*H,2,5)].map(print);
 const c=candles(prints,dec,H,6,NOW);
 // NOW is on an hour boundary, so the six buckets start at NOW-5h … NOW.
 assert.deepEqual(c.map(x=>x.start),[5n,4n,3n,2n,1n,0n].map(k=>NOW-k*H));
 assert.deepEqual(c.map(x=>x.trades),[3,0,0,1,0,0]);
 const first=c.find(x=>x.trades===3)!;
 assert.deepEqual([first.open,first.high,first.low,first.close,first.base],[1,4,1,2,3]);
 const after=c[c.indexOf(first)+1]!;assert.deepEqual([after.open,after.close,after.trades],[2,2,0]);
 assert.equal(c.at(-1)!.close,5);
 assert.equal(candles([],dec,H,6,NOW).length,0);
});

test('depth: order steps plus the pool curve, cumulative and monotone',()=>{
 const pair=pairOf(TOKEN,CKB);
 const book=[
  {offer:TOKEN,ask:CKB,available:10_000_000n,askAmount:220_00000000n,offerAmount:100_000_000n},// 10 tokens at 2.2
  {offer:CKB,ask:TOKEN,available:180_00000000n,askAmount:100_000_000n,offerAmount:180_00000000n},// 100 CKB-worth bid at 1.8
 ];
 const d=depth(pair,book,[],dec,{steps:10,range:0.5});
 assert.equal(d.mid,2);
 assert.equal(d.asks.find(p=>p.price>=2.2)!.base,10);assert.equal(d.asks[0]!.base,0);
 assert.equal(d.bids.find(p=>p.price<=1.8)!.base,100);
 const pool={token:TOKEN,ckb:CKB,x:1000_00000000n,y:500_000_000n,feeBps:30n};// 1000 CKB / 500 tokens: 2 CKB each
 const q=depth(pair,[],[pool],dec,{steps:20,range:0.5});
 for(const side of [q.asks,q.bids])for(let i=1;i<side.length;i++)assert(side[i]!.base>=side[i-1]!.base,'monotone');
 // At p, the pool has sold y - sqrt(xy/(p(1-f))) tokens.
 const p=q.asks.at(-1)!.price;assert(Math.abs(q.asks.at(-1)!.base-(500-Math.sqrt(1000*500/(p*0.997))))<1e-9);
 assert.deepEqual(depth(pair,[],[],dec),{bids:[],asks:[]});
});

test('solver settlements: matches and rings are recognised from the fills alone, with the spread kept',()=>{
 const markets=JSON.parse(readFileSync(new URL('../../deployments/pool-markets.json',import.meta.url),'utf8'));
 const token=(symbol:string)=>udt(ccc.Script.from(markets.tokens.find((t:{symbol:string})=>t.symbol===symbol).token));
 const [test2,test3]=[token('TEST2'),token('TEST3')],U=10n**8n;
 // The live ring (scripts/lock-v2-ring.ts): CKB -> TEST2 -> TEST3 -> CKB, the solver kept 16 CKB.
 const ring=settlements(trades(fixture('solver-ring'))).get(raw.fixtures['solver-ring'].hash)!;
 assert.equal(ring.kind,'ring');assert.equal(ring.legs.length,3);
 assert.deepEqual(ring.route!.map(assetKey),[CKB,test2,test3,CKB].map(assetKey));
 assert.deepEqual(Object.fromEntries(ring.kept),{[assetKey(CKB)]:16n*U,[assetKey(test2)]:0n,[assetKey(test3)]:0n});
 // The live multi-order match (scripts/lock-v2-multi.ts): four fills in TEST2/CKB, 480 TEST2 kept.
 const multi=settlements(trades(fixture('solver-multi'))).get(raw.fixtures['solver-multi'].hash)!;
 assert.equal(multi.kind,'match');assert.equal(multi.route,undefined);assert.equal(multi.legs.length,4);
 assert.deepEqual(Object.fromEntries(multi.kept),{[assetKey(CKB)]:0n,[assetKey(test2)]:480n*U});
 // The v2 campaign's solver match, and the v1 reference solver's match of two reciprocal lots.
 for(const name of ['solver-match','v1-fill-udt-offer'])assert.equal(settlements(trades(fixture(name))).get(raw.fixtures[name].hash)?.kind,'match',name);
 // A wallet taking orders (one way, even several in one transaction), or a pool route, is not a settlement.
 for(const name of Object.keys(raw.fixtures).filter(n=>!n.startsWith('solver-')&&n!=='v1-fill-udt-offer'))assert.equal(settlements(trades(fixture(name))).size,0,name);
 // Three fills over three assets that do not close a cycle are not a ring.
 const [l0,l1,l2]=trades(fixture('solver-ring'));
 const as=(t:Trade,got:AssetId,gave:AssetId)=>({...t,got:{...t.got,asset:got},gave:{...t.gave,asset:gave}});
 assert.equal(settlements([as(l0!,CKB,test2),as(l1!,test2,test3),as(l2!,CKB,test3)]).size,0);
 assert.equal(settlements([as(l0!,CKB,test2),as(l1!,CKB,test2)]).size,0,'one-way fills');
});
