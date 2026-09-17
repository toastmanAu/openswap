import { ccc } from '@ckb-ccc/core';
import { amountData, encodeTerms, uint, U64_MAX } from './codec.js';
import { assetKey, type AssetId, type Deployment, type OpenSwapTerms } from './types.js';
export function orderLock(deployment: Deployment, terms: OpenSwapTerms): ccc.Script {
  if (deployment.hashType !== 'data1') throw new Error('OpenSwap requires Data1');
  return ccc.Script.from({ codeHash: deployment.codeHash, hashType: 'data1', args: encodeTerms(terms) });
}
export function payment(terms: OpenSwapTerms): ccc.CellAny {
  const token = terms.askAsset.kind === 'udt';
  const data = token ? amountData(terms.askAmount) : '0x';
  const capacity = token ? terms.capacityRefund : terms.capacityRefund + terms.askAmount;
  uint(capacity, 64, 'Payment capacity');
  const type = token && terms.askAsset.kind === 'udt' ? terms.askAsset.script : undefined;
  const min = ccc.CellOutput.from({ lock: terms.ownerLock, type }, data).capacity;
  if (capacity < min) throw new Error('Refund cannot fund the maker payment cell');
  return ccc.CellAny.from({ cellOutput: { lock: terms.ownerLock, type, capacity }, outputData: data });
}
export function estimateCapacity(deployment: Deployment, input: Omit<OpenSwapTerms, 'capacityRefund'>, offerAsset: AssetId, offerAmount: bigint) {
  uint(offerAmount, offerAsset.kind === 'ckb' ? 64 : 128);
  if (offerAmount === 0n || assetKey(offerAsset) === assetKey(input.askAsset)) throw new Error('Invalid offer or same-asset trade');
  const preliminary = { ...input, capacityRefund: 0n };
  const data = offerAsset.kind === 'ckb' ? '0x' : amountData(offerAmount);
  const type = offerAsset.kind === 'udt' ? offerAsset.script : undefined;
  const orderMinimum = ccc.CellOutput.from({ lock: orderLock(deployment, preliminary), type }, data).capacity;
  const paymentMinimum = ccc.CellOutput.from({ lock: input.ownerLock, type: input.askAsset.kind === 'udt' ? input.askAsset.script : undefined }, input.askAsset.kind === 'udt' ? amountData(input.askAmount) : '0x').capacity;
  const capacityRefund = input.askAsset.kind === 'udt' && paymentMinimum > orderMinimum ? paymentMinimum : orderMinimum;
  const terms: OpenSwapTerms = { ...input, capacityRefund };
  const capacity = capacityRefund + (offerAsset.kind === 'ckb' ? offerAmount : 0n);
  if (capacity > U64_MAX) throw new Error('Order capacity overflows u64');
  payment(terms);
  const cell = ccc.CellAny.from({ cellOutput: { lock: orderLock(deployment, terms), type, capacity }, outputData: data });
  return { terms, cell, orderMinimum, paymentMinimum, capacityRefund, capacity };
}
