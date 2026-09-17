import {test,expect} from '@playwright/test';import {build} from 'esbuild';import {ccc} from '@ckb-ccc/core';import {readFileSync} from 'node:fs';
import {accountKey} from '../src/activity.js';
test('history keeps unknown submissions and isolates them when switching accounts',async({page})=>{
 page.on('console',message=>{if(message.type()==='warning')console.log(message.text());});
 const deployment=JSON.parse(readFileSync('deployments/testnet.json','utf8'));
 const address='ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq';
 const lock=(await ccc.Address.fromString(address,new ccc.ClientPublicTestnet())).script;
 const hash=`0x${'ad'.repeat(32)}`;
 await page.addInitScript(row=>localStorage.setItem('toastdex-activity',JSON.stringify([row])),{hash,account:accountKey([lock]),network:deployment.genesisHash,summary:'My pending swap',status:'submitted',createdAt:1});
 await page.route('https://testnet.ckb.dev/**',async route=>{const body=route.request().postDataJSON();if(body?.method==='get_transactions')return route.fulfill({json:{jsonrpc:'2.0',id:body.id,result:{objects:[],last_cursor:'0x'}}});if(body?.method==='get_transaction'&&body.params[0]===hash)return route.fulfill({json:{jsonrpc:'2.0',id:body.id,result:null}});return route.continue();});
 await page.goto('/');await expect(page.locator('#scan-status')).toContainText('supported live orders',{timeout:35000});
 const helper=await build({entryPoints:['scripts/browser-signer-helper.ts'],bundle:true,write:false,format:'iife',globalName:'OpenSwapBrowserTest',platform:'browser',target:'es2022'});await page.addScriptTag({content:helper.outputFiles[0]!.text});
 await page.evaluate(a=>(globalThis as any).OpenSwapBrowserTest.installAddress(a),address);
 await page.getByRole('button',{name:'Activity',exact:true}).click();await expect(page.locator('#activity-list')).toContainText('UNKNOWN · My pending swap');await expect(page.locator('#activity-list a')).toHaveAttribute('href',`https://pudge.explorer.nervos.org/transaction/${hash}`);
 await page.evaluate(a=>(globalThis as any).OpenSwapBrowserTest.installAddress(a),'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqgp9mnd6kevd2wgrenv6c09zk7qe9g2vjsyhqsv2');
 await expect(page.locator('#activity-list')).not.toContainText('My pending swap');await expect(page.locator('#activity-status')).toHaveText('No recent transactions found.');
});
