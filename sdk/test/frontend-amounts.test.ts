import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseUnits,formatUnits} from '../../frontend/src/amounts.js';
test('display amounts convert exactly without changing on-chain units',()=>{
 assert.equal(parseUnits('0.0001',8),10000n);assert.equal(parseUnits('9000',0),9000n);
 assert.equal(parseUnits('123456789123456789.12345678',8),12345678912345678912345678n);
 for(const n of [1n,10000n,9000n,2n**128n-1n])for(const d of [0,8,18])assert.equal(parseUnits(formatUnits(n,d),d),n);
 for(const value of ['0','-1','NaN','1e8','0.000000001','1.1.1'])assert.throws(()=>parseUnits(value,8));
 assert.throws(()=>parseUnits('0.1',0));
});
test('unit prices account for different decimals without floating point',async()=>{
 const {unitPrice}=await import('../../frontend/src/amounts.js');
 assert.equal(unitPrice(500000000000n,1000000000000n,8,8),'0.5');
 assert.equal(unitPrice(9000n,10000n,0,8),'90000000');
 assert.equal(unitPrice(1n,10n**30n,8,8),'<0.00000001');
});
