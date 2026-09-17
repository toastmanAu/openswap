import {ccc} from '@ckb-ccc/core';
export type ActivityStatus='submitted'|'pending'|'proposed'|'committed'|'rejected'|'unknown';
export interface Activity {hash:ccc.Hex;account:string;network:string;summary:string;status:ActivityStatus;createdAt:number;block?:string}
const statuses=new Set(['submitted','pending','proposed','committed','rejected','unknown']);
export function readActivity(raw:string|null):Activity[]{
 try{const rows:unknown=JSON.parse(raw??'[]');if(!Array.isArray(rows))return [];
 return rows.filter((r):r is Activity=>!!r&&typeof r==='object'&&/^0x[0-9a-f]{64}$/.test(r.hash)&&typeof r.account==='string'&&r.account.length<=1024&&/^0x[0-9a-f]{64}$/.test(r.network)&&typeof r.summary==='string'&&r.summary.length<=2000&&statuses.has(r.status)&&Number.isSafeInteger(r.createdAt)&&r.createdAt>=0&& (r.block===undefined||/^\d+$/.test(r.block))).slice(-200);
 }catch{return [];}
}
export function accountKey(locks:readonly ccc.Script[]):string{return [...new Set(locks.map(l=>l.hash()))].sort().join(':');}
export function mergeActivity(rows:readonly Activity[],item:Activity):Activity[]{return [...rows.filter(r=>!(r.hash===item.hash&&r.network===item.network&&r.account===item.account)),item].slice(-200);}
/** Bounded direct-indexer history, followed by fresh node status checks for local submissions. */
export async function fetchActivity(client:ccc.Client,locks:readonly ccc.Script[],network:string,local:readonly Activity[]):Promise<Activity[]>{
 const account=accountKey(locks),results=new Map<string,Activity>();
 for(const lock of locks.slice(0,8)){
  const page=await client.findTransactionsPaged({script:lock,scriptType:'lock',scriptSearchMode:'exact',groupByTransaction:true},'desc',20);
  for(const tx of page.transactions)results.set(tx.txHash,{hash:tx.txHash,account,network,summary:'On-chain transaction',status:'committed',createdAt:0,block:tx.blockNumber.toString()});
 }
 for(const item of local.filter(r=>r.network===network&&r.account===account).slice(-20)){
  // Some CCC/node combinations throw on an RPC null response. A failed status
  // lookup is unknown, never evidence of rejection or commitment.
  let status:ccc.ClientTransactionResponse|undefined;try{status=await client.getTransactionNoCache(item.hash);}catch{status=undefined;}
  results.set(item.hash,{...item,status:status?.status==='sent'?'submitted':status?.status??'unknown',block:status?.blockNumber?.toString()});
 }
 return [...results.values()].sort((a,b)=>{
  if(!a.block&&!b.block)return b.createdAt-a.createdAt;
  if(!a.block)return -1;if(!b.block)return 1;
  return BigInt(a.block)>BigInt(b.block)?-1:BigInt(a.block)<BigInt(b.block)?1:b.createdAt-a.createdAt;
 }).slice(0,40);
}
