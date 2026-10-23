import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ccc} from '@ckb-ccc/core';
import {TOKEN_CATALOG,tokensForNetwork,CatalogAssetResolver,DefaultAssetResolver,PinnedXudtResolver} from '../src/index.js';
test('catalog identities, holder ranking and network boundaries',()=>{
 const seen=new Set<string>();
 for(const token of TOKEN_CATALOG){assert.equal(ccc.Script.from(token.script).hash(),token.typeHash,token.symbol);const key=token.network+token.typeHash;assert(!seen.has(key));seen.add(key);assert(Number.isInteger(token.decimals)&&token.decimals>=0&&token.decimals<=255);}
 const ranked=tokensForNetwork('mainnet').filter(t=>t.rank);assert.equal(ranked.length,20);
 ranked.forEach((t,i)=>{assert.equal(t.rank,i+1);if(i)assert(t.holders!<=ranked[i-1]!.holders!);});
 assert.equal(tokensForNetwork('testnet').length,1);assert.equal(tokensForNetwork('testnet')[0]!.symbol,'iCKB');
});
test('explicit iCKB adapter uses network-specific dependencies and rejects extended data',async()=>{
 for(const [client,dep] of [[new ccc.ClientPublicTestnet(),'0xf7ece4fb33d8378344cab11fcd6a4c6f382fd4207ac921cf5821f30712dcd311'],[new ccc.ClientPublicMainnet(),'0x621a6f38de3b9f453016780edac3b26bfcbfa3e2ecb47c2da275471a5d3ed165']] as const){
 const script=ccc.Script.from(TOKEN_CATALOG.find(t=>t.symbol==='iCKB')!.script),resolver=new CatalogAssetResolver(client);
 assert.equal((await new DefaultAssetResolver(client).identify(script)).supported,false);
 assert.equal(await resolver.supports(script,`0x${'00'.repeat(16)}`),true);
 for(const n of [0,15,17,1024])assert.equal(await resolver.supports(script,`0x${'00'.repeat(n)}`),false);
 assert.equal((await resolver.resolveCellDeps(script))[0]!.cellDep.outPoint.txHash,dep);
 const altered=script.clone();altered.args=`0x${'11'.repeat(32)}00000080`;assert.equal((await resolver.identify(altered)).supported,false);
 }
});
test('catalog sUDT adapter is mainnet scoped and does not accept arbitrary scripts',async()=>{
 const main=new CatalogAssetResolver(new ccc.ClientPublicMainnet()),testnet=new CatalogAssetResolver(new ccc.ClientPublicTestnet());
 for(const token of tokensForNetwork('mainnet').filter(t=>t.kind==='sUDT')){const script=ccc.Script.from(token.script);assert.equal(await main.supports(script,`0x${'00'.repeat(16)}`),true);assert.equal((await testnet.identify(script)).supported,false);assert.equal((await main.resolveCellDeps(script)).length,1);}
 const custom=ccc.Script.from(tokensForNetwork('mainnet')[0]!.script);custom.args=`0x${'ab'.repeat(32)}`;assert.equal((await main.identify(custom)).supported,false);
});
test('pinned Data1 xUDT resolver accepts only its exact profile and delegates the rest',async()=>{
 const codeHash=`0x${'50'.repeat(32)}` as ccc.Hex,dep={outPoint:{txHash:`0x${'bf'.repeat(32)}`,index:0n},depType:'code' as const};
 const base={identify:async()=>({asset:{kind:'ckb'} as never,supported:false,reason:'base'}),supports:async()=>false,resolveCellDeps:async():Promise<ccc.CellDepInfo[]>=>{throw new Error('base deps');}};
 const resolver=new PinnedXudtResolver(base,codeHash,dep);
 const token=ccc.Script.from({codeHash,hashType:'data1',args:`0x${'4a'.repeat(32)}`});
 assert.equal(await resolver.supports(token,`0x${'00'.repeat(16)}`),true);
 assert.equal((await resolver.identify(token)).asset.kind,'udt');
 for(const n of [0,15,17])assert.equal(await resolver.supports(token,`0x${'00'.repeat(n)}`),false);
 const deps=await resolver.resolveCellDeps(token);assert.equal(deps.length,1);assert.ok(deps[0]!.cellDep.eq(ccc.CellDep.from(dep)));
 // Any other hash type, code hash or args length is not this profile.
 for(const other of [{...token,hashType:'type' as const},{...token,hashType:'data' as const},{...token,codeHash:`0x${'51'.repeat(32)}` as ccc.Hex},{...token,args:`0x${'4a'.repeat(36)}`}]){
  const script=ccc.Script.from(other);assert.equal((await resolver.identify(script)).reason,'base');await assert.rejects(resolver.resolveCellDeps(script),/base deps/);
 }
 assert.throws(()=>new PinnedXudtResolver(base,codeHash,{...dep,depType:'depGroup'}),/direct code cell/);
});
