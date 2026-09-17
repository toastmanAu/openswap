#!/usr/bin/env -S npx tsx
import { ccc } from '@ckb-ccc/shell';
import { readFile } from 'node:fs/promises';
import { CatalogAssetResolver, assertNetwork, scan, parse, assetKey, orderKey, type Deployment } from '../sdk/src/index.js';
const deployment = JSON.parse(await readFile(new URL('../deployments/testnet.json',import.meta.url),'utf8')) as Deployment;
const owner=ccc.ClientPublicTestnet.open({urls:[process.env.CKB_RPC_URL ?? 'https://testnet.ckb.dev']});
try {
  const client=owner.value,resolver=new CatalogAssetResolver(client);
  const print=(o: Awaited<ReturnType<typeof parse>>) => console.log(ccc.stringify({outPoint:orderKey(o),owner:o.ownerLock,offerAsset:assetKey(o.offerAsset),offerAmount:o.offerAmount,askAsset:assetKey(o.askAsset),askAmount:o.askAmount,capacityRefund:o.capacityRefund,supported:o.supported,supportReason:o.supportReason}));
  if (process.argv[2] === 'inspect') {
    await assertNetwork(client,deployment);
    const hash=process.argv[3],index=process.argv[4]??'0';
    if(!hash) throw new Error('Usage: npm run orders -- inspect <tx-hash> [output-index]');
    const cell=await client.getCellLive({txHash:hash,index:BigInt(index)},true);
    if(!cell) throw new Error('Cell is not live');
    print(await parse(cell,deployment,resolver));
  } else {
    let count=0; for await (const order of scan(client,deployment,resolver,{includeUnsupported:true,onMalformed:(cell,error)=>console.error('Malformed',ccc.stringify(cell.outPoint),String(error))})) {print(order);count++;}
    console.error(`${count} live parsed orders on testnet`);
  }
} finally {await owner.dispose();}
