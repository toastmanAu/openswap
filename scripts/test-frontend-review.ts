// Read-only adversarial review checks using a funded wallet's public key. Signing is forbidden.
import {chromium} from '@playwright/test';import {build} from 'esbuild';import {ccc} from '@ckb-ccc/shell';import {readFile,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const owned=ccc.ClientPublicTestnet.open({urls:['https://testnet.ckb.dev']});const browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try{
 const publicKey=new ccc.SignerCkbPrivateKey(owned.value,(await readFile(new URL('../.local/testnet-solver-key',import.meta.url),'utf8')).trim()).publicKey;
 const page=await browser.newPage();let signingRequests=0;await page.exposeFunction('openswapTestSign',()=>{signingRequests++;throw new Error('Signing forbidden in review test');});
 await page.goto('http://127.0.0.1:5173/');await page.locator('#scan-status').filter({hasText:'supported live orders'}).waitFor({state:'attached',timeout:45000});
 const helper=await build({entryPoints:['scripts/browser-signer-helper.ts'],bundle:true,write:false,format:'iife',globalName:'OpenSwapBrowserTest',platform:'browser',target:'es2022'});await page.addScriptTag({content:helper.outputFiles[0]!.text});
 const connect=async(key:string)=>{await page.evaluate(key=>(globalThis as any).OpenSwapBrowserTest.install(key),key);await page.locator('#connect').filter({hasText:'Switch wallet'}).waitFor();};
 const review=async()=>{await page.getByRole('button',{name:'Orders',exact:true}).click();await page.locator('#offer').fill('0.00000001');await page.locator('#ask').fill('1');await page.getByRole('button',{name:'Review order',exact:true}).click();try{await page.locator('#review').waitFor({state:'visible'});}catch(error){console.error('Review status:',await page.locator('#status').textContent());throw error;}};
 await connect(publicKey);
 // The funded CKB wallet has no iCKB. A direct iCKB quote must explain payment funding before signing.
 const ickbQuote=page.locator('.quote-row').filter({hasText:'iCKB'}).first();
 await ickbQuote.getByRole('button',{name:'Review swap'}).click();
 await page.locator('#status').filter({hasText:'This wallet has 0 iCKB available'}).waitFor();
 assert.equal(signingRequests,0);
 await review();
 await connect('0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');await page.locator('#review').waitFor({state:'hidden'});
 await page.evaluate(()=>document.getElementById('sign')!.click());await page.locator('#status').filter({hasText:'Review is stale'}).waitFor();assert.equal(signingRequests,0);
 await connect(publicKey);await review();
 // A successful endpoint switch invalidates the pending review even if a caller submits the form programmatically.
 await page.evaluate(()=>{(document.getElementById('rpc') as HTMLInputElement).value='https://testnet.ckbapp.dev';(document.getElementById('indexer') as HTMLInputElement).value='https://testnet.ckbapp.dev';(document.getElementById('endpoints') as HTMLFormElement).requestSubmit();});
 await page.locator('#review').waitFor({state:'hidden',timeout:30000});await page.locator('#connect').filter({hasText:'Connect wallet'}).waitFor();
 await page.evaluate(()=>document.getElementById('sign')!.click());await page.locator('#status').filter({hasText:'Review is stale'}).waitFor();assert.equal(signingRequests,0);
 const result={verifiedAt:new Date().toISOString(),accountChangeInvalidatesReview:true,endpointSwitchInvalidatesReview:true,staleReviewCannotSign:true,insufficientTokenExplainedBeforeSigning:true,signingRequests};await writeFile(new URL('../deployments/frontend-review-verification.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await browser.close();await owned.dispose();}
