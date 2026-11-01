#!/usr/bin/env -S npx tsx
// Health check for the solver service: reads its status.json (no RPC, no key) and exits
// 1 on a problem (stale cycle, errors, paused sending, stopped, journal rows needing the
// operator). Warnings (dry run, wallet near its floor) are printed but pass.
// Optional dead-man pings, only when set: OPENSWAP_HEALTH_PING_URL is requested when
// healthy, OPENSWAP_HEALTH_FAIL_URL when not (e.g. a healthchecks.io check and its /fail).
//   npx tsx scripts/solver-service-health.ts [--max-age=SECONDS]   (default 300)
// State directory: OPENSWAP_SOLVER_STATE_DIR, else .local/solver-service.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assessStatus,type ServiceStatus} from '../solver/src/service.js';

const arg=process.argv.slice(2).find(a=>a.startsWith('--max-age='));
for(const a of process.argv.slice(2))if(!/^--max-age=\d+$/.test(a))throw new Error('Usage: solver-service-health.ts [--max-age=SECONDS]');
const maxAgeMs=Number(arg?.split('=')[1]??300)*1000;
const dir=process.env.OPENSWAP_SOLVER_STATE_DIR??fileURLToPath(new URL('../.local/solver-service',import.meta.url));
let health;
try{health=assessStatus(JSON.parse(await readFile(join(dir,'status.json'),'utf8')) as ServiceStatus,Date.now(),maxAgeMs);}
catch(error){health={ok:false,problems:[`cannot read ${join(dir,'status.json')}: ${error instanceof Error?error.message:String(error)}`],warnings:[]};}
for(const p of health.problems)console.log(`PROBLEM ${p}`);
for(const w of health.warnings)console.log(`warning ${w}`);
if(health.ok)console.log('ok');
const ping=health.ok?process.env.OPENSWAP_HEALTH_PING_URL:process.env.OPENSWAP_HEALTH_FAIL_URL;
if(ping){
 try{await fetch(ping,{method:'POST',body:[...health.problems,...health.warnings].join('\n')||'ok',signal:AbortSignal.timeout(10_000)});}
 catch(error){console.log(`warning ping failed: ${error instanceof Error?error.message:String(error)}`);}
}
process.exit(health.ok?0:1);
