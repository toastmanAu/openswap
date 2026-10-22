import {build,context} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
import {existsSync,rmSync} from 'node:fs';
await mkdir('dist',{recursive:true});await copyFile('index.html','dist/index.html');
// Pool UI loads an approved manifest at runtime; without one it shows pools as not deployed.
if(existsSync('../deployments/pool-testnet.json'))await copyFile('../deployments/pool-testnet.json','dist/pool-manifest.json');else rmSync('dist/pool-manifest.json',{force:true});await copyFile('_headers','dist/_headers');await copyFile('../toastDexLogo.png','dist/toastDexLogo.png');
const options={entryPoints:['src/main.ts'],bundle:true,outdir:'dist',format:'esm',platform:'browser',target:'es2022',sourcemap:true,loader:{'.svg':'dataurl','.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"'}};
if(process.argv.includes('--serve')){const ctx=await context(options);await ctx.watch();console.log(await ctx.serve({servedir:'dist',host:'127.0.0.1',port:5173}));}else await build({...options,minify:true});
