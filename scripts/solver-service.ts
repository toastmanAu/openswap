#!/usr/bin/env -S npx tsx
// Always-on testnet solver: ReferenceSolverV2 (v2 orders plus whole v1 lots) in a
// SolverService loop. Dry run by default: it scans the live book, builds what it
// would settle or return and reports it, sending nothing. `--execute` sends with the
// solver wallet (.local/testnet-solver-key; never printed), journaled before every send.
// State lives in .local/solver-service/ (or OPENSWAP_SOLVER_STATE_DIR): journal/ (one
// writer; stop the service before `npm run solver-journal -- --journal-dir=<state>/journal`),
// status.json (rewritten each cycle) and events.jsonl (appended).
// Key: OPENSWAP_SOLVER_KEY_FILE, else systemd's $CREDENTIALS_DIRECTORY/solver-key, else
// .local/testnet-solver-key; refused if group or others can read it.
// On a server, see docs/SOLVER_SERVICE_RUNBOOK.md and deploy/solver/.
//   npm run solver:service -- [--execute] [--once] [--interval=15] [--min-balance=500] [--daily-fee-budget=0.5]
// Amounts in CKB, interval in seconds. Stop with Ctrl-C / SIGTERM: the cycle in progress finishes.
import {ccc} from '@ckb-ccc/core';
import {appendFile,mkdir,readFile,rename,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {CatalogAssetResolver,PinnedXudtResolver,type BuildContext,type Deployment} from '../sdk/src/index.js';
import {ReferenceSolverV2,SolverService,type FeeRecord,type ServiceStatus} from '../solver/src/index.js';
import {FileSubmissionJournal} from '../solver/src/journal.js';
import {ORDER_FEE_POLICY} from '../frontend/src/fees.js';
import {ENDPOINTS,GENESIS,XUDT} from './lib/pool-live.js';

const usage='Usage: npm run solver:service -- [--execute] [--once] [--interval=SECONDS] [--min-balance=CKB] [--daily-fee-budget=CKB]';
const args=process.argv.slice(2);
for(const a of args)if(!/^--(execute|once|interval=\d+|min-balance=\d+(\.\d+)?|daily-fee-budget=\d+(\.\d+)?)$/.test(a))throw new Error(`Unknown option ${a}\n${usage}`);
const flag=(name:string)=>args.find(a=>a.startsWith(`--${name}=`))?.split('=')[1];
const execute=args.includes('--execute'),once=args.includes('--once');
const intervalMs=Number(flag('interval')??15)*1000;
assert(intervalMs>=5000&&intervalMs<=3_600_000,'Interval must be 5..3600 seconds');
const minBalance=ccc.fixedPointFrom(flag('min-balance')??'500'),dailyFeeBudget=ccc.fixedPointFrom(flag('daily-fee-budget')??'0.5');

const root=new URL('../',import.meta.url),local=(p:string)=>new URL(`.local/${p}`,root);
const json=async(path:string)=>JSON.parse(await readFile(new URL(path,root),'utf8'));
const v2=await json('deployments/testnet-v2.json') as Deployment,v1=await json('deployments/testnet.json') as Deployment;
const wallet=await json('deployments/solver-wallet.json');

const client=new ccc.ClientPublicTestnet({url:process.env.CKB_RPC_URL??ENDPOINTS[0]});
assert.equal((await client.getHeaderByNumber(0))?.hash,GENESIS,'Not CKB testnet');
assert(v2.genesisHash===GENESIS&&v1.genesisHash===GENESIS,'Deployments are not on this network');
const keyFile=process.env.OPENSWAP_SOLVER_KEY_FILE??(process.env.CREDENTIALS_DIRECTORY?join(process.env.CREDENTIALS_DIRECTORY,'solver-key'):fileURLToPath(local('testnet-solver-key')));
assert(((await stat(keyFile)).mode&0o077)===0,`Solver key ${keyFile} is readable by group or others; chmod 600 it`);
const signer=new ccc.SignerCkbPrivateKey(client,(await readFile(keyFile,'utf8')).trim());
const lock=(await signer.getRecommendedAddressObj()).script;
assert(lock.eq(ccc.Script.from(wallet.lock)),'Solver key does not match deployments/solver-wallet.json');

const dir=process.env.OPENSWAP_SOLVER_STATE_DIR?pathToFileURL(join(process.env.OPENSWAP_SOLVER_STATE_DIR,'/')):local('solver-service/');
await mkdir(dir,{recursive:true,mode:0o700});
const statusFile=new URL('status.json',dir),eventsFile=new URL('events.jsonl',dir);
let journal:FileSubmissionJournal;
try{journal=new FileSubmissionJournal(fileURLToPath(new URL('journal',dir)),{genesisHash:GENESIS,accountLockHash:lock.hash()});}
catch(error){
 if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Solver journal is locked: another service or solver-journal command is running. Remove journal/writer.lock only after confirming no writer remains.');
 throw error;
}
// Fees from the previous run count against the rolling 24 h budget.
let fees:FeeRecord[]=[];
try{fees=(JSON.parse(await readFile(statusFile,'utf8')) as ServiceStatus).fees??[];}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}

const log=(event:string,details:unknown)=>{
 const line=ccc.stringify({at:new Date().toISOString(),event,details});
 console.log(line);void appendFile(eventsFile,line+'\n',{mode:0o600});
};
const resolver=new PinnedXudtResolver(new CatalogAssetResolver(client),XUDT.codeHash,XUDT.dep);
// Settlements are paid by the solver: minimum relay rate, capped like the app's order transactions.
const context:BuildContext={signer,deployment:v2,resolver,feeRate:ORDER_FEE_POLICY.minRate,maxFee:ORDER_FEE_POLICY.maxFee};
const solver=new ReferenceSolverV2(context,log,{v1,journal});
const service=new SolverService({
 solver,journal,client,emit:log,
 balance:()=>signer.getBalance(),
 feeOf:tx=>tx.getFee(client),
 writeStatus:async status=>{const t=new URL('status.json.tmp',dir);await writeFile(t,JSON.stringify(status,null,1)+'\n',{mode:0o600});await rename(t,statusFile);},
},{execute,minBalance,dailyFeeBudget,intervalMs,fees});

const stop=new AbortController();
for(const s of ['SIGINT','SIGTERM'] as const)process.on(s,()=>{if(!stop.signal.aborted){console.error(`${s}: stopping after this cycle`);stop.abort();}});
console.error(`Solver service on testnet (${execute?'LIVE: sending':'dry run: nothing is sent'}), wallet ${wallet.address}, every ${intervalMs/1000}s; balance floor ${ccc.fixedPointToString(minBalance)} CKB, 24 h fee budget ${ccc.fixedPointToString(dailyFeeBudget)} CKB`);
try{
 if(once)await service.cycle();
 else await service.run(stop.signal,(ms,signal)=>new Promise(resolve=>{const t=setTimeout(resolve,ms);signal.addEventListener('abort',()=>{clearTimeout(t);resolve();},{once:true});}));
 const status=JSON.parse(await readFile(statusFile,'utf8')) as ServiceStatus;
 console.error(`Status: ${status.state}${status.pauseReasons.length?` (${status.pauseReasons.join('; ')})`:''}; balance ${ccc.fixedPointToString(BigInt(status.balance??0))} CKB; journal ${status.journal.active} active, ${status.journal.attention.length} need attention${status.lastError?`; last error: ${status.lastError}`:''}`);
}finally{journal.close();}
process.exit(0);
