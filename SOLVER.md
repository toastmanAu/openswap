# OpenSwap v0.1 Reference Solver

## Principles

A solver is:
- permissionless,
- replaceable,
- non-custodial,
- non-authoritative.

It:
- discovers live order cells,
- finds compatible combinations,
- builds valid CKB transactions,
- pays network fee from its own fee wallet if needed,
- may retain residual spread.

It never needs user private keys.

---

## Package layout

```text
solver/src/
├── index.ts
├── config.ts
├── chain.ts
├── book.ts
├── matcher.ts
├── bundle.ts
├── settlement.ts
├── pending.ts
└── metrics.ts
```

---

## Indexed order

```ts
interface IndexedOrder {
  outPoint: ccc.OutPoint;

  ownerLock: ccc.Script;

  offerAsset: AssetId;
  offerAmount: bigint;

  askAsset: AssetId;
  askAmount: bigint;

  capacityRefund: bigint;
}
```

All state should be reconstructable from live chain cells.

---

## Directional books

Internally keep:

```text
A -> B
B -> A
```

separate.

Sort each by exact rational limit price.

---

## Two-order matching

For:

```text
L offers A asks B
R offers B asks A
```

match when:

```text
L.offerAmount >= R.askAmount
R.offerAmount >= L.askAmount
```

Residual values may be assigned to solver outputs.

---

## Multi-lot matching

For reciprocal sets:

```text
A_available = sum(left.offer)
A_required  = sum(right.ask)

B_available = sum(right.offer)
B_required  = sum(left.ask)
```

Bundle valid when:

```text
A_available >= A_required
B_available >= B_required
```

Reference strategy:
1. direct 1:1 matches,
2. if none, greedily accumulate bounded reciprocal bundles,
3. cap orders per settlement,
4. build transaction,
5. local assertions,
6. recheck liveness,
7. broadcast.

Suggested initial cap:

```text
MAX_ORDERS_PER_SETTLEMENT = 32
```

Implementation cap only; not protocol law.

---

## Fee wallet

Solver should hold a small ordinary CKB wallet.

Why:
- pure UDT<->UDT settlements may leave no free maker capacity for transaction fees because refunds are exact.

Fee wallet:
- funds network fee,
- can receive solver surplus.

It gives solver no protocol authority.

---

## Race handling

Expected:
- multiple solvers build against same order,
- one wins,
- others fail due dead input.

Before submission:
- check each selected OutPoint is still live,
- track local pending OutPoints.

On conflict:
- refresh,
- drop stale candidate,
- retry next route.

Do not implement global reservations.

---

## Instant swap router

A taker wants:

```text
buy A with B
```

Scan maker orders:

```text
A -> B
```

Sort best price.

Greedy accumulate lots until target is reached.

Because lots are indivisible, route may overfill.

Quote must show:
- requested output,
- delivered output,
- overfill,
- input required,
- network fee,
- number of lots,
- effective rational price.

For MVP:
- greedy selection,
- then inspect a bounded tail window of ~8–12 lots for a better subset.

Do not make optimal knapsack solving a v0.1 blocker.

---

## Quote structure

```ts
interface SwapQuote {
  tipBlock: bigint;
  selectedOrders: OpenSwapOrder[];
  amountIn: bigint;
  amountOut: bigint;
  overfill: bigint;
  networkFeeEstimate: bigint;
  effectivePriceNum: bigint;
  effectivePriceDen: bigint;
}
```

No fake expiry timestamp.

Before final signing:
- recheck selected OutPoints,
- reroute if any are spent.

---

## Metrics/events

Suggested structured events:

```text
order_discovered
order_removed
candidate_pair
candidate_bundle
bundle_rejected
settlement_built
settlement_submitted
settlement_committed
settlement_conflict
settlement_failed
```

Never log secrets/private keys.

---

## Future routing

Later:
- 3-asset rings,
- graph routing,
- AMM adapters,
- OTX liquidity,
- Fiber adapters.

These are optimizations over the same settlement foundation.

---

## v2 orders: partial fills and expiry (offline, 2026-10-29)

`ReferenceSolverV2` (`solver/src/runner-v2.ts`) runs on the v2 lock deployment and,
optionally, also whole v1 lots. It reuses the v1 runner's settlement loop
unchanged: reconcile the journal, reserve inputs, journal before the single send.

- **Matching** (`matchV2`, `matchPair`): reciprocal pairs, best prices first. One
  order is filled completely; the other only as much as needed, rounded up to
  its minimum fill. Every v2 leg is re-planned by the SDK and checked against the
  lock model. The solver keeps any spread. Pairwise only, not an optimal router.
- **Expiry policy:** time is the chain tip's timestamp, never the host clock.
  Orders within 300 s of expiry are not filled (median time lags the tip).
- **Keeper** (`returnExpired`): returns up to 16 expired orders per transaction to
  their owners, unchanged, and pays the fee. It waits until 900 s after expiry
  by tip time, so the median time used by `since` has passed.
- Evidence: solver unit tests; `lock-v2-tests` replays matcher-built pairs (60,
  50 with a partial leg) and SDK-planned chains on the real v2 binary.
