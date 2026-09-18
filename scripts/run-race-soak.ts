// Bounded testnet-only integration. Uses dedicated local test keys, never wallet secrets.
import {ccc} from '@ckb-ccc/shell';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {CKB,udt,createOrder,submit,assertNetwork,decodeTerms,payment,parseAmount,type BuiltTransaction,type Deployment} from '../sdk/src/index.js';
import {ReferenceSolver,recoverConflictedTransaction} from '../solver/src/index.js';
const args=process.argv.slice(2);
for(const arg of args)assert(arg==='--execute'||/^--rounds=\d+$/.test(arg)||/^--journal=[a-z0-9-]+\.json$/.test(arg),'Unknown or malformed option');
assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length,'Duplicate option');
const execute=args.includes('--execute');
const rounds=Number(args.find(a=>a.startsWith('--rounds='))?.split('=')[1]??3);
assert(Number.isInteger(rounds)&&rounds>=3&&rounds<=30,'Rounds must be between 3 and 30');
const journalName=args.find(a=>a.startsWith('--journal='))?.split('=')[1]??'race-soak-result.json';
const maxFee=1000000n; // 0.01 CKB per new accepted transaction.
const deployment=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
const journalFile=new URL('../deployments/'+journalName,import.meta.url);
interface Round{ckbOrder?:string;tokenOrder?:string;candidates?:string[];attempts?:{hash:string;result:string}[];winner?:string;checks?:unknown;}
interface Journal{network:string;startedAt:string;funding?:string;secondAddress?:string;rounds:Round[];completedAt?:string;runs?:{startedAt:string;targetRounds:number;initialCompletedRounds:number;feeCapShannon:string;completedAt?:string}[];}
let journal:Journal={network:'testnet',startedAt:new Date().toISOString(),rounds:[]};
try{journal=JSON.parse(await readFile(journalFile,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
assert.equal(journal.network,'testnet');
assert(Array.isArray(journal.rounds)&&journal.rounds.length<=rounds,'Journal has more rounds than requested');
const save=async()=>{
 const temporary=new URL(journalFile.href+'.tmp');
 await writeFile(temporary,JSON.stringify(journal,null,2)+'\n');await rename(temporary,journalFile);
};
const first=ccc.ClientPublicTestnet.open({urls:['https://testnet.ckb.dev']}),second=ccc.ClientPublicTestnet.open({urls:['https://testnet.ckbapp.dev']});
try{
 await Promise.all([assertNetwork(first.value,deployment),assertNetwork(second.value,deployment)]);assert.equal(deployment.network,'testnet');
 const maker=new ccc.SignerCkbPrivateKey(first.value,(await readFile(new URL('../.local/testnet-solver-key',import.meta.url),'utf8')).trim());
 const makerLock=(await maker.getRecommendedAddressObj()).script;
 const issuer=await ccc.Address.fromString('ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq',first.value);
 const token=await ccc.Script.fromKnownScript(first.value,ccc.KnownScript.XUdt,issuer.script.hash());
 if(!execute){console.log(`Dry run: target ${rounds} total rounds, ${journal.rounds.filter(r=>r.checks).length} already verified; at most ${rounds*2} total order creations and ${rounds} winning fills. Existing funding is reused; a fresh journal permits one 300 CKB transfer. Each new accepted transaction fee <= 0.01 CKB. No signing performed.`);}
 else{
  const run={startedAt:new Date().toISOString(),targetRounds:rounds,initialCompletedRounds:journal.rounds.filter(r=>r.checks).length,feeCapShannon:maxFee.toString(),completedAt:undefined as string|undefined};
  (journal.runs??=[]).push(run);delete journal.completedAt;await save();
  const keyFile=new URL('../.local/testnet-race-key',import.meta.url);await mkdir(new URL('../.local/',import.meta.url),{recursive:true,mode:0o700});
  try{await writeFile(keyFile,ccc.hexFrom(randomBytes(32)),{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const rival=new ccc.SignerCkbPrivateKey(second.value,(await readFile(keyFile,'utf8')).trim());
  journal.secondAddress=await rival.getRecommendedAddress();assert.notEqual(journal.secondAddress,await maker.getRecommendedAddress());
  const frozen=(tx:ccc.Transaction):BuiltTransaction=>{const hash=tx.hash();return{tx,deployment,assertLayout(candidate=tx){assert.equal(candidate.hash(),hash,'Transaction changed');}};};
  const confirm=async(hash:string,client=first.value)=>{await client.waitTransaction(hash,1,180000);assert.equal((await client.getTransaction(hash))?.status,'committed');};
  if(!journal.funding){
   const tx=ccc.Transaction.from({});tx.addOutput({lock:(await rival.getRecommendedAddressObj()).script,capacity:30000000000n},'0x');
   await tx.completeInputsByCapacity(maker);await tx.completeFeeBy(maker);assert((await tx.getFee(first.value))<=maxFee);
   assert.equal(tx.outputs[0]!.capacity,30000000000n);
   journal.funding=tx.hash();await save();assert.equal(await submit(frozen(tx),maker),journal.funding);console.log('rival_funded',journal.funding);
  }
  await confirm(journal.funding);
  for(let roundIndex=0;roundIndex<rounds;roundIndex++){
   const round=journal.rounds[roundIndex]??{};journal.rounds[roundIndex]=round;
   const ctx={signer:maker,deployment,maxFee};
   if(!round.ckbOrder){const built=await createOrder(ctx,{offerAsset:CKB,askAsset:udt(token),lots:[{offerAmount:1n,askAmount:1n}]});round.ckbOrder=built.tx.hash();await save();assert.equal(await submit(built,maker),round.ckbOrder);console.log('ckb_order',roundIndex,round.ckbOrder);}await confirm(round.ckbOrder);
   if(!round.tokenOrder){const built=await createOrder(ctx,{offerAsset:udt(token),askAsset:CKB,lots:[{offerAmount:1n,askAmount:1n}]});round.tokenOrder=built.tx.hash();await save();assert.equal(await submit(built,maker),round.tokenOrder);console.log('token_order',roundIndex,round.tokenOrder);}await confirm(round.tokenOrder);
   const allowed=new Set([round.ckbOrder,round.tokenOrder]);
   if(!round.candidates){
    const solvers=[maker,rival].map(signer=>new ReferenceSolver({signer,deployment,maxFee},()=>{},{acceptOrder:o=>o.outPoint.index===0n&&allowed.has(o.outPoint.txHash)}));
    const builds=await Promise.all(solvers.map(s=>s.tick()));assert(builds.every(Boolean),'Indexer lag: rerun after both orders are indexed');
    const shared=builds[0]!.inputs.filter(i=>builds[1]!.inputs.some(j=>i.previousOutput.eq(j.previousOutput)));assert.equal(shared.length,2,'Fee inputs must be distinct; only order inputs may overlap');
    const signed=await Promise.all(builds.map(async(tx,i)=>{const wallet=i===0?maker:rival,built=frozen(tx!);const prepared=await wallet.prepareTransaction(tx!.clone());built.assertLayout(prepared);const result=await wallet.signOnlyTransaction(prepared);built.assertLayout(result);return result;}));
    assert.notEqual(signed[0]!.hash(),signed[1]!.hash());round.candidates=signed.map(tx=>ccc.stringify(tx));await save();
   }
   const candidates=round.candidates.map(raw=>ccc.Transaction.from(JSON.parse(raw)));
   if(!round.winner){
    const outcomes=await Promise.all(candidates.map(async(tx,i)=>{const client=i===0?first.value:second.value;try{const existing=await client.getTransaction(tx.hash());if(!existing||existing.status==='rejected')await client.sendTransaction(tx);return{hash:tx.hash(),result:'submitted_or_known'};}catch(error){return{hash:tx.hash(),result:String(error).slice(0,600)};}}));round.attempts=outcomes;await save();console.log('race_submitted',roundIndex,outcomes);
    let committed:string[]=[];const deadline=Date.now()+180000;
    while(Date.now()<deadline){committed=[];for(const tx of candidates)if((await first.value.getTransaction(tx.hash()))?.status==='committed')committed.push(tx.hash());if(committed.length)break;await new Promise(resolve=>setTimeout(resolve,2000));}
    assert.equal(committed.length,1,'Expected exactly one committed winner within three minutes');round.winner=committed[0];await save();
   }
   const nodeChecks=[];
   for(const client of [first.value,second.value]){
    await confirm(round.winner!,client);const fill=(await client.getTransaction(round.winner!))!.transaction;let count=0;const balances=new Map<string,bigint>();
    const tally=(type:ccc.Script|undefined,data:ccc.Hex,sign:bigint)=>{if(type)balances.set(type.hash(),(balances.get(type.hash())??0n)+sign*parseAmount(data));};
    for(let i=0;i<fill.inputs.length;i++){const cell=await fill.inputs[i]!.getCell(client);assert(!cell.cellOutput.lock.eq(issuer.script));tally(cell.cellOutput.type,cell.outputData,1n);
     if(cell.cellOutput.lock.codeHash===deployment.codeHash){assert(allowed.has(cell.outPoint.txHash));assert.equal(cell.cellOutput.lock.hashType,'data1');const expected=payment(decodeTerms(cell.cellOutput.lock.args));assert.equal(ccc.hexFrom(fill.outputs[i]!.toBytes()),ccc.hexFrom(expected.cellOutput.toBytes()));assert.equal(fill.outputsData[i],expected.outputData);assert.equal(await client.getCellLive(cell.outPoint,true),undefined);assert(!fill.outputs.some(o=>o.lock.eq(cell.cellOutput.lock)));count++;}}
    fill.outputs.forEach((out,i)=>tally(out.type,fill.outputsData[i]!,-1n));assert.equal(count,2);assert(balances.has(token.hash()));for(const balance of balances.values())assert.equal(balance,0n);
    const loser=candidates.find(tx=>tx.hash()!==round.winner)!;assert.notEqual((await client.getTransaction(loser.hash()))?.status,'committed');
    nodeChecks.push({orders:count,issuerInputAbsent:true,conserved:true,feeShannon:(await fill.getFee(client)).toString()});
   }
   assert.deepEqual(nodeChecks[0],nodeChecks[1]);round.checks={nodes:['https://testnet.ckb.dev','https://testnet.ckbapp.dev'],results:nodeChecks};await save();
   for(const signer of [maker,rival])assert.equal(await new ReferenceSolver({signer,deployment},()=>{},{acceptOrder:o=>allowed.has(o.outPoint.txHash)}).tick(),undefined,'Spent candidate rediscovered');
   for(const client of [first.value,second.value])for(const candidate of candidates)if(candidate.hash()!==round.winner)await recoverConflictedTransaction(client,candidate);
   console.log('race_round_verified',roundIndex,round.winner);
  }
  journal.completedAt=new Date().toISOString();run.completedAt=journal.completedAt;await save();console.log('RACE SOAK VERIFIED',rounds,journal.completedAt);
 }
}finally{await first.dispose();await second.dispose();}
