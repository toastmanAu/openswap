#!/usr/bin/env -S npx tsx
// Reproducible offline fuzz/endurance campaigns. Runs each seed in turn and stops
// at the first failure. --record appends results to docs/campaigns/results.jsonl
// with the commit, dirty flag and contract binary hashes they ran against.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFileSync,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const targets={
 'order-parser':{cases:1_000_000,command:(o:Run)=>['cargo',['test','--locked','-q','-p','openswap-tests','seeded_malformed_wire_corpus_never_panics','--','--nocapture']] as const,env:true},
 'pool-wire':{cases:1_000_000,command:(o:Run)=>['cargo',['test','--locked','-q','-p','openswap-pool-arithmetic','--test','wire','seeded_arbitrary_bytes_never_panic','--','--nocapture']] as const,env:true},
 'pool-model-diff':{cases:200_000,command:(o:Run)=>['npx',['tsx','pool-model/src/campaign.ts',`--seed=${o.seed}`,`--cases=${o.cases}`,...(o.seconds===undefined?[]:[`--seconds=${o.seconds}`])]] as const,env:false},
 'pool-vm':{cases:100,command:(o:Run)=>['cargo',['test','--locked','-q','-p','openswap-pool-tests','sdk_seeded_vm_endurance','--','--nocapture']] as const,env:true},
};
type Target=keyof typeof targets;
interface Run {seed:bigint;cases:number;seconds?:number}
const usage=`Usage: npm run campaign -- <${Object.keys(targets).join('|')}|all> [--seeds=A..B|--seed=N] [--cases=N] [--seconds=N] [--record]
  Stops per run at the case budget, the per-run time budget, or the first failure.`;

const [name,...rest]=process.argv.slice(2);
for(const arg of rest)if(!/^--(seeds=\d+\.\.\d+|seed=\d+|cases=\d+|seconds=\d+|record)$/.test(arg))throw new Error(`Unknown or malformed option ${arg}\n${usage}`);
const value=(key:string)=>rest.find(a=>a.startsWith(`--${key}=`))?.split('=')[1];
const selected:Target[]=name==='all'?Object.keys(targets) as Target[]:name&&name in targets?[name as Target]:(()=>{throw new Error(usage);})();
const range=value('seeds')?.split('..').map(BigInt)??[BigInt(value('seed')??'1'),BigInt(value('seed')??'1')];
const [first,last]=range as [bigint,bigint];if(last<first||last-first>=10000n)throw new Error('Seed range must be ascending and at most 10000 seeds');
const seconds=value('seconds')===undefined?undefined:Number(value('seconds'));
const record=rest.includes('--record');

const git=(...args:string[])=>spawnSync('git',args,{cwd:root,encoding:'utf8'}).stdout.trim();
const sha256=(path:string)=>existsSync(`${root}/${path}`)?createHash('sha256').update(readFileSync(`${root}/${path}`)).digest('hex'):null;
const provenance={commit:git('rev-parse','HEAD'),dirty:git('status','--porcelain')!=='',
 binaries:{orderLock:sha256('target/riscv64imac-unknown-none-elf/release/openswap-lock'),pool:sha256('target/riscv64imac-unknown-none-elf/release/openswap-pool')}};
if(provenance.dirty)console.error('Warning: uncommitted changes; recorded results will be marked dirty.');

let failed=false;
for(const target of selected){
 const cases=Number(value('cases')??targets[target].cases);
 for(let seed=first;seed<=last&&!failed;seed++){
  const run:Run={seed,cases,seconds},[command,args]=targets[target].command(run);
  const env={...process.env,...(targets[target].env?{CAMPAIGN_SEED:String(seed),CAMPAIGN_CASES:String(cases),...(seconds===undefined?{}:{CAMPAIGN_SECONDS:String(seconds)})}:{})};
  const result=spawnSync(command,args,{cwd:root,env,encoding:'utf8',maxBuffer:256*1024*1024});
  const output=(result.stdout??'')+(result.stderr??'');
  const line=output.split('\n').find(l=>l.startsWith('CAMPAIGN '));
  const fields=Object.fromEntries((line??'').split(' ').slice(1).map(f=>{const i=f.indexOf('=');return [f.slice(0,i),f.slice(i+1)];}));
  const extra=output.split('\n').find(l=>l.startsWith('VM_ENDURANCE '))?.slice('VM_ENDURANCE '.length);
  const outcome=result.status===0&&line&&fields.stop!=='failure'?fields.stop:'failure';
  const entry={target,seed:seed.toString(),budget:cases,executed:Number(fields.executed??0),stop:outcome,
   failedCase:fields.failed_case===undefined?undefined:Number(fields.failed_case),elapsedMs:Number(fields.elapsed_ms??0),
   outcomes:fields.outcomes,detail:extra,...provenance,recordedAt:new Date().toISOString()};
  console.log(JSON.stringify(entry));
  if(record){mkdirSync(`${root}/docs/campaigns`,{recursive:true});appendFileSync(`${root}/docs/campaigns/results.jsonl`,JSON.stringify(entry)+'\n');}
  if(outcome==='failure'){
   failed=true;
   process.stderr.write(output.split('\n').filter(l=>/panicked|mismatch|Error|assert/.test(l)).slice(0,20).join('\n')+'\n');
   console.error(`Reproduce: npm run campaign -- ${target} --seed=${seed} --cases=${cases}`);
  }
 }
}
process.exit(failed?1:0);
