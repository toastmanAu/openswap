import {test as base,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const deployment=JSON.parse(readFileSync(new URL('../../deployments/testnet.json',import.meta.url),'utf8'));
const zero=`0x${'00'.repeat(32)}`;
const header={hash:deployment.genesisHash,compact_target:'0x0',dao:zero,epoch:'0x10000000000',extra_hash:zero,nonce:'0x0',number:'0x0',parent_hash:zero,proposals_hash:zero,timestamp:'0x0',transactions_root:zero,version:'0x0'};
/** Test-local RPC only. Unexpected network traffic fails instead of contacting
 * public services. Per-test routes can override this using route.fallback(). */
export const test=base.extend({page:async({page},use)=>{
 const unexpected:string[]=[];
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.hostname==='127.0.0.1'||url.hostname==='localhost')return route.continue();
  if(url.hostname==='testnet.ckb.dev'&&request.method()==='POST'){
   const body=request.postDataJSON();let result:unknown;
   switch(body.method){
    case 'get_header_by_number':case 'get_tip_header':result=header;break;
    case 'get_indexer_tip':result={block_number:'0x0',block_hash:deployment.genesisHash};break;
    case 'get_cells':case 'get_transactions':result={objects:[],last_cursor:'0x'};break;
    // Real CKB nodes (checked on both testnet endpoints, 2026-10-22) answer an unknown hash this way, not with null.
    case 'get_transaction':result={transaction:null,tx_status:{status:'unknown',block_hash:null,block_number:null,tx_index:null,reason:null},cycles:null,fee:null,min_replace_fee:null,time_added_to_pool:null};break;
    default:unexpected.push(`${url.origin}: ${body.method}`);return route.abort();
   }
   return route.fulfill({json:{jsonrpc:'2.0',id:body.id,result}});
  }
  unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);await route.abort();
 });
 await use(page);
 expect(unexpected,'unexpected external requests').toEqual([]);
}});
export {expect};
