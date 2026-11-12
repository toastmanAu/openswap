// Cloudflare Pages Function: POST /api/faucet co-signs a testnet token claim.
// The app builds the claim with buildFaucetClaim and the claimant signs it first; this
// checks it with checkFaucetClaim against live chain data, adds the faucet wallet's
// signature and broadcasts it. TESTNET ONLY. The faucet key is the FAUCET_KEY secret
// (wrangler pages secret put FAUCET_KEY); it holds only test-token stock cells.
import {ccc} from '@ckb-ccc/core';
import {checkFaucetClaim,faucetConfigFrom,tokenBalanceOf} from '../../sdk/src/faucet.js';
import manifest from '../../deployments/faucet.json';

interface Env {FAUCET_KEY?:string}
const ENDPOINTS=['https://testnet.ckb.dev','https://testnet.ckbapp.dev'];
const MAX_BODY=32_768;
const config=faucetConfigFrom(manifest);
const reply=(status:number,body:object)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
class Refused extends Error {}

async function claim(bytes:ccc.Hex,key:string,url:string){
 const client=new ccc.ClientPublicTestnet({url});
 const signer=new ccc.SignerCkbPrivateKey(client,key);
 if(!(await signer.getRecommendedAddressObj()).script.eq(config.lock))throw new Error('FAUCET_KEY does not match deployments/faucet.json');
 let tx:ccc.Transaction;
 try{tx=ccc.Transaction.fromBytes(bytes);}catch{throw new Refused('Not a CKB transaction');}
 const inputs=await Promise.all(tx.inputs.map(i=>i.getCell(client)));
 const claimant=inputs.find(c=>!c.cellOutput.lock.eq(config.lock))?.cellOutput.lock;
 const balances=new Map<string,bigint>();
 if(claimant)for(const g of config.grants)balances.set(g.token.hash(),await tokenBalanceOf(client,claimant,g.token));
 let result;
 try{result=checkFaucetClaim(tx,inputs,config,h=>balances.get(h)??0n);}catch(error){throw new Refused((error as Error).message);}
 const signed=await signer.signOnlyTransaction(tx);
 if(signed.hash()!==tx.hash())throw new Error('Signing changed the transaction');
 let hash;
 try{hash=await client.sendTransaction(signed);}catch(error){throw new Refused(`The node rejected the claim (another claim may have used the same stock; build it again): ${(error as Error).message}`.slice(0,500));}
 return {hash,granted:result.granted.map(g=>({symbol:g.symbol,amount:g.amount.toString()}))};
}

export async function onRequestPost({request,env}:{request:Request;env:Env}):Promise<Response>{
 if(!env.FAUCET_KEY)return reply(503,{error:'The faucet is not configured'});
 const text=await request.text();
 if(text.length>MAX_BODY)return reply(413,{error:'Claim too large'});
 let bytes:ccc.Hex;
 try{const body=JSON.parse(text) as {transaction?:unknown};if(typeof body.transaction!=='string'||!/^0x([0-9a-f]{2})+$/.test(body.transaction))throw 0;bytes=body.transaction as ccc.Hex;}
 catch{return reply(400,{error:'Send {"transaction":"0x…"} with the signed claim bytes'});}
 let last:unknown;
 for(const url of ENDPOINTS){
  try{return reply(200,await claim(bytes,env.FAUCET_KEY,url));}
  catch(error){if(error instanceof Refused)return reply(400,{error:error.message});last=error;console.error('faucet',url,error);}
 }
 return reply(502,{error:`Testnet nodes unavailable: ${String(last).slice(0,200)}`});
}
/** Health: whether the key is set and matches the published faucet lock. No chain access. */
export async function onRequestGet({env}:{env:Env}):Promise<Response>{
 if(!env.FAUCET_KEY)return reply(503,{ok:false,error:'The faucet is not configured'});
 const signer=new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet({url:ENDPOINTS[0]}),env.FAUCET_KEY);
 const ok=(await signer.getRecommendedAddressObj()).script.eq(config.lock);
 return reply(ok?200:500,{ok,address:manifest.address,grants:config.grants.map(g=>({symbol:g.symbol,amount:g.amount.toString()}))});
}
