import { ccc } from '@ckb-ccc/core';
import { type AssetResolver, defaultResolver } from '../assets.js';
import { estimateCapacity, payment } from '../capacity.js';
import { amountData, decodeOwner, parseAmount, U128_MAX, U64_MAX } from '../codec.js';
import { nonces } from '../lots.js';
import { assertNetwork, parse } from '../orders.js';
import { type AssetId, type Deployment, type OpenSwapOrder, assetKey } from '../types.js';

export interface BuildContext { signer: ccc.Signer; deployment: Deployment; resolver?: AssetResolver; maxFee?: bigint }
export interface BuiltTransaction {
  tx: ccc.Transaction;
  deployment: Deployment;
  assertLayout(tx?: ccc.Transaction): void;
}
function key(point: ccc.OutPoint): string { return `${point.txHash}:${point.index}`; }
function distinct(cells: ccc.Cell[]): void {
  if (!cells.length || cells.length > 32) throw new Error('Select 1..32 independent lots');
  if (new Set(cells.map(c => key(c.outPoint))).size !== cells.length || new Set(cells.map(c => c.cellOutput.lock.hash())).size !== cells.length) throw new Error('Duplicate OutPoint or OpenSwap lock group');
}
export function pin(tx: ccc.Transaction, inputs: number, outputs: number): (candidate: ccc.Transaction) => void {
  const ins = tx.inputs.slice(0, inputs).map(i => ccc.hexFrom(i.toBytes()));
  const outs = tx.outputs.slice(0, outputs).map((o, i) => [ccc.hexFrom(o.toBytes()), tx.outputsData[i]]);
  return candidate => {
    if (candidate.inputs.length < inputs || candidate.outputs.length < outputs) throw new Error('Pinned prefix removed');
    ins.forEach((v, i) => { if (ccc.hexFrom(candidate.inputs[i]!.toBytes()) !== v) throw new Error('Pinned input reordered or changed'); });
    outs.forEach(([v, data], i) => { if (ccc.hexFrom(candidate.outputs[i]!.toBytes()) !== v || candidate.outputsData[i] !== data) throw new Error('Pinned maker output reordered or changed'); });
  };
}
async function fresh(context: BuildContext, points: ccc.OutPointLike[]): Promise<ccc.Cell[]> {
  await assertNetwork(context.signer.client, context.deployment);
  const cells = await Promise.all(points.map(p => context.signer.client.getCellLive(p, true)));
  if (cells.some(c => !c)) throw new Error('Order input is no longer live');
  const live = cells as ccc.Cell[];
  if (live.some(c => c.cellOutput.lock.codeHash !== context.deployment.codeHash || c.cellOutput.lock.hashType !== 'data1')) throw new Error('Not an OpenSwap order');
  distinct(live); return live;
}
async function tokens(tx: ccc.Transaction, context: BuildContext): Promise<void> {
  const resolver = context.resolver ?? defaultResolver(context.signer.client);
  const assets = new Map<string, ccc.Script>();
  const cells = await Promise.all(tx.inputs.map(i => i.getCell(context.signer.client)));
  for (const c of cells) if (c.cellOutput.type) assets.set(c.cellOutput.type.hash(), c.cellOutput.type);
  for (const c of tx.outputs) if (c.type) assets.set(c.type.hash(), c.type);
  const changeLock = (await context.signer.getRecommendedAddressObj()).script;
  for (const type of assets.values()) {
    await tx.addCellDepInfos(context.signer.client, ...(await resolver.resolveCellDeps(type)));
    let balance = 0n;
    for (const cell of cells) if (cell.cellOutput.type?.eq(type)) {
      if (!await resolver.supports(type, cell.outputData)) throw new Error('Unsupported token input');
      balance += parseAmount(cell.outputData);
    }
    let required = 0n;
    tx.outputs.forEach((o, i) => { if (o.type?.eq(type)) required += parseAmount(tx.outputsData[i]!); });
    if (required > U128_MAX || balance > U128_MAX) throw new Error('Token aggregate exceeds canonical xUDT u128 sum');
    if (balance < required) {
      // CCC's generic UDT helper permits extended data. v0.1 requires exactly 16 bytes.
      await tx.completeInputs(context.signer, { script: type, scriptLenRange: [type.occupiedSize, type.occupiedSize + 1], outputDataLenRange: [16, 17] }, async (_acc, cell) => {
        if (!cell.cellOutput.type?.eq(type) || !await resolver.supports(type, cell.outputData)) throw new Error('Funding asset mismatch');
        balance += parseAmount(cell.outputData);
        if (balance > U128_MAX) throw new Error('Token aggregate overflow');
        return balance >= required ? undefined : balance;
      }, balance);
      if (balance < required) throw new Error('Insufficient token funding');
    }
    const surplus = balance - required;
    if (surplus > 0n) tx.addOutput({ lock: changeLock, type }, amountData(surplus));
  }
}
async function finish(tx: ccc.Transaction, context: BuildContext, check: (tx: ccc.Transaction) => void, feeOutput?: number): Promise<BuiltTransaction> {
  if (feeOutput === undefined) await tokens(tx, context);
  check(tx);
  await tx.completeInputsByCapacity(context.signer); check(tx);
  if (feeOutput === undefined) await tx.completeFeeBy(context.signer);
  else await tx.completeFeeChangeToOutput(context.signer, feeOutput);
  check(tx);
  const fee = await tx.getFee(context.signer.client);
  if (fee < 0n || fee > (context.maxFee ?? 100_000_000n)) throw new Error('Transaction fee exceeds configured maximum');
  if (new Set(tx.inputs.map(i => key(i.previousOutput))).size !== tx.inputs.length) throw new Error('Duplicate funding input');
  for (let i = 0; i < tx.outputs.length; i++) {
    const output = tx.outputs[i]!;
    const minimum = ccc.CellOutput.from({ lock: output.lock, type: output.type }, tx.outputsData[i]!).capacity;
    if (output.capacity < minimum || output.capacity > U64_MAX) throw new Error('Output capacity invalid');
  }
  const expected = tx.hash();
  return { tx, deployment: context.deployment, assertLayout(candidate = tx) { check(candidate); if (candidate.hash() !== expected) throw new Error('Completed transaction changed; rebuild before signing'); } };
}
export async function createOrder(context: BuildContext, request: { offerAsset: AssetId; askAsset: AssetId; lots: { offerAmount: bigint; askAmount: bigint }[] }): Promise<BuiltTransaction> {
  await assertNetwork(context.signer.client, context.deployment);
  if (request.lots.length < 1 || request.lots.length > 32) throw new Error('Create 1..32 lots per transaction');
  const ownerLock = (await context.signer.getRecommendedAddressObj()).script;
  const resolver = context.resolver ?? defaultResolver(context.signer.client);
  for (const asset of [request.offerAsset, request.askAsset]) {
    if (!(await resolver.identify(asset.kind === 'udt' ? asset.script : undefined)).supported) throw new Error('Unsupported asset');
  }
  const tx = ccc.Transaction.from({}); const ns = nonces(request.lots.length);
  request.lots.forEach((lot, i) => tx.addOutput(estimateCapacity(context.deployment, { ownerLock, nonce: ns[i]!, askAsset: request.askAsset, askAmount: lot.askAmount }, request.offerAsset, lot.offerAmount).cell));
  return finish(tx, context, pin(tx, 0, request.lots.length));
}
export async function fillOrders(context: BuildContext, points: ccc.OutPointLike[]): Promise<BuiltTransaction> {
  const cells = await fresh(context, points);
  const resolver = context.resolver ?? defaultResolver(context.signer.client);
  const orders = await Promise.all(cells.map(c => parse(c, context.deployment, resolver)));
  if (orders.some(o => !o.supported)) throw new Error('Unsupported or unfillable order');
  const tx = ccc.Transaction.from({ inputs: cells, cellDeps: [context.deployment.cellDep] });
  orders.forEach(order => tx.addOutput(payment(order)));
  const check = pin(tx, cells.length, cells.length);
  const lockHashes = new Set(cells.map(c => c.cellOutput.lock.hash()));
  return finish(tx, context, candidate => {
    check(candidate);
    if (candidate.outputs.some(o => lockHashes.has(o.lock.hash()))) throw new Error('Order recreated');
  });
}
export async function cancelOrders(context: BuildContext, points: ccc.OutPointLike[], options: { compatibleOwner?: (script: ccc.Script) => Promise<boolean> } = {}): Promise<BuiltTransaction> {
  const cells = await fresh(context, points);
  const owner = decodeOwner(cells[0]!.cellOutput.lock.args).ownerLock;
  if (cells.some(c => !decodeOwner(c.cellOutput.lock.args).ownerLock.eq(owner))) throw new Error('Cancellation requires one owner per builder invocation');
  if (!(await context.signer.getAddressObjs()).some(a => a.script.eq(owner))) throw new Error('Signer does not control the order owner');
  const known = await Promise.all([ccc.KnownScript.JoyId, ccc.KnownScript.Secp256k1Blake160].map(k => context.signer.client.getKnownScript(k)));
  if (!known.some(k => owner.codeHash === k.codeHash && owner.hashType === k.hashType) && !await options.compatibleOwner?.(owner)) throw new Error('Owner cancellation compatibility must be explicitly established');
  const tx = ccc.Transaction.from({ inputs: cells, cellDeps: [context.deployment.cellDep] });
  for (const cell of cells) tx.addOutput({ cellOutput: { lock: owner, type: cell.cellOutput.type, capacity: cell.cellOutput.capacity }, outputData: cell.outputData });
  let proof: ccc.Cell | undefined;
  const minimum = ccc.CellOutput.from({ lock: owner }, '0x').capacity;
  for await (const cell of context.signer.findCells({ scriptLenRange: [0, 1], outputDataLenRange: [0, 1] }, true)) {
    if (cell.cellOutput.lock.eq(owner) && !cell.cellOutput.type && cell.outputData === '0x' && cell.cellOutput.capacity > minimum && !tx.inputs.some(i => i.previousOutput.eq(cell.outPoint))) { proof = cell; break; }
  }
  if (!proof) throw new Error('Cancellation needs a separate plain CKB owner cell with spare capacity');
  const resolver = context.resolver ?? defaultResolver(context.signer.client);
  for (const cell of cells) if (cell.cellOutput.type) await tx.addCellDepInfos(context.signer.client, ...(await resolver.resolveCellDeps(cell.cellOutput.type)));
  tx.addInput(proof); tx.addOutput({ lock: owner, capacity: minimum }, '0x');
  const proofCapacity = proof.cellOutput.capacity;
  const check = pin(tx, cells.length + 1, cells.length);
  return finish(tx, context, candidate => {
    check(candidate);
    const output = candidate.outputs[cells.length];
    if (!output || !output.lock.eq(owner) || output.type || candidate.outputsData[cells.length] !== '0x' || output.capacity >= proofCapacity) throw new Error('Owner proof must decrease at the same index');
  }, cells.length);
}
/** Sign only after rechecking the raw layout, network and every input's liveness. */
export async function submit(built: BuiltTransaction, signer: ccc.Signer): Promise<ccc.Hex> {
  await assertNetwork(signer.client, built.deployment);
  built.assertLayout();
  for (const input of built.tx.inputs) {
    const live = await signer.client.getCellLive(input.previousOutput, true);
    if (!live) throw new Error('Input spent: rebuild or requote');
    const expected = await input.getCell(signer.client);
    if (ccc.hexFrom(live.cellOutput.toBytes()) !== ccc.hexFrom(expected.cellOutput.toBytes()) || live.outputData !== expected.outputData) throw new Error('Funding data changed or indexer disagrees with live cell');
  }
  const prepared = await signer.prepareTransaction(built.tx.clone()); built.assertLayout(prepared);
  const rawHash = prepared.hash();
  const signed = await signer.signOnlyTransaction(prepared);
  built.assertLayout(signed);
  if (signed.hash() !== rawHash) throw new Error('Wallet modified transaction contents');
  return signer.client.sendTransaction(signed);
}
