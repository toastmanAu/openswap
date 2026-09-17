import {test,expect,type Page} from '@playwright/test';
import {ccc} from '@ckb-ccc/core';
import {readFileSync} from 'node:fs';
import {CKB,udt,estimateCapacity,writeLE,type Deployment} from '../../sdk/src/index.js';
const deployment=JSON.parse(readFileSync(new URL('../../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
async function fixtures(){const owned=ccc.ClientPublicTestnet.open({urls:['https://testnet.ckb.dev']});try{
 const owner=(await ccc.Address.fromString('ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq',owned.value)).script;
 const token=await ccc.Script.fromKnownScript(owned.value,ccc.KnownScript.XUdt,owner.hash());
 const script=(s:ccc.Script)=>({code_hash:s.codeHash,hash_type:s.hashType,args:s.args});
 const cells=Array.from({length:120},(_,i)=>{const cell=estimateCapacity(deployment,{ownerLock:owner,nonce:writeLE(BigInt(i+1),16),askAsset:udt(token),askAmount:BigInt(i+1)},CKB,10n).cell;return{out_point:{tx_hash:ccc.hexFrom(writeLE(BigInt(i+1),32)),index:'0x0'},output:{capacity:ccc.numToHex(cell.cellOutput.capacity),lock:script(cell.cellOutput.lock)},output_data:cell.outputData};});
 return[{...cells[0]!,out_point:{tx_hash:'0x'+'ff'.repeat(32),index:'0x0'},output:{...cells[0]!.output,lock:{...cells[0]!.output.lock,args:'0x'}}},...cells];
}finally{await owned.dispose();}}
async function mockBook(page:Page){const cells=await fixtures();await page.route('https://testnet.ckb.dev/**',async route=>{const body=route.request().postDataJSON();if(body?.method!=='get_cells')return route.continue();const start=body.params[3]?Number(BigInt(body.params[3])):0;const count=Number(BigInt(body.params[2]));await route.fulfill({json:{jsonrpc:'2.0',id:body.id,result:{objects:cells.slice(start,start+count),last_cursor:ccc.numToHex(start+count)}}});});}
test('populated book sorts exact prices, skips malformed cells and pages lots',async({page})=>{
 await mockBook(page);await page.goto('/');await expect(page.locator('#scan-status')).toContainText('120 supported live orders · 1 malformed',{timeout:35000});
 await page.getByRole('button',{name:'Orders',exact:true}).click();await page.getByText('Full orderbook',{exact:true}).click();await expect(page.locator('#book tbody tr')).toHaveCount(50);await expect(page.locator('#book tbody tr').first()).toContainText('1/10');
 await page.getByRole('button',{name:'Next page'}).click();await expect(page.locator('#book tbody tr').first()).toContainText('51/10');
 await page.getByRole('button',{name:'Next page'}).click();await expect(page.locator('#book tbody tr')).toHaveCount(20);
 await page.getByRole('button',{name:'Fill lot'}).first().click();await expect(page.locator('#status')).toHaveText('Connect a wallet first');
 await page.screenshot({path:'frontend/test-results/populated-book.png',fullPage:true});
});
test('mismatched custom indexer is rejected and the current connection remains usable',async({page})=>{
 await page.route('https://wrong-indexer.example/**',async route=>{const body=route.request().postDataJSON();await route.fulfill({json:{jsonrpc:'2.0',id:body.id,result:{block_number:'0x0',block_hash:'0x'+'aa'.repeat(32)}}});});
 await page.goto('/');await expect(page.locator('#scan-status')).toContainText('supported live orders',{timeout:35000});
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByText('Connection settings',{exact:true}).click();await page.locator('#indexer').fill('https://wrong-indexer.example/');await page.getByRole('button',{name:'Apply endpoints'}).click();
 await expect(page.locator('#status')).toContainText('different chains');await page.getByRole('button',{name:'Swap',exact:true}).click();await page.getByRole('button',{name:'Refresh live orders'}).click();await expect(page.locator('#scan-status')).toContainText('supported live orders');
});

test('swap quotes use decimal CKB and derive payment without a budget',async({page})=>{
 await mockBook(page);await page.goto('/');await expect(page.locator('#scan-status')).toContainText('120 supported live orders',{timeout:35000});
 await page.locator('#swap-output').fill('0.0000001');await expect(page.locator('#pay-estimate')).toHaveText('1');await expect(page.locator('#quote-status')).toContainText('Receive 0.0000001 CKB for 1 Test xUDT');
 await page.locator('#swap-submit').click();await expect(page.locator('#status')).toHaveText('Connect a wallet first');
 await page.getByRole('button',{name:'Reverse tokens'}).click();await page.locator('#swap-output').fill('1');await expect(page.locator('#quote-status')).toContainText('No available swap');
 await expect(page.locator('#available-orders button').first()).toBeVisible();
});
test('switching wallets clears owned orders and self-fills are excluded',async({page})=>{
 const {build}=await import('esbuild');
 await mockBook(page);await page.goto('/');await expect(page.locator('#scan-status')).toContainText('120 supported live orders',{timeout:35000});
 const helper=await build({entryPoints:['scripts/browser-signer-helper.ts'],bundle:true,write:false,format:'iife',globalName:'OpenSwapBrowserTest',platform:'browser',target:'es2022'});await page.addScriptTag({content:helper.outputFiles[0]!.text});
 const maker='ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq';
 await page.evaluate(address=>(globalThis as any).OpenSwapBrowserTest.installAddress(address),maker);
 await expect(page.locator('#connected-account')).toContainText(maker);await expect(page.locator('#available-orders')).toContainText('Your order');
 await page.locator('#swap-output').fill('0.0000001');await expect(page.locator('#quote-status')).toContainText('No available swap');
 await page.locator('#base').selectOption(await page.locator('#quote').inputValue());await page.getByRole('button',{name:'Orders',exact:true}).click();await expect(page.locator('#my-orders button')).toHaveCount(120);
 await page.getByRole('button',{name:'Switch wallet',exact:true}).click();await expect(page.locator('#my-orders')).toHaveText('Connect a wallet to manage your orders.');await expect(page.locator('#connected-account')).toHaveText('');
 expect(await page.evaluate(()=>(globalThis as any).openswapDisconnects)).toBeGreaterThan(0);
 await page.locator('#close-wallet').click();
 const taker='ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqgp9mnd6kevd2wgrenv6c09zk7qe9g2vjsyhqsv2';
 await page.evaluate(address=>(globalThis as any).OpenSwapBrowserTest.installAddress(address),taker);
 await expect(page.locator('#connected-account')).toContainText(taker);await expect(page.locator('#my-orders')).toHaveText('No live orders for this wallet.');
 await page.getByRole('button',{name:'Swap',exact:true}).click();await page.locator('#base').selectOption('ckb');await expect(page.locator('#quote-status')).toContainText('Receive 0.0000001 CKB');await expect(page.locator('#available-orders').getByRole('button',{name:'Review swap'})).toHaveCount(30);
});
