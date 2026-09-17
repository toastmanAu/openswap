import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import { ReferenceSolver } from '../src/runner.js';
import { setup, a, b } from '../../sdk/test/fixture.js';
import { udt } from '../../sdk/src/index.js';
function market() {
  const f=setup(); f.fund();
  Object.assign(f.client,{cache:new ccc.ClientCacheMemory()});
  const left=f.order(udt(a),udt(b)),right=f.order(udt(b),udt(a));
  f.client.findCells=async function* () {yield left; yield right;};
  return f;
}
test('dry-run scans and builds without signing or broadcasting',async()=>{
  const f=market(); let sent=0;
  f.client.sendTransaction=async()=>{sent++;throw new Error('Unexpected broadcast');};
  assert(await new ReferenceSolver(f.context).tick());
  assert.equal(f.signed(),false); assert.equal(sent,0);
});
test('pending settlements reserve orders; rejection releases them for retry',async()=>{
  const f=market(); let sent=0; let rejected=false; const events:string[]=[];
  f.client.sendTransaction=async tx=>{sent++;return ccc.Transaction.from(tx).hash();};
  f.client.getTransactionNoCache=async()=>({status:rejected?'rejected':'pending'}) as ccc.ClientTransactionResponse;
  const solver=new ReferenceSolver(f.context,event=>events.push(event));
  assert(await solver.tick(true)); assert.equal(sent,1);
  assert.equal(await solver.tick(true),undefined); assert.equal(sent,1);
  rejected=true; assert(await solver.tick(true)); assert.equal(sent,2);
  assert(events.includes('settlement_conflict'));
});
test('competing solvers race; only one broadcast wins and the loser can rescan',async()=>{
  const f=market(); let arrivals=0,accepted=false;
  let release!:()=>void; const barrier=new Promise<void>(resolve=>{release=resolve;});
  f.client.sendTransaction=async tx=>{
    if(++arrivals===2) release(); await barrier;
    if(accepted) throw new Error('Input conflict');
    accepted=true; f.cells.length=0; return ccc.Transaction.from(tx).hash();
  };
  const first=new ReferenceSolver(f.context),second=new ReferenceSolver(f.context);
  const result=await Promise.allSettled([first.tick(true),second.tick(true)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(result.filter(r=>r.status==='rejected').length,1);
  // The mock indexer catches up to the spent chain state.
  f.client.findCells=async function* () {};
  f.client.getTransactionNoCache=async()=>({status:'committed'}) as ccc.ClientTransactionResponse;
  assert.equal(await first.tick(),undefined); assert.equal(await second.tick(),undefined);
});
test('concurrent tick on one instance fails without locking out later scans',async()=>{
  const f=market(); let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
  f.client.findCells=async function* () {await barrier;};
  const solver=new ReferenceSolver(f.context),pending=solver.tick();
  await assert.rejects(()=>solver.tick(),/already running/);
  release(); assert.equal(await pending,undefined); assert.equal(await solver.tick(),undefined);
});
test('explicit order filter prevents selecting outside the requested scope',async()=>{
 const f=market();const events:string[]=[];
 const solver=new ReferenceSolver(f.context,event=>events.push(event),{acceptOrder:()=>false});
 assert.equal(await solver.tick(true),undefined);assert.equal(f.signed(),false);assert(!events.includes('candidate_bundle'));
});
test('an unknown node status releases reservations despite cached sent status',async()=>{
 const f=market();const events:string[]=[];let cachedReads=0;
 f.client.sendTransaction=async tx=>ccc.Transaction.from(tx).hash();
 f.client.getTransactionNoCache=async()=>undefined;
 f.client.getTransaction=async()=>{cachedReads++;return {status:'sent'} as ccc.ClientTransactionResponse;};
 const solver=new ReferenceSolver(f.context,event=>events.push(event));
 assert(await solver.tick(true));assert(await solver.tick());
 assert.equal(cachedReads,0);assert(events.includes('settlement_conflict'));
});
