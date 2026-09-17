// GENERATED OPENSWAP JOYID CREATE/CANCEL TEST — replace all Playground code with this file.

// scripts/joyid-smoke.entry.ts
import { ccc as ccc6 } from "@ckb-ccc/ccc";
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
var DefaultAssetResolver = class {
  constructor(client2) {
    this.client = client2;
  }
  client;
  async known(script2) {
    const info = await this.client.getKnownScript(ccc2.KnownScript.XUdt);
    const args = ccc2.bytesFrom(script2.args);
    return script2.codeHash === info.codeHash && script2.hashType === info.hashType && (args.length === 32 || args.length === 36 && args.subarray(32).every((n) => n === 0));
  }
  async identify(script2, data) {
    if (!script2) return { asset: CKB, supported: data === void 0 || data === "0x", reason: data && data !== "0x" ? "Native CKB must have empty data" : void 0 };
    const supported = await this.known(script2) && (data === void 0 || /^0x[0-9a-fA-F]{32}$/.test(data));
    return { asset: udt(script2), supported, reason: supported ? void 0 : "Requires an AssetResolver for this script or data profile" };
  }
  async supports(script2, data) {
    return (await this.identify(script2, data)).supported;
  }
  async resolveCellDeps(script2) {
    if (!await this.known(script2)) throw new Error("Unsupported asset: supply an AssetResolver");
    return (await this.client.getKnownScript(ccc2.KnownScript.XUdt)).cellDeps;
  }
};
var defaultResolver = (client2) => new DefaultAssetResolver(client2);

// sdk/src/capacity.ts
import { ccc as ccc3 } from "@ckb-ccc/ccc";
function orderLock(deployment2, terms) {
  if (deployment2.hashType !== "data1") throw new Error("OpenSwap requires Data1");
  return ccc3.Script.from({ codeHash: deployment2.codeHash, hashType: "data1", args: encodeTerms(terms) });
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
function estimateCapacity(deployment2, input, offerAsset, offerAmount) {
  uint(offerAmount, offerAsset.kind === "ckb" ? 64 : 128);
  if (offerAmount === 0n || assetKey(offerAsset) === assetKey(input.askAsset)) throw new Error("Invalid offer or same-asset trade");
  const preliminary = { ...input, capacityRefund: 0n };
  const data = offerAsset.kind === "ckb" ? "0x" : amountData(offerAmount);
  const type = offerAsset.kind === "udt" ? offerAsset.script : void 0;
  const orderMinimum = ccc3.CellOutput.from({ lock: orderLock(deployment2, preliminary), type }, data).capacity;
  const paymentMinimum = ccc3.CellOutput.from({ lock: input.ownerLock, type: input.askAsset.kind === "udt" ? input.askAsset.script : void 0 }, input.askAsset.kind === "udt" ? amountData(input.askAmount) : "0x").capacity;
  const capacityRefund = input.askAsset.kind === "udt" && paymentMinimum > orderMinimum ? paymentMinimum : orderMinimum;
  const terms = { ...input, capacityRefund };
  const capacity = capacityRefund + (offerAsset.kind === "ckb" ? offerAmount : 0n);
  if (capacity > U64_MAX) throw new Error("Order capacity overflows u64");
  payment(terms);
  const cell = ccc3.CellAny.from({ cellOutput: { lock: orderLock(deployment2, terms), type, capacity }, outputData: data });
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
    const key2 = Array.from(n).join(",");
    if (!seen.has(key2)) {
      seen.add(key2);
      result.push(n);
    }
  }
  return result;
}

// sdk/src/orders.ts
import { ccc as ccc4 } from "@ckb-ccc/ccc";
async function assertNetwork(client2, deployment2) {
  if (client2.addressPrefix !== (deployment2.network === "testnet" ? "ckt" : "ckb") || (await client2.getHeaderByNumber(0))?.hash !== deployment2.genesisHash) throw new Error("OpenSwap deployment/network mismatch");
}
async function parse(cell, deployment2, resolver) {
  const { cellOutput: output, outputData: data } = cell;
  if (output.lock.codeHash !== deployment2.codeHash || output.lock.hashType !== "data1") throw new Error("Not an OpenSwap Data1 cell");
  const terms = decodeTerms(output.lock.args);
  if (terms.ownerLock.eq(output.lock)) throw new Error("Self-owner lock");
  const offerAsset = output.type ? udt(output.type) : CKB;
  let offerAmount;
  if (output.type) {
    offerAmount = parseAmount(data);
    if (terms.capacityRefund !== output.capacity) throw new Error("UDT refund mismatch");
  } else {
    if (data !== "0x") throw new Error("Native CKB data must be empty");
    const occupied = ccc4.CellOutput.from({ lock: output.lock }, "0x").capacity;
    if (terms.capacityRefund < occupied || terms.capacityRefund >= output.capacity) throw new Error("Invalid CKB refund");
    offerAmount = output.capacity - terms.capacityRefund;
  }
  if (output.capacity > U64_MAX || offerAmount <= 0n || assetKey(offerAsset) === assetKey(terms.askAsset)) throw new Error("Invalid offer");
  const offer = await resolver.identify(output.type, data);
  const ask = await resolver.identify(terms.askAsset.kind === "udt" ? terms.askAsset.script : void 0);
  let supportReason = offer.reason ?? ask.reason;
  try {
    payment(terms);
  } catch (error) {
    supportReason = String(error);
  }
  return { ...terms, outPoint: cell.outPoint, lock: output.lock, cell, offerAsset, offerAmount, supported: offer.supported && ask.supported && !supportReason, supportReason, genesisHash: deployment2.genesisHash };
}

// sdk/src/tx/builders.ts
import { ccc as ccc5 } from "@ckb-ccc/ccc";
function key(point2) {
  return `${point2.txHash}:${point2.index}`;
}
function distinct(cells) {
  if (!cells.length || cells.length > 32) throw new Error("Select 1..32 independent lots");
  if (new Set(cells.map((c) => key(c.outPoint))).size !== cells.length || new Set(cells.map((c) => c.cellOutput.lock.hash())).size !== cells.length) throw new Error("Duplicate OutPoint or OpenSwap lock group");
}
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
async function fresh(context, points) {
  await assertNetwork(context.signer.client, context.deployment);
  const cells = await Promise.all(points.map((p) => context.signer.client.getCellLive(p, true)));
  if (cells.some((c) => !c)) throw new Error("Order input is no longer live");
  const live2 = cells;
  if (live2.some((c) => c.cellOutput.lock.codeHash !== context.deployment.codeHash || c.cellOutput.lock.hashType !== "data1")) throw new Error("Not an OpenSwap order");
  distinct(live2);
  return live2;
}
async function tokens(tx, context) {
  const resolver = context.resolver ?? defaultResolver(context.signer.client);
  const assets = /* @__PURE__ */ new Map();
  const cells = await Promise.all(tx.inputs.map((i) => i.getCell(context.signer.client)));
  for (const c of cells) if (c.cellOutput.type) assets.set(c.cellOutput.type.hash(), c.cellOutput.type);
  for (const c of tx.outputs) if (c.type) assets.set(c.type.hash(), c.type);
  const changeLock = (await context.signer.getRecommendedAddressObj()).script;
  for (const type of assets.values()) {
    await tx.addCellDepInfos(context.signer.client, ...await resolver.resolveCellDeps(type));
    let balance = 0n;
    for (const cell of cells) if (cell.cellOutput.type?.eq(type)) {
      if (!await resolver.supports(type, cell.outputData)) throw new Error("Unsupported token input");
      balance += parseAmount(cell.outputData);
    }
    let required = 0n;
    tx.outputs.forEach((o, i) => {
      if (o.type?.eq(type)) required += parseAmount(tx.outputsData[i]);
    });
    if (required > U128_MAX || balance > U128_MAX) throw new Error("Token aggregate exceeds canonical xUDT u128 sum");
    if (balance < required) {
      await tx.completeInputs(context.signer, { script: type, scriptLenRange: [type.occupiedSize, type.occupiedSize + 1], outputDataLenRange: [16, 17] }, async (_acc, cell) => {
        if (!cell.cellOutput.type?.eq(type) || !await resolver.supports(type, cell.outputData)) throw new Error("Funding asset mismatch");
        balance += parseAmount(cell.outputData);
        if (balance > U128_MAX) throw new Error("Token aggregate overflow");
        return balance >= required ? void 0 : balance;
      }, balance);
      if (balance < required) throw new Error("Insufficient token funding");
    }
    const surplus = balance - required;
    if (surplus > 0n) tx.addOutput({ lock: changeLock, type }, amountData(surplus));
  }
}
async function finish(tx, context, check, feeOutput) {
  if (feeOutput === void 0) await tokens(tx, context);
  check(tx);
  await tx.completeInputsByCapacity(context.signer);
  check(tx);
  if (feeOutput === void 0) await tx.completeFeeBy(context.signer);
  else await tx.completeFeeChangeToOutput(context.signer, feeOutput);
  check(tx);
  const fee = await tx.getFee(context.signer.client);
  if (fee < 0n || fee > (context.maxFee ?? 100000000n)) throw new Error("Transaction fee exceeds configured maximum");
  if (new Set(tx.inputs.map((i) => key(i.previousOutput))).size !== tx.inputs.length) throw new Error("Duplicate funding input");
  for (let i = 0; i < tx.outputs.length; i++) {
    const output = tx.outputs[i];
    const minimum = ccc5.CellOutput.from({ lock: output.lock, type: output.type }, tx.outputsData[i]).capacity;
    if (output.capacity < minimum || output.capacity > U64_MAX) throw new Error("Output capacity invalid");
  }
  const expected = tx.hash();
  return { tx, deployment: context.deployment, assertLayout(candidate = tx) {
    check(candidate);
    if (candidate.hash() !== expected) throw new Error("Completed transaction changed; rebuild before signing");
  } };
}
async function createOrder(context, request) {
  await assertNetwork(context.signer.client, context.deployment);
  if (request.lots.length < 1 || request.lots.length > 32) throw new Error("Create 1..32 lots per transaction");
  const ownerLock = (await context.signer.getRecommendedAddressObj()).script;
  const resolver = context.resolver ?? defaultResolver(context.signer.client);
  for (const asset of [request.offerAsset, request.askAsset]) {
    if (!(await resolver.identify(asset.kind === "udt" ? asset.script : void 0)).supported) throw new Error("Unsupported asset");
  }
  const tx = ccc5.Transaction.from({});
  const ns = nonces(request.lots.length);
  request.lots.forEach((lot, i) => tx.addOutput(estimateCapacity(context.deployment, { ownerLock, nonce: ns[i], askAsset: request.askAsset, askAmount: lot.askAmount }, request.offerAsset, lot.offerAmount).cell));
  return finish(tx, context, pin(tx, 0, request.lots.length));
}
async function cancelOrders(context, points, options = {}) {
  const cells = await fresh(context, points);
  const owner2 = decodeOwner(cells[0].cellOutput.lock.args).ownerLock;
  if (cells.some((c) => !decodeOwner(c.cellOutput.lock.args).ownerLock.eq(owner2))) throw new Error("Cancellation requires one owner per builder invocation");
  if (!(await context.signer.getAddressObjs()).some((a) => a.script.eq(owner2))) throw new Error("Signer does not control the order owner");
  const known = await Promise.all([ccc5.KnownScript.JoyId, ccc5.KnownScript.Secp256k1Blake160].map((k) => context.signer.client.getKnownScript(k)));
  if (!known.some((k) => owner2.codeHash === k.codeHash && owner2.hashType === k.hashType) && !await options.compatibleOwner?.(owner2)) throw new Error("Owner cancellation compatibility must be explicitly established");
  const tx = ccc5.Transaction.from({ inputs: cells, cellDeps: [context.deployment.cellDep] });
  for (const cell of cells) tx.addOutput({ cellOutput: { lock: owner2, type: cell.cellOutput.type, capacity: cell.cellOutput.capacity }, outputData: cell.outputData });
  let proof;
  const minimum = ccc5.CellOutput.from({ lock: owner2 }, "0x").capacity;
  for await (const cell of context.signer.findCells({ scriptLenRange: [0, 1], outputDataLenRange: [0, 1] }, true)) {
    if (cell.cellOutput.lock.eq(owner2) && !cell.cellOutput.type && cell.outputData === "0x" && cell.cellOutput.capacity > minimum && !tx.inputs.some((i) => i.previousOutput.eq(cell.outPoint))) {
      proof = cell;
      break;
    }
  }
  if (!proof) throw new Error("Cancellation needs a separate plain CKB owner cell with spare capacity");
  const resolver = context.resolver ?? defaultResolver(context.signer.client);
  for (const cell of cells) if (cell.cellOutput.type) await tx.addCellDepInfos(context.signer.client, ...await resolver.resolveCellDeps(cell.cellOutput.type));
  tx.addInput(proof);
  tx.addOutput({ lock: owner2, capacity: minimum }, "0x");
  const proofCapacity = proof.cellOutput.capacity;
  const check = pin(tx, cells.length + 1, cells.length);
  return finish(tx, context, (candidate) => {
    check(candidate);
    const output = candidate.outputs[cells.length];
    if (!output || !output.lock.eq(owner2) || output.type || candidate.outputsData[cells.length] !== "0x" || output.capacity >= proofCapacity) throw new Error("Owner proof must decrease at the same index");
  }, cells.length);
}
async function submit(built, signer2) {
  await assertNetwork(signer2.client, built.deployment);
  built.assertLayout();
  for (const input of built.tx.inputs) {
    const live2 = await signer2.client.getCellLive(input.previousOutput, true);
    if (!live2) throw new Error("Input spent: rebuild or requote");
    const expected = await input.getCell(signer2.client);
    if (ccc5.hexFrom(live2.cellOutput.toBytes()) !== ccc5.hexFrom(expected.cellOutput.toBytes()) || live2.outputData !== expected.outputData) throw new Error("Funding data changed or indexer disagrees with live cell");
  }
  const prepared = await signer2.prepareTransaction(built.tx.clone());
  built.assertLayout(prepared);
  const rawHash = prepared.hash();
  const signed = await signer2.signOnlyTransaction(prepared);
  built.assertLayout(signed);
  if (signed.hash() !== rawHash) throw new Error("Wallet modified transaction contents");
  return signer2.client.sendTransaction(signed);
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

// scripts/joyid-smoke.entry.ts
var deployment = testnet_default;
var expectedAddress = "ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9qha8uqganyw9aavyyqeltvrlg59lp4svl02uvq";
var resumeCreateTxHash = "";
if (client.addressPrefix !== "ckt") throw new Error("Select Testnet");
var owner = await ccc6.Address.fromString(expectedAddress, client);
if (!(await signer.getAddressObjs()).some((a) => a.script.eq(owner.script))) throw new Error("Connect the replacement JoyID account ending svl02uvq");
console.log("OPENSWAP JOYID CREATE/CANCEL TEST \u2014 two wallet signatures, testnet only");
var createHash;
if (resumeCreateTxHash) createHash = ccc6.hexFrom(resumeCreateTxHash);
else {
  const askScript = await ccc6.Script.fromKnownScript(client, ccc6.KnownScript.XUdt, ccc6.hashCkb(crypto.getRandomValues(new Uint8Array(32))));
  const created = await createOrder({ signer, deployment }, { offerAsset: CKB, askAsset: udt(askScript), lots: [{ offerAmount: 1n, askAmount: 1n }] });
  console.log("Order capacity temporarily locked (CKB):", ccc6.fixedPointToString(created.tx.outputs[0].capacity));
  console.log("Create network fee (CKB):", ccc6.fixedPointToString(await created.tx.getFee(client)));
  await render(created.tx);
  console.log("REQUESTING CREATE SIGNATURE");
  createHash = await submit(created, signer);
  console.log("CREATE TX HASH:", createHash);
  await client.waitTransaction(createHash, 1);
}
var point = ccc6.OutPoint.from({ txHash: createHash, index: 0 });
var live = await client.getCellLive(point, true);
if (!live) throw new Error("Created order is not live; check whether it was already cancelled");
var order = await parse(live, deployment, defaultResolver(client));
if (!order.ownerLock.eq(owner.script)) throw new Error("Resume transaction belongs to another owner");
var cancelled = await cancelOrders({ signer, deployment }, [point]);
console.log("Cancel network fee (CKB):", ccc6.fixedPointToString(await cancelled.tx.getFee(client)));
await render(cancelled.tx);
console.log("REQUESTING CANCEL SIGNATURE");
var cancelHash = await submit(cancelled, signer);
console.log("CANCEL TX HASH:", cancelHash);
await client.waitTransaction(cancelHash, 1);
if (await client.getCellLive(point, true)) throw new Error("Order is unexpectedly still live");
console.log("JOYID CREATE/CANCEL COMMITTED:", createHash, cancelHash);
