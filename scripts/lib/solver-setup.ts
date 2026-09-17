import {ccc} from '@ckb-ccc/core';
import {amountData,assertNetwork,estimateCapacity,CKB,udt,nonces,parseAmount,pin,U128_MAX,type BuildContext,type BuiltTransaction} from '../../sdk/src/index.js';
/** Testnet fixture funding, not a general-purpose token issuance or transfer API. */
export async function buildSolverSetup(context:BuildContext,recipient:ccc.Script):Promise<BuiltTransaction>{
 const {signer,deployment}=context,client=signer.client;
 await assertNetwork(client,deployment);if(deployment.network!=='testnet')throw new Error('Testnet only');
 const owner=(await signer.getRecommendedAddressObj()).script;
 if(owner.eq(recipient))throw new Error('Solver must use a separate wallet');
 const token=await ccc.Script.fromKnownScript(client,ccc.KnownScript.XUdt,owner.hash());
 const tx=ccc.Transaction.from({});
 tx.addOutput(estimateCapacity(deployment,{ownerLock:owner,nonce:nonces(1)[0]!,askAsset:udt(token),askAmount:1n},CKB,1n).cell);
 tx.addOutput({lock:recipient,capacity:ccc.fixedPointFrom('2000')},'0x');
 tx.addOutput({lock:recipient,type:token},amountData(100n));
 const check=pin(tx,0,3);
 await tx.addCellDepsOfKnownScripts(client,ccc.KnownScript.XUdt);
 let balance=0n;
 await tx.completeInputs(signer,{script:token,scriptLenRange:[token.occupiedSize,token.occupiedSize+1],outputDataLenRange:[16,17]},async(_acc,cell)=>{
  if(!cell.cellOutput.lock.eq(owner)||!cell.cellOutput.type?.eq(token))throw new Error('Unexpected token funding');
  balance+=parseAmount(cell.outputData);if(balance>U128_MAX)throw new Error('Token sum overflow');
  return balance>=100n?undefined:balance;
 },0n);
 if(balance<100n)throw new Error('Need 100 units of the previously minted test token');
 if(balance>100n)tx.addOutput({lock:owner,type:token},amountData(balance-100n));
 await tx.completeInputsByCapacity(signer);await tx.completeFeeBy(signer);check(tx);
 const fee=await tx.getFee(client);if(fee<0n||fee>(context.maxFee??100000000n))throw new Error('Setup fee exceeds cap');
 const hash=tx.hash();return{tx,deployment,assertLayout(candidate=tx){check(candidate);if(candidate.hash()!==hash)throw new Error('Setup transaction changed');}};
}
