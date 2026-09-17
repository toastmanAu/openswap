import { ccc } from '@ckb-ccc/core';
import { CKB, udt, type AssetId } from './types.js';
export interface ResolvedAsset { asset: AssetId; supported: boolean; reason?: string }
export interface AssetResolver {
  identify(script?: ccc.Script, cellData?: ccc.Hex): Promise<ResolvedAsset>;
  resolveCellDeps(script: ccc.Script): Promise<ccc.CellDepInfo[]>;
  supports(script: ccc.Script, data: ccc.Hex): Promise<boolean>;
}
/** Only unextended canonical xUDT: a 32-byte owner, optionally zero u32 flags. */
export class DefaultAssetResolver implements AssetResolver {
  constructor(private readonly client: ccc.Client) {}
  private async known(script: ccc.Script): Promise<boolean> {
    const info = await this.client.getKnownScript(ccc.KnownScript.XUdt);
    const args = ccc.bytesFrom(script.args);
    return script.codeHash === info.codeHash && script.hashType === info.hashType &&
      (args.length === 32 || (args.length === 36 && args.subarray(32).every(n => n === 0)));
  }
  async identify(script?: ccc.Script, data?: ccc.Hex): Promise<ResolvedAsset> {
    if (!script) return { asset: CKB, supported: data === undefined || data === '0x', reason: data && data !== '0x' ? 'Native CKB must have empty data' : undefined };
    const supported = await this.known(script) && (data === undefined || /^0x[0-9a-fA-F]{32}$/.test(data));
    return { asset: udt(script), supported, reason: supported ? undefined : 'Requires an AssetResolver for this script or data profile' };
  }
  async supports(script: ccc.Script, data: ccc.Hex): Promise<boolean> { return (await this.identify(script, data)).supported; }
  async resolveCellDeps(script: ccc.Script): Promise<ccc.CellDepInfo[]> {
    if (!await this.known(script)) throw new Error('Unsupported asset: supply an AssetResolver');
    return (await this.client.getKnownScript(ccc.KnownScript.XUdt)).cellDeps;
  }
}
export const defaultResolver = (client: ccc.Client): AssetResolver => new DefaultAssetResolver(client);
