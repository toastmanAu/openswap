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

- **Matching** (`matchV2`, `matchBook`; `matchPair` is the two-order case):
  several orders per side of one market in one settlement. Both sides are sorted
  best price first (at most 24 per side); every pair of prefixes up to `maxLegs`
  orders (default 8) is tried. In each, one side fills whole and only the last
  order on the other side may fill partly, by as little as its rules allow. A
  plan is kept only if no asset goes negative (inventory-free), and the one that
  delivers the most wins, preferring fewer legs on ties. A marginal order that does
  not cross on its own can still fill when the batch balances; every maker is
  paid at least its own price either way. Every v2 leg is re-planned by the SDK
  and checked against the lock model. The solver keeps any spread.
- **Rings** (`matchRing`, 2026-10-29): when no direct match exists, `matchV2`
  looks for three books forming a cycle of assets (A->B, B->C, C->A), trying the
  best 4 orders per book. One order fills whole and each next order takes just
  enough to pay the one before it; the ring closes when the first order delivers
  enough to pay the last. Every order is tried as the whole one; the plan with
  the most orders filled whole, then the most paid, is kept. A ring settles only
  when the product of its prices is at most 1, inventory-free, each maker at its
  price. Not an optimal router: one order per edge of a ring, three assets.
- **Expiry policy:** time is the chain tip's timestamp, never the host clock.
  Orders within 300 s of expiry are not filled (median time lags the tip).
- **Keeper** (`returnExpired`): returns up to 16 expired orders per transaction to
  their owners, unchanged, and pays the fee. It waits until 900 s after expiry
  by tip time, so the median time used by `since` has passed.
- Evidence: solver unit tests (multi-order books, leg cap, v1 lots, a four-order
  runner settlement); `lock-v2-tests` replays matcher-built pairs (60, 50 with a
  partial leg), matcher-built books (60 settlements, 253 legs, up to 8 per
  settlement, 54 with a partial leg; token amounts and capacity conserved, checked
  from the cells), matcher-built rings (60, both cycle orientations over two
  tokens and CKB, conservation checked from the cells) and SDK-planned chains on
  the real v2 binary.
- **Live (2026-10-29, `scripts/lock-v2-multi.ts`, `deployments/lock-v2-multi.json`):**
  the maker placed three TEST2-for-CKB orders (0.090, 0.092, 0.094 CKB each,
  2,000 TEST2 apiece) and test wallet A offered 1,200 CKB for TEST2 at 0.10.
  `ReferenceSolverV2` run by test wallet B settled all four in one journaled
  transaction, `0x8c7a20aa…12fe4` (block 22,901,010): the three sells filled whole
  and A's order partly (552 CKB for 5,520 TEST2, remainder live under identical
  args). On both endpoints every order input is accepted by the reference model,
  payments sit at order indexes, token and capacity paid out never exceed what the
  orders held, and every other input and output is the solver's. The solver kept
  480 TEST2. `scripts/market-verify.ts` also reads it as exactly these four fills.
