import {ccc} from '@ckb-ccc/core';
import {decodeOwner,type Deployment} from '@openswap/sdk';
/** `deployments`: every order lock whose cells count as this account's orders (v1, v2). */
export async function capacityReview(tx:ccc.Transaction,client:ccc.Client,locks:readonly ccc.Script[],deployments:readonly Deployment[]){
 const mine=(lock:ccc.Script)=>locks.some(l=>l.eq(lock));
 const order=(lock:ccc.Script)=>{if(lock.hashType!=='data1'||!deployments.some(d=>d.codeHash===lock.codeHash))return false;try{return mine(decodeOwner(lock.args).ownerLock);}catch{return false;}};
 let input=0n,output=0n,tokenReserveIn=0n,tokenReserveOut=0n,orderLocked=0n,orderReleased=0n;
 for(const i of tx.inputs){const cell=await i.getCell(client);if(mine(cell.cellOutput.lock)){input+=cell.cellOutput.capacity;if(cell.cellOutput.type)tokenReserveIn+=ccc.CellOutput.from({lock:cell.cellOutput.lock,type:cell.cellOutput.type},cell.outputData).capacity;}if(order(cell.cellOutput.lock))orderReleased+=cell.cellOutput.capacity;}
 tx.outputs.forEach((o,i)=>{if(mine(o.lock)){output+=o.capacity;if(o.type)tokenReserveOut+=ccc.CellOutput.from({lock:o.lock,type:o.type},tx.outputsData[i]!).capacity;}if(order(o.lock))orderLocked+=o.capacity;});
 return{walletChange:output-input,tokenReserveChange:tokenReserveOut-tokenReserveIn,orderLocked,orderReleased};
}
