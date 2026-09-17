// Four UI-originated transactions. Test secret remains in Node; browser receives a public key only.
import {chromium} from '@playwright/test';import {build} from 'esbuild';
import {ccc} from '@ckb-ccc/shell';import {readFile,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
import {assertNetwork,decodeTerms,parseAmount,type Deployment} from '../sdk/src/index.js';
const deployment=JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
const owned=ccc.ClientPublicTestnet.open({urls:['https://testnet.ckb.dev']});
const journalFile=new URL('../deployments/frontend-live-result.json',import.meta.url);
const journal:{startedAt:string;steps:{name:string;hash:string;status:string}[];finishedAt?:string}={startedAt:new Date().toISOString(),steps:[]};
// Never blindly repeat an earlier run that may have submitted transactions.
try{await readFile(journalFile);throw new Error('Frontend journal exists; inspect recorded transactions before resuming manually');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try{
 await assertNetwork(owned.value,deployment);
 const signer=new ccc.SignerCkbPrivateKey(owned.value,(await readFile(new URL('../.local/testnet-solver-key',import.meta.url),'utf8')).trim());
 const owner=(await signer.getRecommendedAddressObj()).script;
 const issuer=(await ccc.Address.fromString('ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq',owned.value)).script;
 const token=await ccc.Script.fromKnownScript(owned.value,ccc.KnownScript.XUdt,issuer.hash());
 const page=await browser.newPage();let stage='',signatures=0;
 await page.exposeFunction('openswapTestSign',async(raw:string)=>{
  assert(++signatures<=4,'Four-signature scenario cap');assert(['create_cancel','cancel','create_swap','swap'].includes(stage));
  const tx=ccc.Transaction.from(JSON.parse(raw));assert(tx.inputs.length<=16&&tx.outputs.length<=16);
  const fee=await tx.getFee(owned.value);assert(fee>=0n&&fee<=1000000n,'Fee cap 0.01 CKB');
  for(const input of tx.inputs){const live=await owned.value.getCellLive(input.previousOutput,true);assert(live,'Input must be live');if(!live.cellOutput.lock.eq(owner)){assert.equal(live.cellOutput.lock.codeHash,deployment.codeHash);assert(decodeTerms(live.cellOutput.lock.args).ownerLock.eq(owner));}}
  for(let i=0;i<tx.outputs.length;i++){const out=tx.outputs[i]!;if(!out.lock.eq(owner)){assert.equal(out.lock.codeHash,deployment.codeHash);assert.equal(out.lock.hashType,'data1');const terms=decodeTerms(out.lock.args);assert(terms.ownerLock.eq(owner));assert(terms.askAsset.kind==='udt'&&terms.askAsset.script.eq(token));assert.equal(terms.askAmount,1n);assert.equal(out.capacity-terms.capacityRefund,1n);assert(!out.type);}
   if(out.type){assert(out.type.eq(token));parseAmount(tx.outputsData[i]!);}
  }
  const signed=await signer.signOnlyTransaction(tx);assert.equal(signed.hash(),tx.hash());journal.steps.push({name:stage,hash:tx.hash(),status:'signed'});await writeFile(journalFile,JSON.stringify(journal,null,2)+'\n');return ccc.stringify(signed);
 });
 await page.goto('http://127.0.0.1:5173/');await page.locator('#scan-status').filter({hasText:'supported live orders'}).waitFor({state:'attached',timeout:45000});
 const helper=await build({entryPoints:['scripts/browser-signer-helper.ts'],bundle:true,write:false,format:'iife',globalName:'OpenSwapBrowserTest',platform:'browser',target:'es2022'});
 await page.addScriptTag({content:helper.outputFiles[0]!.text});await page.evaluate(publicKey=>(globalThis as any).OpenSwapBrowserTest.install(publicKey),signer.publicKey);
 await page.locator('#connect').filter({hasText:'Switch wallet'}).waitFor({timeout:10000});
 const confirm=async(name:string)=>{stage=name;await page.locator('#review').waitFor({state:'visible',timeout:30000});const review=await page.locator('#review-text').innerText();assert(review.includes('Network fee:'));await page.locator('#sign').click();await page.locator('#status').filter({hasText:'Committed:'}).waitFor({timeout:180000});const item=journal.steps.at(-1)!;assert.equal(item.name,name);assert.equal((await owned.value.getTransaction(item.hash))?.status,'committed');item.status='committed';await writeFile(journalFile,JSON.stringify(journal,null,2)+'\n');console.log('frontend_committed',name,item.hash);};
 const create=async(name:string)=>{await page.getByRole('button',{name:'Orders',exact:true}).click();await page.locator('#offer').fill('0.00000001');await page.locator('#ask').fill('1');await page.getByRole('button',{name:'Review order',exact:true}).click();await confirm(name);};
 await create('create_cancel');await page.getByRole('button',{name:'Cancel',exact:true}).click();await confirm('cancel');
 await create('create_swap');await page.getByRole('button',{name:'Swap',exact:true}).click();await page.locator('#swap-output').fill('0.00000001');await page.getByText('Swap options',{exact:true}).click();await page.locator('#swap-budget').fill('1');await page.locator('#swap-submit').click();await confirm('swap');
 for(const step of journal.steps.filter(s=>s.name.startsWith('create')))assert.equal(await owned.value.getCellLive({txHash:step.hash,index:0},true),undefined);
 await page.screenshot({path:'frontend/test-results/live-ui-completed.png',fullPage:true});journal.finishedAt=new Date().toISOString();await writeFile(journalFile,JSON.stringify(journal,null,2)+'\n');console.log('FRONTEND LIVE CREATE/CANCEL/SWAP VERIFIED');
}finally{await browser.close();await owned.dispose();}
