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
/** One explicitly pinned Data1-referenced xUDT profile (for example the pool
 * token), checked by code hash and served from one pinned code dep. The order
 * lock compares assets by type hash only. Everything else goes to `base`. */
export class PinnedXudtResolver implements AssetResolver {
  private readonly dep: ccc.CellDep;
  constructor(private readonly base: AssetResolver, private readonly codeHash: ccc.Hex, cellDep: ccc.CellDepLike) {
    if (!/^0x[0-9a-f]{64}$/.test(codeHash)) throw new Error('Pinned xUDT code hash must be 32 bytes');
    this.dep = ccc.CellDep.from(cellDep);
    if (this.dep.depType !== 'code') throw new Error('Pinned xUDT dependency must be a direct code cell');
  }
  private matches(script: ccc.Script): boolean {
    return script.codeHash === this.codeHash && script.hashType === 'data1' && ccc.bytesFrom(script.args).length === 32;
  }
  async identify(script?: ccc.Script, data?: ccc.Hex): Promise<ResolvedAsset> {
    if (!script || !this.matches(script)) return this.base.identify(script, data);
    const supported = data === undefined || /^0x[0-9a-fA-F]{32}$/.test(data);
    return { asset: udt(script), supported, reason: supported ? undefined : 'Token amount data must be exactly 16 bytes' };
  }
  async supports(script: ccc.Script, data: ccc.Hex): Promise<boolean> { return (await this.identify(script, data)).supported; }
  async resolveCellDeps(script: ccc.Script): Promise<ccc.CellDepInfo[]> {
    if (!this.matches(script)) return this.base.resolveCellDeps(script);
    return [{ cellDep: this.dep.clone() }];
  }
}
