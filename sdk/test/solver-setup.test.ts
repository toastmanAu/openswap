import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ccc} from '@ckb-ccc/core';
import {setup,owner,hex} from './fixture.js';
import {amountData,decodeTerms} from '../src/index.js';
import {buildSolverSetup} from '../../scripts/lib/solver-setup.js';
const recipient=ccc.Script.from({codeHash:hex(9),hashType:'type',args:hex(8,20)});
test('solver setup pins maker and separate funding, conserving all test tokens',async()=>{
 const f=setup();f.fund();const token=await ccc.Script.fromKnownScript(f.client,ccc.KnownScript.XUdt,owner.hash());
 f.add(ccc.CellAny.from({cellOutput:{lock:owner,type:token},outputData:amountData(997n)}));
 const built=await buildSolverSetup(f.context,recipient);built.assertLayout();
 assert(decodeTerms(built.tx.outputs[0]!.lock.args).ownerLock.eq(owner));
 assert(built.tx.outputs[1]!.lock.eq(recipient));assert.equal(built.tx.outputs[1]!.capacity,200000000000n);
 assert(built.tx.outputs[2]!.type?.eq(token));assert.equal(built.tx.outputsData[2],amountData(100n));
 assert.equal(built.tx.getOutputsUdtBalance(token),997n);
 built.tx.outputs[1]!.capacity++;assert.throws(()=>built.assertLayout(),/Pinned|changed/);
});
test('solver setup rejects same wallet and insufficient or extended token funding',async()=>{
 const f=setup();f.fund();await assert.rejects(()=>buildSolverSetup(f.context,owner),/separate wallet/);
 const token=await ccc.Script.fromKnownScript(f.client,ccc.KnownScript.XUdt,owner.hash());
 f.add(ccc.CellAny.from({cellOutput:{lock:owner,type:token},outputData:amountData(100n)+'00'}));
 await assert.rejects(()=>buildSolverSetup(f.context,recipient),/100 units/);
});
