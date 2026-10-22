// GENERATED OPENSWAP P6 POOL LIFECYCLE — TESTNET ONLY. Replace all Playground code with this file.

// <define:__POOL_ISSUER__>
var define_POOL_ISSUER_default = { lockHash: "0x4a98a2a518ca3269730c789c12b2e4ba9ff193decd8d92f480d52c00f91e87d6" };

// <define:__POOL_MANIFEST__>
var define_POOL_MANIFEST_default = { network: "testnet", genesisHash: "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606", codeHash: "0xc58432bfaf1cfaab12532bd4d9ce7e5a43196bd0c867a43b63f19096727a12ed", hashType: "data1", poolDep: { outPoint: { txHash: "0xfc8c182adf14387e29be1a4bdcba21d49f28a3c1d6ec37e14984969f31306f7d", index: 0 }, depType: "code" }, tokenDep: { outPoint: { txHash: "0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f", index: 0 }, depType: "code" }, binarySha256: "d3a6520f08859787e34b5497d0f0f4c893b81b96fe7aaa280e50584024f67829", binaryBytes: 42176, deployer: "ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq", joyIdProfile: { codeHash: "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac", hashType: "type", codeDeps: [{ dep: { outPoint: { txHash: "0x4a596d31dc35e88fb1591debbf680b04a44b4a434e3a94453c21ea8950ffb4d9", index: 0 }, depType: "code" }, dataHash: "0xd2c0f2f621a337007e046f0ed65f8fe29112c32a00ea1e43c2f8059fd42ca6d7" }, { dep: { outPoint: { txHash: "0x4a596d31dc35e88fb1591debbf680b04a44b4a434e3a94453c21ea8950ffb4d9", index: 1 }, depType: "code" }, dataHash: "0xb9a07a8f9b6c30e3a86351ad229882d79920d81b7f81967045445cbcf22ddbf2" }, { dep: { outPoint: { txHash: "0xf2c9dbfe7438a8c622558da8fa912d36755271ea469d3a25cb8d3373d35c8638", index: 1 }, depType: "code" }, dataHash: "0xb511b5400d7adc48c027b513e22d6ebd058519b2f128c9562b1e6a7ba36dfe84" }, { dep: { outPoint: { txHash: "0x95ecf9b41701b45d431657a67bbfa3f07ef7ceb53bf87097f3674e1a4a19ce62", index: 1 }, depType: "code" }, dataHash: "0xbe1a3fd8ce6b89f05c9016e2d507d34d424adc54733d3ccffba109b0db61d65b" }, { dep: { outPoint: { txHash: "0x8b3255491f3c4dcc1cfca33d5c6bcaec5409efe4bbda243900f9580c47e0242e", index: 1 }, depType: "code" }, dataHash: "0xa638f65f650bdac13bf91134ed7eec8feded1dac5e6add9e26cf658b2a693066" }] }, verifiedEndpoints: ["https://testnet.ckb.dev", "https://testnet.ckbapp.dev"], recordedAt: "2026-10-22T11:36:32.285Z" };

// scripts/pool-lifecycle.entry.ts
import { ccc as ccc12 } from "@ckb-ccc/ccc";
import { signer, client, render } from "@ckb-ccc/playground";

// pool-model/src/model.ts
var U64_MAX = (1n << 64n) - 1n;
var RESERVE_MAX = (1n << 112n) - 1n;
var SHARE_MAX = (1n << 128n) - 1n;
var U256_MAX = (1n << 256n) - 1n;
var FEE_DENOMINATOR = 10000n;
var ModelError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ModelError";
  }
  code;
};
function requireCondition(condition, code) {
  if (!condition) throw new ModelError(code);
}
function integer(value, min, max) {
  requireCondition(typeof value === "bigint", "INTEGER");
  requireCondition(value >= min && value <= max, "RANGE");
}
function add(a, b) {
  const value = a + b;
  requireCondition(value <= U256_MAX, "OVERFLOW");
  return value;
}
function mul(a, b) {
  const value = a * b;
  requireCondition(value <= U256_MAX, "OVERFLOW");
  return value;
}
function ceilDiv(a, b) {
  return a / b + (a % b === 0n ? 0n : 1n);
}
function sqrtFloor(n) {
  integer(n, 0n, U256_MAX);
  if (n < 2n) return n;
  let x = n, y = n / 2n + n % 2n;
  while (y < x) {
    x = y;
    y = add(x, n / x) / 2n;
  }
  return x;
}
function validateParameters(p) {
  integer(p.feeBps, 0n, FEE_DENOMINATOR - 1n);
  integer(p.lockedShares, 1n, SHARE_MAX);
  integer(p.backing.state, 1n, U64_MAX);
  integer(p.backing.ckb, 1n, U64_MAX - 1n);
  integer(p.backing.token, 1n, U64_MAX);
}
function maxCkbReserve(p) {
  validateParameters(p);
  return U64_MAX - p.backing.ckb;
}
function validateState(s) {
  validateParameters(s);
  integer(s.x, 1n, maxCkbReserve(s));
  integer(s.y, 1n, RESERVE_MAX);
  integer(s.totalShares, s.lockedShares, SHARE_MAX);
  requireCondition(mul(s.totalShares, s.totalShares) <= mul(s.x, s.y), "STATE");
}
function state(p, x, y, totalShares) {
  const next = { feeBps: p.feeBps, lockedShares: p.lockedShares, backing: { ...p.backing }, x, y, totalShares };
  validateState(next);
  return next;
}
function flows(values) {
  return { paidX: 0n, paidY: 0n, receivedX: 0n, receivedY: 0n, mintedShares: 0n, burnedShares: 0n, unusedX: 0n, unusedY: 0n, ...values };
}
function createPool(p, x, y, minShares) {
  validateParameters(p);
  integer(x, 1n, maxCkbReserve(p));
  integer(y, 1n, RESERVE_MAX);
  integer(minShares, 1n, SHARE_MAX);
  const totalShares = sqrtFloor(mul(x, y));
  requireCondition(totalShares > p.lockedShares, "SHARES");
  const mintedShares = totalShares - p.lockedShares;
  requireCondition(mintedShares >= minShares, "SLIPPAGE");
  return { next: state(p, x, y, totalShares), flows: flows({ paidX: x, paidY: y, mintedShares }) };
}
function swap(s, direction, amountIn, minOut) {
  validateState(s);
  requireCondition(direction === "xToY" || direction === "yToX", "OPERATION");
  const forward = direction === "xToY", input = forward ? s.x : s.y, output2 = forward ? s.y : s.x;
  integer(amountIn, 1n, forward ? maxCkbReserve(s) : RESERVE_MAX);
  integer(minOut, 1n, forward ? RESERVE_MAX : maxCkbReserve(s));
  const updatedInput = add(input, amountIn);
  requireCondition(updatedInput <= (forward ? maxCkbReserve(s) : RESERVE_MAX), "RANGE");
  const effective = mul(amountIn, FEE_DENOMINATOR - s.feeBps);
  const amountOut = mul(effective, output2) / add(mul(input, FEE_DENOMINATOR), effective);
  requireCondition(amountOut > 0n && amountOut < output2, "ZERO_OUTPUT");
  requireCondition(amountOut >= minOut, "SLIPPAGE");
  return {
    next: state(s, forward ? updatedInput : output2 - amountOut, forward ? output2 - amountOut : updatedInput, s.totalShares),
    flows: flows(forward ? { paidX: amountIn, receivedY: amountOut } : { paidY: amountIn, receivedX: amountOut })
  };
}
function deposit(s, maxX, maxY, minShares) {
  validateState(s);
  integer(maxX, 1n, maxCkbReserve(s));
  integer(maxY, 1n, RESERVE_MAX);
  integer(minShares, 1n, SHARE_MAX);
  const byX = mul(maxX, s.totalShares) / s.x, byY = mul(maxY, s.totalShares) / s.y;
  const mintedShares = byX < byY ? byX : byY;
  requireCondition(mintedShares > 0n, "SHARES");
  requireCondition(mintedShares >= minShares, "SLIPPAGE");
  const paidX = ceilDiv(mul(mintedShares, s.x), s.totalShares), paidY = ceilDiv(mul(mintedShares, s.y), s.totalShares);
  requireCondition(paidX <= maxX && paidY <= maxY, "STATE");
  return {
    next: state(s, add(s.x, paidX), add(s.y, paidY), add(s.totalShares, mintedShares)),
    flows: flows({ paidX, paidY, mintedShares, unusedX: maxX - paidX, unusedY: maxY - paidY })
  };
}
function withdraw(s, shares, minX, minY) {
  validateState(s);
  integer(shares, 1n, SHARE_MAX);
  integer(minX, 1n, maxCkbReserve(s));
  integer(minY, 1n, RESERVE_MAX);
  requireCondition(shares <= s.totalShares - s.lockedShares, "SHARES");
  const receivedX = mul(shares, s.x) / s.totalShares, receivedY = mul(shares, s.y) / s.totalShares;
  requireCondition(receivedX > 0n && receivedY > 0n, "ZERO_OUTPUT");
  requireCondition(receivedX >= minX && receivedY >= minY, "SLIPPAGE");
  return { next: state(s, s.x - receivedX, s.y - receivedY, s.totalShares - shares), flows: flows({ receivedX, receivedY, burnedShares: shares }) };
}
function transition(s, operation2) {
  switch (operation2.kind) {
    case "swap":
      return swap(s, operation2.direction, operation2.amountIn, operation2.minOut);
    case "deposit":
      return deposit(s, operation2.maxX, operation2.maxY, operation2.minShares);
    case "withdraw":
      return withdraw(s, operation2.shares, operation2.minX, operation2.minY);
    default:
      throw new ModelError("OPERATION");
  }
}

// pool-sdk/src/funding.ts
import { ccc as ccc5 } from "@ckb-ccc/ccc";

// sdk/src/codec.ts
import { ccc } from "@ckb-ccc/ccc";
var U64_MAX2 = (1n << 64n) - 1n;
var U128_MAX = (1n << 128n) - 1n;
function uint(value, bits, label = "amount") {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(bits)) throw new RangeError(`${label} must fit u${bits}`);
  return value;
}
function writeLE(value, size) {
  uint(value, size * 8);
  const bytes2 = new Uint8Array(size);
  for (let i = 0; i < size; i++, value >>= 8n) bytes2[i] = Number(value & 255n);
  return bytes2;
}
function readLE(bytes2) {
  let n = 0n;
  for (let i = bytes2.length - 1; i >= 0; i--) n = n << 8n | BigInt(bytes2[i]);
  return n;
}
function parseAmount(data) {
  if (!/^0x[0-9a-fA-F]{32}$/.test(data)) throw new Error("Token data must be exactly 16 bytes");
  return readLE(ccc.bytesFrom(data));
}

// pool-sdk/src/codec.ts
import { ccc as ccc2 } from "@ckb-ccc/ccc";
var XUDT_CODE_HASH = "0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95";
var U64 = (1n << 64n) - 1n;
var U128 = (1n << 128n) - 1n;
var Y_MAX = (1n << 112n) - 1n;
var PoolWireError = class extends Error {
  constructor(code) {
    super(`Pool wire error ${code}`);
    this.code = code;
    this.name = "PoolWireError";
  }
  code;
};
function check(ok, code) {
  if (!ok) throw new PoolWireError(code);
}
function bounded(input, max) {
  const size = typeof input === "string" ? (input.length - 2) / 2 : input.length;
  check(size <= max, 2);
  if (typeof input === "string") {
    check(/^0x(?:[0-9a-fA-F]{2})*$/.test(input), 3);
    return ccc2.bytesFrom(input);
  }
  return input;
}
function exact(input, size) {
  const b = bounded(input, size);
  check(b.length === size, 3);
  return b;
}
function header(b, magic) {
  check(b.length >= 6 && new TextDecoder().decode(b.subarray(0, 4)) === magic, 3);
  check(b[4] === 1, 4);
}
function range(n, lo, hi) {
  check(typeof n === "bigint" && n >= lo && n <= hi, 21);
}
function hash(h) {
  return exact(h, 32);
}
function decodeArgs(input) {
  const b = exact(input, 38);
  header(b, "TPL1");
  check(b[5] <= 4, 4);
  return { role: b[5], poolId: ccc2.hexFrom(b.subarray(6)) };
}
function encodeArgs(a) {
  check(Number.isInteger(a.role) && a.role >= 0 && a.role <= 4, 4);
  return ccc2.hexFrom(ccc2.bytesConcat(new TextEncoder().encode("TPL1"), [1, a.role], hash(a.poolId)));
}
function validateStateData(s) {
  range(s.fee, 0n, 9999n);
  range(s.locked, 1n, U128);
  range(s.shares, s.locked, U128);
  range(s.backingState, 1n, U64);
  range(s.backingCkb, 1n, U64 - 1n);
  range(s.backingToken, 1n, U64);
  range(s.rx, 0n, (1n << 32n) - 1n);
  range(s.ry, 0n, (1n << 32n) - 1n);
  check(s.rx < 256n && s.ry < 256n, 2);
  check(s.rx !== s.ry, 7);
  hash(s.tokenCodeHash);
  hash(s.tokenOwner);
}
function decodeState(input) {
  const b = exact(input, 190);
  header(b, "TPS1");
  check(b[5] === 0 && b[104] === 2, 4);
  check(b[105] === 32 && b.subarray(138).every((v) => v === 0), 3);
  const n = (at, size) => readLE(b.subarray(at, at + size));
  const s = {
    fee: n(6, 2),
    locked: n(8, 16),
    shares: n(24, 16),
    backingState: n(40, 8),
    backingCkb: n(48, 8),
    backingToken: n(56, 8),
    rx: n(64, 4),
    ry: n(68, 4),
    tokenCodeHash: ccc2.hexFrom(b.subarray(72, 104)),
    tokenOwner: ccc2.hexFrom(b.subarray(106, 138))
  };
  validateStateData(s);
  return s;
}
function encodeState(s) {
  validateStateData(s);
  const b = new Uint8Array(190);
  b.set(new TextEncoder().encode("TPS1"));
  b[4] = 1;
  for (const [at, n, size] of [
    [6, s.fee, 2],
    [8, s.locked, 16],
    [24, s.shares, 16],
    [40, s.backingState, 8],
    [48, s.backingCkb, 8],
    [56, s.backingToken, 8],
    [64, s.rx, 4],
    [68, s.ry, 4]
  ]) b.set(writeLE(n, size), at);
  b.set(hash(s.tokenCodeHash), 72);
  b[104] = 2;
  b[105] = 32;
  b.set(hash(s.tokenOwner), 106);
  return ccc2.hexFrom(b);
}
function actionFields(a) {
  switch (a.kind) {
    case "create":
      return { tag: 0, values: [a.minShares] };
    case "swap":
      check(a.direction === "xToY" || a.direction === "yToX", 4);
      return { tag: a.direction === "xToY" ? 1 : 2, values: [a.amountIn, a.minOut] };
    case "deposit":
      return { tag: 3, values: [a.maxX, a.maxY, a.minShares] };
    case "withdraw":
      return { tag: 4, values: [a.shares, a.minX, a.minY] };
    default:
      throw new PoolWireError(4);
  }
}
function validateAction(a) {
  const { tag, values } = actionFields(a);
  const limits = [[U128], [U64 - 1n, Y_MAX], [Y_MAX, U64 - 1n], [U64 - 1n, Y_MAX, U128], [U128, U64 - 1n, Y_MAX]][tag];
  values.forEach((v, i) => range(v, 1n, limits[i]));
}
function decodeAction(input) {
  const b = bounded(input, 56);
  header(b, "TPA1");
  const tag = b[5];
  check(tag <= 4, 4);
  const count = [1, 2, 2, 3, 3][tag];
  check(b.length === 8 + 16 * count, 3);
  check(b[6] === 0 && b[7] === 0, 3);
  const n = (at) => readLE(b.subarray(at, at + 16));
  const a = tag === 0 ? { kind: "create", minShares: n(8) } : tag <= 2 ? { kind: "swap", direction: tag === 1 ? "xToY" : "yToX", amountIn: n(8), minOut: n(24) } : tag === 3 ? { kind: "deposit", maxX: n(8), maxY: n(24), minShares: n(40) } : { kind: "withdraw", shares: n(8), minX: n(24), minY: n(40) };
  validateAction(a);
  return a;
}
function encodeAction(a) {
  validateAction(a);
  const { tag, values } = actionFields(a);
  return ccc2.hexFrom(ccc2.bytesConcat(new TextEncoder().encode("TPA1"), [1, tag, 0, 0], ...values.map((n) => writeLE(n, 16))));
}
function table3(input, max) {
  const b = bounded(input, max);
  check(b.length >= 16 && readLE(b.subarray(0, 4)) === BigInt(b.length), 3);
  const [a, c, d] = [4, 8, 12].map((i) => Number(readLE(b.subarray(i, i + 4))));
  check(a === 16 && a <= c && c <= d && d <= b.length, 3);
  return [b.subarray(a, c), b.subarray(c, d), b.subarray(d)];
}
function bytes(b) {
  check(b.length >= 4 && readLE(b.subarray(0, 4)) === BigInt(b.length - 4), 3);
  return b.subarray(4);
}
function poolScript(codeHash, poolId, role) {
  hash(codeHash);
  return ccc2.Script.from({ codeHash, hashType: "data1", args: encodeArgs({ role, poolId }) });
}
function decodeWitness(input, genesis) {
  const fields = table3(input, 4096).map((b) => b.length ? bytes(b) : void 0);
  const selected = fields[genesis ? 2 : 1];
  check(selected !== void 0, 3);
  const a = decodeAction(selected);
  check(genesis === (a.kind === "create"), 4);
  return a;
}

// pool-sdk/src/builders.ts
import { ccc as ccc4 } from "@ckb-ccc/ccc";

// pool-sdk/src/pools.ts
import { ccc as ccc3 } from "@ckb-ccc/ccc";
var PoolReadError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "PoolReadError";
  }
  code;
};
function requirePool(ok, message) {
  if (!ok) throw new PoolReadError("INVALID", message);
}
var pointKey = (p) => {
  const x = ccc3.OutPoint.from(p);
  return `${x.txHash}:${x.index}`;
};
function sameCell(a, b) {
  return a.outPoint.eq(b.outPoint) && a.cellOutput.eq(b.cellOutput) && a.outputData === b.outputData;
}
function minimumCapacity(cell) {
  return ccc3.CellOutput.from({ lock: cell.cellOutput.lock, type: cell.cellOutput.type }, cell.outputData).capacity;
}
function validateCell(cell) {
  requirePool(cell.cellOutput.lock.toBytes().length <= 512 && (!cell.cellOutput.type || cell.cellOutput.type.toBytes().length <= 512), "Script exceeds pool scan bound");
  requirePool(cell.cellOutput.capacity >= minimumCapacity(cell) && cell.cellOutput.capacity <= U64_MAX2, "Invalid occupied capacity");
}
function parsePool(deployment2, stateCell, ckbCell, tokenCell) {
  try {
    const type = stateCell.cellOutput.type;
    requirePool(type && type.codeHash === deployment2.codeHash && type.hashType === "data1", "Not the selected pool validator");
    const args = decodeArgs(type.args);
    requirePool(args.role === 0 /* StateType */, "Not a state type");
    const metadata = decodeState(stateCell.outputData);
    const roles = [0, 1, 2, 3, 4].map((role) => poolScript(deployment2.codeHash, args.poolId, role));
    requirePool(stateCell.outPoint.index < 256n && stateCell.outPoint.index !== metadata.rx && stateCell.outPoint.index !== metadata.ry, "Invalid state sibling index");
    requirePool(ckbCell.outPoint.eq({ txHash: stateCell.outPoint.txHash, index: metadata.rx }) && tokenCell.outPoint.eq({ txHash: stateCell.outPoint.txHash, index: metadata.ry }), "Reserve OutPoint mismatch");
    requirePool(metadata.tokenCodeHash === XUDT_CODE_HASH, "Unsupported prototype token profile");
    requirePool(!roles.slice(1, 4).some((s) => s.hash() === metadata.tokenOwner), "Pool custody cannot be the token issuer");
    const token = ccc3.Script.from({ codeHash: metadata.tokenCodeHash, hashType: "data1", args: metadata.tokenOwner });
    for (const c of [stateCell, ckbCell, tokenCell]) validateCell(c);
    requirePool(stateCell.cellOutput.lock.eq(roles[1]) && stateCell.cellOutput.capacity === metadata.backingState, "State lock/backing mismatch");
    requirePool(ckbCell.cellOutput.lock.eq(roles[2]) && !ckbCell.cellOutput.type && ckbCell.outputData === "0x", "CKB reserve shape mismatch");
    requirePool(metadata.backingCkb >= minimumCapacity(ckbCell), "CKB backing cannot borrow tradeable reserves");
    requirePool(tokenCell.cellOutput.lock.eq(roles[3]) && tokenCell.cellOutput.type?.eq(token) && tokenCell.cellOutput.capacity === metadata.backingToken, "Token reserve shape mismatch");
    const accounting = {
      feeBps: metadata.fee,
      lockedShares: metadata.locked,
      totalShares: metadata.shares,
      backing: { state: metadata.backingState, ckb: metadata.backingCkb, token: metadata.backingToken },
      x: ckbCell.cellOutput.capacity - metadata.backingCkb,
      y: parseAmount(tokenCell.outputData)
    };
    validateState(accounting);
    return { poolId: args.poolId, stateCell: stateCell.clone(), ckbCell: ckbCell.clone(), tokenCell: tokenCell.clone(), metadata, accounting, token, lp: roles[4] };
  } catch (e) {
    if (e instanceof PoolReadError) throw e;
    throw new PoolReadError("INVALID", `Malformed pool: ${String(e)}`);
  }
}
async function readBounded(read, options = {}) {
  const timeout = options.timeoutMs ?? 15e3;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 6e4) throw new Error("timeoutMs must be 1..60000");
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let finished = false;
    const abort = () => finish(() => reject(options.signal?.reason ?? new Error("Aborted")));
    const timer = setTimeout(() => finish(() => reject(new Error("Pool RPC deadline exceeded"))), timeout);
    const finish = (done) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      done();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (finished) return;
      return read();
    }).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}
async function assertPoolNetwork(client2, deployment2, options = {}) {
  if ((await readBounded(() => client2.getHeaderByNumberNoCache(0), options))?.hash !== deployment2.genesisHash) throw new PoolReadError("NETWORK", "Pool deployment/genesis mismatch");
}
async function withPoolDeadline(options, work) {
  const timeoutMs = options.timeoutMs ?? 15e3;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 6e4) throw new Error("Invalid pool operation deadline");
  options.signal?.throwIfAborted();
  const controller = new AbortController(), abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Pool operation deadline exceeded")), timeoutMs);
  const bounded2 = { signal: controller.signal, timeoutMs };
  try {
    return await readBounded(() => work(bounded2), bounded2);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
async function assertPoolDependencies(client2, deployment2, options = {}) {
  for (const [dependency, hash3] of [[deployment2.poolDep, deployment2.codeHash], [deployment2.tokenDep, XUDT_CODE_HASH]]) {
    const dep = ccc3.CellDep.from(dependency);
    requirePool(dep.depType === "code", "Pool/token dependency must be a direct code cell");
    const cell = await liveCell(client2, dep.outPoint, options);
    requirePool(ccc3.hashCkb(cell.outputData) === hash3, "Dependency data hash does not match selected validator");
  }
}
async function liveCell(client2, point, options = {}) {
  const expected = ccc3.OutPoint.from(point).clone();
  const value = await readBounded(() => client2.getCellLiveNoCache(expected.clone(), true, true), options);
  if (!value) throw new PoolReadError("STALE", `Input no longer live: ${pointKey(expected)}`);
  requirePool(value.outPoint.eq(expected), "Node returned a different OutPoint");
  requirePool(value.outputData.length <= 2 + 2 * 1024 * 1024, "Live cell data exceeds 1 MiB bound");
  validateCell(value);
  return value.clone();
}
async function loadPool(client2, deployment2, point, options = {}) {
  await assertPoolNetwork(client2, deployment2, options);
  const state2 = await liveCell(client2, point, options);
  let metadata;
  try {
    metadata = decodeState(state2.outputData);
  } catch (e) {
    throw new PoolReadError("INVALID", String(e));
  }
  const x = await liveCell(client2, { txHash: state2.outPoint.txHash, index: metadata.rx }, options);
  const y = await liveCell(client2, { txHash: state2.outPoint.txHash, index: metadata.ry }, options);
  const parsed = parsePool(deployment2, state2, x, y);
  if (!sameCell(state2, await liveCell(client2, point, options))) throw new PoolReadError("STALE", "Pool changed during discovery");
  return parsed;
}

// pool-sdk/src/builders.ts
var PoolBuildError = class extends Error {
  constructor(code, message) {
    super(`Pool build: ${message}`);
    this.code = code;
    this.name = "PoolBuildError";
  }
  code;
};
function requireBuild(ok, message, code = "INVALID") {
  if (!ok) throw new PoolBuildError(code, message);
}
var amount = (n) => ccc4.hexFrom(writeLE(n, 16));
var output = (lock, type, data = "0x", capacity) => ccc4.CellAny.from({ cellOutput: ccc4.CellOutput.from({ lock: ccc4.Script.from(lock).clone(), type: type ? ccc4.Script.from(type).clone() : void 0, capacity }, data), outputData: data });
function buildCreate(deployment2, wallet, recipients2, request) {
  requireBuild(wallet.funding.length > 0, "creation needs an explicit first funding input");
  const first = ccc4.CellInput.from(wallet.funding[0]);
  const stateIndex = wallet.witness?.kind === "joyid" ? 1n : 0n;
  const id = ccc4.hashCkb(ccc4.bytesConcat(first.toBytes(), writeLE(stateIndex, 8)));
  const result = createPool(request.parameters, request.x, request.y, request.minShares);
  const metadata = {
    fee: request.parameters.feeBps,
    locked: request.parameters.lockedShares,
    shares: result.next.totalShares,
    backingState: request.parameters.backing.state,
    backingCkb: request.parameters.backing.ckb,
    backingToken: request.parameters.backing.token,
    rx: stateIndex + 1n,
    ry: stateIndex + 2n,
    tokenCodeHash: XUDT_CODE_HASH,
    tokenOwner: request.tokenOwner
  };
  return build(deployment2, wallet, recipients2, id, metadata, { kind: "create", minShares: request.minShares }, result);
}
function buildTransition(deployment2, wallet, recipients2, pool, action) {
  const checked = parsePool(deployment2, pool.stateCell, pool.ckbCell, pool.tokenCell);
  const result = transition(checked.accounting, action);
  return build(deployment2, wallet, recipients2, checked.poolId, { ...checked.metadata, shares: result.next.totalShares, rx: 1n, ry: 2n }, action, result, checked);
}
function build(deployment2, wallet, recipients2, id, metadata, action, result, previous) {
  requireBuild(wallet.witness === void 0 || wallet.witness.kind === "joyid", "unsupported wallet witness profile");
  const joyid = wallet.witness?.kind === "joyid", signatureBytes = joyid ? 1e3 : 65;
  const stateOutputIndex = !previous && joyid ? 1 : 0;
  const proof = wallet.witness?.outputType;
  requireBuild(proof === void 0 || typeof proof === "string" && proof.length <= 6002 && /^0x(?:[0-9a-fA-F]{2})*$/.test(proof), "invalid or oversized wallet proof");
  requireBuild(wallet.funding.length > 0 && wallet.funding.length <= (previous ? 253 : 256), "funding count outside bounds");
  requireBuild(typeof wallet.feeRate === "bigint" && wallet.feeRate > 0n && typeof wallet.maxFee === "bigint" && wallet.maxFee > 0n, "positive fee rate and cap required");
  requireBuild(wallet.deps.length > 0 && wallet.deps.length <= 16, "explicit wallet dependencies required");
  const roles = [0, 1, 2, 3, 4].map((role) => poolScript(deployment2.codeHash, id, role));
  const token = ccc4.Script.from({ codeHash: XUDT_CODE_HASH, hashType: "data1", args: metadata.tokenOwner });
  const owner2 = ccc4.Script.from(wallet.lock), change = ccc4.Script.from(wallet.change);
  requireBuild(owner2.hash() !== metadata.tokenOwner, "xUDT issuer-mode funding is unsupported");
  for (const lock of [owner2, change, ...Object.values(recipients2).map((s) => ccc4.Script.from(s))]) {
    requireBuild(lock.toBytes().length <= 512, "recipient script too large");
    requireBuild(lock.codeHash !== deployment2.codeHash, "pool validator is not a wallet/recipient lock");
  }
  const inputs = [...previous ? [previous.stateCell, previous.ckbCell, previous.tokenCell] : [], ...wallet.funding].map((c) => c.clone());
  requireBuild(new Set(inputs.map((c) => pointKey(c.outPoint))).size === inputs.length, "duplicate input");
  let availableY = 0n, availableLp = 0n;
  for (const cell of wallet.funding) {
    validateCell(cell);
    requireBuild(cell.cellOutput.lock.eq(owner2), "mixed wallet signing groups");
    const type = cell.cellOutput.type;
    if (!type) requireBuild(cell.outputData === "0x", "plain funding must have empty data");
    else if (type.eq(token)) availableY += parseAmount(cell.outputData);
    else if (previous && type.eq(roles[4])) availableLp += parseAmount(cell.outputData);
    else throw new Error("Pool build: unsupported funding type");
  }
  const { next, flows: flows2 } = result;
  requireBuild(availableY < 1n << 128n && availableLp < 1n << 128n, "aggregate token/LP amount exceeds u128");
  requireBuild(availableY >= flows2.paidY && availableLp >= flows2.burnedShares, "insufficient token/LP funding", "FUNDING");
  const cells = [
    output(roles[1], roles[0], encodeState(metadata), metadata.backingState),
    output(roles[2], void 0, "0x", metadata.backingCkb + next.x),
    output(roles[3], token, amount(next.y), metadata.backingToken)
  ];
  const synthetic = cells.map((c, index) => ccc4.Cell.from({ ...c, outPoint: { txHash: id, index: index + stateOutputIndex } }));
  parsePool(deployment2, synthetic[0], synthetic[1], synthetic[2]);
  let ckbReceiptTopUp = 0n;
  if (flows2.receivedX) {
    const c = output(recipients2.ckb);
    ckbReceiptTopUp = c.cellOutput.capacity > flows2.receivedX ? c.cellOutput.capacity - flows2.receivedX : 0n;
    c.cellOutput.capacity = flows2.receivedX + ckbReceiptTopUp;
    cells.push(c);
  }
  if (flows2.receivedY) cells.push(output(recipients2.token, token, amount(flows2.receivedY)));
  if (flows2.mintedShares) cells.push(output(recipients2.lp, roles[4], amount(flows2.mintedShares)));
  if (availableY > flows2.paidY) cells.push(output(change, token, amount(availableY - flows2.paidY)));
  if (availableLp > flows2.burnedShares) cells.push(output(change, roles[4], amount(availableLp - flows2.burnedShares)));
  const changeCell = output(change);
  cells.push(changeCell);
  if (stateOutputIndex === 1) cells.unshift(cells.splice(3, 1)[0]);
  const remaining = inputs.reduce((n, c) => n + c.cellOutput.capacity, 0n) - cells.slice(0, -1).reduce((n, c) => n + c.cellOutput.capacity, 0n);
  requireBuild(remaining >= minimumCapacity(changeCell), "insufficient capacity for receipts and change", "FUNDING");
  changeCell.cellOutput.capacity = remaining;
  const walletWitnessIndex = previous ? 3 : 0;
  const witnesses = Array.from({ length: Math.max(inputs.length, stateOutputIndex + 1) }, () => "0x");
  const walletArgs = ccc4.WitnessArgs.from({ lock: new Uint8Array(signatureBytes), outputType: proof });
  witnesses[walletWitnessIndex] = ccc4.hexFrom(walletArgs.toBytes());
  if (previous) witnesses[0] = ccc4.hexFrom(ccc4.WitnessArgs.from({ inputType: encodeAction(action) }).toBytes());
  else if (stateOutputIndex === 0) {
    walletArgs.outputType = encodeAction(action);
    witnesses[0] = ccc4.hexFrom(walletArgs.toBytes());
  } else witnesses[stateOutputIndex] = ccc4.hexFrom(ccc4.WitnessArgs.from({ outputType: encodeAction(action) }).toBytes());
  const deps = [deployment2.poolDep, deployment2.tokenDep, ...wallet.deps].map((d) => ccc4.CellDep.from(d));
  const unique = deps.filter((d, i) => deps.findIndex((other) => ccc4.hexFrom(other.toBytes()) === ccc4.hexFrom(d.toBytes())) === i);
  const transaction = ccc4.Transaction.from({ inputs, outputs: cells.map((c) => c.cellOutput), outputsData: cells.map((c) => c.outputData), cellDeps: unique, witnesses });
  const fee = transaction.estimateFee(wallet.feeRate);
  requireBuild(fee <= wallet.maxFee, "fee exceeds explicit cap", "FEE");
  requireBuild(remaining - fee >= minimumCapacity(changeCell), "change would be dust after fee", "FUNDING");
  transaction.outputs[transaction.outputs.length - 1].capacity = remaining - fee;
  for (let i = 0; i < transaction.outputs.length; i++) validateCell(ccc4.CellAny.from({ cellOutput: transaction.outputs[i], outputData: transaction.outputsData[i] }));
  const rawHash = transaction.hash(), savedWitnesses = [...transaction.witnesses];
  const reviewedInputs = inputs.map((cell) => cell.clone());
  const assertIntegrity = (tx = transaction) => {
    requireBuild(tx.hash() === rawHash, "raw transaction changed");
    for (let i = 0; i < reviewedInputs.length; i++) {
      const candidate = tx.inputs[i], expected = reviewedInputs[i];
      requireBuild(candidate.cellOutput === void 0 || candidate.cellOutput instanceof ccc4.CellOutput && candidate.cellOutput.eq(expected.cellOutput), "cached input output changed");
      requireBuild(candidate.outputData === void 0 || candidate.outputData === expected.outputData, "cached input data changed");
    }
    requireBuild(Array.isArray(tx.witnesses) && tx.witnesses.length === savedWitnesses.length, "witness count changed");
    for (let i = 0; i < savedWitnesses.length; i++) {
      requireBuild(Object.hasOwn(tx.witnesses, i), "missing witness slot");
      const w = tx.witnesses[i];
      requireBuild(typeof w === "string" && w.length <= savedWitnesses[i].length && /^0x(?:[0-9a-fA-F]{2})*$/.test(w), "invalid witness bytes");
      if (i !== walletWitnessIndex) {
        requireBuild(w === savedWitnesses[i], "pool action or other witness changed");
        continue;
      }
      const args = ccc4.WitnessArgs.fromBytes(w);
      requireBuild(ccc4.hexFrom(args.toBytes()) === w.toLowerCase(), "noncanonical wallet witness");
      const length = args.lock === void 0 ? 0 : ccc4.bytesFrom(args.lock).length;
      requireBuild(joyid ? length >= 1 && length <= signatureBytes : length === 65, joyid ? "JoyID signature must be 1..1000 bytes" : "wallet signature must be 65 bytes");
      args.lock = ccc4.hexFrom(new Uint8Array(signatureBytes));
      requireBuild(ccc4.hexFrom(args.toBytes()) === savedWitnesses[i], "wallet witness fields changed");
    }
  };
  const capturedDeployment = { ...deployment2, poolDep: ccc4.CellDep.from(deployment2.poolDep).clone(), tokenDep: ccc4.CellDep.from(deployment2.tokenDep).clone() };
  return {
    transaction,
    poolId: id,
    result,
    fee,
    ckbReceiptTopUp,
    walletWitnessIndex,
    stateOutputIndex,
    assertIntegrity,
    assertFresh: async (client2, options = {}, candidate = transaction) => {
      assertIntegrity(candidate);
      await assertPoolNetwork(client2, capturedDeployment, options);
      await assertPoolDependencies(client2, capturedDeployment, options);
      for (const cell of reviewedInputs) requireBuild(sameCell(cell, await liveCell(client2, cell.outPoint, options)), "live input content changed");
      if (previous) requireBuild(sameCell(reviewedInputs[0], await liveCell(client2, reviewedInputs[0].outPoint, options)), "pool changed during freshness check");
      assertIntegrity(candidate);
    }
  };
}

// pool-sdk/src/funding.ts
var PoolFundingError = class extends Error {
  constructor(code, message) {
    super(`Pool funding: ${message}`);
    this.code = code;
    this.name = "PoolFundingError";
  }
  code;
};
function requireFunding(ok, message) {
  if (!ok) throw new PoolFundingError("INVALID", message);
}
var PoolFundingReservations = class {
  #held = /* @__PURE__ */ new Map();
  key(network, point) {
    return `${network}:${pointKey(point)}`;
  }
  has(network, point) {
    return this.#held.has(this.key(network, point));
  }
  claim(network, points) {
    const keys = points.map((p) => this.key(network, p));
    requireFunding(keys.length > 0 && keys.length <= 256 && new Set(keys).size === keys.length, "invalid reservation set");
    if (keys.some((key) => this.#held.has(key))) throw new PoolFundingError("RESERVED", "inputs already reserved by another review");
    const owner2 = /* @__PURE__ */ Symbol();
    for (const key of keys) this.#held.set(key, owner2);
    return () => {
      for (const key of keys) if (this.#held.get(key) === owner2) this.#held.delete(key);
    };
  }
};
async function fundPoolTransaction(client2, deployment2, wallet, recipients2, intent, options) {
  const selectedDeployment = { ...deployment2, poolDep: ccc5.CellDep.from(deployment2.poolDep).clone(), tokenDep: ccc5.CellDep.from(deployment2.tokenDep).clone() };
  const owner2 = ccc5.Script.from(wallet.lock).clone();
  const selectedWallet = { ...wallet, lock: owner2, change: ccc5.Script.from(wallet.change).clone(), deps: wallet.deps.map((d) => ccc5.CellDep.from(d).clone()), witness: wallet.witness ? { ...wallet.witness } : void 0 };
  const selectedRecipients = { ckb: ccc5.Script.from(recipients2.ckb).clone(), token: ccc5.Script.from(recipients2.token).clone(), lp: ccc5.Script.from(recipients2.lp).clone() };
  const captured = intent.kind === "create" ? { kind: "create", request: { ...intent.request, parameters: { ...intent.request.parameters, backing: { ...intent.request.parameters.backing } } } } : { kind: "transition", pool: parsePool(selectedDeployment, intent.pool.stateCell, intent.pool.ckbCell, intent.pool.tokenCell), action: { ...intent.action } };
  const result = captured.kind === "create" ? createPool(captured.request.parameters, captured.request.x, captured.request.y, captured.request.minShares) : transition(captured.pool.accounting, captured.action);
  const token = captured.kind === "create" ? ccc5.Script.from({ codeHash: XUDT_CODE_HASH, hashType: "data1", args: captured.request.tokenOwner }) : captured.pool.token;
  const lp = captured.kind === "transition" ? captured.pool.lp : void 0;
  requireFunding(owner2.hash() !== token.args, "issuer-mode funding is not supported");
  const { maxCandidates = 1e3, maxPages = 20, pageSize = 50, reservations: reservations2 } = options;
  const protocolMax = captured.kind === "create" ? 256 : 253, maxInputs = options.maxInputs ?? protocolMax;
  for (const [value, max] of [[maxCandidates, 1e4], [maxPages, 100], [pageSize, 100], [maxInputs, protocolMax]]) requireFunding(Number.isSafeInteger(value) && value >= 1 && value <= max, "invalid search bound");
  return withPoolDeadline(options, async (o) => {
    await assertPoolNetwork(client2, selectedDeployment, o);
    const candidates = [];
    const seen = /* @__PURE__ */ new Map(), cursors = /* @__PURE__ */ new Set();
    let cursor, scannedCandidates = 0, scanComplete = false;
    for (let page = 0; page < maxPages && scannedCandidates < maxCandidates; page++) {
      const limit = Math.min(pageSize, maxCandidates - scannedCandidates);
      const response = await readBounded(() => client2.findCellsPagedNoCache({ script: owner2.clone(), scriptType: "lock", scriptSearchMode: "exact", withData: true }, "asc", limit, cursor), o);
      requireFunding(response && Array.isArray(response.cells) && response.cells.length <= limit, "malformed/oversized indexer page");
      requireFunding(typeof response.lastCursor === "string" && response.lastCursor.length <= 4098 && /^0x(?:[0-9a-fA-F]{2})*$/.test(response.lastCursor), "invalid indexer cursor");
      const cells = response.cells.map((cell) => {
        requireFunding(cell.outputData.length <= 2 + 2 * 1024 * 1024, "oversized cell data");
        return cell.clone();
      });
      for (const cell of cells) {
        o.signal?.throwIfAborted();
        scannedCandidates++;
        validateCell(cell);
        requireFunding(cell.cellOutput.lock.eq(owner2), "indexer returned another owner");
        const key = pointKey(cell.outPoint), prior = seen.get(key);
        if (prior) {
          requireFunding(sameCell(prior, cell), "conflicting duplicate candidate");
          continue;
        }
        seen.set(key, cell);
        if (reservations2.has(selectedDeployment.genesisHash, cell.outPoint)) continue;
        const type = cell.cellOutput.type;
        if (!type) {
          if (cell.outputData === "0x") candidates.push({ cell, kind: "ckb", amount: 0n });
          continue;
        }
        if (type.eq(token)) candidates.push({ cell, kind: "token", amount: parseAmount(cell.outputData) });
        else if (lp && type.eq(lp)) candidates.push({ cell, kind: "lp", amount: parseAmount(cell.outputData) });
      }
      if (cells.length < limit) {
        scanComplete = true;
        break;
      }
      requireFunding(response.lastCursor !== "0x" && !cursors.has(response.lastCursor), "indexer cursor did not advance");
      cursors.add(response.lastCursor);
      cursor = response.lastCursor;
    }
    const byPoint = (a, b) => {
      const x = pointKey(a.cell.outPoint), y = pointKey(b.cell.outPoint);
      return x < y ? -1 : x > y ? 1 : 0;
    };
    const descending = (a, b) => a > b ? -1 : a < b ? 1 : 0;
    const chosen = [], used = /* @__PURE__ */ new Set();
    for (const [kind, needed] of [["token", result.flows.paidY], ["lp", result.flows.burnedShares]]) {
      let total = 0n;
      for (const candidate of candidates.filter((c) => c.kind === kind).sort((a, b) => descending(a.amount, b.amount) || byPoint(a, b))) {
        if (total >= needed) break;
        chosen.push(candidate);
        used.add(pointKey(candidate.cell.outPoint));
        total += candidate.amount;
      }
      if (total < needed) throw new PoolFundingError(scanComplete ? "INSUFFICIENT" : "LIMIT", `not enough ${kind} in bounded candidate set`);
    }
    const remainder = candidates.filter((c) => !used.has(pointKey(c.cell.outPoint))).sort((a, b) => Number(a.kind !== "ckb") - Number(b.kind !== "ckb") || descending(a.cell.cellOutput.capacity, b.cell.cellOutput.capacity) || byPoint(a, b));
    const live = [];
    let next = 0;
    while (true) {
      o.signal?.throwIfAborted();
      if (chosen.length === 0) {
        const first = remainder[next++];
        if (!first) throw new PoolFundingError(scanComplete ? "INSUFFICIENT" : "LIMIT", "no eligible funding in bounded candidate set");
        chosen.push(first);
      }
      if (chosen.length > maxInputs) throw new PoolFundingError("LIMIT", "selected funding exceeds input budget");
      for (let i = live.length; i < chosen.length; i++) {
        const expected = chosen[i].cell;
        if (reservations2.has(selectedDeployment.genesisHash, expected.outPoint)) throw new PoolFundingError("RESERVED", "funding reserved during selection");
        const current = await liveCell(client2, expected.outPoint, o);
        requireFunding(sameCell(expected, current), "indexer/live funding mismatch");
        live.push(current);
      }
      let built;
      try {
        const funded = { ...selectedWallet, funding: live };
        built = captured.kind === "create" ? buildCreate(selectedDeployment, funded, selectedRecipients, captured.request) : buildTransition(selectedDeployment, funded, selectedRecipients, captured.pool, captured.action);
      } catch (error) {
        if (!(error instanceof PoolBuildError) || error.code !== "FUNDING") throw error;
        const more = remainder[next++];
        if (!more) throw new PoolFundingError(scanComplete ? "INSUFFICIENT" : "LIMIT", "insufficient capacity in bounded candidate set");
        chosen.push(more);
        continue;
      }
      o.signal?.throwIfAborted();
      const release = reservations2.claim(selectedDeployment.genesisHash, built.transaction.inputs.map((i) => i.previousOutput));
      try {
        await built.assertFresh(client2, o);
        o.signal?.throwIfAborted();
        return { built, funding: live.map((c) => c.clone()), scannedCandidates, scanComplete, release };
      } catch (error) {
        release();
        throw error;
      }
    }
  });
}

// pool-sdk/src/joyid.ts
import { ccc as ccc7 } from "@ckb-ccc/ccc";

// pool-sdk/src/joyid-proof.ts
import { ccc as ccc6 } from "@ckb-ccc/ccc";
function validateJoyIdProof(value) {
  if (typeof value !== "string" || value.length > 6002) throw new Error("JoyID proof must be 1..3000 bytes");
  const bytes2 = value.startsWith("0x") ? value.slice(2) : value;
  if (bytes2.length > 6e3 || !/^(?:[0-9a-fA-F]{2})+$/.test(bytes2)) throw new Error("JoyID proof must be 1..3000 bytes");
  return `0x${bytes2.toLowerCase()}`;
}

// pool-sdk/src/joyid.ts
var ZERO_LOCK = ccc7.hexFrom(new Uint8Array(1e3));
function requireJoy(ok, message) {
  if (!ok) throw new Error(`JoyID pool: ${message}`);
}
function hash2(value) {
  requireJoy(/^0x[0-9a-fA-F]{64}$/.test(value), "invalid hash");
  return value.toLowerCase();
}
function identity(text) {
  requireJoy(typeof text === "string" && text.length <= 4096, "invalid identity size");
  const value = JSON.parse(text);
  requireJoy(value && typeof value === "object" && Object.keys(value).length === 2 && (value.keyType === "main_key" || value.keyType === "sub_key"), "unsupported credential type");
  requireJoy(typeof value.publicKey === "string" && /^(?:[0-9a-fA-F]{2}){1,1024}$/.test(value.publicKey), "invalid public key");
  return { keyType: value.keyType, publicKey: `0x${value.publicKey.toLowerCase()}` };
}
async function resolveJoyIdWallet(source, deployment2, profile, funding, proofSource, options = {}) {
  const { signer: signer2, revision } = source.current(), client2 = signer2.client;
  requireJoy(typeof revision === "string" && revision.length > 0 && revision.length <= 256, "invalid session revision");
  requireJoy(signer2.signType === ccc7.SignerSignType.JoyId, "JoyID signer required");
  const selected = { ...deployment2, genesisHash: hash2(deployment2.genesisHash), poolDep: ccc7.CellDep.from(deployment2.poolDep).clone(), tokenDep: ccc7.CellDep.from(deployment2.tokenDep).clone() };
  const expectedCode = hash2(profile.codeHash), expectedHashType = profile.hashType;
  const cotaType = profile.cotaType ? ccc7.Script.from(profile.cotaType).clone() : void 0;
  requireJoy(Array.isArray(profile.codeDeps) && profile.codeDeps.length >= 1 && profile.codeDeps.length <= 12, "code dependency count must be 1..12");
  const codes = profile.codeDeps.map(({ dep, dataHash }) => ({ dep: ccc7.CellDep.from(dep).clone(), dataHash: hash2(dataHash) }));
  requireJoy(codes.every((c) => c.dep.depType === "code"), "only pinned direct code dependencies supported");
  requireJoy(new Set(codes.map((c) => pointKey(c.dep.outPoint))).size === codes.length, "duplicate code dependency");
  const probeFunding = funding.clone(), lifetimeSignal = options.signal;
  const check2 = () => {
    lifetimeSignal?.throwIfAborted();
    const current = source.current();
    requireJoy(current.signer === signer2 && current.revision === revision && signer2.client === client2 && signer2.signType === ccc7.SignerSignType.JoyId, "wallet session changed");
  };
  async function binding(o) {
    check2();
    o.signal?.throwIfAborted();
    const before = identity(await readBounded(() => signer2.getIdentity(), o));
    check2();
    const addresses = await readBounded(() => signer2.getAddressObjs(), o);
    check2();
    requireJoy(Array.isArray(addresses) && addresses.length === 1, "exactly one JoyID address required");
    const address = addresses[0], lock = address.script.clone();
    requireJoy(address.prefix === client2.addressPrefix && lock.codeHash === expectedCode && lock.hashType === expectedHashType && lock.toBytes().length <= 512, "wallet lock/profile mismatch");
    const after = identity(await readBounded(() => signer2.getIdentity(), o));
    check2();
    requireJoy(before.keyType === after.keyType && before.publicKey === after.publicKey, "identity changed during account read");
    await assertPoolNetwork(client2, selected, o);
    check2();
    return { ...before, lock };
  }
  return withPoolDeadline(options, async (o) => {
    const bound = await binding(o), snapshots = [];
    requireJoy(probeFunding.cellOutput.lock.eq(bound.lock), "funding belongs to another account");
    for (const code of codes) {
      const cell = await liveCell(client2, code.dep.outPoint, o);
      check2();
      requireJoy(ccc7.hashCkb(cell.outputData) === code.dataHash, "wallet code hash mismatch");
      snapshots.push(cell);
    }
    requireJoy(snapshots.some((cell) => expectedHashType === "type" ? cell.cellOutput.type?.hash() === expectedCode : ccc7.hashCkb(cell.outputData) === expectedCode), "pinned code does not resolve wallet lock");
    const stateCells = [];
    let proof;
    if (bound.keyType === "sub_key") {
      requireJoy(cotaType && cotaType.toBytes().length <= 512 && proofSource, "subkey needs explicit CoTA type and proof source");
      const page = await readBounded(() => client2.findCellsPagedNoCache({ script: bound.lock.clone(), scriptType: "lock", scriptSearchMode: "exact", filter: { script: cotaType.clone(), scriptLenRange: [cotaType.toBytes().length, cotaType.toBytes().length + 1] }, withData: true }, "asc", 5), o);
      check2();
      requireJoy(page && Array.isArray(page.cells) && page.cells.length >= 1 && page.cells.length <= 4, "CoTA cell count must be 1..4");
      const seen = new Set(codes.map((c) => pointKey(c.dep.outPoint)));
      const indexedCells = page.cells.map((candidate) => {
        requireJoy(candidate.outputData.length <= 2 + 2 * 1024 * 1024, "CoTA data exceeds bound");
        return candidate.clone();
      });
      for (const indexed of indexedCells) {
        const key = pointKey(indexed.outPoint);
        requireJoy(!seen.has(key), "duplicate CoTA cell");
        seen.add(key);
        const live = await liveCell(client2, indexed.outPoint, o);
        check2();
        requireJoy(sameCell(indexed, live) && live.cellOutput.lock.eq(bound.lock) && live.cellOutput.type?.eq(cotaType), "CoTA owner/type/live mismatch");
        stateCells.push(live);
      }
      proof = validateJoyIdProof(await readBounded(() => proofSource({ lock: ccc7.hexFrom(bound.lock.toBytes()), publicKey: bound.publicKey }, o), o));
      check2();
    }
    snapshots.push(...stateCells);
    const deps = [...codes.map((c) => c.dep), ...stateCells.map((c) => ccc7.CellDep.from({ outPoint: c.outPoint, depType: "code" }))];
    const walletWitness = ccc7.hexFrom(ccc7.WitnessArgs.from({ lock: ZERO_LOCK, outputType: proof }).toBytes());
    const assertBinding = async (options2) => {
      const current = await binding(options2);
      requireJoy(current.keyType === bound.keyType && current.publicKey === bound.publicKey && current.lock.eq(bound.lock), "connected account changed");
    };
    const fresh = async (options2) => {
      await assertBinding(options2);
      for (const cell of snapshots) {
        requireJoy(sameCell(cell, await liveCell(client2, cell.outPoint, options2)), "wallet dependency changed or spent");
        check2();
      }
      await assertBinding(options2);
    };
    requireJoy(sameCell(probeFunding, await liveCell(client2, probeFunding.outPoint, o)), "funding snapshot changed");
    check2();
    const probe = ccc7.Transaction.from({ inputs: [probeFunding.clone()], cellDeps: deps.map((d) => d.clone()), witnesses: [walletWitness] });
    const prepared = (await readBounded(() => signer2.prepareTransaction(probe.clone()), o)).clone();
    check2();
    requireJoy(prepared.hash() === probe.hash(), "unexpected preparation raw/dependency mutation");
    requireJoy(Array.isArray(prepared.witnesses) && prepared.witnesses.length === 1 && Object.hasOwn(prepared.witnesses, 0) && prepared.witnesses[0] === walletWitness, "unexpected preparation witness mutation");
    const cached = prepared.inputs[0];
    requireJoy((cached.cellOutput === void 0 || cached.cellOutput.eq(probeFunding.cellOutput)) && (cached.outputData === void 0 || cached.outputData === probeFunding.outputData), "preparation cache mutation");
    await fresh(o);
    requireJoy(sameCell(probeFunding, await liveCell(client2, probeFunding.outPoint, o)), "funding changed during preparation");
    check2();
    const capturedIdentity = Object.freeze({ ...bound, lock: ccc7.hexFrom(bound.lock.toBytes()), genesisHash: selected.genesisHash, revision });
    const boundReviews = /* @__PURE__ */ new WeakSet();
    return Object.freeze({
      identity: capturedIdentity,
      wallet: () => ({ lock: bound.lock.clone(), deps: deps.map((d) => d.clone()), witness: { kind: "joyid", outputType: proof } }),
      assertFresh: (options2 = {}) => withPoolDeadline(options2, fresh),
      bindReview: (review) => {
        check2();
        requireJoy(!boundReviews.has(review), "review already bound");
        requireJoy(review.summary.genesisHash === selected.genesisHash && review.summary.owner === capturedIdentity.lock, "review account/network mismatch");
        const tx = review.transaction(), index = review.summary.walletWitnessIndex;
        requireJoy(tx.witnesses[index] === walletWitness, "review wallet witness mismatch");
        const expected = [selected.poolDep, selected.tokenDep, ...deps].filter((dep, index2, all) => all.findIndex((other) => other.eq(dep)) === index2);
        requireJoy(tx.cellDeps.length === expected.length && tx.cellDeps.every((dep, i) => dep.eq(expected[i])), "review dependency mismatch");
        boundReviews.add(review);
        let attempted = false;
        return Object.freeze({
          identity: capturedIdentity,
          summary: review.summary,
          sign: (options2 = {}) => withPoolDeadline(options2, async (o2) => {
            requireJoy(!attempted, "review already used for signing");
            attempted = true;
            requireJoy(typeof signer2.signOnlyTransaction === "function", "sign-only method unavailable");
            await fresh(o2);
            await review.assertFresh(client2, o2, tx);
            check2();
            review.assertIntegrity(tx);
            const signed = (await readBounded(() => {
              check2();
              review.assertIntegrity(tx);
              return signer2.signOnlyTransaction(tx.clone());
            }, o2)).clone();
            check2();
            review.assertIntegrity(signed);
            const lock = ccc7.WitnessArgs.fromBytes(signed.witnesses[index]).lock;
            requireJoy(lock !== void 0 && ccc7.bytesFrom(lock).some((byte) => byte !== 0), "wallet returned unsigned placeholder");
            await review.assertFresh(client2, o2, signed);
            await fresh(o2);
            check2();
            review.assertIntegrity(signed);
            o2.signal?.throwIfAborted();
            return signed.clone();
          })
        });
      },
      prepare: (built, options2 = {}) => withPoolDeadline(options2, async (o2) => {
        await fresh(o2);
        built.assertIntegrity();
        const tx = built.transaction.clone(), index = built.walletWitnessIndex;
        requireJoy(Number.isSafeInteger(index) && index >= 0 && index < tx.inputs.length, "invalid wallet witness index");
        requireJoy(tx.witnesses[index] === walletWitness, "transaction does not use the resolved wallet witness");
        const expected = [selected.poolDep, selected.tokenDep, ...deps].filter((dep, index2, all) => all.findIndex((other) => other.eq(dep)) === index2);
        requireJoy(tx.cellDeps.length === expected.length && tx.cellDeps.every((dep, i) => dep.eq(expected[i])), "transaction dependency set differs from resolved profile");
        const input = await liveCell(client2, tx.inputs[index].previousOutput, o2);
        check2();
        requireJoy(input.cellOutput.lock.eq(bound.lock), "transaction belongs to another account");
        await built.assertFresh(client2, o2, tx);
        check2();
        const candidate = (await readBounded(() => signer2.prepareTransaction(tx.clone()), o2)).clone();
        check2();
        built.assertIntegrity(candidate);
        requireJoy(candidate.witnesses[index] === walletWitness, "preparation changed the pinned wallet witness");
        await built.assertFresh(client2, o2, candidate);
        await fresh(o2);
        built.assertIntegrity(candidate);
        check2();
        return candidate.clone();
      })
    });
  });
}

// pool-sdk/src/review.ts
import { ccc as ccc8 } from "@ckb-ccc/ccc";
function freeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function requireReview(ok, message) {
  if (!ok) throw new Error(`Pool review: ${message}`);
}
function reviewPoolTransaction(deployment2, wallet, recipients2, intent, prepared, ttlMs = 12e4) {
  requireReview(Number.isSafeInteger(ttlMs) && ttlMs >= 1 && ttlMs <= 3e5, "expiry must be 1..300000 ms");
  const createdAt = Date.now(), started = performance.now();
  const built = intent.kind === "create" ? buildCreate(deployment2, wallet, recipients2, intent.request) : buildTransition(deployment2, wallet, recipients2, intent.pool, intent.action);
  built.assertIntegrity(prepared);
  requireReview(ccc8.hexFrom(prepared.toBytes()) === ccc8.hexFrom(built.transaction.toBytes()), "expected unsigned prepared bytes");
  const transaction = prepared.clone();
  const action = decodeWitness(transaction.witnesses[intent.kind === "create" ? built.stateOutputIndex : 0], intent.kind === "create");
  const inputs = [...intent.kind === "transition" ? [intent.pool.stateCell, intent.pool.ckbCell, intent.pool.tokenCell] : [], ...wallet.funding].map((c) => c.clone());
  const inputCapacity = inputs.reduce((n, c) => n + c.cellOutput.capacity, 0n);
  const outputCapacity = transaction.outputs.reduce((n, c) => n + c.capacity, 0n);
  const fee = inputCapacity - outputCapacity;
  requireReview(fee === built.fee && fee >= 0n, "capacity fee mismatch");
  const script = (s) => ccc8.hexFrom(s.toBytes());
  const token = transaction.outputs[built.stateOutputIndex + 2].type;
  const lp = poolScript(deployment2.codeHash, built.poolId, 4 /* LpType */);
  const previous = intent.kind === "transition" ? parsePool(deployment2, intent.pool.stateCell, intent.pool.ckbCell, intent.pool.tokenCell).accounting : void 0;
  const summary = freeze({
    createdAt,
    expiresAt: createdAt + ttlMs,
    genesisHash: deployment2.genesisHash,
    transactionHash: transaction.hash(),
    poolId: built.poolId,
    owner: script(ccc8.Script.from(wallet.lock)),
    change: script(ccc8.Script.from(wallet.change)),
    token: script(token),
    lp: script(lp),
    recipients: { ckb: script(ccc8.Script.from(recipients2.ckb)), token: script(ccc8.Script.from(recipients2.token)), lp: script(ccc8.Script.from(recipients2.lp)) },
    action,
    flows: { ...built.result.flows },
    previous,
    next: { ...built.result.next, backing: { ...built.result.next.backing } },
    fee,
    feeRate: wallet.feeRate,
    maxFee: wallet.maxFee,
    ckbReceiptTopUp: built.ckbReceiptTopUp,
    // All wallet receipts/change and permanent pool storage remain individually visible.
    outputs: transaction.outputs.map((output2, index) => ({
      index,
      capacity: output2.capacity,
      occupiedCapacity: minimumCapacity(ccc8.CellAny.from({ cellOutput: output2, outputData: transaction.outputsData[index] })),
      lock: script(output2.lock),
      type: output2.type ? script(output2.type) : void 0,
      data: transaction.outputsData[index],
      asset: output2.type?.eq(token) ? "token" : output2.type?.eq(lp) ? "lp" : output2.type ? "state" : "ckb",
      amount: output2.type?.eq(token) || output2.type?.eq(lp) ? parseAmount(transaction.outputsData[index]) : void 0,
      pool: index >= built.stateOutputIndex && index <= built.stateOutputIndex + 2
    })),
    inputs: inputs.map((c) => ({ txHash: c.outPoint.txHash, index: c.outPoint.index, capacity: c.cellOutput.capacity, lock: script(c.cellOutput.lock), type: c.cellOutput.type ? script(c.cellOutput.type) : void 0, data: c.outputData })),
    dependencies: transaction.cellDeps.map((d) => ({ txHash: d.outPoint.txHash, index: d.outPoint.index, depType: d.depType })),
    walletWitnessIndex: built.walletWitnessIndex,
    stateOutputIndex: built.stateOutputIndex
  });
  const assertActive = () => requireReview(performance.now() - started < ttlMs && Date.now() < createdAt + ttlMs, "expired");
  const assertIntegrity = (candidate) => {
    assertActive();
    built.assertIntegrity(candidate);
  };
  return Object.freeze({
    summary,
    transaction: () => {
      assertActive();
      return transaction.clone();
    },
    assertIntegrity,
    assertFresh: async (client2, options = {}, candidate = transaction) => {
      assertIntegrity(candidate);
      await withPoolDeadline(options, (o) => built.assertFresh(client2, o, candidate));
      assertIntegrity(candidate);
    }
  });
}

// pool-sdk/src/recovery.ts
import { ccc as ccc10 } from "@ckb-ccc/ccc";

// solver/src/resolution.ts
import { ccc as ccc9 } from "@ckb-ccc/ccc";
var IN_FLIGHT = /* @__PURE__ */ new Set(["pending", "proposed", "sent"]);
function requireResolution(ok, message) {
  if (!ok) throw new Error(`Submission resolution: ${message}`);
}
function find(journal2, hash3) {
  const row = journal2.list().find((row2) => row2.hash === hash3);
  requireResolution(row, "unknown submission");
  return row;
}
async function archiveCommittedSubmission(journal2, client2, hash3, minConfirmations = 24, read = (f) => f()) {
  requireResolution(Number.isSafeInteger(minConfirmations) && minConfirmations >= 1 && minConfirmations <= 1e4, "invalid confirmation depth");
  const row = find(journal2, hash3);
  const observed = await read(() => client2.getTransactionNoCache(hash3));
  requireResolution(observed?.status === "committed" && observed.blockNumber !== void 0, "transaction is not committed");
  requireResolution(!observed.transaction || observed.transaction.hash() === hash3, "transaction response mismatch");
  const tip = (await read(() => client2.getTipHeader())).number;
  const confirmations = ccc9.numFrom(tip) - ccc9.numFrom(observed.blockNumber) + 1n;
  requireResolution(confirmations >= BigInt(minConfirmations), `only ${confirmations} confirmations`);
  if (row.status !== "committed") journal2.put({ ...row, status: "committed" });
  journal2.archive(hash3, "committed");
  return Object.freeze({ hash: hash3, resolution: "committed", confirmations, transaction: row.transaction });
}
async function abandonConflictedSubmission(journal2, client2, hash3, acknowledgeReorgRisk, read = (f) => f()) {
  requireResolution(acknowledgeReorgRisk === true, "abandoning requires explicit reorg-risk acknowledgement");
  const row = find(journal2, hash3), tx = ccc9.Transaction.fromBytes(row.transaction);
  const status = async () => {
    const observed = await read(() => client2.getTransactionNoCache(hash3));
    requireResolution(observed?.status !== "committed" && !IN_FLIGHT.has(observed?.status ?? ""), `transaction is ${observed?.status}`);
  };
  await status();
  let spent = 0;
  for (const input of tx.inputs) {
    const cell = await read(() => client2.getCellLiveNoCache(input.previousOutput));
    if (cell) requireResolution(cell.outPoint.eq(input.previousOutput), "input response mismatch");
    else spent++;
  }
  requireResolution(spent > 0, "all inputs are live; the signed transaction can still commit");
  await status();
  if (row.status === "committed") journal2.put({ ...row, status: "unknown" });
  journal2.archive(hash3, "abandoned");
  return Object.freeze({ hash: hash3, resolution: "abandoned", spentInputs: spent, totalInputs: tx.inputs.length, transaction: row.transaction });
}

// pool-sdk/src/recovery.ts
function requireRecovery(ok, message) {
  if (!ok) throw new Error(`Pool recovery: ${message}`);
}
var PoolSubmissionRecovery = class {
  constructor(journal2, reservations2, scope) {
    this.journal = journal2;
    this.reservations = reservations2;
    this.scope = scope;
    this.scope = { ...scope };
  }
  journal;
  reservations;
  scope;
  /** Input key -> release for reservations owned by persisted submissions. */
  held = /* @__PURE__ */ new Map();
  running = false;
  reconciled = false;
  async exclusive(options, client2, run) {
    requireRecovery(!this.running, "already running");
    this.running = true;
    try {
      return await withPoolDeadline(options, async (o) => {
        const scope = this.journal.getScope();
        requireRecovery(scope.genesisHash === this.scope.genesisHash && scope.accountLockHash === this.scope.accountLockHash, "scope mismatch");
        requireRecovery((await readBounded(() => client2.getHeaderByNumberNoCache(0), o))?.hash === scope.genesisHash, "network mismatch");
        return run(o);
      });
    } finally {
      this.running = false;
    }
  }
  hold(row) {
    for (const input of ccc10.Transaction.fromBytes(row.transaction).inputs) {
      const key = pointKey(input.previousOutput);
      if (!this.held.has(key)) this.held.set(key, this.reservations.claim(this.scope.genesisHash, [input.previousOutput]));
    }
  }
  /** Release only inputs no remaining active submission references. */
  releaseUnreferenced() {
    const referenced = new Set(this.journal.list().flatMap((row) => ccc10.Transaction.fromBytes(row.transaction).inputs.map((i) => pointKey(i.previousOutput))));
    for (const [key, release] of this.held) if (!referenced.has(key)) {
      release();
      this.held.delete(key);
    }
  }
  find(hash3) {
    const row = this.journal.list().find((row2) => row2.hash === hash3);
    requireRecovery(row, "unknown submission");
    return row;
  }
  /** Required at startup before any submit or resolution. */
  async reconcile(client2, options = {}) {
    return this.exclusive(options, client2, async (o) => {
      const records = this.journal.list();
      for (const row of records) this.hold(row);
      const reports2 = [];
      for (const row of records) {
        const observed = await readBounded(() => client2.getTransactionNoCache(row.hash), o);
        const status = observed?.status === "committed" ? "committed" : observed?.status === "rejected" ? "rejected" : "unknown";
        if (status !== row.status) this.journal.put({ ...row, status });
        const tx = ccc10.Transaction.fromBytes(row.transaction);
        let liveInputs = 0;
        for (const input of tx.inputs) {
          const cell = await readBounded(() => client2.getCellLiveNoCache(input.previousOutput), o);
          if (cell) {
            requireRecovery(cell.outPoint.eq(input.previousOutput), "input response mismatch");
            liveInputs++;
          }
        }
        reports2.push(Object.freeze({ hash: row.hash, status, observedStatus: observed?.status ?? "absent", liveInputs, totalInputs: tx.inputs.length, reserved: true }));
      }
      this.reconciled = true;
      return Object.freeze(reports2);
    });
  }
  /** Persist exact signed bytes, take over the funding reservation, then send
   * once. Journal failure prevents send. A send error or timeout is ambiguous:
   * the row stays `unknown` and reserved until explicitly resolved. */
  async submit(client2, review, signed, funded, options = {}) {
    requireRecovery(this.reconciled, "reconcile before submitting");
    return this.exclusive(options, client2, async (o) => {
      const tx = signed.clone(), hash3 = tx.hash();
      requireRecovery(review.summary.genesisHash === this.scope.genesisHash, "review network mismatch");
      requireRecovery(hash3 === review.summary.transactionHash && hash3 === funded.built.transaction.hash(), "signed transaction differs from review/funding");
      review.assertIntegrity(tx);
      requireRecovery(ccc10.bytesFrom(ccc10.WitnessArgs.fromBytes(tx.witnesses[review.summary.walletWitnessIndex]).lock ?? "0x").some((b) => b !== 0), "transaction is not signed");
      requireRecovery(!this.journal.list().some((row) => row.hash === hash3), "submission already recorded");
      const points = tx.inputs.map((i) => i.previousOutput);
      requireRecovery(points.every((p) => this.reservations.has(this.scope.genesisHash, p) && !this.held.has(pointKey(p))), "inputs are not reserved by this funding");
      await review.assertFresh(client2, o, tx);
      o.signal?.throwIfAborted();
      const transaction = ccc10.hexFrom(tx.toBytes());
      this.journal.put({ hash: hash3, transaction, orders: points.map(pointKey), status: "unknown", createdAt: Date.now() });
      funded.release();
      this.hold(this.find(hash3));
      try {
        const sent = await readBounded(() => client2.sendTransaction(ccc10.Transaction.fromBytes(transaction)), o);
        requireRecovery(sent === hash3, "node returned a different transaction hash");
        return Object.freeze({ hash: hash3, outcome: "sent" });
      } catch (error) {
        return Object.freeze({ hash: hash3, outcome: "unknown", error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
  /** Operator resolution: archive a submission committed at sufficient depth. */
  async archiveCommitted(client2, hash3, options = {}) {
    requireRecovery(this.reconciled, "reconcile before resolving");
    return this.exclusive(options, client2, async (o) => {
      const { transaction: _, ...result } = await archiveCommittedSubmission(this.journal, client2, hash3, options.minConfirmations, (read) => readBounded(read, o));
      this.releaseUnreferenced();
      return Object.freeze(result);
    });
  }
  /** Operator resolution: abandon a never-committed submission once one of its
   * inputs is spent elsewhere. See `abandonConflictedSubmission` for reorg risk. */
  async abandonConflicted(client2, hash3, options = {}) {
    requireRecovery(this.reconciled, "reconcile before resolving");
    return this.exclusive(options, client2, async (o) => {
      const { transaction: _, ...result } = await abandonConflictedSubmission(this.journal, client2, hash3, options.acknowledgeReorgRisk === true, (read) => readBounded(read, o));
      this.releaseUnreferenced();
      return Object.freeze(result);
    });
  }
};

// scripts/lib/pool-live.ts
import { ccc as ccc11 } from "@ckb-ccc/ccc";
var GENESIS = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";
var IMMUTABLE_LOCK = ccc11.Script.from({ codeHash: `0x${"00".repeat(32)}`, hashType: "data1", args: "0x" });
var joyDep = (txHash, index, dataHash) => ({ dep: { outPoint: { txHash, index }, depType: "code" }, dataHash });
var JOYID_PROFILE = {
  codeHash: "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac",
  hashType: "type",
  codeDeps: [
    joyDep("0x4a596d31dc35e88fb1591debbf680b04a44b4a434e3a94453c21ea8950ffb4d9", 0, "0xd2c0f2f621a337007e046f0ed65f8fe29112c32a00ea1e43c2f8059fd42ca6d7"),
    joyDep("0x4a596d31dc35e88fb1591debbf680b04a44b4a434e3a94453c21ea8950ffb4d9", 1, "0xb9a07a8f9b6c30e3a86351ad229882d79920d81b7f81967045445cbcf22ddbf2"),
    joyDep("0xf2c9dbfe7438a8c622558da8fa912d36755271ea469d3a25cb8d3373d35c8638", 1, "0xb511b5400d7adc48c027b513e22d6ebd058519b2f128c9562b1e6a7ba36dfe84"),
    joyDep("0x95ecf9b41701b45d431657a67bbfa3f07ef7ceb53bf87097f3674e1a4a19ce62", 1, "0xbe1a3fd8ce6b89f05c9016e2d507d34d424adc54733d3ccffba109b0db61d65b"),
    joyDep("0x8b3255491f3c4dcc1cfca33d5c6bcaec5409efe4bbda243900f9580c47e0242e", 1, "0xa638f65f650bdac13bf91134ed7eec8feded1dac5e6add9e26cf658b2a693066")
  ]
};
var POOL_PARAMETERS = { feeBps: 30n, lockedShares: 1000n, backing: { state: 34000000000n, ckb: 8000000000n, token: 16000000000n } };
var INITIAL_LIQUIDITY = { x: 100000000000n, y: 400000000000n };
var FEE_RATE = 1000n;
var MAX_FEE = 10000n;

// scripts/pool-lifecycle.entry.ts
var manifest = define_POOL_MANIFEST_default;
var issuer = define_POOL_ISSUER_default;
var deployment = { genesisHash: manifest.genesisHash, codeHash: manifest.codeHash, poolDep: manifest.poolDep, tokenDep: manifest.tokenDep };
var STEPS = ["create", "xToY", "yToX", "deposit", "partialWithdraw", "fullWithdraw", "reenter"];
var fail = (message) => {
  throw new Error(`P6 lifecycle: ${message}`);
};
if (client.addressPrefix !== "ckt" || (await client.getHeaderByNumber(0))?.hash !== GENESIS || deployment.genesisHash !== GENESIS) fail("select CKB TESTNET");
if (signer.signType !== ccc12.SignerSignType.JoyId) fail("connect a JoyID wallet");
var [account] = await signer.getAddressObjs();
if (!account || account.script.codeHash !== JOYID_PROFILE.codeHash) fail("connect exactly one JoyID testnet account");
var owner = account.script;
var storageKey = `openswap-p6:${GENESIS}:${owner.hash()}`;
console.log("P6 POOL LIFECYCLE \u2014 JoyID", account.toString());
var progress = JSON.parse(localStorage.getItem(`${storageKey}:progress`) ?? '{"steps":{}}');
var saveProgress = () => localStorage.setItem(`${storageKey}:progress`, JSON.stringify(progress));
var BrowserJournal = class {
  getScope() {
    return { genesisHash: GENESIS, accountLockHash: owner.hash() };
  }
  list() {
    return JSON.parse(localStorage.getItem(`${storageKey}:journal`) ?? "[]");
  }
  put(row) {
    const tx = ccc12.Transaction.fromBytes(row.transaction);
    if (tx.hash() !== row.hash || ccc12.hexFrom(tx.toBytes()) !== row.transaction) fail("journal identity mismatch");
    const prior = this.list().find((r) => r.hash === row.hash);
    if (prior && (prior.transaction !== row.transaction || prior.createdAt !== row.createdAt)) fail("immutable submission changed");
    localStorage.setItem(`${storageKey}:journal`, JSON.stringify([...this.list().filter((r) => r.hash !== row.hash), row]));
    if (localStorage.getItem(`${storageKey}:journal`) === null) fail("journal write failed");
  }
  archive(hash3, resolution) {
    const row = this.list().find((r) => r.hash === hash3) ?? fail("unknown submission");
    localStorage.setItem(`${storageKey}:archive`, JSON.stringify([...JSON.parse(localStorage.getItem(`${storageKey}:archive`) ?? "[]"), { resolution, record: row }]));
    localStorage.setItem(`${storageKey}:journal`, JSON.stringify(this.list().filter((r) => r.hash !== hash3)));
  }
};
var reservations = new PoolFundingReservations();
var journal = new BrowserJournal();
var recovery = new PoolSubmissionRecovery(journal, reservations, journal.getScope());
var chain = client;
var reports = await recovery.reconcile(chain);
for (const report of reports) console.log("Journaled submission", report.hash, report.observedStatus);
if (reports.some((r) => r.observedStatus !== "committed")) fail("an earlier submission is not committed yet; wait or inspect before continuing");
for (const report of reports) await recovery.archiveCommitted(client, report.hash, { minConfirmations: 1 });
var recipients = { ckb: owner, token: owner, lp: owner };
var tokenOwner = issuer.lockHash;
var slippage = (amount2) => amount2 * 99n / 100n || 1n;
async function currentPool(previous) {
  const step = progress.steps[previous];
  return loadPool(client, deployment, { txHash: step.hash, index: step.stateIndex });
}
function operation(step, pool) {
  const s = pool.accounting, circulating = s.totalShares - s.lockedShares;
  const quote = (op) => transition(s, op);
  if (step === "xToY" || step === "yToX") {
    const amountIn = step === "xToY" ? 10000000000n : 40000000000n, probe = { kind: "swap", direction: step, amountIn, minOut: 1n };
    const out = step === "xToY" ? quote(probe).flows.receivedY : quote(probe).flows.receivedX;
    return { ...probe, minOut: slippage(out) };
  }
  if (step === "deposit" || step === "reenter") {
    const maxX = step === "deposit" ? 20000000000n : 10000000000n, maxY = maxX * s.y / s.x * 101n / 100n + 1n;
    const minted = quote({ kind: "deposit", maxX, maxY, minShares: 1n }).flows.mintedShares;
    return { kind: "deposit", maxX, maxY, minShares: slippage(minted) };
  }
  const shares = step === "partialWithdraw" ? circulating / 2n : circulating, flows2 = quote({ kind: "withdraw", shares, minX: 1n, minY: 1n }).flows;
  return { kind: "withdraw", shares, minX: slippage(flows2.receivedX), minY: slippage(flows2.receivedY) };
}
for (const [index, step] of STEPS.entries()) {
  if (progress.steps[step]) {
    console.log(`\u2713 ${step} already committed:`, progress.steps[step].hash);
    continue;
  }
  const probe = (await client.findCellsPagedNoCache({ script: owner, scriptType: "lock", scriptSearchMode: "exact", filter: { scriptLenRange: [0, 1], outputDataLenRange: [0, 1] } }, "asc", 1)).cells[0] ?? fail("no plain CKB cell to resolve the JoyID session");
  const resolved = await resolveJoyIdWallet({ current: () => ({ signer, revision: "playground" }) }, deployment, JOYID_PROFILE, probe);
  if (resolved.identity.keyType !== "main_key") fail("subkey sessions need an approved CoTA proof service; reconnect with the main key");
  const pool = index === 0 ? void 0 : await currentPool(STEPS[index - 1]);
  const intent = pool ? { kind: "transition", pool, action: operation(step, pool) } : { kind: "create", request: { parameters: POOL_PARAMETERS, x: INITIAL_LIQUIDITY.x, y: INITIAL_LIQUIDITY.y, minShares: slippage(createPool(POOL_PARAMETERS, INITIAL_LIQUIDITY.x, INITIAL_LIQUIDITY.y, 1n).flows.mintedShares), tokenOwner } };
  const walletPolicy = { ...resolved.wallet(), change: owner, feeRate: FEE_RATE, maxFee: MAX_FEE };
  const funded = await fundPoolTransaction(chain, deployment, walletPolicy, recipients, intent, { reservations });
  try {
    const prepared = await resolved.prepare(funded.built);
    const review = reviewPoolTransaction(deployment, { ...walletPolicy, funding: funded.funding }, recipients, intent, prepared);
    console.log(`STEP ${index + 1}/${STEPS.length}: ${step}`);
    console.log(ccc12.stringify({ action: review.summary.action, flows: review.summary.flows, fee: review.summary.fee, previous: review.summary.previous, next: review.summary.next, expiresAt: new Date(review.summary.expiresAt).toISOString() }));
    await render(prepared);
    const approve = globalThis.confirm;
    if (!approve || !approve(`Sign P6 step ${index + 1}/${STEPS.length} (${step})? Review the summary in the console first. Fee: ${review.summary.fee} shannons.`)) fail(`step ${step} not approved; nothing signed`);
    const signed = await resolved.bindReview(review).sign();
    const outcome = await recovery.submit(chain, review, signed, funded);
    if (outcome.outcome !== "sent") fail(`send outcome unknown for ${outcome.hash} (${outcome.error}); do NOT retry, inspect status first`);
    console.log(`${step} TX HASH:`, outcome.hash);
    await client.waitTransaction(outcome.hash, 1, 6e5);
    await recovery.archiveCommitted(client, outcome.hash, { minConfirmations: 1 });
    progress.steps[step] = { hash: outcome.hash, stateIndex: review.summary.stateOutputIndex };
    saveProgress();
  } finally {
    funded.release();
  }
}
console.log("P6 LIFECYCLE COMPLETE. Verify with: npm run pool:verify --", STEPS.map((s) => progress.steps[s].hash).join(" "));
