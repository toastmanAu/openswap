# Order lock v2: partial fills and expiry (DRAFT for review, 2026-10-29)

Status (2026-10-29): design approved by the user with the defaults below. Steps
1–5 are done; the lock is deployed on testnet and passed a local-key live run. It reopens two frozen v0.1
decisions in [DECISIONS.md](../../DECISIONS.md) ("full-fill lots only", "no
expiry v0.1") for v2 only. v1 is unchanged and remains deployed.

## Goals

1. **Partial fills.** One order can be filled in several pieces at the maker's
   fixed price, without the solver paying for the maker's storage.
2. **Expiry.** A maker can set a time after which anyone may send the order back
   to them unchanged, without the maker signing.
3. Keep everything v1 guarantees: permissionless fills and solvers, the maker's
   price is always met, same-index payment binding, owner cancellation that
   works even for malformed args, no admin, fee or upgrade key.

## What expiry can and cannot mean on CKB

`since` can only say "not before". Header deps are chosen by the spender, so they
are not a clock. **No lock can stop a fill after a deadline.** v2 expiry is
therefore:

- after the expiry time, the order may also be **returned** to the owner by
  anyone, enforced by an absolute `since` on the order input;
- the reference solver and app **stop filling** at expiry and return expired
  orders themselves;
- until someone returns it, a third party ignoring the convention can still fill
  it, **at the maker's price**. The UI must say exactly this ("after <time>,
  this order can be returned to you by anyone; it may still be filled at your
  price until then").

## Deployment shape

- A new binary (`openswap-lock` crate, tail version 2) gets a new `data1` code
  hash. It accepts only version 2 tails.
- The v1 binary stays deployed. Existing v1 orders keep working (fill, cancel).
  The SDK reads both. After the v2 deployment, the app creates only v2 orders.
- Pools are unaffected.

## Args (version 2)

Same leading owner Script as v1. Tail, offsets from `owner_lock.end`:

| Offset | Size | Field | Rule |
|---:|---:|---|---|
| 0 | 1 | version | `2` |
| 1 | 1 | flags | `0` |
| 2 | 2 | reserved | `0` |
| 4 | 16 | nonce | non-zero |
| 20 | 8 | capacity_refund | see capacity rules |
| 28 | 8 | expiry | `0` = none, else a CKB absolute `since` value (block number or timestamp metric) |
| 36 | 4 | ask_script_size | `0` = CKB |
| 40 | N | ask_type_script | canonical Molecule Script |
| 40+N | 16 | ask_amount | > 0 |
| 56+N | 16 | offer_amount | > 0 |
| 72+N | 16 | min_fill | > 0, ≤ offer_amount |

Fixed tail is 88 bytes, so `args.len() == O + 88 + A` exactly. The price is the
ratio `ask_amount / offer_amount` and never changes. `min_fill == offer_amount`
means full fills only, which is equivalent to a v1 order.

Because a partial fill recreates the order with **identical args**, price,
owner, expiry and nonce carry over to the remainder unchanged.

## Spend paths

Validation order, for the single order input at absolute index `i`:

1. Parse the owner Script only.
2. **Cancel** (unchanged from v1): an exact recovery output at `i` plus the
   owner proof cell. No tail parsing, so malformed tails stay rescuable.
3. Parse the tail.
4. **Expiry return:** an exact recovery output at `i` (owner lock, same type, same
   data, capacity ≥ input), no output with the order lock, `expiry != 0`, and the
   order input's `since` is absolute, uses the same metric as `expiry`, and has a
   value ≥ `expiry`. Whoever submits it pays the network fee from their own cells.
5. **Fill** (full or partial), below.

## Fill rules

Let `C_in` be the order capacity and `R` the optional **remainder**: the only
output whose lock hash equals the running lock hash. Zero or one is allowed,
and two or more are rejected. If `R` exists it must have the same type as the
input, and data that is empty (CKB offer) or exactly 16 bytes (UDT offer).
`C_out` is R's capacity, or 0 if there is no remainder. `D = C_in - C_out` is
the capacity leaving the order. The payment is `Output[i]`, which must have
the owner lock and the ask type.

**Offered amount consumed (`t`)** and **remainder offer**:

| Offer | `t` | remainder offer |
|---|---|---|
| UDT | `amount_in - amount_R` | `amount_R` |
| CKB | `D - payment.capacity` | `C_out - capacity_refund` |

**Payment received (`paid`)** and capacity rule:

| Offer → Ask | Payment capacity | `paid` |
|---|---|---|
| UDT → CKB | `≥ D`, no type, empty data | `payment.capacity - D` |
| UDT → UDT | `== D` | `u128(payment.data)` |
| CKB → UDT | `== capacity_refund` | `u128(payment.data)` |

Every unit of capacity that leaves the order lands in the maker's payment cell.
The solver never funds maker storage, and can never take maker capacity.

**Checks for every fill:**

- `t > 0`
- **Price:** `paid × offer_amount ≥ t × ask_amount`, computed in U256. Rounding
  always favours the maker.
- If R exists (partial fill): `t ≥ min_fill` and remainder offer `≥ min_fill`, so
  a fill can never leave unfillable dust. For a CKB offer, `C_out ≥
  capacity_refund + min_fill`.
- If there is no remainder (final fill): any `t > 0`.
- A UDT offer requires `capacity_refund == 0`. The field is unused there, and
  requiring zero keeps the encoding canonical.
- Same-asset orders are rejected, as in v1.

**Single fill = v1.** Without a remainder, a UDT→CKB payment needs `≥ C_in + paid`
and a UDT→UDT payment needs `== C_in`. These are the v1 rules with
`capacity_refund = C_in`. For CKB→UDT, `t = C_in - capacity_refund`.

## What partial fills cost the maker

- **UDT → CKB:** nothing extra. Each fill pays plain CKB to the maker, and any
  fill can pay ≥ 61 CKB.
- **UDT → UDT:** each partial payment cell needs about 144 CKB, taken from the
  order's capacity. The app pre-funds the order for "up to N partial fills". When
  that capacity runs out, only a final fill is possible. No solver subsidy.
- **CKB → UDT:** each partial payment cell's `capacity_refund` (≈144 CKB) comes
  out of the order's CKB. That CKB is the maker's own and stays in the maker's
  wallet as the payment cell's storage. It does mean that **after k partial
  fills, k × capacity_refund less CKB is sold**. (Changed during the SDK build:
  pre-funding a reserve here would let a single final fill buy the reserve too,
  selling more CKB than the maker offered, because the lock cannot tell reserve
  CKB from offered CKB. So CKB offers carry no reserve, and the app discloses
  the shortfall instead.)

Example (UDT → CKB): sell 10,000 TEST for 1,000 CKB, min fill 1,000 TEST.
- A taker fills 2,500 TEST and must pay ≥ 250 CKB to the maker at output `i`. The
  remainder holds 7,500 TEST under identical args.
- A second taker fills the last 7,500 TEST for ≥ 750 CKB and receives the
  remainder's capacity in the payment too.

## Security notes and trade-offs

- **Contention.** One partially fillable order is a single cell, so concurrent
  takers conflict. Lots still work: a maker can create several v2 lots, each
  partially fillable.
- **Griefing.** Min fill bounds dust fills. Every fill pays the maker at their
  price, and the filler pays the network fee.
- **Expiry is soft.** See above. The order is never at risk of a worse price, only
  of being filled at a now-stale price.
- **`since` timestamp lag.** The timestamp metric compares against median block
  time, which lags wall time by minutes. The app should show expiry as "about".
- **Keeper incentive.** No tip in this draft. The reference solver returns
  expired orders as a service, and the maker can always cancel. An optional
  keeper tip is possible later but adds a value-extraction path.
- **Audit scope** grows from the v1 lock to the v1 lock, the v2 lock and the pool.
  v2 adds about 150 lines of consensus code plus U256 multiplication (from
  `pool-arithmetic`).

## Build plan (each step offline unless stated)

1. **Spec and model:** `WIRE_FORMAT` v2 section, TS reference model of the fill
   rules, golden vectors shared by Rust and TS.
2. **Contract:** v2 parsing, fill, return and cancel; VM tests for every rule,
   tampers (remainder type/args/duplicates, payment capacity theft, rounding, dust,
   since metric and value, malformed tail rescue); property tests against the model.
3. **SDK:** v2 encode/decode, discovery of v1 and v2 orders, builders for
   create, partial fill, return and cancel; quotes that can take part of an order.
4. **Solver:** partial matching, skip expired orders, return expired orders.
5. **Frontend:** create form (min fill, "good until", partial-fill reserve),
   order book showing remaining amount and expiry, review lines, return button.
6. **Testnet (needs approval):** deploy v2, live create, partial fill, final
   fill, expiry return and cancel with local keys and then JoyID; campaigns;
   Pages deploy.

## Decisions (user, 2026-10-29)

1. Soft expiry as described: permissionless return, fills possible until returned.
2. Timestamp expiry only. The contract rejects other `since` metrics (code 37);
   the app shows the time as approximate.
3. No keeper tip.
4. After deployment the app creates only v2 orders and still fills and cancels v1.

## Build status

| Step | State |
|---|---|
| 1. Spec and model | Done. `WIRE_FORMAT.md` v2 section; `sdk/src/v2/` codec and fill model; 22 wire and 647 fill vectors |
| 2. Contract | Done. `contracts/openswap-lock-v2`: 30,000 bytes, sha256 `0f5e8e73…6350`, data hash `0x71027f76…3ede`. `lock-v2-tests`: all fill vectors give the model's exact verdict on the binary (369 accepted, max 70,082 cycles); cancel and malformed-tail rescue; expiry `since` boundaries; no recreation on return; chained partial fills; two partial orders in one transaction; wide product checked against U256 |
| 3. SDK | Done (offline). `sdk/src/v2/`: create sizing (`planCreateV2`), decode/parse, fill planning (`planFillV2`, `partialRange`; every plan is checked against the model, and cells are built at exact capacity because CCC silently raises too-small capacities), builders for create, fill (partial v2 plus whole v1 lots in one transaction), expiry return (`since` = expiry) and cancel, `scanV2`, and `quoteMixed` over v1 and v2 with expiry margin. 8 builder/planner tests; VM replay of SDK-planned chains (`npm run campaign -- lock-v2-sdk`; 1,200 chains, 2,658 transactions, 1,458 partial fills verified at seed 29) |
| 4. Solver | Done (offline). `matchV2`/`matchPair` (pairwise, partial legs, expiry margin by chain time), `ReferenceSolverV2` on the shared journaled settlement loop, keeper `returnExpired` (900 s after expiry by tip time). 6 solver tests; 60 matcher-built pairs replayed on the binary |
| 5. Frontend | Done (offline). Gated on a served v2 manifest; create form (partial fills, min fill, good until), mixed quotes and partial fills, rows with remaining/minimum/expiry, Return to owner, v2 cancel. 3 browser tests (28 total) |
| 6. Testnet | In progress. Deployed (user approved) 2026-10-29: tx `0xf2d18570…8457`, block 22,898,419, code cell under the always-fail lock, 30,041 tCKB from the split-maker test key; verified on both endpoints (`deployments/testnet-v2.json`, `scripts/lock-v2-deploy.ts`). Local-key live run (`scripts/lock-v2-live.ts`, `deployments/lock-v2-live.json`), every step model-checked on both endpoints: see below. Pages deploy `0754cabe` (source `e1f617c`) ships the v2 manifest; served files match the release on toastdex.org, toastdex.pages.dev and the deployment URL; 28 browser tests pass on both. JoyID partial fill on toastdex.org verified, and the live campaign passed (below). Step 6 done |

### Live run with local keys (2026-10-29)

Maker: split-maker test key. Taker and keeper: contention test key.

| Step | Transaction | Block | Result |
|---|---|---:|---|
| createB | `0xd0fedac0…1a0f` | 22,898,443 | 100 TEST3 for 50 CKB, whole only, expiry about 2 min |
| createA | `0x480fde09…0e6f` | 22,898,448 | 1,000 TEST2 for 300 CKB, min fill 250, up to 2 partial fills |
| createC | `0x8cc2a431…f452` | 22,898,452 | 400 CKB for 1,000 TEST2, min fill 100 CKB |
| fillA1 | `0xceec5c80…6f0e` | 22,898,456 | partial: took 400 TEST2, maker paid 120 CKB, remainder 600 TEST2 under identical args |
| fillA2 | `0x07dba1cd…17df` | 22,898,463 | final: took 600 TEST2, maker paid 180 CKB plus the order capacity |
| fillC1 | `0x4c4953c7…3a6e` | 22,898,469 | partial CKB offer: took 100 CKB, maker paid 250 TEST2 in a capacity_refund cell, remainder 300 CKB |
| cancelC | `0xdb012842…3f74` | 22,898,473 | owner cancel of the partly filled remainder |
| returnB | `0x1b4ebdd5…f0f0` | 22,898,564 | `ReferenceSolverV2.returnExpired` (journaled) returned B unchanged, input `since` = expiry |

The planner refused a first `fillC1` take of 150 CKB before signing: a CKB-offer
remainder must keep the order cell's own storage (~287 CKB here), so a 400 CKB
order can only take 100–113 CKB partially. The create review now shows this range
or warns that an order is too small to fill partly (`plannedPartialRange`).

### JoyID partial fill on toastdex.org (2026-10-29)

Order `0x7798b8a5…6384` (block 22,898,735, split-maker key): 2,000 TEST3 for
4,000 CKB, partial from 250 TEST3, 24 h expiry, priced under the CKB / TEST3 pool
(about 2.12). toastdex.org quoted 500 TEST3 for 1,000 CKB from it against 1,340
from the pool. The user then swapped on toastdex.org with JoyID (main key): tx
`0xddf59ef8…5979`, block 22,899,288. `scripts/lock-v2-joyid-verify.ts` checked
on both endpoints that the reference model accepts the committed fill; that the
maker got 700 CKB at the order index for 350 TEST3 (exactly 2 CKB per TEST3);
that 1,650 TEST3 stays live under identical args; that every other input and output
is the user's JoyID wallet; and that the wallet received exactly 350 TEST3. Fee
0.00074351 CKB for 1,581 bytes, from the node's fee-rate estimate under the app's 1
CKB cap ([record](../../deployments/lock-v2-joyid.json)).

Commands: `make lock-v2-test`; `npx tsx --test sdk/test/v2.test.ts`.

## Original questions for the user

1. Is soft expiry acceptable as described (permissionless return, fills
   possible until returned)?
2. Should expiry be a timestamp (default) or allow block height as well?
3. No keeper tip for now?
4. Should the app create only v2 orders after deployment, while still filling
   and cancelling v1?

## Live campaign (2026-10-29)

`scripts/lock-v2-campaign.ts --execute --rounds=6` (seed 61; resumable journal
[lock-v2-campaign.json](../../deployments/lock-v2-campaign.json)). Maker: split-maker
key. Takers: A (contention key) and B (solver key), funded by the maker with 2,000
CKB and 20,000 TEST2 each. 27 transactions, blocks 22,899,517–22,899,678, every
one committed and checked on both endpoints (fills against the reference model,
returns byte for byte with `since` = expiry). Total fees 0.00028031 CKB (fee rate
1,000 shannons/KB).

- **Races (6 rounds, alternately selling 3,000 TEST2 for 285 CKB and offering
  600 CKB for 7,000 TEST2).** Both takers built random partial fills of the same
  order cell and sent them at once to different endpoints. Both nodes accepted
  their transaction every time, and exactly one committed every time (A won 2, B
  won 4; 14–25 s to commit). The loser's transaction never appeared on either
  endpoint. The loser then rebuilt on the remainder and the order was filled to
  completion: 14 fills, 8 of them partial, all accepted by the model.
- **Solver.** Two crossing v2 orders from different owners (maker sells 1,000
  TEST3 at 2.0 CKB; taker A offers 1,000 CKB for 450 TEST3). `ReferenceSolverV2`
  run by taker B matched them, filling A's order completely and the maker's
  partly (450 TEST3, remainder 550 TEST3 live), in one journaled transaction
  `0x643a1655…68c9`. The solver kept the 100 CKB spread.
- **Soft expiry.** Three orders expiring 3 minutes after creation. After expiry,
  taker A filled one at the maker's price with `allowExpired` (`0xdceb4fa9…7d5b`),
  as the design allows until an order is returned. 900 s after expiry by tip time,
  taker B returned the other two to the maker in one transaction
  (`0x0a684a2a…bafe`), each input carrying `since` = expiry.

Harness issues found and fixed during the run (no lock or SDK change): CCC's
client cache keeps the outputs of transactions it sent, so after a lost race the
loser's change, and across the two endpoint clients a spent remainder, looked
live. The campaign clears both caches after each race and fill, and confirms
order cells with `getCellLiveNoCache`. In each case `submit` or `fillOrdersV2`
refused before signing. The SDK's liveness checks did their job; apps that use
two clients for one wallet should do the same.
