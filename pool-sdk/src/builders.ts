/** Explicit-input, single-wallet unsigned builders. Never signs or broadcasts. */
import {ccc} from '@ckb-ccc/core';
import {writeLE,parseAmount} from '../../sdk/src/codec.js';
import {createPool,transition,type Parameters,type Operation,type Result} from '../../pool-model/src/model.js';
import {encodeAction,encodeState,poolScript,Role,XUDT_CODE_HASH,type Action,type StateData} from './codec.js';
import {parsePool,validateCell,minimumCapacity,pointKey,sameCell,assertPoolNetwork,assertPoolDependencies,liveCell,type PoolDeployment,type PoolSnapshot,type PoolClient,type ReadOptions} from './pools.js';

export interface Wallet {
 /** All funding inputs must use this one lock. Signature slot is exactly 65 bytes. */
 lock:ccc.ScriptLike;deps:ccc.CellDepLike[];funding:ccc.Cell[];
 change:ccc.ScriptLike;feeRate:bigint;maxFee:bigint;
}
export interface Recipients {ckb:ccc.ScriptLike;token:ccc.ScriptLike;lp:ccc.ScriptLike}
export interface CreateRequest {parameters:Parameters;x:bigint;y:bigint;minShares:bigint;tokenOwner:ccc.Hex}
export interface BuiltPoolTransaction {
 transaction:ccc.Transaction;poolId:ccc.Hex;result:Result;fee:bigint;ckbReceiptTopUp:bigint;walletWitnessIndex:number;
 /** Pins raw bytes/witnesses except the signature; optional input caches must match reviewed inputs. */
 assertIntegrity:(transaction?:ccc.Transaction)=>void;
 /** Recheck immediately before signing/submitting; liveness is never a reservation. */
 assertFresh:(client:PoolClient,options?:ReadOptions,candidate?:ccc.Transaction)=>Promise<void>;
}
function requireBuild(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(`Pool build: ${message}`);}
const amount=(n:bigint)=>ccc.hexFrom(writeLE(n,16));
const output=(lock:ccc.ScriptLike,type?:ccc.ScriptLike,data:ccc.Hex='0x',capacity?:bigint):ccc.CellAny=>ccc.CellAny.from({cellOutput:ccc.CellOutput.from({lock:ccc.Script.from(lock).clone(),type:type?ccc.Script.from(type).clone():undefined,capacity},data),outputData:data});

export function buildCreate(deployment:PoolDeployment,wallet:Wallet,recipients:Recipients,request:CreateRequest):BuiltPoolTransaction {
 requireBuild(wallet.funding.length>0,'creation needs an explicit first funding input');
 const first=ccc.CellInput.from(wallet.funding[0]!);
 const id=ccc.hashCkb(ccc.bytesConcat(first.toBytes(),writeLE(0n,8)));
 const result=createPool(request.parameters,request.x,request.y,request.minShares);
 const metadata:StateData={fee:request.parameters.feeBps,locked:request.parameters.lockedShares,shares:result.next.totalShares,
  backingState:request.parameters.backing.state,backingCkb:request.parameters.backing.ckb,backingToken:request.parameters.backing.token,
  rx:1n,ry:2n,tokenCodeHash:XUDT_CODE_HASH,tokenOwner:request.tokenOwner};
 return build(deployment,wallet,recipients,id,metadata,{kind:'create',minShares:request.minShares},result);
}
export function buildTransition(deployment:PoolDeployment,wallet:Wallet,recipients:Recipients,pool:PoolSnapshot,action:Operation):BuiltPoolTransaction {
 // Re-derive from exact cells, never trust caller-supplied accounting or script summaries.
 const checked=parsePool(deployment,pool.stateCell,pool.ckbCell,pool.tokenCell);
 const result=transition(checked.accounting,action);
 return build(deployment,wallet,recipients,checked.poolId,{...checked.metadata,shares:result.next.totalShares,rx:1n,ry:2n},action,result,checked);
}
function build(deployment:PoolDeployment,wallet:Wallet,recipients:Recipients,id:ccc.Hex,metadata:StateData,action:Action,result:Result,previous?:PoolSnapshot):BuiltPoolTransaction {
 requireBuild(wallet.funding.length>0&&wallet.funding.length<=(previous?253:256),'funding count outside bounds');
 requireBuild(typeof wallet.feeRate==='bigint'&&wallet.feeRate>0n&&typeof wallet.maxFee==='bigint'&&wallet.maxFee>0n,'positive fee rate and cap required');
 requireBuild(wallet.deps.length>0&&wallet.deps.length<=16,'explicit wallet dependencies required');
 const roles=[0,1,2,3,4].map(role=>poolScript(deployment.codeHash,id,role));
 const token=ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:metadata.tokenOwner});
 const owner=ccc.Script.from(wallet.lock),change=ccc.Script.from(wallet.change);
 // Never select issuer-mode xUDT funding; only conservation is supported here.
 requireBuild(owner.hash()!==metadata.tokenOwner,'xUDT issuer-mode funding is unsupported');
 for(const lock of [owner,change,...Object.values(recipients).map(s=>ccc.Script.from(s))]){
  requireBuild(lock.toBytes().length<=512,'recipient script too large');
  requireBuild(lock.codeHash!==deployment.codeHash,'pool validator is not a wallet/recipient lock');
 }
 const inputs=[...(previous?[previous.stateCell,previous.ckbCell,previous.tokenCell]:[]),...wallet.funding].map(c=>c.clone());
 requireBuild(new Set(inputs.map(c=>pointKey(c.outPoint))).size===inputs.length,'duplicate input');
 let availableY=0n,availableLp=0n;
 for(const cell of wallet.funding){
  validateCell(cell);requireBuild(cell.cellOutput.lock.eq(owner),'mixed wallet signing groups');
  const type=cell.cellOutput.type;
  if(!type)requireBuild(cell.outputData==='0x','plain funding must have empty data');
  else if(type.eq(token))availableY+=parseAmount(cell.outputData);
  else if(previous&&type.eq(roles[4]!))availableLp+=parseAmount(cell.outputData);
  else throw new Error('Pool build: unsupported funding type');
 }
 const {next,flows}=result;
 requireBuild(availableY<(1n<<128n)&&availableLp<(1n<<128n),'aggregate token/LP amount exceeds u128');
 requireBuild(availableY>=flows.paidY&&availableLp>=flows.burnedShares,'insufficient token/LP funding');
 const cells=[output(roles[1]!,roles[0]!,encodeState(metadata),metadata.backingState),
  output(roles[2]!,undefined,'0x',metadata.backingCkb+next.x),output(roles[3]!,token,amount(next.y),metadata.backingToken)];
 // This validates genesis occupied backing and the selected immutable profile as well.
 const synthetic=cells.map((c,index)=>ccc.Cell.from({...c,outPoint:{txHash:id,index}}));
 parsePool(deployment,synthetic[0]!,synthetic[1]!,synthetic[2]!);
 let ckbReceiptTopUp=0n;
 if(flows.receivedX){const c=output(recipients.ckb);ckbReceiptTopUp=c.cellOutput.capacity>flows.receivedX?c.cellOutput.capacity-flows.receivedX:0n;c.cellOutput.capacity=flows.receivedX+ckbReceiptTopUp;cells.push(c);}
 if(flows.receivedY)cells.push(output(recipients.token,token,amount(flows.receivedY)));
 if(flows.mintedShares)cells.push(output(recipients.lp,roles[4]!,amount(flows.mintedShares)));
 if(availableY>flows.paidY)cells.push(output(change,token,amount(availableY-flows.paidY)));
 if(availableLp>flows.burnedShares)cells.push(output(change,roles[4]!,amount(availableLp-flows.burnedShares)));
 const changeCell=output(change);cells.push(changeCell);
 const remaining=inputs.reduce((n,c)=>n+c.cellOutput.capacity,0n)-cells.slice(0,-1).reduce((n,c)=>n+c.cellOutput.capacity,0n);
 requireBuild(remaining>=minimumCapacity(changeCell),'insufficient capacity for receipts and change');
 changeCell.cellOutput.capacity=remaining;
 const walletWitnessIndex=previous?3:0;
 const witnesses:ccc.Hex[]=inputs.map(()=> '0x');
 witnesses[0]=ccc.hexFrom(ccc.WitnessArgs.from(previous?{inputType:encodeAction(action)}:{outputType:encodeAction(action),lock:new Uint8Array(65)}).toBytes());
 if(previous)witnesses[walletWitnessIndex]=ccc.hexFrom(ccc.WitnessArgs.from({lock:new Uint8Array(65)}).toBytes());
 const deps=[deployment.poolDep,deployment.tokenDep,...wallet.deps].map(d=>ccc.CellDep.from(d));
 const unique=deps.filter((d,i)=>deps.findIndex(other=>ccc.hexFrom(other.toBytes())===ccc.hexFrom(d.toBytes()))===i);
 const transaction=ccc.Transaction.from({inputs,outputs:cells.map(c=>c.cellOutput),outputsData:cells.map(c=>c.outputData),cellDeps:unique,witnesses});
 const fee=transaction.estimateFee(wallet.feeRate);
 requireBuild(fee<=wallet.maxFee,'fee exceeds explicit cap');
 requireBuild(remaining-fee>=minimumCapacity(changeCell),'change would be dust after fee');
 transaction.outputs[transaction.outputs.length-1]!.capacity=remaining-fee;
 for(let i=0;i<transaction.outputs.length;i++)validateCell(ccc.CellAny.from({cellOutput:transaction.outputs[i]!,outputData:transaction.outputsData[i]!}));
 const rawHash=transaction.hash(),savedWitnesses=[...transaction.witnesses];
 // CCC input caches can alias the transaction's mutable objects. Keep independent
 // snapshots for both cache comparisons and subsequent live-input checks.
 const reviewedInputs=inputs.map(cell=>cell.clone());
 const assertIntegrity=(tx=transaction)=>{
  requireBuild(tx.hash()===rawHash,'raw transaction changed');
  for(let i=0;i<reviewedInputs.length;i++){
   const candidate=tx.inputs[i]!,expected=reviewedInputs[i]!;
   // Raw-deserialized inputs have no caches. Validate each cache when supplied;
   // never normalize or repair candidate values while checking them.
   requireBuild(candidate.cellOutput===undefined||(candidate.cellOutput instanceof ccc.CellOutput&&candidate.cellOutput.eq(expected.cellOutput)),'cached input output changed');
   requireBuild(candidate.outputData===undefined||candidate.outputData===expected.outputData,'cached input data changed');
  }
  requireBuild(Array.isArray(tx.witnesses)&&tx.witnesses.length===savedWitnesses.length,'witness count changed');
  for(let i=0;i<savedWitnesses.length;i++){
   requireBuild(Object.hasOwn(tx.witnesses,i),'missing witness slot');
   const w=tx.witnesses[i];
   requireBuild(typeof w==='string'&&w.length===savedWitnesses[i]!.length&&/^0x(?:[0-9a-fA-F]{2})*$/.test(w),'invalid witness bytes');
   if(i!==walletWitnessIndex){requireBuild(w===savedWitnesses[i],'pool action or other witness changed');continue;}
   const args=ccc.WitnessArgs.fromBytes(w);
   requireBuild(args.lock!==undefined&&ccc.bytesFrom(args.lock).length===65,'wallet signature must be 65 bytes');
   args.lock=ccc.hexFrom(new Uint8Array(65));
   requireBuild(ccc.hexFrom(args.toBytes())===savedWitnesses[i],'wallet witness fields changed');
  }
 };
 const capturedDeployment={...deployment,poolDep:ccc.CellDep.from(deployment.poolDep).clone(),tokenDep:ccc.CellDep.from(deployment.tokenDep).clone()};
 return {transaction,poolId:id,result,fee,ckbReceiptTopUp,walletWitnessIndex,assertIntegrity,
  assertFresh:async(client,options={},candidate=transaction)=>{
   assertIntegrity(candidate);await assertPoolNetwork(client,capturedDeployment,options);
   await assertPoolDependencies(client,capturedDeployment,options);
   for(const cell of reviewedInputs)requireBuild(sameCell(cell,await liveCell(client,cell.outPoint,options)),'live input content changed');
   // Recheck state last to detect a transition racing the wallet reads.
   if(previous)requireBuild(sameCell(reviewedInputs[0]!,await liveCell(client,reviewedInputs[0]!.outPoint,options)),'pool changed during freshness check');
   // Wallet preparation or application code may mutate the transaction during RPC awaits.
   assertIntegrity(candidate);
  }};
}
