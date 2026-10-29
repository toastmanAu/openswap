# Order lock v2: partial fills and expiry (DRAFT for review, 2026-10-29)

Status (2026-10-29): design approved by the user with the defaults below. Build
steps 1 and 2 are done offline; nothing is deployed. It reopens two frozen v0.1
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
  fills, k × capacity_refund less CKB is sold**. The app adds the reserve when
  the user picks "up to N fills", so the full amount can still sell.

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
| 3. SDK | Not started |
| 4. Solver | Not started |
| 5. Frontend | Not started |
| 6. Testnet | Not started; needs approval |

Commands: `make lock-v2-test`; `npx tsx --test sdk/test/v2.test.ts`.

## Original questions for the user

1. Is soft expiry acceptable as described (permissionless return, fills
   possible until returned)?
2. Should expiry be a timestamp (default) or allow block height as well?
3. No keeper tip for now?
4. Should the app create only v2 orders after deployment, while still filling
   and cancelling v1?
