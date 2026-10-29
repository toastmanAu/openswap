/** Bounded single-owner funding. No signing, send, or automatic consolidation. */
import {ccc} from '@ckb-ccc/core';
import {parseAmount} from '../../sdk/src/codec.js';
import {createPool,transition,swap,type Operation} from '../../pool-model/src/model.js';
import {XUDT_CODE_HASH} from './codec.js';
import {buildCreate,buildTransition,buildRoute,PoolBuildError,type Wallet,type Recipients,type CreateRequest,type BuiltPoolTransaction,type OrderFill} from './builders.js';
import {decodeOrder} from '../../sdk/src/orders.js';
import {assertPoolNetwork,liveCells,parsePool,pointKey,sameCell,validateCell,readBounded,withPoolDeadline,type PoolClient,type PoolDeployment,type PoolSnapshot,type ReadOptions} from './pools.js';

export type PoolIntent={kind:'create';request:CreateRequest}|{kind:'transition';pool:PoolSnapshot;action:Operation;
 /** Order lots settled in the same transaction (split route); the builder checks them. */
 orders?:OrderFill}
 /** Two-pool route: pay `amountIn` of the first pool's token, receive at least
  * `minOut` of the second pool's token, via CKB. */
 |{kind:'route';pools:readonly [PoolSnapshot,PoolSnapshot];amountIn:bigint;minOut:bigint};
/** The one builder call for an intent; funding and review must agree on it. */
export function buildIntent(deployment:PoolDeployment,wallet:Wallet,recipients:Recipients,intent:PoolIntent):BuiltPoolTransaction {
 if(intent.kind==='create')return buildCreate(deployment,wallet,recipients,intent.request);
 if(intent.kind==='route')return buildRoute(deployment,wallet,recipients,intent.pools[0],intent.pools[1],{amountIn:intent.amountIn,minOut:intent.minOut});
 return buildTransition(deployment,wallet,recipients,intent.pool,intent.action,intent.orders);
}
export class PoolFundingError extends Error {
 constructor(readonly code:'INVALID'|'INSUFFICIENT'|'LIMIT'|'RESERVED',message:string){super(`Pool funding: ${message}`);this.name='PoolFundingError';}
}
function requireFunding(ok:unknown,message:string):asserts ok {if(!ok)throw new PoolFundingError('INVALID',message);}

/** Process-local exclusion only. Share one instance between concurrent reviews.
 * Durable submission/restart reconciliation is a separate required layer. */
export class PoolFundingReservations {
 #held=new Map<string,symbol>();
 private key(network:ccc.Hex,point:ccc.OutPointLike){return `${network}:${pointKey(point)}`;}
 has(network:ccc.Hex,point:ccc.OutPointLike):boolean {return this.#held.has(this.key(network,point));}
 claim(network:ccc.Hex,points:readonly ccc.OutPointLike[]):()=>void {
  const keys=points.map(p=>this.key(network,p));
  requireFunding(keys.length>0&&keys.length<=256&&new Set(keys).size===keys.length,'invalid reservation set');
  if(keys.some(key=>this.#held.has(key)))throw new PoolFundingError('RESERVED','inputs already reserved by another review');
  const owner=Symbol();for(const key of keys)this.#held.set(key,owner);
  return ()=>{for(const key of keys)if(this.#held.get(key)===owner)this.#held.delete(key);};
 }
}
export interface FundingOptions extends ReadOptions {
 reservations:PoolFundingReservations;maxCandidates?:number;maxPages?:number;pageSize?:number;maxInputs?:number;
}
export interface FundedPoolTransaction {
 built:BuiltPoolTransaction;funding:ccc.Cell[];scannedCandidates:number;scanComplete:boolean;
 /** Release only on abandoning an unsigned review or after submission has been
  * definitively reconciled. Never release merely because a send reply is lost. */
 release():void;
}

export async function fundPoolTransaction(
 client:PoolClient,deployment:PoolDeployment,wallet:Omit<Wallet,'funding'>,
 recipients:Recipients,intent:PoolIntent,options:FundingOptions,
):Promise<FundedPoolTransaction> {
 const selectedDeployment={...deployment,poolDep:ccc.CellDep.from(deployment.poolDep).clone(),tokenDep:ccc.CellDep.from(deployment.tokenDep).clone()};
 const owner=ccc.Script.from(wallet.lock).clone();
 const selectedWallet={...wallet,lock:owner,change:ccc.Script.from(wallet.change).clone(),deps:wallet.deps.map(d=>ccc.CellDep.from(d).clone()),witness:wallet.witness?{...wallet.witness}:undefined};
 const selectedRecipients={ckb:ccc.Script.from(recipients.ckb).clone(),token:ccc.Script.from(recipients.token).clone(),lp:ccc.Script.from(recipients.lp).clone()};
 const captured:PoolIntent=intent.kind==='create'?{kind:'create',request:{...intent.request,parameters:{...intent.request.parameters,backing:{...intent.request.parameters.backing}}}}:
  intent.kind==='route'?{kind:'route',pools:[parsePool(selectedDeployment,intent.pools[0].stateCell,intent.pools[0].ckbCell,intent.pools[0].tokenCell),parsePool(selectedDeployment,intent.pools[1].stateCell,intent.pools[1].ckbCell,intent.pools[1].tokenCell)],amountIn:intent.amountIn,minOut:intent.minOut}:
  {kind:'transition',pool:parsePool(selectedDeployment,intent.pool.stateCell,intent.pool.ckbCell,intent.pool.tokenCell),action:{...intent.action},
   orders:intent.orders&&{codeHash:intent.orders.codeHash,cellDep:ccc.CellDep.from(intent.orders.cellDep).clone(),cells:intent.orders.cells.map(c=>c.clone())}};
 const orders=captured.kind==='transition'?captured.orders:undefined;
 // A route spends only the first pool's token; its builder refuses any other asset.
 const result=captured.kind==='create'?createPool(captured.request.parameters,captured.request.x,captured.request.y,captured.request.minShares):
  captured.kind==='route'?swap(captured.pools[0].accounting,'yToX',captured.amountIn,1n):transition(captured.pool.accounting,captured.action);
 const token=captured.kind==='create'?ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:captured.request.tokenOwner}):captured.kind==='route'?captured.pools[0].token:captured.pool.token;
 const lp=captured.kind==='transition'?captured.pool.lp:undefined;
 requireFunding(owner.hash()!==token.args,'issuer-mode funding is not supported');
 if(captured.kind==='route')requireFunding(owner.hash()!==captured.pools[1].token.args,'issuer-mode funding is not supported');
 const {maxCandidates=1000,maxPages=20,pageSize=50,reservations}=options;
 const protocolMax=captured.kind==='create'?256:captured.kind==='route'?250:253-(orders?.cells.length??0),maxInputs=options.maxInputs??protocolMax;
 for(const [value,max] of [[maxCandidates,10000],[maxPages,100],[pageSize,100],[maxInputs,protocolMax]])requireFunding(Number.isSafeInteger(value)&&value!>=1&&value!<=max!,'invalid search bound');
 return withPoolDeadline(options,async o=>{
  await assertPoolNetwork(client,selectedDeployment,o);
  const candidates:{cell:ccc.Cell;kind:'ckb'|'token'|'lp';amount:bigint}[]=[];
  const seen=new Map<string,ccc.Cell>(),cursors=new Set<string>();let cursor:string|undefined,scannedCandidates=0,scanComplete=false;
  for(let page=0;page<maxPages&&scannedCandidates<maxCandidates;page++){
   const limit=Math.min(pageSize,maxCandidates-scannedCandidates);
   const response=await readBounded(()=>client.findCellsPagedNoCache({script:owner.clone(),scriptType:'lock',scriptSearchMode:'exact',withData:true},'asc',limit,cursor),o);
   requireFunding(response&&Array.isArray(response.cells)&&response.cells.length<=limit,'malformed/oversized indexer page');
   requireFunding(typeof response.lastCursor==='string'&&response.lastCursor.length<=4098&&/^0x(?:[0-9a-fA-F]{2})*$/.test(response.lastCursor),'invalid indexer cursor');
   // Capture the entire page before any subsequent asynchronous read.
   const cells=response.cells.map(cell=>{requireFunding(cell.outputData.length<=2+2*1024*1024,'oversized cell data');return cell.clone();});
   for(const cell of cells){
    o.signal?.throwIfAborted();scannedCandidates++;
    validateCell(cell);requireFunding(cell.cellOutput.lock.eq(owner),'indexer returned another owner');
    const key=pointKey(cell.outPoint),prior=seen.get(key);
    if(prior){requireFunding(sameCell(prior,cell),'conflicting duplicate candidate');continue;}seen.set(key,cell);
    if(reservations.has(selectedDeployment.genesisHash,cell.outPoint))continue;
    const type=cell.cellOutput.type;
    if(!type){if(cell.outputData==='0x')candidates.push({cell,kind:'ckb',amount:0n});continue;}
    if(type.eq(token))candidates.push({cell,kind:'token',amount:parseAmount(cell.outputData)});
    else if(lp&&type.eq(lp))candidates.push({cell,kind:'lp',amount:parseAmount(cell.outputData)});
    // Other valid owner assets (including CoTA) are never spent for capacity.
   }
   if(cells.length<limit){scanComplete=true;break;}
   requireFunding(response.lastCursor!=='0x'&&!cursors.has(response.lastCursor),'indexer cursor did not advance');
   cursors.add(response.lastCursor);cursor=response.lastCursor;
  }
  const byPoint=(a:typeof candidates[number],b:typeof candidates[number])=>{const x=pointKey(a.cell.outPoint),y=pointKey(b.cell.outPoint);return x<y?-1:x>y?1:0;};
  const descending=(a:bigint,b:bigint)=>a>b?-1:a<b?1:0;
  const chosen:typeof candidates=[],used=new Set<string>();
  // Maker payments in the token come out of the same funding as the pool leg. The
  // builder re-derives and checks every lot; this only sizes the selection.
  let lotTokenOut=0n;
  if(orders)for(const cell of orders.cells){try{const o=decodeOrder(cell,orders.codeHash);if(o.askAsset.kind==='udt'&&o.askAsset.script.eq(token))lotTokenOut+=o.askAmount;}catch{/* rejected by the builder */}}
  for(const [kind,needed] of [['token',result.flows.paidY+lotTokenOut],['lp',result.flows.burnedShares]] as const){
   let total=0n;
   for(const candidate of candidates.filter(c=>c.kind===kind).sort((a,b)=>descending(a.amount,b.amount)||byPoint(a,b))){
    if(total>=needed)break;chosen.push(candidate);used.add(pointKey(candidate.cell.outPoint));total+=candidate.amount;
   }
   if(total<needed)throw new PoolFundingError(scanComplete?'INSUFFICIENT':'LIMIT',`not enough ${kind} in bounded candidate set`);
  }
  // Required assets first; then prefer plain CKB, then spare capacity in this
  // exact token/LP profile. Largest-first is deterministic, not globally optimal.
  const remainder=candidates.filter(c=>!used.has(pointKey(c.cell.outPoint))).sort((a,b)=>(Number(a.kind!=='ckb')-Number(b.kind!=='ckb'))||descending(a.cell.cellOutput.capacity,b.cell.cellOutput.capacity)||byPoint(a,b));
  const live:ccc.Cell[]=[];let next=0;
  while(true){
   o.signal?.throwIfAborted();
   if(chosen.length===0){const first=remainder[next++];if(!first)throw new PoolFundingError(scanComplete?'INSUFFICIENT':'LIMIT','no eligible funding in bounded candidate set');chosen.push(first);}
   if(chosen.length>maxInputs)throw new PoolFundingError('LIMIT','selected funding exceeds input budget');
   const fresh=chosen.slice(live.length).map(c=>c.cell);
   for(const expected of fresh)if(reservations.has(selectedDeployment.genesisHash,expected.outPoint))throw new PoolFundingError('RESERVED','funding reserved during selection');
   const current=await liveCells(client,fresh.map(c=>c.outPoint),o);
   for(const [i,expected] of fresh.entries()){requireFunding(sameCell(expected,current[i]!),'indexer/live funding mismatch');live.push(current[i]!);}
   let built:BuiltPoolTransaction;
   try{
    const funded={...selectedWallet,funding:live};
    built=buildIntent(selectedDeployment,funded,selectedRecipients,captured);
   }catch(error){
    if(!(error instanceof PoolBuildError)||error.code!=='FUNDING')throw error;
    const more=remainder[next++];
    if(!more)throw new PoolFundingError(scanComplete?'INSUFFICIENT':'LIMIT','insufficient capacity in bounded candidate set');
    chosen.push(more);continue;
   }
   // Atomic in this JS process, including pool inputs to prevent competing local
   // reviews. Keep the claim while freshness checks await; release on failure.
   o.signal?.throwIfAborted();
   const release=reservations.claim(selectedDeployment.genesisHash,built.transaction.inputs.map(i=>i.previousOutput));
   try{await built.assertFresh(client,o);o.signal?.throwIfAborted();return {built,funding:live.map(c=>c.clone()),scannedCandidates,scanComplete,release};}
   catch(error){release();throw error;}
  }
 });
}
