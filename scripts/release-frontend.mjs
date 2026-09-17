// Builds twice and compares every output byte. No credentials or backend required.
import {execFileSync} from 'node:child_process';
import {readFile,readdir,writeFile,mkdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const sha=data=>createHash('sha256').update(data).digest('hex');
async function snapshot(){const result={};for(const name of (await readdir('frontend/dist')).sort())result[name]=sha(await readFile(`frontend/dist/${name}`));return result;}
await rm('frontend/dist',{recursive:true,force:true});execFileSync('npm',['run','build:frontend'],{stdio:'inherit'});const first=await snapshot();
await rm('frontend/dist',{recursive:true,force:true});execFileSync('npm',['run','build:frontend'],{stdio:'inherit'});const second=await snapshot();assert.deepEqual(second,first,'Static build is not reproducible');
await mkdir('release',{recursive:true});
const identity={application:'ToastDEX',network:'testnet',node:process.version,lockfileSha256:sha(await readFile('package-lock.json')),files:second};
await writeFile('release/frontend-manifest.json',JSON.stringify(identity,null,2)+'\n');
execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-czf','release/toastdex-testnet.tar.gz','-C','frontend/dist','.']);
await writeFile('release/SHA256SUMS',`${sha(await readFile('release/toastdex-testnet.tar.gz'))}  toastdex-testnet.tar.gz\n${sha(await readFile('release/frontend-manifest.json'))}  frontend-manifest.json\n`);
console.log('Two clean static builds match. Release archive and hashes are in release/.');
