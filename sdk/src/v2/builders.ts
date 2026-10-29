// v2 transaction builders. Same safety pattern as v1 (sdk/src/tx/builders.ts):
// fresh live inputs, pinned maker outputs, bounded fee, layout rechecked at submit.
import { ccc } from '@ckb-ccc/core';
import { defaultResolver } from '../assets.js';
import { payment } from '../capacity.js';
import { assertNetwork, parse } from '../orders.js';
import { nonces } from '../lots.js';
import { cancelOrders, distinct, finish, pin, type BuildContext, type BuiltTransaction } from '../tx/builders.js';
import type { AssetId, Deployment, OpenSwapOrder } from '../types.js';
import { decodeTermsV2 } from './codec.js';
import { isExpired, parseV2, planCreateV2, planFillV2, type CreateLotV2, type OpenSwapOrderV2, type PlannedFill } from './orders.js';

export async function createOrdersV2(context: BuildContext, request: { offerAsset: AssetId; askAsset: AssetId; expiry: bigint; lots: CreateLotV2[] }): Promise<BuiltTransaction & { lots: ReturnType<typeof planCreateV2>[] }> {
  await assertNetwork(context.signer.client, context.deployment);
  if (request.lots.length < 1 || request.lots.length > 32) throw new Error('Create 1..32 lots per transaction');
  const ownerLock = (await context.signer.getRecommendedAddressObj()).script;
  const resolver = context.resolver ?? defaultResolver(context.signer.client);
  for (const asset of [request.offerAsset, request.askAsset]) {
    if (!(await resolver.identify(asset.kind === 'udt' ? asset.script : undefined)).supported) throw new Error('Unsupported asset');
  }
  const ns = nonces(request.lots.length);
  const lots = request.lots.map((lot, i) => planCreateV2(context.deployment, { ownerLock, nonce: ns[i]!, askAsset: request.askAsset, expiry: request.expiry }, request.offerAsset, lot));
  const tx = ccc.Transaction.from({});
  for (const lot of lots) tx.addOutput(lot.cell);
  const built = await finish(tx, context, pin(tx, 0, lots.length));
  return { ...built, lots };
}

export interface FillRequest { outPoint: ccc.OutPointLike; /** Offer units to take; omit for the whole order. */ take?: bigint }
export type AnyOrder = OpenSwapOrder | OpenSwapOrderV2;
export const isV2 = (o: AnyOrder): o is OpenSwapOrderV2 => (o as OpenSwapOrderV2).version === 2;

/**
 * Fill v2 orders (whole or partial) and, optionally, whole v1 lots in one
 * transaction. Payments sit at each order's input index; v2 remainders follow.
 * Honest-solver policy: expired v2 orders are refused unless allowExpired.
 */
export async function fillOrdersV2(context: BuildContext, fills: FillRequest[], options: { v1?: Deployment; nowSeconds: bigint; allowExpired?: boolean }): Promise<BuiltTransaction & { orders: AnyOrder[]; plans: (PlannedFill | undefined)[] }> {
  const client = context.signer.client;
  await assertNetwork(client, context.deployment);
  if (options.v1 && options.v1.genesisHash !== context.deployment.genesisHash) throw new Error('v1 and v2 deployments are on different networks');
  const cells = await Promise.all(fills.map(f => client.getCellLive(f.outPoint, true)));
  if (cells.some(c => !c)) throw new Error('Order input is no longer live');
  const live = cells as ccc.Cell[];
  distinct(live);
  const resolver = context.resolver ?? defaultResolver(client);
  const orders: AnyOrder[] = [], plans: (PlannedFill | undefined)[] = [];
  const tx = ccc.Transaction.from({ inputs: live, cellDeps: [context.deployment.cellDep] });
  let usesV1 = false;
  for (const [i, cell] of live.entries()) {
    const lock = cell.cellOutput.lock;
    if (lock.hashType === 'data1' && lock.codeHash === context.deployment.codeHash) {
      const order = await parseV2(cell, context.deployment, resolver);
      if (isExpired(order, options.nowSeconds) && !options.allowExpired) throw new Error('Order has expired; it may only be returned');
      const plan = planFillV2(order, fills[i]!.take ?? order.available);
      orders.push(order); plans.push(plan); tx.addOutput(plan.payment);
    } else if (options.v1 && lock.hashType === 'data1' && lock.codeHash === options.v1.codeHash) {
      if (fills[i]!.take !== undefined) throw new Error('v1 lots fill whole only');
      const order = await parse(cell, options.v1, resolver);
      if (!order.supported) throw new Error('Unsupported or unfillable order');
      orders.push(order); plans.push(undefined); tx.addOutput(payment(order)); usesV1 = true;
    } else throw new Error('Not an OpenSwap order');
  }
  if (usesV1) tx.addCellDeps(options.v1!.cellDep);
  const remainders = plans.filter((p): p is PlannedFill => !!p?.remainder);
  for (const p of remainders) tx.addOutput(p.remainder!);
  const check = pin(tx, live.length, live.length + remainders.length);
  const lockHashes = new Set(live.map(c => c.cellOutput.lock.hash()));
  const built = await finish(tx, context, candidate => {
    check(candidate);
    const recreated = candidate.outputs.filter(o => lockHashes.has(o.lock.hash())).length;
    if (recreated !== remainders.length) throw new Error('Order recreated outside the planned remainders');
  });
  return { ...built, orders, plans };
}

/**
 * Return expired v2 orders to their owners, unchanged, without their signature.
 * Each order input carries `since` = its expiry, so the node only accepts the
 * transaction once the chain's median time has passed it. The signer pays the fee.
 */
export async function returnExpiredV2(context: BuildContext, points: ccc.OutPointLike[], nowSeconds: bigint): Promise<BuiltTransaction> {
  const client = context.signer.client;
  await assertNetwork(client, context.deployment);
  const cells = await Promise.all(points.map(p => client.getCellLive(p, true)));
  if (cells.some(c => !c)) throw new Error('Order input is no longer live');
  const live = cells as ccc.Cell[];
  distinct(live);
  const tx = ccc.Transaction.from({ cellDeps: [context.deployment.cellDep] });
  const resolver = context.resolver ?? defaultResolver(client);
  for (const cell of live) {
    const lock = cell.cellOutput.lock;
    if (lock.codeHash !== context.deployment.codeHash || lock.hashType !== 'data1') throw new Error('Not an OpenSwap v2 order');
    const terms = decodeTermsV2(lock.args);
    if (!isExpired(terms, nowSeconds)) throw new Error('Order has not expired');
    tx.inputs.push(ccc.CellInput.from({ previousOutput: cell.outPoint, since: terms.expiry, cellOutput: cell.cellOutput, outputData: cell.outputData }));
    tx.addOutput({ cellOutput: { lock: terms.ownerLock, type: cell.cellOutput.type, capacity: cell.cellOutput.capacity }, outputData: cell.outputData });
    if (cell.cellOutput.type) await tx.addCellDepInfos(client, ...(await resolver.resolveCellDeps(cell.cellOutput.type)));
  }
  const check = pin(tx, live.length, live.length);
  const lockHashes = new Set(live.map(c => c.cellOutput.lock.hash()));
  return finish(tx, context, candidate => {
    check(candidate);
    if (candidate.outputs.some(o => lockHashes.has(o.lock.hash()))) throw new Error('Order recreated');
  });
}

/** Owner cancellation is identical to v1 (recovery output plus owner proof);
 * pass a context whose deployment is the v2 lock. */
export const cancelOrdersV2 = cancelOrders;
