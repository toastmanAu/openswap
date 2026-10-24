import { ccc } from '@ckb-ccc/core';
import { decodeTerms, parseAmount, U64_MAX } from './codec.js';
import { payment } from './capacity.js';
import { assetKey, CKB, udt, type AssetId, type Deployment, type OpenSwapOrder, type OpenSwapTerms } from './types.js';
import type { AssetResolver } from './assets.js';
export async function assertNetwork(client: ccc.Client, deployment: Deployment): Promise<void> {
  if (client.addressPrefix !== (deployment.network === 'testnet' ? 'ckt' : 'ckb') || (await client.getHeaderByNumber(0))?.hash !== deployment.genesisHash) throw new Error('OpenSwap deployment/network mismatch');
}
/** Structural decode of an order cell: terms, offer asset and amount. Synchronous
 * and resolver-free; `parse` adds asset support and payment feasibility. */
export function decodeOrder(cell: ccc.Cell, codeHash: ccc.Hex): OpenSwapTerms & { offerAsset: AssetId; offerAmount: bigint } {
  const { cellOutput: output, outputData: data } = cell;
  if (output.lock.codeHash !== codeHash || output.lock.hashType !== 'data1') throw new Error('Not an OpenSwap Data1 cell');
  const terms = decodeTerms(output.lock.args);
  if (terms.ownerLock.eq(output.lock)) throw new Error('Self-owner lock');
  const offerAsset = output.type ? udt(output.type) : CKB;
  let offerAmount: bigint;
  if (output.type) {
    offerAmount = parseAmount(data);
    if (terms.capacityRefund !== output.capacity) throw new Error('UDT refund mismatch');
  } else {
    if (data !== '0x') throw new Error('Native CKB data must be empty');
    const occupied = ccc.CellOutput.from({ lock: output.lock }, '0x').capacity;
    if (terms.capacityRefund < occupied || terms.capacityRefund >= output.capacity) throw new Error('Invalid CKB refund');
    offerAmount = output.capacity - terms.capacityRefund;
  }
  if (output.capacity > U64_MAX || offerAmount <= 0n || assetKey(offerAsset) === assetKey(terms.askAsset)) throw new Error('Invalid offer');
  return { ...terms, offerAsset, offerAmount };
}
export async function parse(cell: ccc.Cell, deployment: Deployment, resolver: AssetResolver): Promise<OpenSwapOrder> {
  const { cellOutput: output, outputData: data } = cell;
  const { offerAsset, offerAmount, ...terms } = decodeOrder(cell, deployment.codeHash);
  const offer = await resolver.identify(output.type, data);
  const ask = await resolver.identify(terms.askAsset.kind === 'udt' ? terms.askAsset.script : undefined);
  let supportReason = offer.reason ?? ask.reason;
  // Structurally valid orders can still have unspendable payment capacities.
  try { payment(terms); } catch (error) { supportReason = String(error); }
  return { ...terms, outPoint: cell.outPoint, lock: output.lock, cell, offerAsset, offerAmount, supported: offer.supported && ask.supported && !supportReason, supportReason, genesisHash: deployment.genesisHash };
}
export const comparePrice = (a: OpenSwapOrder, b: OpenSwapOrder): number => {
  if (assetKey(a.offerAsset) !== assetKey(b.offerAsset) || assetKey(a.askAsset) !== assetKey(b.askAsset)) throw new Error('Cannot compare different markets');
  const delta = a.askAmount * b.offerAmount - b.askAmount * a.offerAmount; return delta < 0n ? -1 : delta > 0n ? 1 : 0;
};
