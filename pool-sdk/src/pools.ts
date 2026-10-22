import {ccc} from '@ckb-ccc/core';
import {parseAmount,U64_MAX} from '../../sdk/src/codec.js';
import {validateState,type PoolState} from '../../pool-model/src/model.js';
import {decodeArgs,decodeState,poolScript,Role,XUDT_CODE_HASH,type StateData} from './codec.js';

/** Explicit local/prototype deployment information; no network defaults. */
export interface PoolDeployment {
 genesisHash:ccc.Hex;codeHash:ccc.Hex;poolDep:ccc.CellDepLike;tokenDep:ccc.CellDepLike;
}
export interface PoolSnapshot {
 poolId:ccc.Hex;stateCell:ccc.Cell;ckbCell:ccc.Cell;tokenCell:ccc.Cell;
 metadata:StateData;accounting:PoolState;token:ccc.Script;lp:ccc.Script;
}
export type PoolClient=Pick<ccc.Client,'getHeaderByNumberNoCache'|'getCellLiveNoCache'|'findCellsPagedNoCache'>;
export interface ReadOptions {signal?:AbortSignal;timeoutMs?:number}
export class PoolReadError extends Error {
 constructor(readonly code:'INVALID'|'STALE'|'NETWORK',message:string){super(message);this.name='PoolReadError';}
}
function requirePool(ok:unknown,message:string):asserts ok {if(!ok)throw new PoolReadError('INVALID',message);}
export const pointKey=(p:ccc.OutPointLike)=>{const x=ccc.OutPoint.from(p);return `${x.txHash}:${x.index}`;};
export function sameCell(a:ccc.Cell,b:ccc.Cell):boolean {
 return a.outPoint.eq(b.outPoint)&&a.cellOutput.eq(b.cellOutput)&&a.outputData===b.outputData;
}
export function minimumCapacity(cell:ccc.CellAny):bigint {
 return ccc.CellOutput.from({lock:cell.cellOutput.lock,type:cell.cellOutput.type},cell.outputData).capacity;
}
export function validateCell(cell:ccc.CellAny):void {
 requirePool(cell.cellOutput.lock.toBytes().length<=512&&(!cell.cellOutput.type||cell.cellOutput.type.toBytes().length<=512),'Script exceeds pool scan bound');
 requirePool(cell.cellOutput.capacity>=minimumCapacity(cell)&&cell.cellOutput.capacity<=U64_MAX,'Invalid occupied capacity');
}
export function parsePool(deployment:PoolDeployment,stateCell:ccc.Cell,ckbCell:ccc.Cell,tokenCell:ccc.Cell):PoolSnapshot {
 try {
  const type=stateCell.cellOutput.type;
  requirePool(type&&type.codeHash===deployment.codeHash&&type.hashType==='data1','Not the selected pool validator');
  const args=decodeArgs(type.args);requirePool(args.role===Role.StateType,'Not a state type');
  const metadata=decodeState(stateCell.outputData);
  const roles=[0,1,2,3,4].map(role=>poolScript(deployment.codeHash,args.poolId,role));
  requirePool(stateCell.outPoint.index<256n&&stateCell.outPoint.index!==metadata.rx&&stateCell.outPoint.index!==metadata.ry,'Invalid state sibling index');
  requirePool(ckbCell.outPoint.eq({txHash:stateCell.outPoint.txHash,index:metadata.rx})&&tokenCell.outPoint.eq({txHash:stateCell.outPoint.txHash,index:metadata.ry}),'Reserve OutPoint mismatch');
  requirePool(metadata.tokenCodeHash===XUDT_CODE_HASH,'Unsupported prototype token profile');
  requirePool(!roles.slice(1,4).some(s=>s.hash()===metadata.tokenOwner),'Pool custody cannot be the token issuer');
  const token=ccc.Script.from({codeHash:metadata.tokenCodeHash,hashType:'data1',args:metadata.tokenOwner});
  for(const c of [stateCell,ckbCell,tokenCell])validateCell(c);
  requirePool(stateCell.cellOutput.lock.eq(roles[1]!)&&stateCell.cellOutput.capacity===metadata.backingState,'State lock/backing mismatch');
  requirePool(ckbCell.cellOutput.lock.eq(roles[2]!)&&!ckbCell.cellOutput.type&&ckbCell.outputData==='0x','CKB reserve shape mismatch');
  requirePool(metadata.backingCkb>=minimumCapacity(ckbCell),'CKB backing cannot borrow tradeable reserves');
  requirePool(tokenCell.cellOutput.lock.eq(roles[3]!)&&tokenCell.cellOutput.type?.eq(token)&&tokenCell.cellOutput.capacity===metadata.backingToken,'Token reserve shape mismatch');
  const accounting:PoolState={feeBps:metadata.fee,lockedShares:metadata.locked,totalShares:metadata.shares,
   backing:{state:metadata.backingState,ckb:metadata.backingCkb,token:metadata.backingToken},x:ckbCell.cellOutput.capacity-metadata.backingCkb,y:parseAmount(tokenCell.outputData)};
  validateState(accounting);
  return {poolId:args.poolId,stateCell:stateCell.clone(),ckbCell:ckbCell.clone(),tokenCell:tokenCell.clone(),metadata,accounting,token,lp:roles[4]!};
 }catch(e){if(e instanceof PoolReadError)throw e;throw new PoolReadError('INVALID',`Malformed pool: ${String(e)}`);}
}
/** Deadline stops awaiting an RPC; transport cancellation depends on the client. */
export async function readBounded<T>(read:()=>Promise<T>,options:ReadOptions={}):Promise<T> {
 const timeout=options.timeoutMs??15000;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000)throw new Error('timeoutMs must be 1..60000');
 options.signal?.throwIfAborted();
 return new Promise<T>((resolve,reject)=>{
  let finished=false;
  const abort=()=>finish(()=>reject(options.signal?.reason??new Error('Aborted')));
  const timer=setTimeout(()=>finish(()=>reject(new Error('Pool RPC deadline exceeded'))),timeout);
  const finish=(done:()=>void)=>{if(finished)return;finished=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);done();};
  options.signal?.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>{if(finished)return;return read();}).then(value=>finish(()=>resolve(value as T)),error=>finish(()=>reject(error)));
 });
}
export async function assertPoolNetwork(client:PoolClient,deployment:PoolDeployment,options:ReadOptions={}):Promise<void> {
 if((await readBounded(()=>client.getHeaderByNumberNoCache(0),options))?.hash!==deployment.genesisHash)throw new PoolReadError('NETWORK','Pool deployment/genesis mismatch');
}
/** Overall deadline for a bounded sequence of reads, not just each RPC await.
 * Injected callbacks must honor the signal to cancel their underlying work. */
export async function withPoolDeadline<T>(options:ReadOptions,work:(options:ReadOptions)=>Promise<T>):Promise<T> {
 const timeoutMs=options.timeoutMs??15000;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new Error('Invalid pool operation deadline');
 options.signal?.throwIfAborted();
 const controller=new AbortController(),abort=()=>controller.abort(options.signal?.reason);
 options.signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(new Error('Pool operation deadline exceeded')),timeoutMs);
 const bounded={signal:controller.signal,timeoutMs};
 try{return await readBounded(()=>work(bounded),bounded);}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);controller.abort();}
}
/** The prototype requires direct Data1 code deps, never caller-labelled dep groups. */
export async function assertPoolDependencies(client:PoolClient,deployment:PoolDeployment,options:ReadOptions={}):Promise<void> {
 for(const [dependency,hash] of [[deployment.poolDep,deployment.codeHash],[deployment.tokenDep,XUDT_CODE_HASH]] as const){
  const dep=ccc.CellDep.from(dependency);requirePool(dep.depType==='code','Pool/token dependency must be a direct code cell');
  const cell=await liveCell(client,dep.outPoint,options);
  requirePool(ccc.hashCkb(cell.outputData)===hash,'Dependency data hash does not match selected validator');
 }
}
export async function liveCell(client:PoolClient,point:ccc.OutPointLike,options:ReadOptions={}):Promise<ccc.Cell> {
 const expected=ccc.OutPoint.from(point).clone();
 const value=await readBounded(()=>client.getCellLiveNoCache(expected.clone(),true,true),options);
 if(!value)throw new PoolReadError('STALE',`Input no longer live: ${pointKey(expected)}`);
 requirePool(value.outPoint.eq(expected),'Node returned a different OutPoint');
 // Bound work after the client decodes a response; this is not a transport byte cap.
 requirePool(value.outputData.length<=2+2*1024*1024,'Live cell data exceeds 1 MiB bound');
 validateCell(value);return value.clone();
}
export async function loadPool(client:PoolClient,deployment:PoolDeployment,point:ccc.OutPointLike,options:ReadOptions={}):Promise<PoolSnapshot> {
 await assertPoolNetwork(client,deployment,options);
 const state=await liveCell(client,point,options);
 let metadata:StateData;
 try{metadata=decodeState(state.outputData);}catch(e){throw new PoolReadError('INVALID',String(e));}
 const x=await liveCell(client,{txHash:state.outPoint.txHash,index:metadata.rx},options);
 const y=await liveCell(client,{txHash:state.outPoint.txHash,index:metadata.ry},options);
 const parsed=parsePool(deployment,state,x,y);
 // Detect a transition that raced the reserve reads. This is not an atomic chain snapshot.
 if(!sameCell(state,await liveCell(client,point,options)))throw new PoolReadError('STALE','Pool changed during discovery');
 return parsed;
}
export interface ScanOptions extends ReadOptions {maxCandidates?:number;maxPages?:number;pageSize?:number;onMalformed?:(point:ccc.OutPoint,error:PoolReadError)=>void}
export async function* scanPools(client:PoolClient,deployment:PoolDeployment,options:ScanOptions={}):AsyncGenerator<PoolSnapshot> {
 const {maxCandidates=1000,maxPages=20,pageSize=50}=options;
 for(const [n,max] of [[maxCandidates,10000],[maxPages,100],[pageSize,100]] as const)if(!Number.isSafeInteger(n)||n<1||n>max)throw new Error('Invalid pool scan bound');
 await assertPoolNetwork(client,deployment,options);
 let cursor: string|undefined,seenCount=0;const seen=new Set<string>(),cursors=new Set<string>();
 for(let page=0;page<maxPages&&seenCount<maxCandidates;page++){
  const limit=Math.min(pageSize,maxCandidates-seenCount);
  const response=await readBounded(()=>client.findCellsPagedNoCache({script:{codeHash:deployment.codeHash,hashType:'data1',args:'0x54504c310100'},scriptType:'type',scriptSearchMode:'prefix',withData:true},'asc',limit,cursor),options);
  requirePool(response&&Array.isArray(response.cells),'Malformed indexer page');
  requirePool(typeof response.lastCursor==='string'&&response.lastCursor.length<=4098&&/^0x(?:[0-9a-f]{2})*$/i.test(response.lastCursor),'Malformed or oversized indexer cursor');
  if(response.cells.length>limit)throw new PoolReadError('INVALID','Indexer exceeded requested page size');
  for(const candidate of response.cells){
   options.signal?.throwIfAborted();seenCount++;
   const key=pointKey(candidate.outPoint);if(seen.has(key))continue;seen.add(key);
   try {
    requirePool(candidate.outputData.length===382,'Indexer state data length mismatch');validateCell(candidate);
    const indexed=candidate.clone();
    const pool=await loadPool(client,deployment,indexed.outPoint,options);
    if(!sameCell(indexed,pool.stateCell))throw new PoolReadError('INVALID','Indexer/live state mismatch');
    yield pool;
   }catch(e){if(!(e instanceof PoolReadError)||e.code==='NETWORK')throw e;options.onMalformed?.(candidate.outPoint,e);}
  }
  if(response.cells.length<limit)return;
  if(!response.lastCursor||cursors.has(response.lastCursor))throw new PoolReadError('INVALID','Indexer cursor did not advance');
  cursors.add(response.lastCursor);cursor=response.lastCursor;
 }
}
