import { ccc } from '@ckb-ccc/core';
export type AssetId = { kind: 'ckb' } | { kind: 'udt'; script: ccc.Script; scriptHash: ccc.Hex };
export interface OpenSwapTerms {
  ownerLock: ccc.Script;
  nonce: Uint8Array;
  capacityRefund: bigint;
  askAsset: AssetId;
  askAmount: bigint;
}
export interface Deployment {
  network: 'testnet' | 'mainnet';
  genesisHash: ccc.Hex;
  codeHash: ccc.Hex;
  hashType: 'data1';
  cellDep: ccc.CellDepLike;
}
export interface OpenSwapOrder extends OpenSwapTerms {
  outPoint: ccc.OutPoint;
  lock: ccc.Script;
  cell: ccc.Cell;
  offerAsset: AssetId;
  offerAmount: bigint;
  supported: boolean;
  supportReason?: string;
  genesisHash: ccc.Hex;
}
export const CKB: AssetId = { kind: 'ckb' };
export const udt = (script: ccc.Script): AssetId => ({ kind: 'udt', script, scriptHash: script.hash() });
export const assetKey = (asset: AssetId): string => asset.kind === 'ckb' ? 'ckb' : asset.script.hash();
export const orderKey = (order: Pick<OpenSwapOrder, 'outPoint'>): string => `${order.outPoint.txHash}:${order.outPoint.index}`;
