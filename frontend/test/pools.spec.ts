import type {Page} from '@playwright/test';
import {test,expect} from './fixtures.js';
import {ccc} from '@ckb-ccc/core';
import {JsonRpcTransformers} from '@ckb-ccc/core/advanced';
import {readFileSync} from 'node:fs';
import {writeLE} from '../../sdk/src/codec.js';
import {buildCreate,XUDT_CODE_HASH} from '../../pool-sdk/src/index.js';

// Offline fixture only: a real SDK-built genesis served by a mocked node, and a
// mock JoyID signer. Nothing here is a live deployment, OutPoint or credential.
const genesisHash=JSON.parse(readFileSync(new URL('../../deployments/testnet.json',import.meta.url),'utf8')).genesisHash as ccc.Hex;
const hash=(n:number)=>`0x${n.toString(16).padStart(2,'0').repeat(32)}` as ccc.Hex;
const dep=(n:number)=>({outPoint:{txHash:hash(n),index:0n},depType:'code' as const});
const xudt=ccc.hexFrom(readFileSync(new URL('../../tests/fixtures/xudt',import.meta.url)));
const deployment={genesisHash,codeHash:ccc.hashCkb('0x1234'),poolDep:dep(3),tokenDep:dep(4)};
const codeType=ccc.Script.from({codeHash:hash(11),hashType:'type',args:hash(12)});
const joyLock=ccc.Script.from({codeHash:codeType.hash(),hashType:'type',args:`0x0001${'66'.repeat(20)}`});
const otherJoyLock=ccc.Script.from({codeHash:codeType.hash(),hashType:'type',args:`0x0001${'77'.repeat(20)}`});
const creator=ccc.Script.from({codeHash:hash(8),hashType:'type',args:'0x0002'});
const token=ccc.Script.from({codeHash:XUDT_CODE_HASH,hashType:'data1',args:hash(7)});

type TokenMeta='match'|'mismatch'|'none';
function chain(tokenMeta:TokenMeta='match'){
 const cell=(point:{txHash:ccc.Hex;index:bigint},lock:ccc.Script,capacity:bigint,data:ccc.Hex='0x',type?:ccc.Script)=>ccc.Cell.from({outPoint:point,cellOutput:{capacity,lock,type},outputData:data});
 const request={parameters:{feeBps:30n,lockedShares:1000n,backing:{state:34_000_000_000n,ckb:8_000_000_000n,token:16_000_000_000n}},x:10n**12n,y:4n*10n**12n,minShares:1n,tokenOwner:hash(7)};
 const creatorFunding=[cell({txHash:hash(20),index:0n},creator,20_000_000_000n,ccc.hexFrom(writeLE(request.y,16)),token),cell({txHash:hash(21),index:0n},creator,2n*10n**12n)];
 const built=buildCreate(deployment,{lock:creator,change:creator,deps:[dep(5)],funding:creatorFunding,feeRate:1000n,maxFee:10000n},{ckb:creator,token:creator,lp:creator},request);
 const tx=built.transaction,txHash=tx.hash();
 const lp=tx.outputs.find(o=>o.type&&!o.type.eq(token)&&o.lock.eq(creator)&&o.type.codeHash===deployment.codeHash)!.type!;
 const cells=[
  cell(dep(3).outPoint,creator,10n**12n,'0x1234'),cell(dep(4).outPoint,creator,10n**12n,xudt),cell(dep(9).outPoint,creator,10n**12n,'0xabcd',codeType),
  ...tx.outputs.map((o,i)=>cell({txHash,index:BigInt(i)},o.lock,o.capacity,tx.outputsData[i]!,o.type)),
  // The trader: one plain CKB cell and one token cell.
  cell({txHash:hash(30),index:0n},joyLock,10n**13n),cell({txHash:hash(31),index:0n},joyLock,20_000_000_000n,ccc.hexFrom(writeLE(10n**12n,16)),token),
  cell({txHash:hash(32),index:0n},otherJoyLock,10n**13n),
  // The trader also holds 1,000,000 LP shares of this pool.
  cell({txHash:hash(33),index:0n},joyLock,20_000_000_000n,ccc.hexFrom(writeLE(1_000_000n,16)),lp),
 ];
 const manifest={version:1,network:'testnet',
  deployment:{genesisHash,codeHash:deployment.codeHash,poolDep:{outPoint:{txHash:hash(3),index:'0'},depType:'code'},tokenDep:{outPoint:{txHash:hash(4),index:'0'},depType:'code'}},
  pools:[{label:'CKB / TEST',poolId:built.poolId,...(tokenMeta==='none'?{}:{token:{symbol:'TEST',decimals:8,typeHash:tokenMeta==='match'?token.hash():hash(13)}})}],
  joyid:{codeHash:joyLock.codeHash,hashType:'type',codeDeps:[{dep:{outPoint:{txHash:hash(9),index:'0'},depType:'code'},dataHash:ccc.hashCkb('0xabcd')}]},
  policy:{feeRate:'1000',maxFee:'10000',slippageBps:50,reviewTtlMs:60000}};
 // Committed parent transactions, which CCC reads to price inputs before sending.
 const parents=new Map<string,ccc.Transaction>([[txHash,tx]]);
 for(const c of cells)if(c.outPoint.txHash!==txHash){
  const parent=parents.get(c.outPoint.txHash)??ccc.Transaction.from({});
  while(parent.outputs.length<=Number(c.outPoint.index)){parent.outputs.push(c.cellOutput.clone());parent.outputsData.push(c.outputData);}
  parent.outputs[Number(c.outPoint.index)]=c.cellOutput.clone();parent.outputsData[Number(c.outPoint.index)]=c.outputData;parents.set(c.outPoint.txHash,parent);
 }
 return {cells,manifest,poolId:built.poolId,parents};
}
const json=(s?:ccc.Script)=>s?{code_hash:s.codeHash,hash_type:s.hashType,args:s.args}:null;
const out=(c:ccc.Cell)=>({capacity:ccc.numToHex(c.cellOutput.capacity),lock:json(c.cellOutput.lock),type:json(c.cellOutput.type)});
const key=(p:{tx_hash:string;index:string})=>`${p.tx_hash}:${BigInt(p.index)}`;
function matches(c:ccc.Cell,search:any){
 const target=search.script_type==='lock'?c.cellOutput.lock:c.cellOutput.type;if(!target)return false;
 const s=search.script;if(target.codeHash!==s.code_hash||target.hashType!==s.hash_type)return false;
 if(search.script_search_mode==='prefix'?!target.args.startsWith(s.args):target.args!==s.args)return false;
 const f=search.filter;if(!f)return true;
 if(f.script_len_range){const len=c.cellOutput.type?c.cellOutput.type.occupiedSize:0;if(len<Number(BigInt(f.script_len_range[0]))||len>=Number(BigInt(f.script_len_range[1])))return false;}
 if(f.output_data_len_range){const len=(c.outputData.length-2)/2;if(len<Number(BigInt(f.output_data_len_range[0]))||len>=Number(BigInt(f.output_data_len_range[1])))return false;}
 if(f.script){const t=c.cellOutput.type;if(!t||t.codeHash!==f.script.code_hash||t.hashType!==f.script.hash_type||t.args!==f.script.args)return false;}
 return true;
}
interface Mock {sent:string[];journalAtSend:string[];send:'ok'|'abort';committedAt?:bigint;tip:bigint}
async function mockPools(page:Page,options:{manifest?:boolean;token?:TokenMeta}={}):Promise<Mock>{
 const {cells,manifest,parents}=chain(options.token),live=new Map(cells.map(c=>[`${c.outPoint.txHash}:${c.outPoint.index}`,c]));
 const mock:Mock={sent:[],journalAtSend:[],send:'ok',tip:100n},pool=new Map<string,unknown>();
 if(options.manifest!==false)await page.route('**/pool-manifest.json',route=>route.fulfill({json:manifest}));
 await page.route('https://testnet.ckb.dev/**',async route=>{
  const body=route.request().postDataJSON();let result:unknown;
  switch(body?.method){
   case 'get_live_cell':{const c=live.get(key(body.params[0]));result=c?{cell:{output:out(c),data:{content:c.outputData,hash:ccc.hashCkb(c.outputData)}},status:'live'}:{cell:null,status:'unknown'};break;}
   case 'get_cells':{const found=cells.filter(c=>matches(c,body.params[0]));if(!found.length)return route.fallback();
    result={objects:found.map(c=>({block_number:'0x1',out_point:{tx_hash:c.outPoint.txHash,index:ccc.numToHex(c.outPoint.index)},output:out(c),output_data:c.outputData,tx_index:'0x0'})),last_cursor:'0x'};break;}
   case 'send_transaction':{
    // The signed bytes must already be in the browser journal when send is attempted.
    mock.journalAtSend.push(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('toastdex-pool-journal:')&&!k.endsWith(':archive')).map(k=>localStorage.getItem(k)).join('')));
    const tx=JsonRpcTransformers.transactionTo(body.params[0]);mock.sent.push(ccc.hexFrom(tx.toBytes()));
    if(mock.send==='abort')return route.abort();pool.set(tx.hash(),body.params[0]);result=tx.hash();break;}
   case 'get_transaction':{
    // Like a real node, report an accepted transaction as pending; otherwise unknown.
    const sent=pool.get(body.params[0]),parent=parents.get(body.params[0]);
    if(sent&&mock.committedAt!==undefined)result={transaction:sent,tx_status:{status:'committed',block_hash:hash(41),block_number:ccc.numToHex(mock.committedAt),reason:null},cycles:null,time_added_to_pool:null,fee:null,min_replace_fee:null};
    else if(sent)result={transaction:sent,tx_status:{status:'pending',block_hash:null,block_number:null,reason:null},cycles:null,time_added_to_pool:null,fee:null,min_replace_fee:null};
    else if(parent)result={transaction:JsonRpcTransformers.transactionFrom(parent),tx_status:{status:'committed',block_hash:hash(40),block_number:'0x1',reason:null},cycles:null,time_added_to_pool:null,fee:null,min_replace_fee:null};
    else return route.fallback();
    break;}
   case 'get_tip_header':
    result={compact_target:'0x1d08a2a4',dao:`0x${'00'.repeat(32)}`,epoch:'0x0',extra_hash:hash(42),hash:hash(43),nonce:'0x0',number:ccc.numToHex(mock.tip),parent_hash:hash(44),proposals_hash:hash(45),timestamp:'0x0',transactions_root:hash(46),version:'0x0'};break;
   default:return route.fallback();
  }
  await route.fulfill({json:{jsonrpc:'2.0',id:body.id,result}});
 });
 return mock;
}
async function connect(page:Page,lock=joyLock){
 const {build}=await import('esbuild');
 const helper=await build({entryPoints:['frontend/test/pool-wallet-helper.ts'],bundle:true,write:false,format:'iife',globalName:'PoolWalletTest',platform:'browser',target:'es2022'});
 await page.addScriptTag({content:helper.outputFiles[0]!.text});
 await page.evaluate(([lockJson,publicKey])=>(globalThis as any).PoolWalletTest.installJoyId(lockJson,publicKey),[JSON.stringify({codeHash:lock.codeHash,hashType:lock.hashType,args:lock.args}),'77'.repeat(64)]);
 await expect(page.locator('#connected-account')).toContainText('ckt1');
}
async function openPools(page:Page){
 await page.goto('/');await expect(page.locator('#scan-status')).toContainText('supported live orders',{timeout:35000});
 await page.getByRole('button',{name:'Pools',exact:true}).click();
}
async function reviewSwap(page:Page,amount='100'){
 await page.locator('#pool-swap-amount').fill(amount);await expect(page.locator('#pool-quote')).toContainText('minimum accepted');
 await page.getByRole('button',{name:'Review pool swap'}).click();await expect(page.locator('#pool-review')).toBeVisible({timeout:20000});
}
const records=(page:Page)=>page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('toastdex-pool-journal:')&&!k.endsWith(':archive')).flatMap(k=>JSON.parse(localStorage.getItem(k)!).records));

test('pools tab reports no deployment when no manifest is served',async({page})=>{
 // Explicit 404: dist may hold the real P6 manifest.
 await page.route('**/pool-manifest.json',route=>route.fulfill({status:404,body:'not found'}));
 await openPools(page);
 await expect(page.locator('#pool-status')).toHaveText('Pools are not deployed on this network yet. No pool transactions can be prepared.');
 for(const id of ['#pool-swap','#pool-deposit','#pool-withdraw','#pool-create'])await expect(page.locator(id)).toBeHidden();
});

test('pool view, swap review gating and a single durable send',async({page})=>{
 const mock=await mockPools(page);await openPools(page);
 await expect(page.locator('#pool-status')).toHaveText('1 of 1 listed pools live.');
 const info=page.locator('#pool-info');
 await expect(info).toContainText('Reserves: 10000 CKB · 40000 TEST');await expect(info).toContainText('TEST (8 decimals)');
 await expect(info).toContainText('Swap fee: 0.3%');await expect(info).toContainText('1000 virtual locked shares');
 await expect(info).toContainText('Permanent backing (never withdrawable): state 340 CKB · CKB reserve 80 CKB · token reserve 160 CKB');
 await page.locator('#pool-swap-amount').fill('100');await page.getByRole('button',{name:'Review pool swap'}).click();
 await expect(page.locator('#status')).toHaveText('Connect a wallet first');
 // Errors also appear beside the pool forms, not only in the page-bottom status line.
 await expect(page.locator('#pool-action-status')).toHaveText('Connect a wallet first');
 await connect(page);await reviewSwap(page);
 const review=page.locator('#pool-review-text');
 await expect(page.locator('#pool-action-status')).toHaveText('Review ready. Check every line before approving.');
 for(const line of ['Pool swap','JoyID main_key','Network: CKB TESTNET','You pay: 100 CKB · 0 TEST','You receive (exact):','Minimum accepted:','Network fee:','Permanent backing (never withdrawable): 580 CKB','Review expires:'])await expect(review).toContainText(line);
 // Approval gating: nothing is signed or sent before the explicit approval.
 expect(await page.evaluate(()=>(globalThis as any).poolSignCalls)).toBe(0);expect(mock.sent).toEqual([]);
 await page.getByRole('button',{name:'Approve and sign'}).click();
 await expect(page.locator('#pool-action-status')).toContainText('Submitted 0x');await expect(page.locator('#pool-review')).toBeHidden();
 expect(mock.sent).toHaveLength(1);expect(mock.journalAtSend[0]).toContain(mock.sent[0]!);
 const saved=await records(page);expect(saved).toHaveLength(1);expect(saved[0].transaction).toBe(mock.sent[0]);
 await expect(page.locator('#pool-submissions')).toContainText(`SENT · waiting for confirmation · ${saved[0].hash}`);
 // Recheck: the node reports it pending, then committed but shallow, then deep enough to archive.
 await page.getByRole('button',{name:'Recheck'}).click();
 await expect(page.locator('#pool-submissions')).toContainText(`PENDING · accepted by the node, waiting to be committed · ${saved[0].hash}`);
 mock.committedAt=95n;await page.getByRole('button',{name:'Recheck'}).click();
 await expect(page.locator('#pool-submissions')).toContainText(`COMMITTED · 6 of 24 confirmations`);
 expect(await records(page)).toHaveLength(1);
 mock.tip=118n;await page.getByRole('button',{name:'Recheck'}).click();
 await expect(page.locator('#pool-submissions-status')).toHaveText('No unresolved pool submissions from this browser.');
 expect(await records(page)).toEqual([]);
 const archived=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('toastdex-pool-journal:')&&k.endsWith(':archive')).map(k=>localStorage.getItem(k)).join(''));
 expect(archived).toContain(saved[0].hash);expect(mock.sent).toHaveLength(1);
 await page.screenshot({path:'frontend/test-results/pool-submitted.png',fullPage:true});
});

test('a repeated review click while preparing starts nothing new and reserves nothing twice',async({page})=>{
 const mock=await mockPools(page);await openPools(page);await expect(page.locator('#pool-status')).toContainText('listed pools live');
 await connect(page);
 await page.locator('#pool-swap-amount').fill('100');
 await page.locator('#pool-swap-amount').press('Enter');await page.locator('#pool-swap-amount').press('Enter');
 await expect(page.locator('#pool-review')).toBeVisible({timeout:20000});
 await expect(page.locator('#pool-action-status')).toHaveText('Review ready. Check every line before approving.');
 await expect(page.locator('#status')).not.toContainText('reserved');await expect(page.locator('#status')).not.toContainText('changed');
 await expect(page.locator('#pool-approve')).toBeEnabled();
 expect(mock.sent).toEqual([]);
});

test('wallet refusal sends nothing, journals nothing and releases the funding',async({page})=>{
 const mock=await mockPools(page);await openPools(page);await expect(page.locator('#pool-status')).toContainText('listed pools live');
 await connect(page);await page.evaluate(()=>{(globalThis as any).poolSignMode='refuse';});
 await reviewSwap(page);await page.getByRole('button',{name:'Approve and sign'}).click();
 await expect(page.locator('#status')).toContainText('Wallet request cancelled');await expect(page.locator('#pool-review')).toBeHidden();
 expect(mock.sent).toEqual([]);expect(await records(page)).toEqual([]);
 // Reservations were released: the same inputs can be reviewed again.
 await page.evaluate(()=>{(globalThis as any).poolSignMode='ok';});await reviewSwap(page);
});

test('review expiry and account changes clear the review before signing',async({page})=>{
 await page.clock.install();
 const mock=await mockPools(page);await openPools(page);await expect(page.locator('#pool-status')).toContainText('listed pools live');
 await connect(page);await reviewSwap(page);
 await page.clock.fastForward('01:01');
 await page.getByRole('button',{name:'Approve and sign'}).click();
 await expect(page.locator('#status')).toContainText('Review expired');await expect(page.locator('#pool-review')).toBeHidden();
 await reviewSwap(page);
 await connect(page,otherJoyLock);
 await expect(page.locator('#pool-review')).toBeHidden();await expect(page.locator('#pool-review-text')).toHaveText('');
 expect(await page.evaluate(()=>(globalThis as any).poolSignCalls)).toBe(0);expect(mock.sent).toEqual([]);
});

test('an ambiguous send stays unknown, is never retried and survives a reload',async({page})=>{
 const mock=await mockPools(page);mock.send='abort';await openPools(page);await expect(page.locator('#pool-status')).toContainText('listed pools live');
 await connect(page);await reviewSwap(page);await page.getByRole('button',{name:'Approve and sign'}).click();
 await expect(page.locator('#pool-action-status')).toContainText('Status unknown for 0x');
 await expect(page.locator('#pool-action-status')).toContainText('Do not prepare it again');
 const [row]=await records(page);expect(row.status).toBe('unknown');expect(mock.sent).toEqual([row.transaction]);
 await expect(page.locator('#pool-submissions')).toContainText(`UNKNOWN · the send was not confirmed by the node. Do not prepare it again. · ${row.hash}`);
 await expect(page.locator('#pool-submissions button')).toHaveCount(0);
 await page.reload();await expect(page.locator('#scan-status')).toContainText('supported live orders',{timeout:35000});
 await connect(page);await page.getByRole('button',{name:'Pools',exact:true}).click();
 await expect(page.locator('#pool-submissions')).toContainText(`UNKNOWN · the node does not report this transaction yet`);
 await expect(page.locator('#pool-submissions')).toContainText(row.hash);
 // Its inputs (including the pool state) stay reserved, so a conflicting swap cannot be prepared.
 await page.locator('#pool-swap-amount').fill('100');await page.getByRole('button',{name:'Review pool swap'}).click();
 await expect(page.locator('#status')).toContainText(`Pool submission ${row.hash} (unknown) already spends this pool's current state`);
 expect(mock.sent).toHaveLength(1);
});

test('liquidity screens review deposits with an LP minimum and refuse withdrawals without LP shares',async({page})=>{
 const mock=await mockPools(page);await openPools(page);await expect(page.locator('#pool-status')).toContainText('listed pools live');
 await connect(page);
 await page.locator('#pool-deposit-ckb').fill('100');await expect(page.locator('#pool-deposit-token-label')).toHaveText('Maximum TEST');await page.locator('#pool-deposit-token').fill('4000');
 await page.getByRole('button',{name:'Review deposit'}).click();await expect(page.locator('#pool-review')).toBeVisible({timeout:20000});
 const review=page.locator('#pool-review-text');
 for(const line of ['Add liquidity','Minimum LP shares:','You receive (exact): 0 CKB · 0 TEST ·','LP shares'])await expect(review).toContainText(line);
 await page.getByRole('button',{name:'Back'}).click();await expect(page.locator('#pool-review')).toBeHidden();
 await page.locator('#pool-withdraw-shares').fill('2000000');
 await expect(page.locator('#pool-withdraw-quote')).toHaveText('You have only 1000000 LP shares in this pool');
 await page.getByRole('button',{name:'Review withdrawal'}).click();
 await expect(page.locator('#status')).toContainText('not enough lp');
 expect(mock.sent).toEqual([]);
});

test('token amounts use decimals only when the metadata matches the live token',async({page})=>{
 await mockPools(page,{token:'none'});await openPools(page);await expect(page.locator('#pool-status')).toContainText('listed pools live');
 await expect(page.locator('#pool-info')).toContainText('Reserves: 10000 CKB · 4000000000000 token units');
 await page.locator('#pool-swap-direction').selectOption('yToX');await expect(page.locator('#pool-swap-direction option:checked')).toHaveText('Pay token units, receive CKB');
 await page.locator('#pool-swap-amount').fill('1.5');await expect(page.locator('#pool-quote')).toContainText('at most 0 decimal places');
});

test('token metadata bound to another type hash refuses to show the pool',async({page})=>{
 await mockPools(page,{token:'mismatch'});await openPools(page);
 await expect(page.locator('#pool-status')).toContainText('token metadata does not match the live token');
 for(const id of ['#pool-swap','#pool-deposit','#pool-withdraw'])await expect(page.locator(id)).toBeHidden();
});

test('decimal token input is quoted and reviewed in whole tokens',async({page})=>{
 await mockPools(page);await openPools(page);await expect(page.locator('#pool-status')).toContainText('listed pools live');
 await page.locator('#pool-swap-direction').selectOption('yToX');await expect(page.locator('#pool-swap-direction option:checked')).toHaveText('Pay TEST, receive CKB');
 await page.locator('#pool-swap-amount').fill('1.5');await expect(page.locator('#pool-quote')).toContainText(/Expected: [\d.]+ CKB/);
 await page.locator('#pool-swap-direction').selectOption('xToY');await page.locator('#pool-swap-amount').fill('10');
 await expect(page.locator('#pool-quote')).toContainText(/Expected: [\d.]+ TEST · minimum accepted [\d.]+ TEST/);
});

test('remove liquidity shows the LP position, fills a share of it and estimates the payout',async({page})=>{
 const mock=await mockPools(page);await openPools(page);await expect(page.locator('#pool-status')).toContainText('listed pools live');
 await expect(page.locator('#pool-lp-balance')).toHaveText('Connect a wallet to see your LP shares.');
 await connect(page);await page.getByRole('button',{name:'Refresh pools'}).click();
 await expect(page.locator('#pool-lp-balance')).toContainText('Your LP shares: 1000000 (worth about');
 await page.getByRole('button',{name:'50%'}).click();
 await expect(page.locator('#pool-withdraw-shares')).toHaveValue('500000');
 await expect(page.locator('#pool-withdraw-quote')).toContainText('(50% of your position)');
 await expect(page.locator('#pool-withdraw-quote')).toContainText(/You receive about [\d.]+ CKB · [\d.]+ TEST/);
 await page.getByRole('button',{name:'Max'}).click();
 await expect(page.locator('#pool-withdraw-shares')).toHaveValue('1000000');
 await expect(page.locator('#pool-withdraw-quote')).toContainText('(100% of your position)');
 await page.getByRole('button',{name:'Review withdrawal'}).click();await expect(page.locator('#pool-review')).toBeVisible({timeout:20000});
 for(const line of ['Remove liquidity','Minimum received:','1000000 LP shares'])await expect(page.locator('#pool-review-text')).toContainText(line);
 expect(mock.sent).toEqual([]);
});

test('the Swap tab compares venues and routes to the pool through the pool review',async({page})=>{
 const mock=await mockPools(page);
 await page.goto('/');await expect(page.locator('#scan-status')).toContainText('supported live orders',{timeout:35000});
 // The pool token joins the Swap tab with its manifest symbol and decimals.
 await expect(page.locator(`#base option[value="${token.hash()}"]`)).toHaveText('TEST');
 await page.locator('#quote').selectOption('ckb');await page.locator('#base').selectOption(token.hash());
 await page.locator('#swap-output').fill('10');
 const status=page.locator('#quote-status');
 await expect(status).toContainText(/Best route: pool\. Receive 10(\.\d+)? TEST for [\d.]+ CKB/);
 await expect(status).toContainText('Order book: no whole-lot route for this amount');
 await expect(page.locator('#pay-estimate')).not.toHaveText('—');
 // A budget below the pool's input makes it ineligible, with the reason shown.
 await page.locator('summary',{hasText:'Swap options'}).click();await page.locator('#swap-budget').fill('0.001');await expect(status).toContainText('(over your maximum payment)');
 await page.locator('#swap-budget').fill('');
 await connect(page);await page.locator('#swap-output').fill('10');
 await page.getByRole('button',{name:'Review swap'}).click();
 await expect(page.locator('#pool-review')).toBeVisible({timeout:30000});
 for(const line of ['Routed swap via pool','You receive (exact): 0 CKB · 10.','Minimum accepted: 10 TEST'])await expect(page.locator('#pool-review-text')).toContainText(line);
 expect(mock.sent).toEqual([]);
 await page.getByRole('button',{name:'Approve and sign'}).click();
 await expect(page.locator('#pool-review')).toBeHidden();expect(mock.sent).toHaveLength(1);
});

test('a malformed manifest is an error, not a silent "not deployed"',async({page})=>{
 await page.route('**/pool-manifest.json',route=>route.fulfill({json:{version:1,network:'testnet',extra:true}}));
 await openPools(page);
 await expect(page.locator('#status')).toContainText('Pool manifest: unexpected fields');
 for(const id of ['#pool-swap','#pool-deposit','#pool-withdraw'])await expect(page.locator(id)).toBeHidden();
});

test('the browser journal refuses to continue after another tab writes it',async({page})=>{
 await mockPools(page);await openPools(page);await expect(page.locator('#pool-status')).toContainText('listed pools live');
 await connect(page);await reviewSwap(page);await page.getByRole('button',{name:'Approve and sign'}).click();
 await expect(page.locator('#pool-action-status')).toContainText('Submitted 0x');
 await page.evaluate(()=>{for(const k of Object.keys(localStorage).filter(k=>k.startsWith('toastdex-pool-journal:')&&!k.endsWith(':archive'))){const v=JSON.parse(localStorage.getItem(k)!);v.revision++;localStorage.setItem(k,JSON.stringify(v));}});
 await page.getByRole('button',{name:'Recheck'}).click();
 await expect(page.locator('#status')).toContainText('changed in another tab');
});
