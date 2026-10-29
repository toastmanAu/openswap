import {test,expect} from './fixtures.js';
import {build} from 'esbuild';
import {ccc} from '@ckb-ccc/core';
import {readFileSync} from 'node:fs';
import {marketEvents,print,type MarketSources,type Print} from '../../pool-sdk/src/market.js';
import {comparePrints,priceOf} from '../../pool-sdk/src/market-stats.js';

// Real committed testnet transactions with resolved inputs (scripts/market-fixtures.ts).
const raw=JSON.parse(readFileSync('pool-sdk/test/fixtures/market.json','utf8'));
const sources=raw.sources as MarketSources;
const markets=JSON.parse(readFileSync('deployments/pool-markets.json','utf8'));
const labels:Record<string,string>=Object.fromEntries(markets.tokens.map((t:{typeHash:string;symbol:string})=>[t.typeHash,t.symbol]));
const prints:Print[]=Object.values<any>(raw.fixtures).flatMap(f=>marketEvents({hash:f.hash,block:BigInt(f.block),time:BigInt(f.time),tx:ccc.Transaction.fromBytes(f.tx),inputs:f.inputs.map((c:ccc.CellLike)=>ccc.Cell.from(c))},sources).events)
 .flatMap(e=>e.kind==='trade'?[print(e)]:[]);
const newest=prints.reduce((m,p)=>p.trade.time>m?p.trade.time:m,0n);
const TIP=newest+3_600_000n;
const test3=markets.tokens.find((t:{symbol:string})=>t.symbol==='TEST3'),test2=markets.tokens.find((t:{symbol:string})=>t.symbol==='TEST2');
const pairPrints=(hash:string)=>prints.filter(p=>p.pair.base.kind==='udt'&&p.pair.base.scriptHash===hash).sort(comparePrints).reverse();
const dec=()=>8;

test('markets: trades, stats, charts and depth from real testnet transactions',async({page})=>{
 await page.setViewportSize({width:1100,height:900});
 await page.goto('/');await expect(page.locator('#scan-status')).toContainText('supported live orders',{timeout:35000});
 const harness=await build({entryPoints:['frontend/test/markets-harness.ts'],bundle:true,write:false,format:'iife',globalName:'MarketsHarness',platform:'browser',target:'es2022'});
 await page.addScriptTag({content:harness.outputFiles[0]!.text});
 const book=[{offer:test2.typeHash,ask:'ckb',available:String(1000n*10n**8n),askAmount:String(95n*10n**8n),offerAmount:String(1000n*10n**8n)},
  {offer:'ckb',ask:test2.typeHash,available:String(300n*10n**8n),askAmount:String(3500n*10n**8n),offerAmount:String(300n*10n**8n)}];
 const pools=[{token:test2.token,x:String(4849n*10n**8n),y:String(51555n*10n**8n),feeBps:'30'}];
 await page.evaluate(([fixtures,options])=>(globalThis as any).MarketsHarness.install(fixtures,options),[raw,{tip:String(TIP),labels,book,pools}] as const);

 const pairs=new Set(prints.map(p=>p.pair.key)).size;
 await expect(page.locator('#markets-status')).toContainText(`${prints.length} trades in ${pairs} markets from the newest ${Object.keys(raw.fixtures).length} OpenSwap transactions`);
 await expect(page.locator('#markets-status')).toContainText('Read in full');
 const fullReads=await page.evaluate(()=>(globalThis as any).marketReads as number);
 // A returning visit restores the settled history saved in this browser and re-reads only recent blocks.
 expect(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('toastdex-market-history:')))).toBe(true);
 await page.evaluate(([fixtures,options])=>{(globalThis as any).marketReads=0;return (globalThis as any).MarketsHarness.install(fixtures,options);},[raw,{tip:String(TIP),labels,book,pools}] as const);
 await expect(page.locator('#markets-status')).toContainText('Saved history in this browser');
 await expect(page.locator('#markets-status')).toContainText(`${prints.length} trades in ${pairs} markets`);
 expect(await page.evaluate(()=>(globalThis as any).marketReads as number)).toBeLessThan(fullReads);
 await expect(page.locator('#markets-list')).toContainText('TEST3 / CKB');await expect(page.locator('#markets-list')).toContainText('TEST2 / CKB');

 // TEST3: the solver match (two order fills) and the JoyID route's second hop.
 await page.locator('#markets-list tr',{hasText:'TEST3 / CKB'}).click();
 await expect(page.locator('#market-title')).toHaveText('TEST3 / CKB');
 const t3=pairPrints(test3.typeHash);
 const last=priceOf(t3[0]!,dec).toLocaleString(undefined,{maximumSignificantDigits:6});
 await expect(page.locator('#market-stats .stat').first()).toContainText(last);
 await page.locator('[data-market-range="all"]').click();
 await expect(page.locator('#market-trades tbody tr')).toHaveCount(t3.length);
 await expect(page.locator('#market-trades tbody tr').first().locator('a')).toHaveAttribute('href',`https://pudge.explorer.nervos.org/transaction/${t3[0]!.trade.hash}`);
 await expect(page.locator('#market-trades')).toContainText(t3.some(p=>p.trade.venue==='pool')?'Pool':'Order');
 // 24 h window ends at the chain tip, not the host clock.
 await page.locator('[data-market-range="day"]').click();
 const inDay=t3.filter(p=>p.trade.time>=TIP-86_400_000n).length;
 if(inDay)await expect(page.locator('#market-trades tbody tr')).toHaveCount(inDay);else await expect(page.locator('#market-trades')).toContainText('No trades in this range');
 await page.locator('[data-market-range="all"]').click();

 // Hover and keyboard give the same readout; the tooltip never gates a value (the list has it).
 const chart=page.locator('#price-chart svg');await chart.scrollIntoViewIfNeeded();const box=(await chart.boundingBox())!;
 await page.mouse.move(box.x+box.width-30,box.y+box.height/2);await page.mouse.move(box.x+box.width-24,box.y+box.height/2);
 await expect(page.locator('#price-chart .chart-tip')).toBeVisible();
 await expect(page.locator('#price-chart .chart-tip')).toContainText('CKB per TEST3');
 await page.mouse.move(0,0);await chart.focus();await expect(page.locator('#price-chart .chart-tip')).toContainText(last);
 await page.keyboard.press('ArrowLeft');
 if(t3.length>1)await expect(page.locator('#price-chart .chart-tip')).toContainText(priceOf(t3[1]!,dec).toLocaleString(undefined,{maximumSignificantDigits:6}));

 // TEST2: depth combines the open orders with the pool curve.
 await page.locator('#markets-list tr',{hasText:'TEST2 / CKB'}).click();
 await expect(page.locator('#depth-chart svg')).toBeVisible();
 await expect(page.locator('#depth-chart')).toContainText('Bids');await expect(page.locator('#depth-chart')).toContainText('Asks');
 await page.locator('summary',{hasText:'Depth as a table'}).click();
 await expect(page.locator('#depth-table tbody tr').first()).toContainText('Bid');
 await page.locator('#view-markets').screenshot({path:'frontend/test-results/markets.png'});

 // Phone width: no page-level horizontal scroll; wide tables scroll inside their panel.
 await page.setViewportSize({width:390,height:900});
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 await page.locator('#view-markets').screenshot({path:'frontend/test-results/markets-phone.png'});
});
