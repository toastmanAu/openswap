// Shared by the solver integration runner and the operator journal CLI.
import {ccc} from '@ckb-ccc/shell';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import type {Deployment} from '../sdk/src/index.js';
import type {JournalScope} from '../solver/src/journal.js';

/** Private, gitignored directory keyed by network and solver account. */
export async function solverJournalConfig(directory?:string){
 const deployment=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
 const wallet=JSON.parse(await readFile(new URL('../deployments/solver-wallet.json',import.meta.url),'utf8'));
 const scope:JournalScope={genesisHash:deployment.genesisHash,accountLockHash:ccc.Script.from(wallet.lock).hash()};
 const fallback=fileURLToPath(new URL(`../.local/solver-journal/${deployment.network}-${scope.accountLockHash.slice(2,18)}`,import.meta.url));
 return {deployment,wallet,scope,directory:directory??fallback};
}
