#!/usr/bin/env -S npx tsx
// Testnet token faucet wallet (sdk/src/faucet.ts, functions/api/faucet.ts). TESTNET ONLY.
//   prepare                    create .local/testnet-faucet-key and a claim-tester key,
//                              write deployments/faucet.json (public lock and grants)
//   seed [--execute]           one transaction: each issuer mints the faucet's stock cells
//                              (owner mode) and the TEST issuer funds them and the tester
//   status                     stock per token, and what a lock may still claim
//   claim <url> [--execute]    the tester builds and signs a claim, posts it to <url>
//                              (/api/faucet), then checks the commit on both endpoints
// Dry runs by default. Keys stay in ignored .local and are never printed.
import {ccc} from '@ckb-ccc/core';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {amountData,buildFaucetClaim,checkFaucetClaim,eligibleGrants,faucetConfigFrom,tokenBalanceOf} from '../sdk/src/index.js';
import {ENDPOINTS,GENESIS,XUDT} from './lib/pool-live.js';

const root=new URL('../',import.meta.url);
const json=async(path:string)=>JSON.parse(await readFile(new URL(path,root),'utf8'));
const exists=(path:string)=>readFile(new URL(path,root)).then(()=>true,(e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return false;throw e;});
const show=(a:bigint)=>ccc.fixedPointToString(a);
const [command,...rest]=process.argv.slice(2);
const execute=rest.includes('--execute');
const UNIT=10n**8n,FEE_RATE=1000n,MAX_FEE=1_000_000n;
/** Per claim, in whole tokens; each stock cell holds STOCK_CLAIMS claims. */
const GRANTS={TEST:250n,TEST2:1000n,TEST3:500n};
const STOCK_CELLS=8,STOCK_CLAIMS=25n,TESTER_FUNDING=1000n*UNIT;
const KEYS={faucet:'.local/testnet-faucet-key',tester:'.local/testnet-faucet-tester-key',TEST:'.local/testnet-pool-issuer-key',TEST2:'.local/testnet-token-test2-key',TEST3:'.local/testnet-token-test3-key'};
const CONFIG='deployments/faucet.json',SEED='deployments/faucet-seed.json',CLAIMS='deployments/faucet-claims.json';

async function open(url:string){
 const client=new ccc.ClientPublicTestnet({url});
 assert.equal((await client.getHeaderByNumber(0))?.hash,GENESIS,`${url} is not CKB testnet`);
 return client;
}
async function signerOf(client:ccc.Client,path:string){
 const {mode}=await import('node:fs/promises').then(f=>f.stat(new URL(path,root)));
 assert.equal(mode&0o077,0,`${path} must be owner-only`);
 return new ccc.SignerCkbPrivateKey(client,(await readFile(new URL(path,root),'utf8')).trim());
}
async function tokens(){
 const issuer=await json('deployments/pool-issuer.json'),markets=await json('deployments/pool-markets.json');
 return [{symbol:'TEST' as const,decimals:8,token:ccc.Script.from(issuer.token),issuer:issuer.address as string},
  ...markets.tokens.map((t:{symbol:'TEST2'|'TEST3';decimals:number;token:ccc.ScriptLike;issuer:string})=>({symbol:t.symbol,decimals:t.decimals,token:ccc.Script.from(t.token),issuer:t.issuer}))] as {symbol:keyof typeof GRANTS;decimals:number;token:ccc.Script;issuer:string}[];
}

if(command==='prepare'){
 for(const path of [KEYS.faucet,KEYS.tester]){
  try{await writeFile(new URL(path,root),ccc.hexFrom(randomBytes(32)),{flag:'wx',mode:0o600});console.log(`Created ${path} (owner-only).`);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;console.log(`${path} exists; reusing it.`);}
 }
 const client=await open(ENDPOINTS[0]);
 const faucet=await (await signerOf(client,KEYS.faucet)).getRecommendedAddressObj(),tester=await (await signerOf(client,KEYS.tester)).getRecommendedAddressObj();
 const grants=(await tokens()).map(t=>({symbol:t.symbol,decimals:t.decimals,token:t.token,typeHash:t.token.hash(),amount:(GRANTS[t.symbol]*UNIT).toString()}));
 await writeFile(new URL(CONFIG,root),ccc.stringify({network:'testnet',genesis:GENESIS,address:faucet.toString(),lock:faucet.script,maxFee:MAX_FEE.toString(),xudtDep:XUDT.dep,grants,
  stock:{cellsPerToken:STOCK_CELLS,claimsPerCell:STOCK_CLAIMS.toString()},tester:tester.toString()})+'\n');
 console.log('Faucet address:',faucet.toString(),'\nClaim tester:',tester.toString(),`\nWrote ${CONFIG}.`);
}else if(command==='seed'){
 if(await exists(SEED))throw new Error(`${SEED} exists: the stock was already seeded or is pending. Inspect it; do not seed twice.`);
 const client=await open(ENDPOINTS[0]),config=await json(CONFIG),faucet=ccc.Script.from(config.lock);
 const list=await tokens(),funder=await signerOf(client,KEYS.TEST);
 const issuers=await Promise.all(list.map(t=>signerOf(client,KEYS[t.symbol])));
 for(const [i,t] of list.entries())assert.equal((await issuers[i]!.getRecommendedAddressObj()).toString(),t.issuer,`${KEYS[t.symbol]} is not the ${t.symbol} issuer`);
 assert(!(await funder.getRecommendedAddressObj()).script.eq(faucet),'The faucet must be its own wallet');
 const tx=ccc.Transaction.from({cellDeps:[XUDT.dep]});
 for(const t of list){const per=GRANTS[t.symbol]*UNIT*STOCK_CLAIMS;for(let i=0;i<STOCK_CELLS;i++)tx.addOutput({lock:faucet,type:t.token},amountData(per));}
 tx.addOutput({lock:(await ccc.Address.fromString(config.tester,client)).script});tx.outputs.at(-1)!.capacity=TESTER_FUNDING;
 // Owner mode needs an input of each issuer; the issuers other than the funder get their cell back unchanged.
 for(const issuer of issuers.slice(1)){
  const lock=(await issuer.getRecommendedAddressObj()).script;
  let cell:ccc.Cell|undefined;for await(const c of client.findCellsByLock(lock,null,true))if(c.outputData==='0x'){cell=c;break;}
  assert(cell,'An issuer has no plain CKB cell');
  tx.addInput(cell);tx.addOutput({lock,capacity:cell.cellOutput.capacity});
 }
 await tx.completeInputsByCapacity(funder);
 let prepared=tx;for(const s of issuers)prepared=await s.prepareTransaction(prepared);
 await prepared.completeFeeBy(funder,FEE_RATE);
 const fee=await prepared.getFee(client);
 assert(fee>0n&&fee<=MAX_FEE,`Seed fee ${fee} exceeds ${MAX_FEE}`);
 const stockCapacity=prepared.outputs.filter(o=>o.lock.eq(faucet)).reduce((s,o)=>s+o.capacity,0n);
 console.log(ccc.stringify({faucet:config.address,stock:list.map(t=>({symbol:t.symbol,cells:STOCK_CELLS,perCell:show(GRANTS[t.symbol]*UNIT*STOCK_CLAIMS),claims:(STOCK_CLAIMS*BigInt(STOCK_CELLS)).toString()})),
  stockCapacity:show(stockCapacity),testerFunding:show(TESTER_FUNDING),inputs:prepared.inputs.length,outputs:prepared.outputs.length,fee:show(fee)}));
 if(!execute){console.log('Dry run: nothing signed or sent. Add --execute to seed once.');process.exit(0);}
 let signed=prepared;for(const s of issuers)signed=await s.signOnlyTransaction(signed);
 const hash=signed.hash();
 await writeFile(new URL(SEED,root),ccc.stringify({status:'sent',hash,transaction:ccc.hexFrom(signed.toBytes())})+'\n',{flag:'wx'});
 try{assert.equal(await client.sendTransaction(signed),hash);}catch(error){console.error('Send outcome unknown; do not retry blindly. Check',hash);throw error;}
 console.log('SEED TX HASH:',hash);
 await client.waitTransaction(hash,1,600_000);
 for(const url of ENDPOINTS)assert.equal((await (await open(url)).getTransactionNoCache(hash))?.status,'committed',`Not committed on ${url}`);
 await writeFile(new URL(SEED,root),ccc.stringify({status:'committed',hash,fee:show(fee),verifiedEndpoints:ENDPOINTS})+'\n');
 console.log('Seed committed on both endpoints.');
}else if(command==='status'){
 const client=await open(ENDPOINTS[0]),raw=await json(CONFIG),config=faucetConfigFrom(raw);
 for(const g of config.grants){
  let cells=0,total=0n;for await(const c of client.findCellsByLock(config.lock,g.token,true)){cells++;total+=BigInt(ccc.numLeFromBytes(ccc.bytesFrom(c.outputData).slice(0,16)));}
  console.log(`${g.symbol}: ${cells} stock cells, ${show(total)} left = ${total/g.amount} claims of ${show(g.amount)}`);
 }
 const who=rest.find(a=>a.startsWith('ckt1'))??raw.tester;
 const lock=(await ccc.Address.fromString(who,client)).script;
 console.log(`${who} may claim:`,(await eligibleGrants(client,lock,config)).map(g=>g.symbol).join(', ')||'nothing');
}else if(command==='claim'){
 const url=rest.find(a=>/^https?:\/\//.test(a));
 assert(url,'Usage: faucet-wallet.ts claim <https://…/api/faucet> [--execute]');
 const client=await open(ENDPOINTS[0]),config=faucetConfigFrom(await json(CONFIG)),tester=await signerOf(client,KEYS.tester);
 const lock=(await tester.getRecommendedAddressObj()).script,grants=await eligibleGrants(client,lock,config);
 assert(grants.length,'The tester already holds every grant');
 const tx=await buildFaucetClaim(tester,config,grants,XUDT.dep,FEE_RATE);
 const inputs=await Promise.all(tx.inputs.map(i=>i.getCell(client)));
 const before=new Map(await Promise.all(config.grants.map(async g=>[g.token.hash(),await tokenBalanceOf(client,lock,g.token)] as const)));
 const local=checkFaucetClaim(tx,inputs,config,h=>before.get(h)??0n);
 console.log(ccc.stringify({claimant:(await tester.getRecommendedAddressObj()).toString(),granted:local.granted.map(g=>`${show(g.amount)} ${g.symbol}`),fee:show(local.fee),inputs:tx.inputs.length,outputs:tx.outputs.length,url}));
 if(!execute){console.log('Dry run: nothing signed or posted. Add --execute to claim.');process.exit(0);}
 const signed=await tester.signOnlyTransaction(tx);
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transaction:ccc.hexFrom(signed.toBytes())})});
 const body=await response.json() as {hash?:ccc.Hex;error?:string};
 assert(response.ok&&body.hash,`Faucet refused (${response.status}): ${body.error}`);
 assert.equal(body.hash,signed.hash(),'The faucet sent a different transaction');
 console.log('CLAIM TX HASH:',body.hash);
 await client.waitTransaction(body.hash,1,600_000);
 const results=[];
 for(const endpoint of ENDPOINTS){
  const c=await open(endpoint),seen=await c.getTransactionNoCache(body.hash);
  assert.equal(seen?.status,'committed',`Not committed on ${endpoint}`);
  const cells=await Promise.all(seen!.transaction.inputs.map(i=>i.getCell(c)));
  const checked=checkFaucetClaim(seen!.transaction,cells,config,h=>before.get(h)??0n);
  for(const g of checked.granted)assert.equal(await tokenBalanceOf(c,lock,g.token),(before.get(g.token.hash())??0n)+g.amount,`${g.symbol} balance on ${endpoint}`);
  results.push({endpoint,block:seen!.blockNumber!.toString(),fee:show(checked.fee),granted:checked.granted.map(g=>`${show(g.amount)} ${g.symbol}`)});
 }
 assert.equal(results[0]!.block,results[1]!.block,'Endpoints disagree on the block');
 const prior=await json(CLAIMS).catch(()=>({claims:[]}));
 await writeFile(new URL(CLAIMS,root),ccc.stringify({network:'testnet',claims:[...prior.claims,{tx:body.hash,url,checkedAt:new Date().toISOString(),results}]})+'\n');
 console.log('Claim committed, checked and balances verified on both endpoints.');
}else throw new Error('Usage: faucet-wallet.ts prepare | seed [--execute] | status [address] | claim <url> [--execute]');
process.exit(0);
