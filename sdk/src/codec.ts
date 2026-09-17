import { ccc } from '@ckb-ccc/core';
import { CKB, udt, type OpenSwapTerms } from './types.js';
export const MAX_RUNNING_SCRIPT_BYTES = 4096;
export const MAX_OWNER_SCRIPT_BYTES = 1024;
export const MAX_ASK_SCRIPT_BYTES = 1024;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export class WireError extends Error {
  constructor(public readonly code: number, message: string) { super(message); this.name = 'WireError'; }
}
function fail(code: number, message: string): never { throw new WireError(code, message); }
export function uint(value: bigint, bits: number, label = 'amount'): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << BigInt(bits)) throw new RangeError(`${label} must fit u${bits}`);
  return value;
}
export function writeLE(value: bigint, size: number): Uint8Array {
  uint(value, size * 8);
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++, value >>= 8n) bytes[i] = Number(value & 255n);
  return bytes;
}
export function readLE(bytes: Uint8Array): bigint {
  let n = 0n; for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!); return n;
}
export function amountData(amount: bigint): ccc.Hex { return ccc.hexFrom(writeLE(amount, 16)); }
export function parseAmount(data: ccc.Hex): bigint {
  if (!/^0x[0-9a-fA-F]{32}$/.test(data)) throw new Error('Token data must be exactly 16 bytes');
  return readLE(ccc.bytesFrom(data));
}
function boundedArgs(input: Uint8Array | ccc.Hex): Uint8Array {
  const length = typeof input === 'string' ? (input.length - 2) / 2 : input.length;
  if (length + 53 > MAX_RUNNING_SCRIPT_BYTES) fail(20, 'Running script exceeds 4096 bytes');
  return typeof input === 'string' ? ccc.bytesFrom(input) : input;
}
function script(bytes: Uint8Array, code: number): ccc.Script {
  try {
    const parsed = ccc.Script.fromBytes(bytes);
    if (ccc.hexFrom(parsed.toBytes()) !== ccc.hexFrom(bytes)) fail(code, 'Noncanonical Script');
    return parsed;
  } catch { return fail(code, 'Invalid canonical Molecule Script'); }
}
export function decodeOwner(input: Uint8Array | ccc.Hex): { ownerLock: ccc.Script; end: number } {
  const bytes = boundedArgs(input);
  if (bytes.length < 4) fail(21, 'Args too short');
  const end = Number(readLE(bytes.subarray(0, 4)));
  if (end > MAX_OWNER_SCRIPT_BYTES) fail(22, 'Owner Script too large');
  if (end > bytes.length) fail(23, 'Owner Script truncated');
  return { ownerLock: script(bytes.subarray(0, end), 23), end };
}
export function decodeTerms(input: Uint8Array | ccc.Hex): OpenSwapTerms {
  const bytes = boundedArgs(input);
  const { ownerLock, end } = decodeOwner(bytes);
  const tail = bytes.subarray(end);
  if (tail.length < 48) fail(21, 'Tail too short');
  if (tail[0] !== 1) fail(27, 'Unsupported version');
  if (tail[1] !== 0) fail(28, 'Unsupported flags');
  if (tail[2] !== 0 || tail[3] !== 0) fail(29, 'Reserved bytes nonzero');
  const nonce = tail.slice(4, 20);
  if (nonce.every(n => n === 0)) fail(30, 'Zero nonce');
  const capacityRefund = readLE(tail.subarray(20, 28));
  const askSize = Number(readLE(tail.subarray(28, 32)));
  if (askSize > MAX_ASK_SCRIPT_BYTES) fail(24, 'Ask Script too large');
  if (tail.length !== 48 + askSize) fail(26, 'Incorrect args length');
  const askAsset = askSize === 0 ? CKB : udt(script(tail.subarray(32, 32 + askSize), 25));
  const askAmount = readLE(tail.subarray(32 + askSize));
  if (askAmount === 0n) fail(31, 'Zero ask amount');
  return { ownerLock, nonce, capacityRefund, askAsset, askAmount };
}
export function encodeTerms(terms: OpenSwapTerms): ccc.Hex {
  const owner = terms.ownerLock.toBytes();
  const ask = terms.askAsset.kind === 'ckb' ? new Uint8Array() : terms.askAsset.script.toBytes();
  if (owner.length > MAX_OWNER_SCRIPT_BYTES) fail(22, 'Owner Script too large');
  if (ask.length > MAX_ASK_SCRIPT_BYTES) fail(24, 'Ask Script too large');
  if (terms.nonce.length !== 16) throw new Error('Nonce must be 16 bytes');
  const bytes = new Uint8Array(owner.length + 48 + ask.length);
  bytes.set(owner); const tail = bytes.subarray(owner.length);
  tail[0] = 1; tail.set(terms.nonce, 4);
  tail.set(writeLE(terms.capacityRefund, 8), 20); tail.set(writeLE(BigInt(ask.length), 4), 28);
  tail.set(ask, 32); tail.set(writeLE(terms.askAmount, 16), 32 + ask.length);
  decodeTerms(bytes);
  return ccc.hexFrom(bytes);
}
