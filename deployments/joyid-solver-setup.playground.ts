// GENERATED OPENSWAP SEPARATE SOLVER SETUP — replace all Playground code with this file.

// scripts/joyid-solver-setup.entry.ts
import { ccc as ccc7 } from "@ckb-ccc/ccc";
import { signer, client, render } from "@ckb-ccc/playground";

// sdk/src/types.ts
var CKB = { kind: "ckb" };
var udt = (script2) => ({ kind: "udt", script: script2, scriptHash: script2.hash() });
var assetKey = (asset) => asset.kind === "ckb" ? "ckb" : asset.script.hash();

// sdk/src/codec.ts
import { ccc } from "@ckb-ccc/ccc";
var MAX_RUNNING_SCRIPT_BYTES = 4096;
var MAX_OWNER_SCRIPT_BYTES = 1024;
var MAX_ASK_SCRIPT_BYTES = 1024;
var U64_MAX = (1n << 64n) - 1n;
var U128_MAX = (1n << 128n) - 1n;
var WireError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "WireError";
  }
  code;
};
function fail(code, message) {
  throw new WireError(code, message);
}
function uint(value, bits, label = "amount") {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(bits)) throw new RangeError(`${label} must fit u${bits}`);
  return value;
}
function writeLE(value, size) {
  uint(value, size * 8);
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++, value >>= 8n) bytes[i] = Number(value & 255n);
  return bytes;
}
function readLE(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = n << 8n | BigInt(bytes[i]);
  return n;
}
function amountData(amount) {
  return ccc.hexFrom(writeLE(amount, 16));
}
function parseAmount(data) {
  if (!/^0x[0-9a-fA-F]{32}$/.test(data)) throw new Error("Token data must be exactly 16 bytes");
  return readLE(ccc.bytesFrom(data));
}
function boundedArgs(input) {
  const length = typeof input === "string" ? (input.length - 2) / 2 : input.length;
  if (length + 53 > MAX_RUNNING_SCRIPT_BYTES) fail(20, "Running script exceeds 4096 bytes");
  return typeof input === "string" ? ccc.bytesFrom(input) : input;
}
function script(bytes, code) {
  try {
    const parsed = ccc.Script.fromBytes(bytes);
    if (ccc.hexFrom(parsed.toBytes()) !== ccc.hexFrom(bytes)) fail(code, "Noncanonical Script");
    return parsed;
  } catch {
    return fail(code, "Invalid canonical Molecule Script");
  }
}
function decodeOwner(input) {
  const bytes = boundedArgs(input);
  if (bytes.length < 4) fail(21, "Args too short");
  const end = Number(readLE(bytes.subarray(0, 4)));
  if (end > MAX_OWNER_SCRIPT_BYTES) fail(22, "Owner Script too large");
  if (end > bytes.length) fail(23, "Owner Script truncated");
  return { ownerLock: script(bytes.subarray(0, end), 23), end };
}
function decodeTerms(input) {
  const bytes = boundedArgs(input);
  const { ownerLock, end } = decodeOwner(bytes);
  const tail = bytes.subarray(end);
  if (tail.length < 48) fail(21, "Tail too short");
  if (tail[0] !== 1) fail(27, "Unsupported version");
  if (tail[1] !== 0) fail(28, "Unsupported flags");
  if (tail[2] !== 0 || tail[3] !== 0) fail(29, "Reserved bytes nonzero");
  const nonce2 = tail.slice(4, 20);
  if (nonce2.every((n) => n === 0)) fail(30, "Zero nonce");
  const capacityRefund = readLE(tail.subarray(20, 28));
  const askSize = Number(readLE(tail.subarray(28, 32)));
  if (askSize > MAX_ASK_SCRIPT_BYTES) fail(24, "Ask Script too large");
  if (tail.length !== 48 + askSize) fail(26, "Incorrect args length");
  const askAsset = askSize === 0 ? CKB : udt(script(tail.subarray(32, 32 + askSize), 25));
  const askAmount = readLE(tail.subarray(32 + askSize));
  if (askAmount === 0n) fail(31, "Zero ask amount");
  return { ownerLock, nonce: nonce2, capacityRefund, askAsset, askAmount };
}
function encodeTerms(terms) {
  const owner2 = terms.ownerLock.toBytes();
  const ask = terms.askAsset.kind === "ckb" ? new Uint8Array() : terms.askAsset.script.toBytes();
  if (owner2.length > MAX_OWNER_SCRIPT_BYTES) fail(22, "Owner Script too large");
  if (ask.length > MAX_ASK_SCRIPT_BYTES) fail(24, "Ask Script too large");
  if (terms.nonce.length !== 16) throw new Error("Nonce must be 16 bytes");
  const bytes = new Uint8Array(owner2.length + 48 + ask.length);
  bytes.set(owner2);
  const tail = bytes.subarray(owner2.length);
  tail[0] = 1;
  tail.set(terms.nonce, 4);
  tail.set(writeLE(terms.capacityRefund, 8), 20);
  tail.set(writeLE(BigInt(ask.length), 4), 28);
  tail.set(ask, 32);
  tail.set(writeLE(terms.askAmount, 16), 32 + ask.length);
  decodeTerms(bytes);
  return ccc.hexFrom(bytes);
}

// sdk/src/assets.ts
import { ccc as ccc2 } from "@ckb-ccc/ccc";

// sdk/src/capacity.ts
import { ccc as ccc3 } from "@ckb-ccc/ccc";
function orderLock(deployment, terms) {
  if (deployment.hashType !== "data1") throw new Error("OpenSwap requires Data1");
  return ccc3.Script.from({ codeHash: deployment.codeHash, hashType: "data1", args: encodeTerms(terms) });
}
function payment(terms) {
  const token = terms.askAsset.kind === "udt";
  const data = token ? amountData(terms.askAmount) : "0x";
  const capacity = token ? terms.capacityRefund : terms.capacityRefund + terms.askAmount;
  uint(capacity, 64, "Payment capacity");
  const type = token && terms.askAsset.kind === "udt" ? terms.askAsset.script : void 0;
  const min = ccc3.CellOutput.from({ lock: terms.ownerLock, type }, data).capacity;
  if (capacity < min) throw new Error("Refund cannot fund the maker payment cell");
  return ccc3.CellAny.from({ cellOutput: { lock: terms.ownerLock, type, capacity }, outputData: data });
}
function estimateCapacity(deployment, input, offerAsset, offerAmount) {
  uint(offerAmount, offerAsset.kind === "ckb" ? 64 : 128);
  if (offerAmount === 0n || assetKey(offerAsset) === assetKey(input.askAsset)) throw new Error("Invalid offer or same-asset trade");
  const preliminary = { ...input, capacityRefund: 0n };
  const data = offerAsset.kind === "ckb" ? "0x" : amountData(offerAmount);
  const type = offerAsset.kind === "udt" ? offerAsset.script : void 0;
  const orderMinimum = ccc3.CellOutput.from({ lock: orderLock(deployment, preliminary), type }, data).capacity;
  const paymentMinimum = ccc3.CellOutput.from({ lock: input.ownerLock, type: input.askAsset.kind === "udt" ? input.askAsset.script : void 0 }, input.askAsset.kind === "udt" ? amountData(input.askAmount) : "0x").capacity;
  const capacityRefund = input.askAsset.kind === "udt" && paymentMinimum > orderMinimum ? paymentMinimum : orderMinimum;
  const terms = { ...input, capacityRefund };
  const capacity = capacityRefund + (offerAsset.kind === "ckb" ? offerAmount : 0n);
  if (capacity > U64_MAX) throw new Error("Order capacity overflows u64");
  payment(terms);
  const cell = ccc3.CellAny.from({ cellOutput: { lock: orderLock(deployment, terms), type, capacity }, outputData: data });
  return { terms, cell, orderMinimum, paymentMinimum, capacityRefund, capacity };
}

// sdk/src/lots.ts
function nonce() {
  for (; ; ) {
    const value = crypto.getRandomValues(new Uint8Array(16));
    if (value.some((n) => n !== 0)) return value;
  }
}
function nonces(count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1024) throw new Error("Invalid batch count");
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  while (result.length < count) {
    const n = nonce();
    const key = Array.from(n).join(",");
    if (!seen.has(key)) {
      seen.add(key);
      result.push(n);
    }
  }
  return result;
}

// sdk/src/orders.ts
import { ccc as ccc4 } from "@ckb-ccc/ccc";
async function assertNetwork(client2, deployment) {
  if (client2.addressPrefix !== (deployment.network === "testnet" ? "ckt" : "ckb") || (await client2.getHeaderByNumber(0))?.hash !== deployment.genesisHash) throw new Error("OpenSwap deployment/network mismatch");
}

// sdk/src/tx/builders.ts
import { ccc as ccc5 } from "@ckb-ccc/ccc";
function pin(tx, inputs, outputs) {
  const ins = tx.inputs.slice(0, inputs).map((i) => ccc5.hexFrom(i.toBytes()));
  const outs = tx.outputs.slice(0, outputs).map((o, i) => [ccc5.hexFrom(o.toBytes()), tx.outputsData[i]]);
  return (candidate) => {
    if (candidate.inputs.length < inputs || candidate.outputs.length < outputs) throw new Error("Pinned prefix removed");
    ins.forEach((v, i) => {
      if (ccc5.hexFrom(candidate.inputs[i].toBytes()) !== v) throw new Error("Pinned input reordered or changed");
    });
    outs.forEach(([v, data], i) => {
      if (ccc5.hexFrom(candidate.outputs[i].toBytes()) !== v || candidate.outputsData[i] !== data) throw new Error("Pinned maker output reordered or changed");
    });
  };
}
async function submit(built2, signer2) {
  await assertNetwork(signer2.client, built2.deployment);
  built2.assertLayout();
  for (const input of built2.tx.inputs) {
    const live = await signer2.client.getCellLive(input.previousOutput, true);
    if (!live) throw new Error("Input spent: rebuild or requote");
    const expected = await input.getCell(signer2.client);
    if (ccc5.hexFrom(live.cellOutput.toBytes()) !== ccc5.hexFrom(expected.cellOutput.toBytes()) || live.outputData !== expected.outputData) throw new Error("Funding data changed or indexer disagrees with live cell");
  }
  const prepared = await signer2.prepareTransaction(built2.tx.clone());
  built2.assertLayout(prepared);
  const rawHash = prepared.hash();
  const signed = await signer2.signOnlyTransaction(prepared);
  built2.assertLayout(signed);
  if (signed.hash() !== rawHash) throw new Error("Wallet modified transaction contents");
  return signer2.client.sendTransaction(signed);
}

// scripts/lib/solver-setup.ts
import { ccc as ccc6 } from "@ckb-ccc/ccc";
async function buildSolverSetup(context, recipient) {
  const { signer: signer2, deployment } = context, client2 = signer2.client;
  await assertNetwork(client2, deployment);
  if (deployment.network !== "testnet") throw new Error("Testnet only");
  const owner2 = (await signer2.getRecommendedAddressObj()).script;
  if (owner2.eq(recipient)) throw new Error("Solver must use a separate wallet");
  const token = await ccc6.Script.fromKnownScript(client2, ccc6.KnownScript.XUdt, owner2.hash());
  const tx = ccc6.Transaction.from({});
  tx.addOutput(estimateCapacity(deployment, { ownerLock: owner2, nonce: nonces(1)[0], askAsset: udt(token), askAmount: 1n }, CKB, 1n).cell);
  tx.addOutput({ lock: recipient, capacity: ccc6.fixedPointFrom("2000") }, "0x");
  tx.addOutput({ lock: recipient, type: token }, amountData(100n));
  const check = pin(tx, 0, 3);
  await tx.addCellDepsOfKnownScripts(client2, ccc6.KnownScript.XUdt);
  let balance = 0n;
  await tx.completeInputs(signer2, { script: token, scriptLenRange: [token.occupiedSize, token.occupiedSize + 1], outputDataLenRange: [16, 17] }, async (_acc, cell) => {
    if (!cell.cellOutput.lock.eq(owner2) || !cell.cellOutput.type?.eq(token)) throw new Error("Unexpected token funding");
    balance += parseAmount(cell.outputData);
    if (balance > U128_MAX) throw new Error("Token sum overflow");
    return balance >= 100n ? void 0 : balance;
  }, 0n);
  if (balance < 100n) throw new Error("Need 100 units of the previously minted test token");
  if (balance > 100n) tx.addOutput({ lock: owner2, type: token }, amountData(balance - 100n));
  await tx.completeInputsByCapacity(signer2);
  await tx.completeFeeBy(signer2);
  check(tx);
  const fee = await tx.getFee(client2);
  if (fee < 0n || fee > (context.maxFee ?? 100000000n)) throw new Error("Setup fee exceeds cap");
  const hash2 = tx.hash();
  return { tx, deployment, assertLayout(candidate = tx) {
    check(candidate);
    if (candidate.hash() !== hash2) throw new Error("Setup transaction changed");
  } };
}

// deployments/testnet.json
var testnet_default = {
  network: "testnet",
  genesisHash: "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606",
  codeHash: "0x1d4e322540cbec1d1fdf2ca4a13b12521401d6c1ed5f0432c01cce84ea94eddf",
  hashType: "data1",
  cellDep: {
    outPoint: {
      txHash: "0x070bdab0b200bb12faca14662c2c7ebbaeaecf51b1da05170e4d5de5c4dc3fca",
      index: "0x0"
    },
    depType: "code"
  },
  binarySha256: "060b0b73f91a960a965fcfaeb68dc40ada0557ff24e0c086c89611dd471340ab",
  binaryBytes: 28592
};

// deployments/solver-wallet.json
var solver_wallet_default = { network: "testnet", address: "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqgp9mnd6kevd2wgrenv6c09zk7qe9g2vjsyhqsv2", lock: { codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8", hashType: "type", args: "0x012ee6dd5b2c6a9c81e66cd61e515bc0c950a64a" } };

// scripts/joyid-solver-setup.entry.ts
var owner = await ccc7.Address.fromString("ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq", client);
if (!(await signer.getRecommendedAddressObj()).script.eq(owner.script)) throw new Error("Connect JoyID wallet ending svl02uvq");
console.log("OPENSWAP SEPARATE SOLVER SETUP \u2014 one JoyID signature");
console.log("Local testnet solver address:", solver_wallet_default.address);
var built = await buildSolverSetup({ signer, deployment: testnet_default }, ccc7.Script.from(solver_wallet_default.lock));
console.log("Solver plain CKB:", ccc7.fixedPointToString(built.tx.outputs[1].capacity));
console.log("Solver token cell CKB:", ccc7.fixedPointToString(built.tx.outputs[2].capacity));
console.log("Maker order CKB:", ccc7.fixedPointToString(built.tx.outputs[0].capacity));
console.log("Network fee CKB:", ccc7.fixedPointToString(await built.tx.getFee(client)));
await render(built.tx);
console.log("REQUESTING SETUP SIGNATURE");
var hash = await submit(built, signer);
console.log("SOLVER SETUP TX HASH:", hash);
await client.waitTransaction(hash, 1);
console.log("SOLVER SETUP COMMITTED:", hash);
