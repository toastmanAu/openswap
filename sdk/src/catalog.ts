import {ccc} from '@ckb-ccc/core';
import {DefaultAssetResolver, type AssetResolver, type ResolvedAsset} from './assets.js';
import {udt} from './types.js';
import {catalogSnapshot} from './catalog-data.js';
export type TokenNetwork = 'mainnet' | 'testnet';
export interface CatalogToken {
 network: TokenNetwork; symbol: string; name: string; decimals: number;
 kind: 'sUDT' | 'xUDT'; typeHash: ccc.Hex; script: ccc.ScriptLike;
 source: 'explorer' | 'utxoswap' | 'ickb';
 profile: 'sudt' | 'canonical-xudt' | 'ickb' | 'resolver-required';
 holders?: number; rank?: number;
}
export const TOKEN_CATALOG: readonly CatalogToken[] = catalogSnapshot.tokens;
export const CATALOG_DATE = catalogSnapshot.retrievedAt;
export function tokensForNetwork(network: TokenNetwork): readonly CatalogToken[] {
 return TOKEN_CATALOG.filter(token => token.network === network);
}
/** Explicit support for catalog sUDT and iCKB profiles. Unknown scripts still require an adapter. */
export class CatalogAssetResolver implements AssetResolver {
 private readonly fallback: DefaultAssetResolver;
 private readonly network: TokenNetwork;
 constructor(private readonly client: ccc.Client) {
  this.network = client.addressPrefix === 'ckb' ? 'mainnet' : 'testnet';
  this.fallback = new DefaultAssetResolver(client);
 }
 private entry(script: ccc.Script) {
  return tokensForNetwork(this.network).find(token => token.typeHash === script.hash());
 }
 private async explicit(script: ccc.Script): Promise<CatalogToken | undefined> {
  const token = this.entry(script);
  if (token?.profile === 'ickb') return token;
  if (token?.profile === 'sudt') {
   const known = await this.client.getKnownScript(ccc.KnownScript.SUdt);
   if (script.codeHash === known.codeHash && script.hashType === known.hashType && ccc.bytesFrom(script.args).length === 32) return token;
  }
  return undefined;
 }
 async identify(script?: ccc.Script, data?: ccc.Hex): Promise<ResolvedAsset> {
  if (!script || !await this.explicit(script)) return this.fallback.identify(script, data);
  const supported = data === undefined || /^0x[0-9a-fA-F]{32}$/.test(data);
  return {asset: udt(script), supported, reason: supported ? undefined : 'Token amount data must be exactly 16 bytes'};
 }
 async supports(script: ccc.Script, data: ccc.Hex) { return (await this.identify(script, data)).supported; }
 async resolveCellDeps(script: ccc.Script): Promise<ccc.CellDepInfo[]> {
  const token = await this.explicit(script);
  if (token?.profile === 'sudt') return (await this.client.getKnownScript(ccc.KnownScript.SUdt)).cellDeps;
  if (token?.profile === 'ickb') return [{cellDep: ccc.CellDep.from({outPoint: {
   txHash: this.network === 'mainnet' ? '0x621a6f38de3b9f453016780edac3b26bfcbfa3e2ecb47c2da275471a5d3ed165' : '0xf7ece4fb33d8378344cab11fcd6a4c6f382fd4207ac921cf5821f30712dcd311', index: 0n}, depType: 'depGroup'})}];
  return this.fallback.resolveCellDeps(script);
 }
}
