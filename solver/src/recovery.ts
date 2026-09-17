import {ccc} from '@ckb-ccc/core';
/** Discard a rejected/unknown transaction's speculative change and restore only live inputs. */
export async function recoverConflictedTransaction(client:ccc.Client,tx:ccc.Transaction):Promise<void>{
 await client.cache.markUnusable(tx.outputs.map((_output,index)=>({txHash:tx.hash(),index})));
 for(const input of tx.inputs){
  // Include the local transaction pool: do not restore inputs reserved there.
  const live=await client.getCellLive(input.previousOutput,true,true);
  if(live)await client.cache.markUsable(live);
  else await client.cache.markUnusable(input.previousOutput);
 }
}
