// v2 orders: lock construction, decoding, creation sizing and fill planning.
// Every planned fill is checked against the reference model before use.
import { ccc } from '@ckb-ccc/core';
import type { AssetResolver } from '../assets.js';
import { amountData, parseAmount, U128_MAX, U64_MAX, uint } from '../codec.js';
import { assetKey, CKB, udt, type AssetId, type Deployment } from '../types.js';
import { decodeTermsV2, encodeTermsV2, expirySeconds, type OpenSwapTermsV2 } from './codec.js';
import { checkFill, requiredPayment, type ModelCell } from './model.js';

export interface OpenSwapOrderV2 extends OpenSwapTermsV2 {
  version: 2;
  outPoint: ccc.OutPoint;
  lock: ccc.Script;
  cell: ccc.Cell;
  offerAsset: AssetId;
  /** Offer still in the cell: token amount, or capacity minus capacityRefund for CKB. */
  available: bigint;
  supported: boolean;
  supportReason?: string;
  genesisHash: ccc.Hex;
}

export function orderLockV2(deployment: Deployment, terms: OpenSwapTermsV2): ccc.Script {
  if (deployment.hashType !== 'data1') throw new Error('OpenSwap requires Data1');
  return ccc.Script.from({ codeHash: deployment.codeHash, hashType: 'data1', args: encodeTermsV2(terms) });
}

const occupied = (lock: ccc.Script, type: ccc.Script | undefined, data: ccc.Hex) => ccc.CellOutput.from({ lock, type }, data).capacity;
/** A cell with exactly `capacity`. CCC raises a too-small capacity to the
 * occupied minimum, which would silently invent CKB; refuse that instead. */
function exactCell(lock: ccc.Script, type: ccc.Script | undefined, capacity: bigint, data: ccc.Hex, tooSmall: string): ccc.CellAny {
  if (capacity < 0n || capacity < occupied(lock, type, data)) throw new Error(tooSmall);
  const cell = ccc.CellAny.from({ cellOutput: { lock, type, capacity }, outputData: data });
  if (cell.cellOutput.capacity !== capacity) throw new Error('Cell capacity changed during construction');
  return cell;
}
/** Minimum capacity of the maker's payment cell for one fill. */
export function paymentMinimum(terms: Pick<OpenSwapTermsV2, 'ownerLock' | 'askAsset'>): bigint {
  return terms.askAsset.kind === 'udt' ? occupied(terms.ownerLock, terms.askAsset.script, amountData(0n)) : occupied(terms.ownerLock, undefined, '0x');
}

/** Structural decode, mirroring the lock's fill-path preconditions. */
export function decodeOrderV2(cell: ccc.Cell, codeHash: ccc.Hex): OpenSwapTermsV2 & { offerAsset: AssetId; available: bigint } {
  const { cellOutput: output, outputData: data } = cell;
  if (output.lock.codeHash !== codeHash || output.lock.hashType !== 'data1') throw new Error('Not an OpenSwap v2 Data1 cell');
  const terms = decodeTermsV2(output.lock.args);
  if (terms.ownerLock.eq(output.lock)) throw new Error('Self-owner lock');
  const offerAsset = output.type ? udt(output.type) : CKB;
  let available: bigint;
  if (output.type) {
    available = parseAmount(data);
    if (terms.capacityRefund !== 0n) throw new Error('UDT offer requires capacityRefund 0');
  } else {
    if (data !== '0x') throw new Error('Native CKB data must be empty');
    if (terms.capacityRefund >= output.capacity) throw new Error('No CKB left to offer');
    available = output.capacity - terms.capacityRefund;
  }
  if (available <= 0n || assetKey(offerAsset) === assetKey(terms.askAsset)) throw new Error('Invalid offer');
  return { ...terms, offerAsset, available };
}

export async function parseV2(cell: ccc.Cell, deployment: Deployment, resolver: AssetResolver): Promise<OpenSwapOrderV2> {
  const { offerAsset, available, ...terms } = decodeOrderV2(cell, deployment.codeHash);
  const offer = await resolver.identify(cell.cellOutput.type, cell.outputData);
  const ask = await resolver.identify(terms.askAsset.kind === 'udt' ? terms.askAsset.script : undefined);
  let supportReason = offer.reason ?? ask.reason;
  if (!supportReason && terms.askAsset.kind === 'udt' && offerAsset.kind === 'ckb' && terms.capacityRefund < paymentMinimum(terms)) supportReason = 'Refund cannot fund the maker payment cell';
  return { ...terms, version: 2, outPoint: cell.outPoint, lock: cell.cellOutput.lock, cell, offerAsset, available, supported: !supportReason, supportReason, genesisHash: deployment.genesisHash };
}

/** True once the order may be returned (and should no longer be filled by honest solvers). */
export function isExpired(order: Pick<OpenSwapTermsV2, 'expiry'>, nowSeconds: bigint): boolean {
  const at = expirySeconds(order.expiry);
  return at !== undefined && nowSeconds >= at;
}

export interface CreateLotV2 { offerAmount: bigint; askAmount: bigint; minFill: bigint; partialFills: number }
/**
 * Capacity for a new v2 order. UDT offers carry capacity for `partialFills`
 * payment cells (no oversell is possible: the reserve is capacity, not offer).
 * CKB offers carry offer + one payment cell; each partial fill moves one
 * capacityRefund of the maker's own CKB into that fill's payment cell, so k
 * partial fills sell k × capacityRefund less CKB.
 */
export function planCreateV2(deployment: Deployment, base: { ownerLock: ccc.Script; nonce: Uint8Array; askAsset: AssetId; expiry: bigint }, offerAsset: AssetId, lot: CreateLotV2) {
  uint(lot.offerAmount, offerAsset.kind === 'ckb' ? 64 : 128); uint(lot.askAmount, 128); uint(lot.minFill, 128);
  if (lot.offerAmount === 0n || lot.askAmount === 0n || assetKey(offerAsset) === assetKey(base.askAsset)) throw new Error('Invalid offer or same-asset trade');
  if (!Number.isSafeInteger(lot.partialFills) || lot.partialFills < 0 || lot.partialFills > 64) throw new Error('Partial fills must be 0..64');
  const minFill = lot.partialFills === 0 ? lot.offerAmount : lot.minFill;
  if (minFill === 0n || minFill > lot.offerAmount) throw new Error('Minimum fill must be 1..offer amount');
  const type = offerAsset.kind === 'udt' ? offerAsset.script : undefined;
  const data = offerAsset.kind === 'udt' ? amountData(lot.offerAmount) : '0x';
  const pay = paymentMinimum({ ownerLock: base.ownerLock, askAsset: base.askAsset });
  const capacityRefund = offerAsset.kind === 'ckb' ? pay : 0n;
  const terms: OpenSwapTermsV2 = { ...base, capacityRefund, askAmount: lot.askAmount, offerAmount: lot.offerAmount, minFill };
  const lock = orderLockV2(deployment, terms);
  const orderMinimum = occupied(lock, type, data);
  let capacity: bigint;
  if (offerAsset.kind === 'ckb') capacity = lot.offerAmount + capacityRefund;
  else {
    // Each partial payment cell needs `pay`; CKB asks pay part of it themselves.
    const perFill = base.askAsset.kind === 'udt' ? pay : (pay > requiredPayment(terms, minFill) ? pay - requiredPayment(terms, minFill) : 0n);
    capacity = orderMinimum + BigInt(lot.partialFills) * perFill;
  }
  if (capacity < orderMinimum) throw new Error('Offer too small to hold the order cell');
  if (capacity > U64_MAX) throw new Error('Order capacity overflows u64');
  const cell = exactCell(lock, type, capacity, data, 'Offer too small to hold the order cell');
  return { terms, cell, capacity, orderMinimum, paymentMinimum: pay };
}

export interface PlannedFill {
  order: OpenSwapOrderV2;
  taken: bigint;
  paid: bigint;
  final: boolean;
  payment: ccc.CellAny;
  remainder?: ccc.CellAny;
}

function modelCell(cell: ccc.CellAny | ccc.Cell, labels: (s: ccc.Script) => string): ModelCell {
  const o = cell.cellOutput;
  return { lock: labels(o.lock), type: o.type ? o.type.hash() : null, capacity: o.capacity, data: ccc.bytesFrom(cell.outputData) };
}
/** Run one planned fill through the reference model; throws on any rejection. */
export function assertFillModel(plan: PlannedFill): void {
  const { order } = plan;
  const lockId = (s: ccc.Script) => s.hash();
  const outputs: ModelCell[] = [modelCell(plan.payment, lockId)];
  if (plan.remainder) outputs.push(modelCell(plan.remainder, lockId));
  const code = checkFill(
    { owner: order.ownerLock.hash(), capacityRefund: order.capacityRefund, ask: order.askAsset.kind === 'udt' ? order.askAsset.scriptHash : null, askAmount: order.askAmount, offerAmount: order.offerAmount, minFill: order.minFill },
    order.lock.hash(), modelCell(order.cell, lockId), 0, outputs);
  if (code !== 0) throw new Error(`Planned fill violates the v2 lock rules (code ${code})`);
}

/** Offer left in the remainder after a partial take. A CKB remainder keeps one
 * capacityRefund for its own final payment cell, so that CKB is not sold. */
export function leftAfter(order: Pick<OpenSwapOrderV2, 'offerAsset' | 'available' | 'capacityRefund'>, take: bigint): bigint {
  return order.available - take - (order.offerAsset.kind === 'ckb' ? order.capacityRefund : 0n);
}

/** Range of partial takes (excluding the final whole take), or undefined if none fits. */
export function partialRange(order: OpenSwapOrderV2): { min: bigint; max: bigint } | undefined {
  const min = order.minFill;
  let max = leftAfter(order, 0n) - order.minFill;
  // A CKB remainder's capacity shrinks with the take and must still hold the cell.
  if (order.offerAsset.kind === 'ckb') {
    const room = order.available - occupied(order.lock, undefined, '0x');
    if (room < max) max = room;
  }
  if (max < min) return undefined;
  for (const take of [min, max]) { try { planFillV2(order, take); } catch { return undefined; } }
  return { min, max };
}

/** Payment and remainder for taking `take` offer units (`take == available` is the final fill). */
export function planFillV2(order: OpenSwapOrderV2, take: bigint): PlannedFill {
  if (!order.supported) throw new Error(order.supportReason ?? 'Unsupported order');
  if (take <= 0n || take > order.available) throw new Error('Take must be 1..available');
  const final = take === order.available;
  if (!final && (take < order.minFill || leftAfter(order, take) < order.minFill)) throw new Error('Partial fill must take and leave at least the minimum fill');
  const paid = requiredPayment(order, take);
  if (paid > U128_MAX) throw new Error('Payment overflows u128');
  const cIn = order.cell.cellOutput.capacity, owner = order.ownerLock;
  const askType = order.askAsset.kind === 'udt' ? order.askAsset.script : undefined;
  const offerType = order.cell.cellOutput.type;
  const pay = paymentMinimum(order);
  const noRoom = 'Order has no capacity left for another partial fill; fill it completely';
  const lowPayment = 'Payment cell is below its minimum capacity';
  let payment: ccc.CellAny, remainder: ccc.CellAny | undefined;
  if (order.offerAsset.kind === 'ckb') {
    payment = exactCell(owner, askType, order.capacityRefund, amountData(paid), lowPayment);
    if (!final) remainder = exactCell(order.lock, undefined, cIn - take - order.capacityRefund, '0x', noRoom);
  } else {
    const rest = order.available - take;
    // Capacity leaving the order: everything on a final fill, else only what the payment cell needs.
    let leaving: bigint;
    if (final) leaving = cIn;
    else if (askType) leaving = pay;
    else leaving = pay > paid ? pay - paid : 0n;
    if (!askType && paid + leaving > U64_MAX) throw new Error('CKB payment overflows u64');
    payment = askType
      ? exactCell(owner, askType, leaving, amountData(paid), lowPayment)
      : exactCell(owner, undefined, leaving + paid, '0x', lowPayment);
    if (!final) remainder = exactCell(order.lock, offerType, cIn - leaving, amountData(rest), noRoom);
  }
  const plan: PlannedFill = { order, taken: take, paid, final, payment, remainder };
  assertFillModel(plan);
  return plan;
}
