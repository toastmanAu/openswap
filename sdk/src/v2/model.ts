// Reference model of the v2 fill rules. Mirrors, check for check and in the same
// order, contracts/openswap-lock-v2/src/fill.rs. Cells are abstract: locks and
// types are compared by label/hash only. Returns 0 for accept, else the error code.

/** Lock/type identity (any comparable string, e.g. a script hash). */
export type Id = string;
export interface ModelCell { lock: Id; type: Id | null; capacity: bigint; data: Uint8Array }
export interface ModelTerms {
  owner: Id; capacityRefund: bigint; ask: Id | null;
  askAmount: bigint; offerAmount: bigint; minFill: bigint;
}

/** sys::amount: data must be exactly 16 bytes. */
function amount(data: Uint8Array): bigint | undefined {
  if (data.length !== 16) return undefined;
  let n = 0n; for (let i = 15; i >= 0; i--) n = (n << 8n) | BigInt(data[i]!); return n;
}

export function checkFill(terms: ModelTerms, orderLock: Id, order: ModelCell, index: number, outputs: readonly ModelCell[]): number {
  const offerType = order.type, cIn = order.capacity;
  let amountIn: bigint | undefined;
  if (offerType !== null) {
    const a = amount(order.data);
    if (a === undefined) return 40;
    if (a === 0n) return 41;
    if (terms.capacityRefund !== 0n) return 42;
    amountIn = a;
  } else if (order.data.length !== 0) return 40;
  if (offerType === terms.ask) return 43;

  const payment = outputs[index];
  if (!payment) return 51;
  if (payment.lock !== terms.owner) return 52;
  if (payment.type !== terms.ask) return 53;

  const mine = outputs.filter(o => o.lock === orderLock);
  if (mine.length > 1) return 70;
  let remainder: { capacity: bigint; amount: bigint } | undefined;
  if (mine.length === 1) {
    const r = mine[0]!;
    if (r.type !== offerType) return 71;
    let a = 0n;
    if (amountIn !== undefined) { const x = amount(r.data); if (x === undefined) return 72; a = x; }
    else if (r.data.length !== 0) return 72;
    remainder = { capacity: r.capacity, amount: a };
  }
  const cOut = remainder?.capacity ?? 0n;
  if (cOut > cIn) return 73;
  const leaving = cIn - cOut;

  let taken: bigint, left: bigint;
  if (amountIn !== undefined) {
    const rest = remainder?.amount ?? 0n;
    if (rest > amountIn) return 74;
    taken = amountIn - rest; left = rest;
  } else {
    if (payment.capacity > leaving) return 74;
    taken = leaving - payment.capacity;
    if (remainder) { if (cOut < terms.capacityRefund) return 76; left = cOut - terms.capacityRefund; }
    else left = 0n;
  }
  if (taken === 0n) return 74;

  let paid: bigint;
  if (terms.ask === null) {
    if (payment.data.length !== 0) return 54;
    if (payment.capacity < leaving) return 56;
    paid = payment.capacity - leaving;
  } else {
    const p = amount(payment.data);
    if (p === undefined) return 54;
    if (payment.capacity !== (amountIn !== undefined ? leaving : terms.capacityRefund)) return 56;
    paid = p;
  }
  if (paid * terms.offerAmount < taken * terms.askAmount) return 55;
  if (remainder) {
    if (taken < terms.minFill) return 75;
    if (left < terms.minFill) return 76;
  }
  return 0;
}

/** Smallest payment a maker accepts for `taken` offer units (ceil, maker-favouring). */
export function requiredPayment(terms: Pick<ModelTerms, 'askAmount' | 'offerAmount'>, taken: bigint): bigint {
  return (taken * terms.askAmount + terms.offerAmount - 1n) / terms.offerAmount;
}
