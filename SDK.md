# OpenSwap v0.1 TypeScript / CCC SDK

## Package structure

```text
sdk/src/
├── index.ts
├── types.ts
├── codec.ts
├── assets.ts
├── capacity.ts
├── lots.ts
├── orders.ts
├── indexer.ts
├── quote.ts
├── tx/
│   ├── create.ts
│   ├── cancel.ts
│   ├── fill.ts
│   └── swap.ts
└── utils/
    ├── bigint.ts
    └── bytes.ts
```

---

## Public API target

```text
OpenSwap.codec.encodeTerms(...)
OpenSwap.codec.decodeTerms(...)

OpenSwap.orders.scan(client)
OpenSwap.orders.parse(cell)

OpenSwap.lots.plan(...)
OpenSwap.lots.estimateCapacity(...)

OpenSwap.tx.createOrder(...)
OpenSwap.tx.cancelOrders(...)
OpenSwap.tx.fillOrders(...)

OpenSwap.quote.swap(...)
OpenSwap.tx.executeSwap(...)

OpenSwap.assets.defaultResolver(client)
```

---

## Core types

```ts
export type AssetId =
  | { kind: "ckb" }
  | {
      kind: "udt";
      script: ccc.Script;
      scriptHash: ccc.Hex;
    };

export interface OpenSwapTerms {
  ownerLock: ccc.Script;
  nonce: Uint8Array;
  capacityRefund: bigint;
  askAsset: AssetId;
  askAmount: bigint;
}

export interface OpenSwapOrder {
  outPoint: ccc.OutPoint;

  lock: ccc.Script;
  ownerLock: ccc.Script;

  offerAsset: AssetId;
  offerAmount: bigint;

  askAsset: AssetId;
  askAmount: bigint;

  capacityRefund: bigint;

  blockNumber?: bigint;

  supported: boolean;
  supportReason?: string;
}
```

---

## Codec

Use CCC's canonical `Script.toBytes()` and `Script.fromBytes()`.

Use fixed-width LE encoding:
- u64 = 8 bytes,
- u32 = 4 bytes,
- u128 = 16 bytes.

Avoid custom CKB Script serialization.

---

## AssetResolver

```ts
export interface AssetResolver {
  identify(
    script?: ccc.Script,
    cellData?: ccc.Hex,
  ): Promise<ResolvedAsset>;

  resolveCellDeps(
    script: ccc.Script,
  ): Promise<ccc.CellDepInfo[]>;

  supports(
    script: ccc.Script,
    data: ccc.Hex,
  ): Promise<boolean>;
}
```

Default resolver:
- native CKB,
- canonical `KnownScript.XUdt`,
- 16-byte xUDT data only.

Unknown UDT-like types may be parsed but should be marked unsupported unless an adapter is supplied.

---

## Capacity estimator

Use CCC `CellOutput.from({lock,type}, outputData)` to derive minimum capacity.

### UDT -> CKB

```text
capacityRefund = orderMinimum
order.capacity = capacityRefund
```

### UDT -> UDT

```text
capacityRefund =
max(orderMinimum, futurePaymentMinimum)

order.capacity = capacityRefund
```

### CKB -> UDT

```text
capacityRefund =
max(orderMinimum, futurePaymentMinimum)

order.capacity =
capacityRefund + offeredCKB
```

Important:
- encode final args before calculating OpenSwap order minimum,
- `capacityRefund` has fixed width so setting its numeric value does not alter args length.

---

## Lot planner

Input:

```ts
interface LotPlanRequest {
  totalOffer: bigint;
  priceNumerator: bigint;
  priceDenominator: bigint;
  candidateCounts?: number[];
}
```

Default candidate counts:

```text
1, 2, 4, 8
```

Uniform division:
- distribute remainder across first lots.

Per-lot ask:

```text
ceil(
    lotOffer * numerator
    /
    denominator
)
```

Use bigint only.

Report:
- count,
- lot offer sizes,
- ask sizes,
- total ask,
- rounding premium,
- total CKB locked.

---

## Rounding premium

```text
wholeAsk =
ceil(totalOffer * num / den)

lotAsk =
sum(each lot ceil(...))

premium =
lotAsk - wholeAsk
```

Never weaken maker's requested limit.

---

## Nonce

Generate 16 random bytes using platform crypto API.

Ensure:
- not all zero,
- no duplicate within same creation batch.

---

## Chain discovery

Query live cells by OpenSwap lock prefix:

```ts
{
  script: {
    codeHash: OPEN_SWAP_CODE_HASH,
    hashType: "data1",
    args: "0x",
  },
  scriptType: "lock",
  scriptSearchMode: "prefix",
  withData: true,
}
```

Use CCC `client.findCells()`.

OutPoint remains the authoritative order ID.

Malformed cells:
- catch parse errors,
- hide from normal book,
- optionally expose in diagnostics.

---

## Parsed order checks

Mirror consensus:
- version,
- flags,
- reserved,
- nonce,
- ask amount,
- exact wire length,
- CKB/UDT offer shape,
- capacityRefund rule,
- same-asset rejection,
- owner != OpenSwap lock,
- 16-byte token data.

---

## Price sorting

Represent price as exact rational:

```text
askAmount / offerAmount
```

Compare:

```ts
a.askAmount * b.offerAmount
vs
b.askAmount * a.offerAmount
```

No JS `number` conversion.

---

## Transaction ordering

Always pin:

```text
OpenSwap inputs first
Maker payment outputs first
Input[i] corresponds to Output[i]
```

Then add:
- funding,
- proceeds,
- change.

Before signing, assert exact layout.

Any CCC completion method that reorders pinned entries must be rejected by SDK tests.

---

## Create order

One maker transaction may create N lots.

Each output:
- unique nonce,
- same price semantics,
- independent OutPoint.

No OpenSwap lock execution occurs simply because the output is created.

Relevant token type scripts do execute and therefore need deps.

---

## Cancel

Cancellation builder:
- OpenSwap order inputs first,
- recovered maker cells at same indices,
- separate plain CKB owner proof input,
- same-index proof output with slightly reduced capacity,
- complete fees from proof/funding input.

One proof can cancel many maker lots.

---

## Fill

Fill one or many orders:
- preserve pinned order/payment prefix,
- add token/CKB funding,
- add proceeds/surplus/change,
- include OpenSwap dep,
- include asset deps,
- validate client-side,
- broadcast.

---

## Custom RPC

SDK must accept:
- public default client,
- custom CKB node endpoint.

No OpenSwap-hosted service should be assumed.
