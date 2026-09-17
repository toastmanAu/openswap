import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ccc} from '@ckb-ccc/core';
import {isOwnOrder,assertExternalFill} from '../../frontend/src/ownership.js';
const script=(n:string)=>ccc.Script.from({codeHash:`0x${'ab'.repeat(32)}`,hashType:'type',args:`0x${n.repeat(20)}`});
const maker=script('01'),taker=script('02');
const wallet=(locks:ccc.Script[])=>({getAddressObjs:async()=>locks.map(script=>ccc.Address.fromScript(script,new ccc.ClientPublicTestnet()))});
test('self-fill guard compares CKB scripts, including secondary wallet accounts',async()=>{
 assert(isOwnOrder({ownerLock:maker},[taker,maker.clone()]));
 await assert.rejects(()=>assertExternalFill(wallet([maker]),[{ownerLock:maker}]),/pay the tokens back to yourself/);
 await assert.rejects(()=>assertExternalFill(wallet([taker,maker]),[{ownerLock:maker}]),/connected CKB account/);
 await assertExternalFill(wallet([taker]),[{ownerLock:maker}]);
 assert(!isOwnOrder({ownerLock:maker},[taker]));
});
