import { ccc } from '@ckb-ccc/core';
import { amountData, readLE } from './codec.js';

// Testnet token faucet. A dedicated faucet wallet (secp256k1) holds stock cells of each
// test token. A claim is one transaction the claimant builds and signs first: it moves
// each granted amount from a stock cell to the claimant, returns the rest of the stock
// cell to the faucet with the same capacity, and the claimant's own CKB pays the new
// cells' capacity and the fee. The faucet signs only after checkFaucetClaim accepts it,
// so the faucet never pays CKB and gives away only the configured grants.

export interface FaucetGrant { symbol: string; decimals: number; token: ccc.Script; amount: bigint }
export interface FaucetConfig { lock: ccc.Script; grants: FaucetGrant[]; /** Highest network fee a claim may pay, in shannons. */ maxFee: bigint }
/** Bytes of a secp256k1 signature; the faucet's witness placeholder. */
export const FAUCET_SIGNATURE_BYTES = 65;

/** deployments/faucet.json (served to the app as faucet-manifest.json). */
export function faucetConfigFrom(json: { lock: ccc.ScriptLike; maxFee: string | number; grants: { symbol: string; decimals: number; token: ccc.ScriptLike; amount: string | number }[] }): FaucetConfig {
  const lock = ccc.Script.from(json.lock);
  const grants = json.grants.map(g => ({ symbol: g.symbol, decimals: g.decimals, token: ccc.Script.from(g.token), amount: BigInt(g.amount) }));
  if (!grants.length || grants.some(g => g.amount <= 0n)) throw new Error('Faucet grants must be positive');
  if (new Set(grants.map(g => g.token.hash())).size !== grants.length) throw new Error('Faucet grants repeat a token');
  return { lock, grants, maxFee: BigInt(json.maxFee) };
}

const tokenAmount = (data: ccc.HexLike) => {
  const bytes = ccc.bytesFrom(data);
  if (bytes.length !== 16) throw new Error('Faucet token cells hold a plain 16-byte amount');
  return readLE(bytes);
};

export interface FaucetClaim { claimant: ccc.Script; granted: FaucetGrant[]; fee: bigint }

/**
 * Accepts a claim only if the faucet loses exactly one grant of each token it gives,
 * no CKB, and nothing else. `inputs` are the transaction's resolved input cells in
 * order. `balances` returns the claimant's current balance of a token (by type hash):
 * a grant is refused once the claimant already holds that much.
 */
export function checkFaucetClaim(tx: ccc.Transaction, inputs: ccc.CellLike[], config: FaucetConfig, balances: (typeHash: ccc.Hex) => bigint): FaucetClaim {
  if (inputs.length !== tx.inputs.length) throw new Error('Every input must be resolved');
  const cells = inputs.map(c => ccc.Cell.from(c));
  const outputs = tx.outputs.map((o, i) => ({ lock: o.lock, type: o.type, capacity: o.capacity, data: tx.outputsData[i] ?? '0x' }));
  const grants = new Map(config.grants.map(g => [g.token.hash(), g]));
  const isFaucet = (lock: ccc.Script) => lock.eq(config.lock);
  const faucetIn = cells.filter(c => isFaucet(c.cellOutput.lock)), faucetOut = outputs.filter(o => isFaucet(o.lock));
  const otherIn = cells.filter(c => !isFaucet(c.cellOutput.lock)), otherOut = outputs.filter(o => !isFaucet(o.lock));
  if (!faucetIn.length) throw new Error('The claim spends no faucet stock');
  if (!otherIn.length) throw new Error('The claimant must fund the claim');
  const claimant = otherIn[0]!.cellOutput.lock;
  if (otherIn.some(c => !c.cellOutput.lock.eq(claimant) || c.cellOutput.type)) throw new Error('Claimant inputs must be plain CKB cells of one lock');
  if (otherOut.some(o => !o.lock.eq(claimant))) throw new Error('Every output goes to the faucet or the claimant');
  if (faucetOut.length > faucetIn.length) throw new Error('A claim may not split faucet stock');

  const grantOf = (type: ccc.Script | undefined) => {
    const grant = type && grants.get(type.hash());
    if (!grant) throw new Error('Faucet cells hold only the configured test tokens');
    return grant;
  };
  const sum = (rows: { type?: ccc.Script; data: ccc.HexLike }[], hash: ccc.Hex) => rows.reduce((s, r) => s + (r.type?.hash() === hash ? tokenAmount(r.data) : 0n), 0n);
  const inRows = faucetIn.map(c => ({ type: c.cellOutput.type, data: c.outputData }));
  for (const row of [...inRows, ...faucetOut]) grantOf(row.type);
  for (const o of otherOut) if (o.type) grantOf(o.type);
  const capacityIn = faucetIn.reduce((s, c) => s + c.cellOutput.capacity, 0n), capacityOut = faucetOut.reduce((s, o) => s + o.capacity, 0n);
  if (capacityOut < capacityIn) throw new Error('The faucet pays no CKB: return every stock cell\'s capacity');

  const granted: FaucetGrant[] = [];
  for (const [hash, grant] of grants) {
    const given = sum(inRows, hash) - sum(faucetOut, hash);
    if (given === 0n) continue;
    if (given !== grant.amount) throw new Error(`A claim gives exactly ${grant.amount} base units of ${grant.symbol}`);
    if (balances(hash) >= grant.amount) throw new Error(`This account already holds at least one claim of ${grant.symbol}`);
    granted.push(grant);
  }
  if (!granted.length) throw new Error('The claim gives no tokens');
  const fee = cells.reduce((s, c) => s + c.cellOutput.capacity, 0n) - outputs.reduce((s, o) => s + o.capacity, 0n);
  if (fee <= 0n || fee > config.maxFee) throw new Error(`Claim fee must be positive and at most ${config.maxFee} shannons`);
  return { claimant, granted, fee };
}

/** Sum of a lock's live cells of a token. */
export async function tokenBalanceOf(client: ccc.Client, lock: ccc.Script, token: ccc.Script): Promise<bigint> {
  let total = 0n;
  for await (const cell of client.findCellsByLock(lock, token, true)) total += readLE(ccc.bytesFrom(cell.outputData).slice(0, 16));
  return total;
}

/** The grants this lock may claim now. */
export async function eligibleGrants(client: ccc.Client, lock: ccc.Script, config: FaucetConfig): Promise<FaucetGrant[]> {
  const balances = await Promise.all(config.grants.map(g => tokenBalanceOf(client, lock, g.token)));
  return config.grants.filter((g, i) => balances[i]! < g.amount);
}

/**
 * Builds an unsigned claim for `signer`: one stock cell per grant (chosen at random
 * among those that can cover it, so concurrent claims rarely collide), the faucet's
 * secp256k1 code dependency and signature placeholder, then the claimant's capacity
 * and fee. The claimant signs it; the faucet service checks and co-signs.
 */
export async function buildFaucetClaim(signer: ccc.Signer, config: FaucetConfig, grants: FaucetGrant[], xudtDep: ccc.CellDepLike, feeRate: bigint, random: () => number = Math.random): Promise<ccc.Transaction> {
  if (!grants.length) throw new Error('Nothing to claim');
  const client = signer.client, claimant = (await signer.getRecommendedAddressObj()).script;
  const tx = ccc.Transaction.from({ cellDeps: [xudtDep] });
  for (const grant of grants) {
    const stock: ccc.Cell[] = [];
    for await (const cell of client.findCellsByLock(config.lock, grant.token, true)) if (ccc.bytesFrom(cell.outputData).length === 16 && tokenAmount(cell.outputData) >= grant.amount) stock.push(cell);
    if (!stock.length) throw new Error(`The faucet is out of ${grant.symbol}`);
    const cell = stock[Math.floor(random() * stock.length)]!;
    tx.addInput(cell);
    tx.addOutput({ lock: config.lock, type: grant.token, capacity: cell.cellOutput.capacity }, amountData(tokenAmount(cell.outputData) - grant.amount));
    tx.addOutput({ lock: claimant, type: grant.token }, amountData(grant.amount));
  }
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.Secp256k1Blake160);
  tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({ lock: ccc.hexFrom(new Uint8Array(FAUCET_SIGNATURE_BYTES)) }));
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, feeRate);
  return tx;
}
