// Order lock v2 args (docs/research/ORDER_LOCK_V2.md). Mirrors
// contracts/openswap-lock-v2/src/args.rs, including error codes.
import { ccc } from '@ckb-ccc/core';
import { CKB, udt, type AssetId } from '../types.js';
import { MAX_ASK_SCRIPT_BYTES, MAX_OWNER_SCRIPT_BYTES, WireError, decodeOwner, readLE, writeLE } from '../codec.js';

export const V2_FIXED_TAIL = 88;
export const SINCE_FLAGS = 0xff00_0000_0000_0000n;
export const SINCE_ABSOLUTE_TIMESTAMP = 0x4000_0000_0000_0000n;
export const SINCE_VALUE = (1n << 56n) - 1n;

export interface OpenSwapTermsV2 {
  ownerLock: ccc.Script;
  nonce: Uint8Array;
  /** CKB offer: capacity of each UDT payment cell. UDT offer: must be 0. */
  capacityRefund: bigint;
  /** 0n for none, else an absolute timestamp `since` (see expiryAt). */
  expiry: bigint;
  askAsset: AssetId;
  /** Price is askAmount / offerAmount; a full fill of offerAmount pays askAmount. */
  askAmount: bigint;
  offerAmount: bigint;
  /** Smallest partial fill and smallest remainder; offerAmount = full fills only. */
  minFill: bigint;
}

function fail(code: number, message: string): never { throw new WireError(code, message); }

/** Absolute timestamp `since` for a unix time in seconds. */
export function expiryAt(unixSeconds: bigint): bigint {
  if (unixSeconds <= 0n || unixSeconds > SINCE_VALUE) throw new RangeError('Expiry time out of range');
  return SINCE_ABSOLUTE_TIMESTAMP | unixSeconds;
}
export function expirySeconds(expiry: bigint): bigint | undefined {
  return expiry === 0n ? undefined : expiry & SINCE_VALUE;
}
export function validExpiry(expiry: bigint): boolean {
  return expiry === 0n || ((expiry & SINCE_FLAGS) === SINCE_ABSOLUTE_TIMESTAMP && (expiry & SINCE_VALUE) !== 0n);
}

function script(bytes: Uint8Array, code: number): ccc.Script {
  try {
    const parsed = ccc.Script.fromBytes(bytes);
    if (ccc.hexFrom(parsed.toBytes()) !== ccc.hexFrom(bytes)) fail(code, 'Noncanonical Script');
    return parsed;
  } catch { return fail(code, 'Invalid canonical Molecule Script'); }
}

export function decodeTermsV2(input: Uint8Array | ccc.Hex): OpenSwapTermsV2 {
  const bytes = typeof input === 'string' ? ccc.bytesFrom(input) : input;
  const { ownerLock, end } = decodeOwner(bytes);
  const tail = bytes.subarray(end);
  if (tail.length < V2_FIXED_TAIL) fail(21, 'Tail too short');
  if (tail[0] !== 2) fail(27, 'Unsupported version');
  if (tail[1] !== 0) fail(28, 'Unsupported flags');
  if (tail[2] !== 0 || tail[3] !== 0) fail(29, 'Reserved bytes nonzero');
  const nonce = tail.slice(4, 20);
  if (nonce.every(n => n === 0)) fail(30, 'Zero nonce');
  const capacityRefund = readLE(tail.subarray(20, 28));
  const expiry = readLE(tail.subarray(28, 36));
  if (!validExpiry(expiry)) fail(37, 'Expiry must be 0 or an absolute timestamp since');
  const askSize = Number(readLE(tail.subarray(36, 40)));
  if (askSize > MAX_ASK_SCRIPT_BYTES) fail(24, 'Ask Script too large');
  if (tail.length !== V2_FIXED_TAIL + askSize) fail(26, 'Incorrect args length');
  const askAsset = askSize === 0 ? CKB : udt(script(tail.subarray(40, 40 + askSize), 25));
  const at = 40 + askSize;
  const askAmount = readLE(tail.subarray(at, at + 16));
  const offerAmount = readLE(tail.subarray(at + 16, at + 32));
  const minFill = readLE(tail.subarray(at + 32, at + 48));
  if (askAmount === 0n) fail(31, 'Zero ask amount');
  if (offerAmount === 0n) fail(35, 'Zero offer amount');
  if (minFill === 0n || minFill > offerAmount) fail(36, 'Minimum fill must be 1..offer amount');
  return { ownerLock, nonce, capacityRefund, expiry, askAsset, askAmount, offerAmount, minFill };
}

export function encodeTermsV2(terms: OpenSwapTermsV2): ccc.Hex {
  const owner = terms.ownerLock.toBytes();
  const ask = terms.askAsset.kind === 'ckb' ? new Uint8Array() : terms.askAsset.script.toBytes();
  if (owner.length > MAX_OWNER_SCRIPT_BYTES) fail(22, 'Owner Script too large');
  if (ask.length > MAX_ASK_SCRIPT_BYTES) fail(24, 'Ask Script too large');
  if (terms.nonce.length !== 16) throw new Error('Nonce must be 16 bytes');
  const bytes = new Uint8Array(owner.length + V2_FIXED_TAIL + ask.length);
  bytes.set(owner); const tail = bytes.subarray(owner.length);
  tail[0] = 2; tail.set(terms.nonce, 4);
  tail.set(writeLE(terms.capacityRefund, 8), 20); tail.set(writeLE(terms.expiry, 8), 28);
  tail.set(writeLE(BigInt(ask.length), 4), 36); tail.set(ask, 40);
  const at = 40 + ask.length;
  tail.set(writeLE(terms.askAmount, 16), at); tail.set(writeLE(terms.offerAmount, 16), at + 16);
  tail.set(writeLE(terms.minFill, 16), at + 32);
  decodeTermsV2(bytes);
  return ccc.hexFrom(bytes);
}
