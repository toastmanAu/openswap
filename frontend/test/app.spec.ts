import {test,expect} from '@playwright/test';
test('live testnet page scans and opens the CCC wallet selector',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('/');await expect(page.getByRole('heading',{name:'Swap',exact:true})).toBeVisible();
 await expect(page.locator('#scan-status')).toContainText('supported live orders',{timeout:40000});
 await expect(page.locator('#book')).toContainText('Asks');
 await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
 await expect(page.locator('#wallet-dialog')).toBeVisible();
 await expect(page.locator('ccc-connector')).toContainText('JoyID',{timeout:20000});
 await page.locator('#close-wallet').click();await expect(page.locator('#wallet-dialog')).not.toBeVisible();
 expect(errors).toEqual([]);
 await page.screenshot({path:'frontend/test-results/orderbook-desktop.png',fullPage:true});
});
test('mobile layout and invalid token input remain usable',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/');
 await page.getByText('Add a token by type script',{exact:true}).click();
 await page.locator('#token-label').fill('Bad token');await page.locator('#token-script').fill('not JSON');
 await page.getByRole('button',{name:'Add to this browser'}).click();await expect(page.locator('#status')).toContainText(/JSON|Unexpected/);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'frontend/test-results/orderbook-mobile.png',fullPage:true});
});
test('built-in catalog finds iCKB and mainnet tokens without script entry',async({page})=>{
 await page.goto('/');await expect(page.locator('#scan-status')).toContainText('supported live orders',{timeout:40000});
 await page.getByText('Token catalog',{exact:true}).click();await page.locator('#catalog-search').fill('ickb');await expect(page.locator('#catalog-results')).toContainText('iCKB');
 await page.getByRole('button',{name:'Use token',exact:true}).click();await expect(page.locator('#quote')).toHaveValue('0xd485c2271949c232e3f5d46128336c716f90bcbf3cb278696083689fbbcd407a');
 await page.locator('#catalog-network').selectOption('mainnet');await page.locator('#catalog-search').fill('sUDT');await expect(page.locator('.catalog-row')).toHaveCount(20);
 await expect(page.locator('#catalog-results button').first()).toBeDisabled();
 await page.locator('#catalog-search').fill('CAT++');await expect(page.locator('#catalog-results')).toContainText('CAT++');await expect(page.locator('#catalog-results button')).toBeDisabled();
 await page.locator('#catalog-search').fill('no-such-token');await expect(page.locator('#catalog-results')).toHaveText('No matching tokens.');
});
