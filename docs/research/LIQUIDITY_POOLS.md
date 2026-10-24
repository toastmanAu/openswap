# ToastDEX liquidity pools: implementation research

Date: 2026-09-20. **Research proposal, not an approved consensus specification.**
No contract, deployed order, SDK behaviour or frontend is changed by this document.

## Recommendation

Investigate a separate, immutable constant-product pool primitive alongside the
existing full-lot order protocol. Start with CKB/canonical-xUDT, direct swaps and
proportional deposits/withdrawals. Allow anyone to create a pool, submit a swap,
provide liquidity or withdraw their shares. LP trading fees can remain in the
pool; the ToastDEX protocol/operator cut remains zero.

The original DECISIONS.md excludes AMMs as the v0.1 protocol core. This proposal
preserves that boundary: new pool scripts would get new code identities and a
separate specification, tests, review and deployment. A shared application/router
can use both primitives without changing existing orders.

A mutable state cell **per pool** is proposed. There would be no global DEX state
cell, canonical factory, admin key, upgrade key or required matcher. Whether this
local state is acceptable is an explicit architecture decision before implementation.

## Alternatives

| Approach | Advantages | Limitations | Assessment |
|---|---|---|---|
| Market maker posts existing full-lot orders | Uses the existing lock; independent lots trade concurrently | Inventory/prices need replenishment; maker signing or additional vault rules; no passive pooled LP shares | Useful alongside pools, not equivalent to pooled liquidity |
| Independent constant-product pool | Simple pricing; passive proportional LP shares; can settle directly | Shared reserves create contention within each pool; new arithmetic and share-accounting contracts | Recommended first research prototype |
| Split liquidity among several independent pools | Different pools can trade independently | Liquidity is fragmented; route selection and arbitrage become more important | Later scaling option; not free concurrency for one shared reserve |
| Concentrated liquidity | LPs choose narrower active price ranges | Tick traversal, position accounting, fee growth and more complex arithmetic/state | Defer |
| Stable-swap curve | Potentially efficient around a justified relative price | Amplification, price assumptions and additional failure modes | Defer; CKB/iCKB is not a permanently fixed 1:1 pair |

Uniswap's published v2 design supplies a pricing/share-accounting reference;
v3 illustrates the added range/position machinery. These are behavioural research
references, not code to transplant into CKB. [S1, S2, S3]

## What the primary sources establish

- CKB transactions consume live cells and create replacements. Capacity is both
  CKB value and storage backing. Type scripts can enforce creation and transition
  rules; lock scripts protect spending. A cell has one optional type script, so
  a state type and an existing token type cannot simply occupy the same slot.
  Identity/lineage needs explicit enforcement. [S4, S5]
- sUDT has a 128-bit amount and owner-authorized issuance; normal transfers permit
  burning. A token issuer's mint authority alone is not proportional LP-share
  accounting. A new LP design must enforce that independently. [S6]
- UTXOSwap's public SDK README constructs a backend client with an API key. Its
  client source has sequencer API paths. This verifies a dependency in the
  published SDK flow, not a complete audit of its deployed contracts or proof
  that every alternative withdrawal path needs that backend. [S7, S8]
- On the research date UTXOSwap's official site announces service shutdown on
  **2026-10-11 00:00 UTC+8**, asking users to remove liquidity. Preserve independent
  scanning/building/withdrawal tools in ToastDEX; do not infer contract custody or
  recoverability solely from this notice. [S9]

## Proposed CKB cell layout

This section is original design analysis requiring a prototype and security review.
A deliberately uniform first layout would use three cells per pool:

1. **State:** pool identity, version, complete asset identities, immutable fee,
   total LP shares, storage policy and reserve output indexes. A dedicated state
   type enforces unique genesis and exactly one successor for normal transitions.
2. **Reserve A:** pool custody lock; CKB capacity or the actual token's type script
   with exactly 16-byte amount data.
3. **Reserve B:** equivalent custody rules for the other asset.

All three are consumed and recreated together. A CKB reserve's tradeable quantity
is its capacity minus explicitly protected storage backing. The state cell and
UDT cell backing are excluded from market reserves. Transaction fees come from
separate caller funding; validators must prevent disguised reserve/storage drains.

### Reserve identity is a security requirement

Never treat any cell sharing a pool lock or asset symbol as an authentic reserve.
One candidate binding is: a state cell records the indexes of its two sibling
reserve outputs. Its input OutPoint supplies their creating transaction hash.
A transition must consume those exact sibling OutPoints, and validate both new
reserve outputs at the successor's recorded indexes. This avoids a circular
reference to the transaction currently being built.

The state and custody validators must jointly enforce this binding, no omitted
reserves, no duplicate state successors, no cross-pool substitutions and no
unauthorized retirement. A unique-genesis scheme can borrow Type-ID-style
identity rules inside the custom state validator; the built-in Type ID is not a
second type script stacked on a token. Identity does not imply upgradeability:
code remains referenced by its immutable Data1 hash. [S5]

Unsolicited lookalike cells must not change balances, block valid transitions or
become an issuer-authority shortcut. Define their treatment explicitly. Discovery
finds supported pool state types and validates referenced reserves, not just locks.
Anyone may create another pool for the same pair; the router compares actual pools.

## Price, fees and integer arithmetic

For reserves x and y, input dx, fee numerator f and denominator D:

```text
a = dx * (D - f)
out = floor(a * y / (x * D + a))
x_next = x + dx
y_next = y - out
```

The input fee stays in the reserves and benefits LPs. Fee parameters are immutable
per pool; the exact rate is undecided. A 0.30% rate is an illustrative benchmark,
not an approved parameter. There is no protocol recipient or fee switch.

Proposed MVP: one swap direction per transition, positive input/output, exact
rounded quote and checked post-state bounds. Reject simultaneous bidirectional
swap accounting until separately specified. A pool does not need an external
oracle to quote; an oracle would add another dependency. Pool spot price must not
be presented as a manipulation-resistant oracle. Arbitrage can align prices,
but is not guaranteed. LPs can lose value relative to holding the assets. [S1]

**Arithmetic differs materially from the existing lock.** Two u128 reserves need
up to 256 bits for their product; multiplying by a fee denominator can need more.
Do not assume U256 alone safely handles unrestricted u128 fee-adjusted products.
Two implementation candidates:

- Cap reserves/input amounts at 112 bits and fee denominator at 10,000. The
  fee-adjusted invariant product then fits within 252 bits; quote multiplication
  fits within 238 bits. Bound LP supply and check every intermediate operation.
- Retain full u128 reserves with wider arithmetic or a formally bounded multiply/
  divide algorithm. This increases implementation and review cost.

The first is a practical prototype candidate, subject to token-unit range checks
and CKB-VM cycle measurements. It introduces wider arithmetic only in new pool
contracts; the existing v0.1 lock still needs none. Never use floating point in
consensus. Compare Rust calculations against an independent BigInt model.

## Liquidity shares

Use a dedicated, non-admin LP type bound to the exact pool identity. Normal LP
transfers preserve supply. Mint/burn must accompany a validated pool transition;
an ordinary issuer key, or a generic UDT owner mode alone, is insufficient.
Require state supply changes to equal the aggregate LP issuance/redemption.
Define how permanently locked shares are represented in this equality.

Candidate proportional accounting:

- Initial shares derive from floor(sqrt(x*y)), with a carefully specified initial
  locked-share mechanism to resist first-deposit/donation rounding attacks.
- Later deposits mint the smaller of floor(dx*L/x) and floor(dy*L/y). Reject zero
  shares. Return excess assets rather than silently treating them as a donation.
- Burning b shares withdraws floor(b*x/L) and floor(b*y/L). Reject zero/dust results
  and enforce backing for remaining cells. A direct LP-owner-signed transaction
  must permit withdrawal without operator approval.

These standard proportional formulas are reference economics [S1, S2]; CKB-specific
storage and authorization rules remain to be designed. Do not blindly copy a
minimum-share constant across different token decimal scales.

Specify upfront who funds pool storage, whether it is permanently committed,
and whether a final close is possible. Permanently locked minimum shares and
full closure cannot both be promised without an additional mechanism. For the
first prototype, a permanent pool with disclosed initialization storage backing
is simpler. LP-holder wallet-cell storage is separate from pool storage.

## Concurrent execution and ToastDEX integration

Two swaps spending the same current reserve set conflict. One wins; the other
must fetch current state, requote and obtain a fresh signature if signed contents
change. This is per-pool serialization, not a need for a privileged sequencer.
Dependent transactions may be chained when node policy permits; do not describe
this as a hard one-swap-per-block limit. Different pools can be updated separately.
These are consequences of CKB's consumed-cell model [S4, S5], not measured throughput.

Begin with direct user transactions for create pool, deposit, swap and withdrawal.
Optional permissionless solvers can later combine pool liquidity with existing
ToastDEX orders in one atomic transaction:

- Each existing order input at index i still has its maker payment at output i.
- The builder allocates and pins those positions and separately places pool state,
  reserves, taker receipts, LP cells and fee/change outputs.
- Pool validators enforce their own transition in that same transaction.
- A solver cannot change a signed transaction to repair a stale pool quote.
- Indexer discovery and CLI builders remain sufficient if the official site stops.

Batching several user intents may improve throughput, but requires a precise
price/order/surplus policy. Do not silently promise price improvement to the user
when v0.1's maker lock only enforces a minimum/exact settlement and permits solver
spread. Add aggregate routing protections and clear user review before offering
hybrid routes. Do not require a licensed batcher, hosted quote API or operator key.

## Asset scope

First prototype: CKB and one canonical test xUDT. Then validate a known iCKB
profile using the existing resolver boundary and real scripts. iCKB's economic
relationship to CKB and its special issuance profile need explicit tests; a
stable-swap assumption is not implied by the ticker. The official iCKB whitepaper
describes an exchange rate that changes with Nervos DAO accumulation. [S10]

Unknown UDT profiles require analysis/resolvers. Catalog presence is not contract
support. Use full script identities, not names. Bitcoin-bound RGB++ assets need a
separate leap/ownership integration before they can become CKB-side pool reserves.

## Prototype acceptance criteria

1. Separate pool specification: genesis, reserve binding, storage backing, fees,
   LP supply, rounding, direct withdrawal and permanent/closing lifecycle.
2. Integer reference model and adversarial property tests: rounding boundaries,
   near-limit values, repeated tiny swaps, zero-share deposits, initialization
   manipulation, donations and profitable add/remove rounding cycles.
3. CKB-VM prototype with real xUDT: stolen/replaced reserves, forged states,
   LP inflation, burn-without-withdrawal policy, duplicate successors, arbitrary
   output indexes, truncated/oversized fields and pool-storage theft.
4. Direct indexer scanner and create/deposit/swap/withdraw builders; no hosted API.
5. Two-wallet testnet race and stale-quote tests; absent-solver withdrawal; fresh
   transaction rebuild after contention; measured cycles, size and capacity.
6. Atomic order-plus-pool settlement tests preserving every existing maker index.
   (Done offline 2026-10-24: `pool-tests` `sdk_split_route_orders_and_pool`; see docs/FRONTEND.md.)
7. Separate independent review before placing real funds in the new contracts.

Recommendation: decide the local per-pool state boundary, then write the pool
specification and executable integer model. Leave concentrated liquidity, stable
curves, mandatory batching, flash-loan callbacks and oracle facilities out of
this first research prototype.

## Sources

All checked 2026-09-20. Primary sources only. No Nervina SDL implementation was
consulted or copied. No external implementation code was copied into ToastDEX.

- S1: [Uniswap v2 whitepaper](https://app.uniswap.org/whitepaper.pdf).
- S2: [Uniswap v2 architecture](https://developers.uniswap.org/docs/protocols/v2/concepts/architecture).
- S3: [Uniswap v3 whitepaper](https://app.uniswap.org/whitepaper-v3.pdf).
- S4: [CKB RFC 0002](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0002-ckb/0002-ckb.md).
- S5: [CKB transaction structure and Type ID](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0022-transaction-structure/0022-transaction-structure.md).
- S6: [sUDT specification](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0025-simple-udt/0025-simple-udt.md).
- S7: [UTXOSwap SDK README](https://github.com/UTXOSwap/utxoswap-sdk-js).
- S8: [UTXOSwap public API client](https://github.com/UTXOSwap/utxoswap-sdk-js/blob/main/src/entities/client.ts).
- S9: [UTXOSwap official site](https://utxoswap.xyz).
- S10: [iCKB whitepaper and exchange-rate model](https://github.com/ickb/whitepaper#ickbckb-exchange-rate-idea).

## Follow-up prototype

The [draft transition specification](POOL_TRANSITIONS.md) and isolated
[integer model](../../pool-model/README.md) implement the next research step.
They do not deploy pools or change the existing order protocol.
