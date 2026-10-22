#!/usr/bin/env -S npx tsx
// Operator resolution for the reference solver journal. Read-only RPC; never
// signs or sends. Stop the solver first: the journal admits one writer.
import {ccc} from '@ckb-ccc/shell';
import {assertNetwork} from '../sdk/src/index.js';
import {FileSubmissionJournal} from '../solver/src/journal.js';
import {abandonConflictedSubmission,archiveCommittedSubmission} from '../solver/src/resolution.js';
import {solverJournalConfig} from './solver-journal-config.js';

const usage=`Usage: npm run solver-journal -- <command> [--journal-dir=PATH]
  list                                        print journaled submissions (offline)
  status                                      report node status and live inputs (read-only)
  archive-committed <tx-hash> [--min-confirmations=24]
  abandon-conflicted <tx-hash> --acknowledge-reorg-risk`;
const [command,...rest]=process.argv.slice(2);
const flags=rest.filter(a=>a.startsWith('--')),positional=rest.filter(a=>!a.startsWith('--'));
for(const flag of flags)if(!/^--(journal-dir=.+|min-confirmations=\d+|acknowledge-reorg-risk)$/.test(flag))throw new Error(`Unknown option ${flag}\n${usage}`);
const flag=(name:string)=>flags.find(f=>f.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const hash=positional[0];
if(!['list','status','archive-committed','abandon-conflicted'].includes(command??'')||(command!=='list'&&command!=='status'&&!/^0x[0-9a-f]{64}$/.test(hash??'')))throw new Error(usage);

const {deployment,scope,directory}=await solverJournalConfig(flag('journal-dir'));
let journal:FileSubmissionJournal;
try{journal=new FileSubmissionJournal(directory,scope);}
catch(error){
 if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error(`Journal ${directory} is locked: stop the solver. Remove writer.lock only after confirming no writer remains.`);
 throw error;
}
try{
 if(command==='list'){
  for(const row of journal.list())console.log(ccc.stringify({hash:row.hash,status:row.status,createdAt:new Date(row.createdAt).toISOString(),orders:row.orders}));
  console.error(`${journal.list().length} active submissions in ${directory}`);
 }else{
  const owned=ccc.ClientPublicTestnet.open({urls:[process.env.CKB_RPC_URL??'https://testnet.ckb.dev']});
  try{
   const client=owned.value;await assertNetwork(client,deployment);
   if(command==='status'){
    for(const row of journal.list()){
     const tx=ccc.Transaction.fromBytes(row.transaction);let live=0;
     for(const input of tx.inputs)if(await client.getCellLiveNoCache(input.previousOutput))live++;
     const observed=await client.getTransactionNoCache(row.hash);
     console.log(ccc.stringify({hash:row.hash,journal:row.status,node:observed?.status??'absent',blockNumber:observed?.blockNumber,liveInputs:live,totalInputs:tx.inputs.length}));
    }
   }else if(command==='archive-committed'){
    const depth=flag('min-confirmations');
    console.log(ccc.stringify(await archiveCommittedSubmission(journal,client,hash as ccc.Hex,depth===undefined?undefined:Number(depth))));
   }else{
    console.log(ccc.stringify(await abandonConflictedSubmission(journal,client,hash as ccc.Hex,flags.includes('--acknowledge-reorg-risk'))));
   }
  }finally{await owned.dispose();}
 }
}finally{journal.close();}
