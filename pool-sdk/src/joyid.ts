/** JoyID resolution, preparation and explicit reviewed signing. Never sends. */
import {ccc} from '@ckb-ccc/core';
import type {BuiltPoolTransaction,Wallet} from './builders.js';
import {assertPoolNetwork,liveCell,pointKey,readBounded,sameCell,withPoolDeadline as deadline,type PoolDeployment,type ReadOptions} from './pools.js';
import {validateJoyIdProof,type JoyIdProofSource} from './joyid-proof.js';
import type {PoolTransactionReview} from './review.js';

export type PoolJoyIdSigner=Pick<ccc.Signer,'client'|'signType'|'getIdentity'|'getAddressObjs'|'prepareTransaction'>&Partial<Pick<ccc.Signer,'signOnlyTransaction'>>;
export interface JoyIdSessionSource {
 /** Revision MUST change on disconnect/account/endpoint/network changes, even
  * when the same account is later restored. A monotonic UI session ID works. */
 current():{signer:PoolJoyIdSigner;revision:string};
}
export interface JoyIdWalletProfile {
 codeHash:ccc.Hex;hashType:ccc.Script['hashType'];
 /** Approved exact direct-code OutPoints AND data hashes, not ticker defaults.
  * Dep groups are deliberately unsupported until their member hashes are pinned. */
 codeDeps:readonly {dep:ccc.CellDepLike;dataHash:ccc.Hex}[];
 /** Exact CoTA type for account-owned subkey state cells, not a prefix. */
 cotaType?:ccc.ScriptLike;
}
export interface ResolvedJoyIdWallet {
 readonly identity:Readonly<{keyType:'main_key'|'sub_key';publicKey:ccc.Hex;lock:ccc.Hex;genesisHash:ccc.Hex;revision:string}>;
 /** Fresh copies; mutating them cannot alter the resolver's captured policy. */
 wallet():Pick<Wallet,'lock'|'deps'|'witness'>;
 assertFresh(options?:ReadOptions):Promise<void>;
 /** Preparation ONLY, with final raw/witness/cache and session checks. */
 prepare(built:BuiltPoolTransaction,options?:ReadOptions):Promise<ccc.Transaction>;
 /** Display both identity and review summary; call sign only on explicit approval.
  * One attempt per review. Cancellation ignores late results, not wallet popups. */
 bindReview(review:PoolTransactionReview):{readonly identity:ResolvedJoyIdWallet['identity'];readonly summary:PoolTransactionReview['summary'];sign(options?:ReadOptions):Promise<ccc.Transaction>};
}

const ZERO_LOCK=ccc.hexFrom(new Uint8Array(1000));
function requireJoy(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(`JoyID pool: ${message}`);}
function hash(value:ccc.Hex):ccc.Hex {requireJoy(/^0x[0-9a-fA-F]{64}$/.test(value),'invalid hash');return value.toLowerCase() as ccc.Hex;}
function identity(text:string):{keyType:'main_key'|'sub_key';publicKey:ccc.Hex} {
 requireJoy(typeof text==='string'&&text.length<=4096,'invalid identity size');
 const value=JSON.parse(text);
 requireJoy(value&&typeof value==='object'&&Object.keys(value).length===2&&(value.keyType==='main_key'||value.keyType==='sub_key'),'unsupported credential type');
 requireJoy(typeof value.publicKey==='string'&&/^(?:[0-9a-fA-F]{2}){1,1024}$/.test(value.publicKey),'invalid public key');
 return {keyType:value.keyType,publicKey:`0x${value.publicKey.toLowerCase()}`};
}
export async function resolveJoyIdWallet(
 source:JoyIdSessionSource,deployment:PoolDeployment,profile:JoyIdWalletProfile,
 funding:ccc.Cell,proofSource?:JoyIdProofSource,options:ReadOptions={},
):Promise<ResolvedJoyIdWallet> {
 // Capture caller data synchronously, before callbacks/RPC can mutate it.
 const {signer,revision}=source.current(),client=signer.client;
 requireJoy(typeof revision==='string'&&revision.length>0&&revision.length<=256,'invalid session revision');
 requireJoy(signer.signType===ccc.SignerSignType.JoyId,'JoyID signer required');
 const selected={...deployment,genesisHash:hash(deployment.genesisHash),poolDep:ccc.CellDep.from(deployment.poolDep).clone(),tokenDep:ccc.CellDep.from(deployment.tokenDep).clone()};
 const expectedCode=hash(profile.codeHash),expectedHashType=profile.hashType;
 const cotaType=profile.cotaType?ccc.Script.from(profile.cotaType).clone():undefined;
 requireJoy(Array.isArray(profile.codeDeps)&&profile.codeDeps.length>=1&&profile.codeDeps.length<=12,'code dependency count must be 1..12');
 const codes=profile.codeDeps.map(({dep,dataHash})=>({dep:ccc.CellDep.from(dep).clone(),dataHash:hash(dataHash)}));
 requireJoy(codes.every(c=>c.dep.depType==='code'),'only pinned direct code dependencies supported');
 requireJoy(new Set(codes.map(c=>pointKey(c.dep.outPoint))).size===codes.length,'duplicate code dependency');
 const probeFunding=funding.clone(),lifetimeSignal=options.signal;
 const check=()=>{
  lifetimeSignal?.throwIfAborted();const current=source.current();
  requireJoy(current.signer===signer&&current.revision===revision&&signer.client===client&&signer.signType===ccc.SignerSignType.JoyId,'wallet session changed');
 };
 async function binding(o:ReadOptions){
  check();o.signal?.throwIfAborted();
  const before=identity(await readBounded(()=>signer.getIdentity(),o));check();
  const addresses=await readBounded(()=>signer.getAddressObjs(),o);check();
  requireJoy(Array.isArray(addresses)&&addresses.length===1,'exactly one JoyID address required');
  const address=addresses[0]!,lock=address.script.clone();
  requireJoy(address.prefix===client.addressPrefix&&lock.codeHash===expectedCode&&lock.hashType===expectedHashType&&lock.toBytes().length<=512,'wallet lock/profile mismatch');
  const after=identity(await readBounded(()=>signer.getIdentity(),o));check();
  requireJoy(before.keyType===after.keyType&&before.publicKey===after.publicKey,'identity changed during account read');
  await assertPoolNetwork(client,selected,o);check();
  return {...before,lock};
 }
 return deadline(options,async o=>{
  const bound=await binding(o),snapshots:ccc.Cell[]=[];
  requireJoy(probeFunding.cellOutput.lock.eq(bound.lock),'funding belongs to another account');
  for(const code of codes){
   const cell=await liveCell(client,code.dep.outPoint,o);check();
   requireJoy(ccc.hashCkb(cell.outputData)===code.dataHash,'wallet code hash mismatch');snapshots.push(cell);
  }
  requireJoy(snapshots.some(cell=>expectedHashType==='type'?cell.cellOutput.type?.hash()===expectedCode:ccc.hashCkb(cell.outputData)===expectedCode),'pinned code does not resolve wallet lock');
  const stateCells:ccc.Cell[]=[];
  let proof:ccc.Hex|undefined;
  if(bound.keyType==='sub_key'){
   requireJoy(cotaType&&cotaType.toBytes().length<=512&&proofSource,'subkey needs explicit CoTA type and proof source');
   // A single bounded page gives at most four account-owned cells; receiving a
   // fifth fails closed, rather than silently truncating a larger dependency set.
   const page=await readBounded(()=>client.findCellsPagedNoCache({script:bound.lock.clone(),scriptType:'lock',scriptSearchMode:'exact',filter:{script:cotaType.clone(),scriptLenRange:[cotaType.toBytes().length,cotaType.toBytes().length+1]},withData:true},'asc',5),o);check();
   requireJoy(page&&Array.isArray(page.cells)&&page.cells.length>=1&&page.cells.length<=4,'CoTA cell count must be 1..4');
   const seen=new Set(codes.map(c=>pointKey(c.dep.outPoint)));
   const indexedCells=page.cells.map(candidate=>{
    requireJoy(candidate.outputData.length<=2+2*1024*1024,'CoTA data exceeds bound');return candidate.clone();
   });
   for(const indexed of indexedCells){
    const key=pointKey(indexed.outPoint);
    requireJoy(!seen.has(key),'duplicate CoTA cell');seen.add(key);
    const live=await liveCell(client,indexed.outPoint,o);check();
    requireJoy(sameCell(indexed,live)&&live.cellOutput.lock.eq(bound.lock)&&live.cellOutput.type?.eq(cotaType),'CoTA owner/type/live mismatch');stateCells.push(live);
   }
   proof=validateJoyIdProof(await readBounded(()=>proofSource({lock:ccc.hexFrom(bound.lock.toBytes()),publicKey:bound.publicKey},o),o));check();
  }
  snapshots.push(...stateCells);
  const deps=[...codes.map(c=>c.dep),...stateCells.map(c=>ccc.CellDep.from({outPoint:c.outPoint,depType:'code'}))];
  const walletWitness=ccc.hexFrom(ccc.WitnessArgs.from({lock:ZERO_LOCK,outputType:proof}).toBytes());
  const assertBinding=async(options:ReadOptions)=>{
   const current=await binding(options);
   requireJoy(current.keyType===bound.keyType&&current.publicKey===bound.publicKey&&current.lock.eq(bound.lock),'connected account changed');
  };
  const fresh=async(options:ReadOptions)=>{
   await assertBinding(options);
   for(const cell of snapshots){requireJoy(sameCell(cell,await liveCell(client,cell.outPoint,options)),'wallet dependency changed or spent');check();}
   await assertBinding(options);
  };
  // Empty-output preflight is never signed. Pre-resolved proof means the real
  // connector need not enter its unbounded aggregator/CoTA lookup branch.
  requireJoy(sameCell(probeFunding,await liveCell(client,probeFunding.outPoint,o)),'funding snapshot changed');check();
  const probe=ccc.Transaction.from({inputs:[probeFunding.clone()],cellDeps:deps.map(d=>d.clone()),witnesses:[walletWitness]});
  const prepared=(await readBounded(()=>signer.prepareTransaction(probe.clone()),o)).clone();check();
  requireJoy(prepared.hash()===probe.hash(),'unexpected preparation raw/dependency mutation');
  requireJoy(Array.isArray(prepared.witnesses)&&prepared.witnesses.length===1&&Object.hasOwn(prepared.witnesses,0)&&prepared.witnesses[0]===walletWitness,'unexpected preparation witness mutation');
  const cached=prepared.inputs[0]!;
  requireJoy((cached.cellOutput===undefined||cached.cellOutput.eq(probeFunding.cellOutput))&&(cached.outputData===undefined||cached.outputData===probeFunding.outputData),'preparation cache mutation');
  await fresh(o);
  requireJoy(sameCell(probeFunding,await liveCell(client,probeFunding.outPoint,o)),'funding changed during preparation');check();
  const capturedIdentity=Object.freeze({...bound,lock:ccc.hexFrom(bound.lock.toBytes()),genesisHash:selected.genesisHash,revision});
  const boundReviews=new WeakSet<PoolTransactionReview>();
  return Object.freeze({
   identity:capturedIdentity,
   wallet:()=>({lock:bound.lock.clone(),deps:deps.map(d=>d.clone()),witness:{kind:'joyid' as const,outputType:proof}}),
   assertFresh:(options:ReadOptions={})=>deadline(options,fresh),
   bindReview:(review:PoolTransactionReview)=>{
    check();requireJoy(!boundReviews.has(review),'review already bound');
    requireJoy(review.summary.genesisHash===selected.genesisHash&&review.summary.owner===capturedIdentity.lock,'review account/network mismatch');
    const tx=review.transaction(),index=review.summary.walletWitnessIndex;
    requireJoy(tx.witnesses[index]===walletWitness,'review wallet witness mismatch');
    const expected=[selected.poolDep,selected.tokenDep,...deps].filter((dep,index,all)=>all.findIndex(other=>other.eq(dep))===index);
    requireJoy(tx.cellDeps.length===expected.length&&tx.cellDeps.every((dep,i)=>dep.eq(expected[i]!)),'review dependency mismatch');
    boundReviews.add(review);let attempted=false;
    return Object.freeze({identity:capturedIdentity,summary:review.summary,
     sign:(options:ReadOptions={})=>deadline(options,async o=>{
      requireJoy(!attempted,'review already used for signing');attempted=true;
      requireJoy(typeof signer.signOnlyTransaction==='function','sign-only method unavailable');
      await fresh(o);await review.assertFresh(client,o,tx);check();review.assertIntegrity(tx);
      const signed=(await readBounded(()=>{check();review.assertIntegrity(tx);return signer.signOnlyTransaction!(tx.clone());},o)).clone();
      check();review.assertIntegrity(signed);
      const lock=ccc.WitnessArgs.fromBytes(signed.witnesses[index]!).lock;
      requireJoy(lock!==undefined&&ccc.bytesFrom(lock).some(byte=>byte!==0),'wallet returned unsigned placeholder');
      await review.assertFresh(client,o,signed);await fresh(o);
      check();review.assertIntegrity(signed);o.signal?.throwIfAborted();return signed.clone();
     }),
    });
   },
   prepare:(built:BuiltPoolTransaction,options:ReadOptions={})=>deadline(options,async o=>{
    await fresh(o);built.assertIntegrity();
    const tx=built.transaction.clone(),index=built.walletWitnessIndex;
    requireJoy(Number.isSafeInteger(index)&&index>=0&&index<tx.inputs.length,'invalid wallet witness index');
    requireJoy(tx.witnesses[index]===walletWitness,'transaction does not use the resolved wallet witness');
    const expected=[selected.poolDep,selected.tokenDep,...deps].filter((dep,index,all)=>all.findIndex(other=>other.eq(dep))===index);
    requireJoy(tx.cellDeps.length===expected.length&&tx.cellDeps.every((dep,i)=>dep.eq(expected[i]!)),'transaction dependency set differs from resolved profile');
    const input=await liveCell(client,tx.inputs[index]!.previousOutput,o);check();
    requireJoy(input.cellOutput.lock.eq(bound.lock),'transaction belongs to another account');
    await built.assertFresh(client,o,tx);check();
    const candidate=(await readBounded(()=>signer.prepareTransaction(tx.clone()),o)).clone();check();
    built.assertIntegrity(candidate);
    requireJoy(candidate.witnesses[index]===walletWitness,'preparation changed the pinned wallet witness');
    await built.assertFresh(client,o,candidate);await fresh(o);built.assertIntegrity(candidate);check();
    return candidate.clone();
   }),
  });
 });
}
