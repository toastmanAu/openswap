import {createPool,swap,deposit,withdraw,circulatingShares,type Parameters} from './model.js';
// Explicit illustrative policy only: no approved fee/minimum or serialized capacity estimate.
const parameters:Parameters={feeBps:30n,lockedShares:1000n,backing:{state:30000000000n,ckb:10000000000n,token:20000000000n}};
const created=createPool(parameters,1_000_000_000_000n,1_000_000_000_000n,1n);
const traded=swap(created.next,'xToY',10_000_000_000n,9_000_000_000n);
const added=deposit(traded.next,10_000_000_000n,10_000_000_000n,1n);
const removed=withdraw(added.next,added.flows.mintedShares,1n,1n);
console.log(JSON.stringify({notice:'OFF-CHAIN REFERENCE MODEL ONLY. X is shannons; Y and LP shares are integer base units. Storage figures are illustrative, not occupied-capacity estimates.',created,traded,added,removed,remainingCirculatingShares:circulatingShares(removed.next)},(_key,value)=>typeof value==='bigint'?value.toString():value,2));
