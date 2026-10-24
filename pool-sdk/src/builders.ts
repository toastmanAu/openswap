/** Explicit-input, single-wallet unsigned builders. Never signs or broadcasts. */
import {ccc} from '@ckb-ccc/core';
import {writeLE,parseAmount} from '../../sdk/src/codec.js';
import {payment} from '../../sdk/src/capacity.js';
import {decodeOrder} from '../../sdk/src/orders.js';
import {createPool,transition,type Parameters,type Operation,type Result} from '../../pool-model/src/model.js';
import {encodeAction,encodeState,poolScript,Role,XUDT_CODE_HASH,type Action,type StateData} from './codec.js';
import {parsePool,validateCell,minimumCapacity,pointKey,sameCell,assertPoolNetwork,assertPoolDependencies,liveCell,liveCells,type PoolDeployment,type PoolSnapshot,type PoolClient,type ReadOptions} from './pools.js';

export interface Wallet {
 /** All funding inputs must use this one lock. Default signing shape is 65-byte secp. */
 lock:ccc.ScriptLike;deps:ccc.CellDepLike[];funding:ccc.Cell[];
 change:ccc.ScriptLike;feeRate:bigint;maxFee:bigint;
 /** Explicit JoyID layout. Resolve/pin any subkey proof and dependencies before building. */
 witness?:{kind:'joyid';outputType?:ccc.Hex};
}
export interface Recipients {ckb:ccc.ScriptLike;token:ccc.ScriptLike;lp:ccc.ScriptLike}
/** Order-book lots filled in the same transaction as a pool swap (split route).
 * Lot `i` is input `i` and its maker payment is output `i`, as the order lock
 * requires; the pool cells follow at `n..n+2`. Terms and payments are derived
 * here from the exact cells, never taken from the caller. */
export interface OrderFill {codeHash:ccc.Hex;cellDep:ccc.CellDepLike;cells:ccc.Cell[]}
export interface OrderLeg {outPoint:ccc.OutPoint;owner:ccc.Script;offer:'ckb'|'token';offerAmount:bigint;ask:'ckb'|'token';askAmount:bigint;paymentIndex:number}
export interface CreateRequest {parameters:Parameters;x:bigint;y:bigint;minShares:bigint;tokenOwner:ccc.Hex}
export interface BuiltPoolTransaction {
 transaction:ccc.Transaction;poolId:ccc.Hex;result:Result;fee:bigint;ckbReceiptTopUp:bigint;walletWitnessIndex:number;stateOutputIndex:number;
 /** Witness index holding the pool action (the state input index for a transition). */
 actionWitnessIndex:number;
 /** Filled order lots, in input/payment order; empty for a pool-only transaction. */
 orders:readonly OrderLeg[];orderDep?:ccc.CellDep;
 /** Pins raw bytes/witnesses except the signature; optional input caches must match reviewed inputs. */
 assertIntegrity:(transaction?:ccc.Transaction)=>void;
 /** Recheck immediately before signing/submitting; liveness is never a reservation. */
 assertFresh:(client:PoolClient,options?:ReadOptions,candidate?:ccc.Transaction)=>Promise<void>;
}
export class PoolBuildError extends Error {
 constructor(readonly code:'INVALID'|'FUNDING'|'FEE',message:string){super(`Pool build: ${message}`);this.name='PoolBuildError';}
}
function requireBuild(ok:unknown,message:string,code:'INVALID'|'FUNDING'|'FEE'='INVALID'):asserts ok {if(!ok)throw new PoolBuildError(code,message);}
const amount=(n:bigint)=>ccc.hexFrom(writeLE(n,16));
const output=(lock:ccc.ScriptLike,type?:ccc.ScriptLike,data:ccc.Hex='0x',capacity?:bigint):ccc.CellAny=>ccc.CellAny.from({cellOutput:ccc.CellOutput.from({lock:ccc.Script.from(lock).clone(),type:type?ccc.Script.from(type).clone():undefined,capacity},data),outputData:data});

export function buildCreate(deployment:PoolDeployment,wallet:Wallet,recipients:Recipients,request:CreateRequest):BuiltPoolTransaction {
 requireBuild(wallet.funding.length>0,'creation needs an explicit first funding input');
 const first=ccc.CellInput.from(wallet.funding[0]!);
 // JoyID's first wallet outputType may contain a subkey proof. Put the create
 // action at witness/output index 1 instead, using the already-supported ABI.
 const stateIndex=wallet.witness?.kind==='joyid'?1n:0n;
 const id=ccc.hashCkb(ccc.bytesConcat(first.toBytes(),writeLE(stateIndex,8)));
 const result=createPool(request.parameters,request.x,request.y,request.minShares);
 const metadata:StateData={fee:request.parameters.feeBps,locked:request.parameters.lockedShares,shares:result.next.totalShares,
  backingState:request.parameters.backing.state,backingCkb:request.parameters.backing.ckb,backingToken:request.parameters.backing.token,
  rx:stateIndex+1n,ry:stateIndex+2n,tokenCodeHash:XUDT_CODE_HASH,tokenOwner:request.tokenOwner};
 return build(deployment,wallet,recipients,id,metadata,{kind:'create',minShares:request.minShares},result);
}
export function buildTransition(deployment:PoolDeployment,wallet:Wallet,recipients:Recipients,pool:PoolSnapshot,action:Operation,orders?:OrderFill):BuiltPoolTransaction {
 // Re-derive from exact cells, never trust caller-supplied accounting or script summaries.
 const checked=parsePool(deployment,pool.stateCell,pool.ckbCell,pool.tokenCell);
 const result=transition(checked.accounting,action);
 const n=BigInt(orders?.cells.length??0);
 return build(deployment,wallet,recipients,checked.poolId,{...checked.metadata,shares:result.next.totalShares,rx:n+1n,ry:n+2n},action,result,checked,orders);
}
/** Lots must trade the pool's own pair in the swap's direction: paying CKB they
 * offer the pool token for CKB, paying the token they offer CKB for it. */
function orderLegs(fill:OrderFill,token:ccc.Script,action:Action,poolCode:ccc.Hex){
 requireBuild(action.kind==='swap','order lots combine only with a pool swap');
 requireBuild(fill.cells.length>=1&&fill.cells.length<=32,'select 1..32 order lots');
 requireBuild(ccc.CellDep.from(fill.cellDep).depType==='code','order dependency must be a direct code cell');
 const asset=(t?:ccc.Script)=>t===undefined?'ckb' as const:t.eq(token)?'token' as const:undefined;
 const lockHashes=new Set(fill.cells.map(c=>c.cellOutput.lock.hash()));
 requireBuild(lockHashes.size===fill.cells.length,'duplicate order lock group');
 return fill.cells.map((cell,index)=>{
  validateCell(cell);
  let decoded;try{decoded=decodeOrder(cell,fill.codeHash);}catch(error){throw new PoolBuildError('INVALID',`order lot ${index}: ${error instanceof Error?error.message:error}`);}
  const offer=asset(decoded.offerAsset.kind==='udt'?decoded.offerAsset.script:undefined),ask=asset(decoded.askAsset.kind==='udt'?decoded.askAsset.script:undefined);
  requireBuild(offer&&ask&&offer!==ask,'order lot does not trade this pool pair');
  requireBuild(action.direction==='xToY'?ask==='ckb':ask==='token','order lot direction differs from the pool swap');
  let paid;try{paid=payment(decoded);}catch(error){throw new PoolBuildError('INVALID',`order lot ${index}: ${error instanceof Error?error.message:error}`);}
  const owner=decoded.ownerLock;
  requireBuild(!lockHashes.has(owner.hash())&&owner.codeHash!==poolCode&&owner.toBytes().length<=1024,'order owner lock unsupported');
  return {cell:cell.clone(),payment:paid,leg:{outPoint:cell.outPoint.clone(),owner:owner.clone(),offer,offerAmount:decoded.offerAmount,ask,askAmount:decoded.askAmount,paymentIndex:index} satisfies OrderLeg};
 });
}
function build(deployment:PoolDeployment,wallet:Wallet,recipients:Recipients,id:ccc.Hex,metadata:StateData,action:Action,result:Result,previous?:PoolSnapshot,fill?:OrderFill):BuiltPoolTransaction {
 requireBuild(wallet.witness===undefined||wallet.witness.kind==='joyid','unsupported wallet witness profile');
 const joyid=wallet.witness?.kind==='joyid',signatureBytes=joyid?1000:65;
 const token=ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:metadata.tokenOwner});
 const legs=fill?orderLegs(fill,token,action,deployment.codeHash):[],n=legs.length;
 requireBuild(!fill||previous,'order lots need an existing pool');
 const stateOutputIndex=!previous&&joyid?1:n;
 const proof=wallet.witness?.outputType;
 requireBuild(proof===undefined||(typeof proof==='string'&&proof.length<=6002&&/^0x(?:[0-9a-fA-F]{2})*$/.test(proof)),'invalid or oversized wallet proof');
 requireBuild(wallet.funding.length>0&&wallet.funding.length<=(previous?253-n:256),'funding count outside bounds');
 requireBuild(typeof wallet.feeRate==='bigint'&&wallet.feeRate>0n&&typeof wallet.maxFee==='bigint'&&wallet.maxFee>0n,'positive fee rate and cap required');
 requireBuild(wallet.deps.length>0&&wallet.deps.length<=16,'explicit wallet dependencies required');
 const roles=[0,1,2,3,4].map(role=>poolScript(deployment.codeHash,id,role));
 const owner=ccc.Script.from(wallet.lock),change=ccc.Script.from(wallet.change);
 // Never select issuer-mode xUDT funding; only conservation is supported here.
 requireBuild(owner.hash()!==metadata.tokenOwner,'xUDT issuer-mode funding is unsupported');
 for(const lock of [owner,change,...Object.values(recipients).map(s=>ccc.Script.from(s))]){
  requireBuild(lock.toBytes().length<=512,'recipient script too large');
  requireBuild(lock.codeHash!==deployment.codeHash,'pool validator is not a wallet/recipient lock');
 }
 const inputs=[...legs.map(l=>l.cell),...(previous?[previous.stateCell,previous.ckbCell,previous.tokenCell]:[]),...wallet.funding].map(c=>c.clone());
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
 // Lots paying CKB deliver tokens and the reverse; both legs are the user's trade.
 const sum=(f:(l:OrderLeg)=>bigint)=>legs.reduce((total,l)=>total+f(l.leg),0n);
 const lotTokenIn=sum(l=>l.offer==='token'?l.offerAmount:0n),lotTokenOut=sum(l=>l.ask==='token'?l.askAmount:0n),lotCkbIn=sum(l=>l.offer==='ckb'?l.offerAmount:0n);
 requireBuild(availableY<(1n<<128n)&&availableLp<(1n<<128n)&&lotTokenIn<(1n<<128n)&&lotTokenOut<(1n<<128n),'aggregate token/LP amount exceeds u128');
 requireBuild(availableY>=flows.paidY+lotTokenOut&&availableLp>=flows.burnedShares,'insufficient token/LP funding','FUNDING');
 const cells=[output(roles[1]!,roles[0]!,encodeState(metadata),metadata.backingState),
  output(roles[2]!,undefined,'0x',metadata.backingCkb+next.x),output(roles[3]!,token,amount(next.y),metadata.backingToken)];
 // This validates genesis occupied backing and the selected immutable profile as well.
 const synthetic=cells.map((c,index)=>ccc.Cell.from({...c,outPoint:{txHash:id,index:index+stateOutputIndex}}));
 parsePool(deployment,synthetic[0]!,synthetic[1]!,synthetic[2]!);
 let ckbReceiptTopUp=0n;
 const receivedX=flows.receivedX+lotCkbIn,receivedY=flows.receivedY+lotTokenIn;
 if(receivedX){const c=output(recipients.ckb);ckbReceiptTopUp=c.cellOutput.capacity>receivedX?c.cellOutput.capacity-receivedX:0n;c.cellOutput.capacity=receivedX+ckbReceiptTopUp;cells.push(c);}
 if(receivedY)cells.push(output(recipients.token,token,amount(receivedY)));
 if(flows.mintedShares)cells.push(output(recipients.lp,roles[4]!,amount(flows.mintedShares)));
 if(availableY>flows.paidY+lotTokenOut)cells.push(output(change,token,amount(availableY-flows.paidY-lotTokenOut)));
 if(availableLp>flows.burnedShares)cells.push(output(change,roles[4]!,amount(availableLp-flows.burnedShares)));
 const changeCell=output(change);cells.push(changeCell);
 // Genesis always mints LP. Move that wallet receipt before the three pool
 // outputs; keep final plain change last for fee accounting. Legacy layout is unchanged.
 if(stateOutputIndex===1)cells.unshift(cells.splice(3,1)[0]!);
 cells.unshift(...legs.map(l=>l.payment));
 const remaining=inputs.reduce((n,c)=>n+c.cellOutput.capacity,0n)-cells.slice(0,-1).reduce((n,c)=>n+c.cellOutput.capacity,0n);
 requireBuild(remaining>=minimumCapacity(changeCell),'insufficient capacity for receipts and change','FUNDING');
 changeCell.cellOutput.capacity=remaining;
 const walletWitnessIndex=previous?n+3:0,actionWitnessIndex=previous?n:stateOutputIndex;
 const witnesses:ccc.Hex[]=Array.from({length:Math.max(inputs.length,stateOutputIndex+1)},()=> '0x');
 const walletArgs=ccc.WitnessArgs.from({lock:new Uint8Array(signatureBytes),outputType:proof});
 witnesses[walletWitnessIndex]=ccc.hexFrom(walletArgs.toBytes());
 if(previous)witnesses[n]=ccc.hexFrom(ccc.WitnessArgs.from({inputType:encodeAction(action)}).toBytes());
 else if(stateOutputIndex===0){walletArgs.outputType=encodeAction(action);witnesses[0]=ccc.hexFrom(walletArgs.toBytes());}
 else witnesses[stateOutputIndex]=ccc.hexFrom(ccc.WitnessArgs.from({outputType:encodeAction(action)}).toBytes());
 const orderDep=fill?ccc.CellDep.from(fill.cellDep).clone():undefined;
 const deps=[deployment.poolDep,deployment.tokenDep,...(orderDep?[orderDep]:[]),...wallet.deps].map(d=>ccc.CellDep.from(d));
 const unique=deps.filter((d,i)=>deps.findIndex(other=>ccc.hexFrom(other.toBytes())===ccc.hexFrom(d.toBytes()))===i);
 const transaction=ccc.Transaction.from({inputs,outputs:cells.map(c=>c.cellOutput),outputsData:cells.map(c=>c.outputData),cellDeps:unique,witnesses});
 const fee=transaction.estimateFee(wallet.feeRate);
 requireBuild(fee<=wallet.maxFee,'fee exceeds explicit cap','FEE');
 requireBuild(remaining-fee>=minimumCapacity(changeCell),'change would be dust after fee','FUNDING');
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
   requireBuild(typeof w==='string'&&w.length<=savedWitnesses[i]!.length&&/^0x(?:[0-9a-fA-F]{2})*$/.test(w),'invalid witness bytes');
   if(i!==walletWitnessIndex){requireBuild(w===savedWitnesses[i],'pool action or other witness changed');continue;}
   const args=ccc.WitnessArgs.fromBytes(w);
   requireBuild(ccc.hexFrom(args.toBytes())===w.toLowerCase(),'noncanonical wallet witness');
   const length=args.lock===undefined?0:ccc.bytesFrom(args.lock).length;
   requireBuild(joyid?length>=1&&length<=signatureBytes:length===65,joyid?'JoyID signature must be 1..1000 bytes':'wallet signature must be 65 bytes');
   args.lock=ccc.hexFrom(new Uint8Array(signatureBytes));
   requireBuild(ccc.hexFrom(args.toBytes())===savedWitnesses[i],'wallet witness fields changed');
  }
 };
 const capturedDeployment={...deployment,poolDep:ccc.CellDep.from(deployment.poolDep).clone(),tokenDep:ccc.CellDep.from(deployment.tokenDep).clone()};
 const orderCode=fill?.codeHash;
 return {transaction,poolId:id,result,fee,ckbReceiptTopUp,walletWitnessIndex,stateOutputIndex,actionWitnessIndex,
  orders:Object.freeze(legs.map(l=>Object.freeze(l.leg))),orderDep:orderDep?.clone(),assertIntegrity,
  assertFresh:async(client,options={},candidate=transaction)=>{
   assertIntegrity(candidate);
   // Network, dependencies and inputs are independent reads; run them together.
   const [,,live,orderCodeCell]=await Promise.all([assertPoolNetwork(client,capturedDeployment,options),assertPoolDependencies(client,capturedDeployment,options),liveCells(client,reviewedInputs.map(c=>c.outPoint),options),
    orderDep?liveCell(client,orderDep.outPoint,options):undefined]);
   for(const [i,cell] of reviewedInputs.entries())requireBuild(sameCell(cell,live[i]!),'live input content changed');
   // Data1 order locks name their code by data hash.
   if(orderDep)requireBuild(ccc.hashCkb(orderCodeCell!.outputData)===orderCode,'order dependency data hash does not match the order lock');
   // Recheck state last to detect a transition racing the wallet reads.
   if(previous)requireBuild(sameCell(reviewedInputs[n]!,await liveCell(client,reviewedInputs[n]!.outPoint,options)),'pool changed during freshness check');
   // Wallet preparation or application code may mutate the transaction during RPC awaits.
   assertIntegrity(candidate);
  }};
}
