import {ccc} from '@ckb-ccc/core';
import type {PoolDeployment} from '../../../pool-sdk/src/pools.js';
import type {JoyIdWalletProfile} from '../../../pool-sdk/src/joyid.js';
import type {Parameters} from '../../../pool-model/src/model.js';

/** Served as `pool-manifest.json` next to the app. Absent means no approved
 * pool deployment for this build; nothing here is a network default. */
export interface PoolManifest {
 network:'testnet';deployment:PoolDeployment;
 /** Known pool IDs only. Current state is discovered live by ID, never pinned. */
 pools:{label:string;poolId:ccc.Hex}[];
 joyid:JoyIdWalletProfile&{proofEndpoint?:string};
 policy:{feeRate:bigint;maxFee:bigint;slippageBps:number;reviewTtlMs:number};
 create?:{parameters:Parameters;tokenOwner:ccc.Hex};
}
function check(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(`Pool manifest: ${message}`);}
const isHash=(v:unknown):v is ccc.Hex=>typeof v==='string'&&/^0x[0-9a-f]{64}$/.test(v);
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
function dep(v:unknown):ccc.CellDepLike {
 check(exact(v,['outPoint','depType'])&&(v as {depType:unknown}).depType==='code','dependencies must be direct code cells');
 const point=(v as {outPoint:unknown}).outPoint;
 check(exact(point,['txHash','index'])&&isHash((point as {txHash:unknown}).txHash)&&/^(0|[1-9]\d{0,8})$/.test(String((point as {index:unknown}).index)),'invalid OutPoint');
 return {outPoint:{txHash:(point as {txHash:ccc.Hex}).txHash,index:BigInt((point as {index:string|number}).index)},depType:'code'};
}
function uint(v:unknown,max:bigint,message:string):bigint {check(typeof v==='string'&&/^(0|[1-9]\d{0,38})$/.test(v)&&BigInt(v)<=max,message);return BigInt(v);}
/** Strict: unknown fields, inexact hashes or out-of-range policy reject the whole file. */
export function parsePoolManifest(raw:unknown):PoolManifest {
 check(exact(raw,['version','network','deployment','pools','joyid','policy'])||exact(raw,['version','network','deployment','pools','joyid','policy','create']),'unexpected fields');
 const m=raw as Record<string,any>;
 check(m.version===1&&m.network==='testnet','only version 1 testnet manifests are supported');
 check(exact(m.deployment,['genesisHash','codeHash','poolDep','tokenDep'])&&isHash(m.deployment.genesisHash)&&isHash(m.deployment.codeHash),'invalid deployment');
 const deployment:PoolDeployment={genesisHash:m.deployment.genesisHash,codeHash:m.deployment.codeHash,poolDep:dep(m.deployment.poolDep),tokenDep:dep(m.deployment.tokenDep)};
 check(Array.isArray(m.pools)&&m.pools.length<=32,'pools must be a list of at most 32');
 const pools=m.pools.map((p:unknown)=>{check(exact(p,['label','poolId'])&&typeof (p as any).label==='string'&&(p as any).label.length>=1&&(p as any).label.length<=40&&isHash((p as any).poolId),'invalid pool entry');return {label:(p as any).label as string,poolId:(p as any).poolId as ccc.Hex};});
 check(new Set(pools.map((p:{poolId:string})=>p.poolId)).size===pools.length,'duplicate pool ID');
 const j=m.joyid;
 check(exact(j,['codeHash','hashType','codeDeps'])||exact(j,['codeHash','hashType','codeDeps','cotaType'])||exact(j,['codeHash','hashType','codeDeps','cotaType','proofEndpoint']),'invalid JoyID profile');
 check(isHash(j.codeHash)&&['type','data','data1','data2'].includes(j.hashType)&&Array.isArray(j.codeDeps)&&j.codeDeps.length>=1&&j.codeDeps.length<=12,'invalid JoyID code profile');
 const codeDeps=j.codeDeps.map((d:unknown)=>{check(exact(d,['dep','dataHash'])&&isHash((d as any).dataHash),'invalid JoyID code dependency');return {dep:dep((d as any).dep),dataHash:(d as any).dataHash as ccc.Hex};});
 if(j.cotaType!==undefined)check(exact(j.cotaType,['codeHash','hashType','args'])&&isHash(j.cotaType.codeHash)&&typeof j.cotaType.args==='string'&&/^0x(?:[0-9a-f]{2}){0,64}$/.test(j.cotaType.args),'invalid CoTA type');
 if(j.proofEndpoint!==undefined){const url=new URL(j.proofEndpoint);check(url.protocol==='https:'&&!url.username&&!url.password,'proof endpoint must be HTTPS without credentials');}
 const p=m.policy;
 check(exact(p,['feeRate','maxFee','slippageBps','reviewTtlMs']),'invalid policy');
 const policy={feeRate:uint(p.feeRate,100000n,'feeRate must be 1..100000 shannons/KB'),maxFee:uint(p.maxFee,100000000n,'maxFee must be at most 1 CKB'),slippageBps:p.slippageBps as number,reviewTtlMs:p.reviewTtlMs as number};
 check(policy.feeRate>0n&&policy.maxFee>0n,'fee rate and cap must be positive');
 check(Number.isSafeInteger(policy.slippageBps)&&policy.slippageBps>=0&&policy.slippageBps<=500,'slippageBps must be 0..500');
 check(Number.isSafeInteger(policy.reviewTtlMs)&&policy.reviewTtlMs>=10000&&policy.reviewTtlMs<=300000,'reviewTtlMs must be 10000..300000');
 let create:PoolManifest['create'];
 if(m.create!==undefined){
  const c=m.create;check(exact(c,['parameters','tokenOwner'])&&isHash(c.tokenOwner)&&exact(c.parameters,['feeBps','lockedShares','backing'])&&exact(c.parameters.backing,['state','ckb','token']),'invalid create profile');
  create={tokenOwner:c.tokenOwner,parameters:{feeBps:uint(c.parameters.feeBps,9999n,'invalid fee'),lockedShares:uint(c.parameters.lockedShares,(1n<<128n)-1n,'invalid locked shares'),
   backing:{state:uint(c.parameters.backing.state,(1n<<64n)-1n,'invalid backing'),ckb:uint(c.parameters.backing.ckb,(1n<<64n)-1n,'invalid backing'),token:uint(c.parameters.backing.token,(1n<<64n)-1n,'invalid backing')}}};
 }
 return {network:'testnet',deployment,pools,joyid:{codeHash:j.codeHash,hashType:j.hashType,codeDeps,cotaType:j.cotaType,proofEndpoint:j.proofEndpoint},policy,create};
}
/** `undefined` only when no manifest is served (404). Any other failure is an error. */
export async function loadPoolManifest(url='./pool-manifest.json'):Promise<PoolManifest|undefined> {
 const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(10000)});
 if(response.status===404)return undefined;
 if(!response.ok)throw new Error(`Pool manifest unavailable (${response.status})`);
 const text=await response.text();check(text.length<=65536,'file too large');
 return parsePoolManifest(JSON.parse(text));
}
