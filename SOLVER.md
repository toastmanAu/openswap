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
candidate_pair     (v2: two reciprocal orders)
candidate_book     (v2: several orders in one market)
candidate_ring     (v2: a cycle of three assets; details include the route)
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
- **Live ring (2026-10-30, `scripts/lock-v2-ring.ts`, `deployments/lock-v2-ring.json`):**
  three test wallets placed CKB->TEST2 (400 CKB for 4,000 TEST2), TEST2->TEST3
  (6,000 TEST2 for 2,400 TEST3) and TEST3->CKB (2,000 TEST3 for 480 CKB). No two
  share a market, so `ReferenceSolverV2` found the ring and settled it in one
  journaled transaction, `0x21543cfa…9f0fa` (block 22,901,977): the CKB order filled
  whole, the TEST2 order sold 4,000 for 1,600 TEST3 and the TEST3 order sold 1,600
  for 384 CKB, both remainders live. Checked on both endpoints as above; the solver
  kept 16 CKB and added no tokens or capacity of its own.
  The recorded solver events predate the event rename (2026-10-30), so the journal
  logs this ring as `candidate_pair`; the runner now emits `candidate_ring` with the route.

---

## Always-on service (2026-11-01)

`SolverService` (`solver/src/service.ts`) runs a solver in a loop;
`npm run solver:service` (`scripts/solver-service.ts`) runs `ReferenceSolverV2` on
testnet with the solver wallet, over v2 orders and whole v1 lots. **Dry run by
default:** it builds what it would send and reports it. `--execute` sends.

Each cycle (every 15 s by default):
1. Archives journaled settlements committed at least 24 blocks deep, and marks their
   live outputs usable again, so the solver's own change is spent in later
   settlements (before this, a long-running solver would have locked itself out of
   its change).
2. Checks sending is allowed: the fee wallet holds at least its floor (500 CKB) and
   the fees paid in the last 24 h are under the budget (0.5 CKB). If not, the cycle
   still scans and builds, sends nothing, and the status says why.
3. Settles up to 4 matches (one per tick: pairs, books, rings), checking the budget
   before each send, so it is overshot by at most one transaction's fee (cap 0.01 CKB).
4. Returns up to 16 expired v2 orders to their owners (the keeper).
5. Writes `.local/solver-service/status.json`: mode, state (`running`, `paused`,
   `error`, `stopped`), pause reasons, balance, fees in the last 24 h, what was last
   built and sent, active journal rows, and rows that need the operator.

Settlements are built at 1,000 shannons/KB, capped at 0.01 CKB each. Errors back
off exponentially (to 5 min) and clear on the next good cycle. Rejected rows, and
rows unresolved for 30 min, are listed under `attention` and stay reserved; the
service never abandons or resends them; resolve them with `npm run solver-journal`
(`--journal-dir=.local/solver-service/journal`, after stopping the service, since
the journal admits one writer). Fees already paid carry over a restart through the
status file. SIGINT or SIGTERM stops after the cycle in progress.

**On a server:** `docs/SOLVER_SERVICE_RUNBOOK.md` with the systemd units in
`deploy/solver/`. The key comes from `OPENSWAP_SOLVER_KEY_FILE` or systemd's
`LoadCredential` (refused if group or others can read it) and state from
`OPENSWAP_SOLVER_STATE_DIR`. `npm run solver:health` (`assessStatus`) reads the
status file and fails on a stale cycle, errors, paused sending, a stopped service or
journal rows needing the operator; a timer runs it every 5 minutes, with optional
dead-man pings. One running instance per solver wallet.

Runner fix that goes with it: with a journal, the runner now rebuilds its pending
set from the journal each tick; before, an archived row stayed in memory and the
next tick failed reading it.

Evidence: 10 service tests (dry run, per-cycle cap, budget pause and carry-over,
balance floor, archive at depth with outputs freed, attention list, backoff, stop),
a runner test for archived rows. First dry cycle on testnet (2026-11-01): no
crossing orders; would return five expired orders in one transaction.

**Supervised live run (2026-11-01, `--execute` on the development machine).** The
first cycle sent that return, `0x46c2c0c7…c93f` (block 22,928,102, fee 0.00001638
CKB): 1,650 TEST3, 400 TEST3, 550 TEST3, 2,000 TEST2 and 648 CKB, each back to its
owner unchanged at its own index after expiry. `scripts/solver-service-verify.ts`
checks this on both endpoints (`deployments/solver-service.json`); it also checks
settlements against the reference model with per-asset conservation. The service
archived the return 24 blocks deep (about 4 minutes later).

**Live settlement by the service (2026-11-01, `scripts/solver-service-pair.ts`,
`deployments/solver-service-pair.json`).** That script places orders and never runs
a solver. The maker offered 1,000 TEST3 for 2,000 TEST2 (`0xb3c2a943…`) and wallet C
1,800 TEST2 for 800 TEST3 (`0x8f83c685…`). The running service found the pair
within one cycle and settled it, `0x6f533564…30ed` (block 22,929,128, fee 0.00001599
CKB): C filled whole (800 TEST3), the maker sold 800 TEST3 for 1,600 TEST2 with
200 TEST3 left live, and the solver kept 200 TEST2. The solver funded it with the
change output of its earlier return (`0x46c2c0c7…:5`), freed by the archive step.
Verified on both endpoints by `scripts/solver-service-verify.ts`: reference model at
every order input, payments at order indexes, per-asset conservation, solver-only
other cells. The 200 TEST3 remainder expired at 04:28 UTC and the keeper returned
it at 04:44 (`0xeae77d5c…fa5a`, block 22,930,152, fee 0.00000691 CKB, verified).

**Outage (2026-11-03 05:59 to 2026-11-04 03:57 UTC).** The development laptop
suspended and then had no DNS for about 22 hours. The service logged 257
consecutive `fetch failed` cycles at the 5-minute backoff cap, sent nothing, and
resumed by itself when the network returned; nothing was pending at the time.
