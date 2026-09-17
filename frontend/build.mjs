import {build,context} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});await copyFile('index.html','dist/index.html');
const options={entryPoints:['src/main.ts'],bundle:true,outdir:'dist',format:'esm',platform:'browser',target:'es2022',sourcemap:true,loader:{'.svg':'dataurl','.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"'}};
if(process.argv.includes('--serve')){const ctx=await context(options);await ctx.watch();console.log(await ctx.serve({servedir:'dist',host:'127.0.0.1',port:5173}));}else await build({...options,minify:true});
