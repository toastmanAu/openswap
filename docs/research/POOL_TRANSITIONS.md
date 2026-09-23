# ToastDEX pools: draft transition specification (model revision 1)

Date: 2026-09-20. **Off-chain prototype specification; not frozen consensus.**
This specifies the next research step authorized by the user. The OpenSwap v0.1
order contract and its one-order/one-payment invariant remain unchanged. Nothing
here is deployed or connected to the trading app. No independent pool audit exists.

## 1. Scope and choices

- A separate constant-product pool for native CKB (X) and one supported canonical
  exactly-16-byte xUDT (Y). All amounts are base-unit integers; X is shannons.
- A pool has its own state and two reserves. There is no global DEX state, factory
  gate, operator signature, mutable fee recipient or required backend.
- Four pool transitions: Create, SwapExactIn, Deposit and Withdraw. One transition
  per pool per transaction. Normal LP transfers do not require pool state.
- Fee denominator D = 10,000. The creator explicitly chooses immutable integer
  f in [0, 9999]. There is **no default or approved production fee rate**. Wallets
  must show it; the extreme permitted fee is a testing boundary, not a suggested rate.
- Creator explicitly chooses positive virtual locked liquidity M. There is no
  production default for M. It is fixed forever and never issued as a spendable
  token. The initial creator bears its dilution and the pool's permanent storage.
- There is no close operation, fee switch, donations/sync operation, hard expiry,
  oracle, callbacks, single-sided LP deposit, or concentrated liquidity in this draft.
- Fees remain in reserves. Protocol/operator revenue is zero.

Creation, fees, backing and initialization price need explicit user review. A low
M, arbitrary starting price or thin liquidity can still be economically dangerous.
This draft does not claim the virtual-share rule eliminates all economic attacks.

## 2. Integer domains and state

| Symbol | Meaning | Domain |
|---|---|---|
| X, Y | Full canonical asset identities | X = native CKB; Y = complete supported type Script |
| x | Tradeable CKB reserve | 1 .. (2^64 - 1 - Bx) |
| y | Canonical xUDT reserve | 1 .. (2^112 - 1) |
| L | Total accounting shares including virtual shares | M .. (2^128 - 1) |
| M | Permanently unissued, nonredeemable shares | 1 .. (2^128 - 1), immutable |
| f | LP fee numerator | 0 .. 9999, immutable |
| Bs, Bx, By | State, CKB-reserve and token-reserve storage backing | Positive u64; Bx < 2^64 - 1; immutable |
| rx, ry | Reserve sibling output indexes | Distinct bounded u32; neither equals state output index |

Backing is not a claimable trade reserve. Pool capacities must be exactly:

```text
state.capacity         = Bs
ckb_reserve.capacity   = Bx + x
xudt_reserve.capacity  = By
xudt_reserve.data      = LE_u128(y), exactly 16 bytes
```

A real CKB implementation must additionally verify occupied capacity from the
actual serialized cells, cell-data lengths and scripts. The model cannot estimate
that without a finalized wire layout. It only checks integer capacity bounds.
Fees, LP-wallet cell capacity and recipient token-cell capacity are funded outside
the protected pool cells. Network fees must never silently reduce Bs/Bx/By or x/y.

Economic state invariants:

```text
L >= M > 0
x > 0; y > 0
L*L <= x*y
circulating LP supply = L - M
```

The product/share inequality follows from genesis and is preserved by these
rounding rules. LP cells contain only circulating shares; M exists solely in
state accounting. A full circulating withdrawal leaves L=M and positive reserves.
New providers may subsequently deposit; this does not reset M or pool identity.

All intermediates are checked nonnegative U256. A 112-bit reserve cap and
D=10,000 bound the generic fee-adjusted product to 252 bits and quote numerator
to 238 bits. This CKB/XUDT draft further restricts x to its u64 capacity limit.
Share products fit U256 using u128 shares and the stated reserve bounds.
Square root and ceil division must avoid overflow in intermediate additions.
There is no floating point. Invalid state must fail before transition evaluation.

## 3. Authenticity and cell transition obligations

These are required validator behaviours, **not implemented by the integer model**.

### Pool identity and genesis

A new pool identity must be derived unambiguously from the transaction's first
input and state output index, with Type-ID-style unique-genesis enforcement.
There must be zero input state cells and exactly one initial output state for
that identity. Duplicate pairs are allowed; duplicate state identities are not.
The type validator must check the reserve outputs and LP issuance at genesis.

The state type, reserve custody lock and LP type are separate logical roles whose
immutable code identities must be authenticated. No role may accept an arbitrary
caller-supplied "validator hash" without binding it to its own deployed rules.
A shared Data1 binary with role-tagged args is one candidate that avoids circular
cross-binary hash dependencies; exact script ABI remains a pre-contract decision.

### Normal transitions

Consume exactly one authentic state and both authentic reserve cells, and create
exactly one successor state plus its two reserves. Enforce all of the following:

1. The input state's OutPoint transaction hash and stored rx/ry identify the exact
   reserve inputs. Matching a lock or asset type alone does not establish identity.
2. Output rx/ry reference distinct successor reserve cells in this transaction.
   The successor cannot refer to itself as a reserve. The next generation can
   recover their OutPoints from its own creating transaction hash and these indexes.
3. Pool identity, version, asset scripts, fee, M, backing policy and role identities
   are unchanged. Only reserves, L and reserve output indexes may change.
4. Every reserve input's custody lock requires the authenticated state transition;
   a caller cannot spend a reserve while merely supplying the state as a cell dep.
5. Compare actual input/output capacities and token amounts with the transition.
   Extra lookalike cells cannot inflate balances, authorize LP issuance, substitute
   reserves, or force otherwise valid transitions to consume them.
6. Reject state destruction, additional successors, omitted reserves, duplicate
   reserve indexes, unauthorized type/data changes and unsupported actions.
7. Bound field sizes, input/output scans and script groups. Validate scripts with
   raw bounded syscalls. Give future custom consensus errors explicit stable codes.

All pool backing stays fixed for the life of this draft pool. Unsolicited cells
under its custody lock are not reserves; no recovery of those mistakenly sent
cells is promised. The SDK must warn against direct transfers to pool addresses.

### LP type rules

LP identity binds to the precise pool identity and supported immutable validator
roles. Full scripts identify tokens; tickers and names are irrelevant.

- Transfer without a pool transition: aggregate LP inputs equal aggregate LP
  outputs. No unsolicited burn is allowed to desynchronize L-M.
- Create: aggregate LP output minus input equals the creator's issued shares below.
- Deposit: aggregate LP output minus input equals minted shares m.
- Withdraw: aggregate LP input minus output equals burned shares b.
- Swap: LP aggregate delta is zero.
- Any mint/burn requires the authenticated matching pool transition. Another
  pool's state, a lookalike reserve or an owner-mode token issuer cannot authorize it.

A wallet's ordinary input locks authorize spending its LP cells and funding
assets. Validators enforce accounting; wallet signatures and builders protect the
chosen recipients and minimum receipts. M can never be minted, transferred or burned.

## 4. Create

Arguments: x, y, f, M, Bs/Bx/By, Y identity, reserve indexes and creator minShares.
The input funding is ordinary wallet-owned CKB/tokens; validate all parameter,
script, capacity and amount domains.

```text
L = floor_sqrt(x*y)
require L > M
minted = L - M
require minted >= minShares > 0
```

Create the three pool cells and exactly minted circulating LP shares. The creator
funds backing in addition to tradeable x. Its model flow excludes that permanent
backing contribution; builders must explicitly include and display it. No share
is issued for backing. Genesis itself defines the starting price; there is no
external fairness assertion or implicit market-price oracle.

## 5. SwapExactIn

Arguments: direction, positive exact input a and positive minOut. For X to Y:

```text
effective = a*(D-f)
out = floor(effective*y / (x*D + effective))
x' = x+a
y' = y-out
L' = L
require 0 < out < y
require out >= minOut
```

Reverse x and y for Y to X. Check post-state domains, including CKB capacity.
Require the **exact** rounded transition, not merely a nondecreasing product.
The full input enters reserves; the fee is implicit in the smaller output and
stays with the pool. No protocol output exists. Reject dust with zero output.

The signed direct transaction pins the reserve OutPoints and the user's receipts.
If the pool changes before inclusion, rebuild, requote and obtain a new signature;
never substitute a new state into a previously signed transaction. User minima
are builder/signing constraints for direct transactions; on-chain intent minima
would need a separately specified intent lock if optional batching is introduced.

## 6. Deposit

Arguments: positive budget maxima maxX/maxY and positive minShares.

```text
m = min(floor(maxX*L/x), floor(maxY*L/y))
require m > 0 and m >= minShares
usedX = ceil(m*x/L)
usedY = ceil(m*y/L)
x' = x+usedX
y' = y+usedY
L' = L+m
unusedX = maxX-usedX
unusedY = maxY-usedY
```

Check all domains and used amounts within budgets. The ceil costs ensure the new
shares have sufficient backing; consuming both maxima would silently donate the
unbalanced excess. Only usedX/usedY enter the pool. Unused budgets are not assets
in the transaction until actually funded; builders preserve real excess inputs
as wallet change. Network/recipient storage costs require separate accounting.

Even if another smaller deposit could fit, this exact request rejects when its
computed successor exceeds a bound. The model does not silently lower m to fit.
A fresh request can use smaller budgets. Existing LPs' reserve value per share
cannot be reduced by the permitted rounding. Fees from swaps accrue to existing
shares, including the permanently virtual portion.

## 7. Withdraw

Arguments: positive circulating shares b to burn, positive minX and minY.

```text
require b <= L-M
outX = floor(b*x/L)
outY = floor(b*y/L)
require outX > 0 and outY > 0
require outX >= minX and outY >= minY
x' = x-outX
y' = y-outY
L' = L-b
```

Burn b actual circulating LP shares under their owners' ordinary locks. Return
the amounts to signed recipients. Rounding dust remains in the pool. The storage
backing and virtual shares are never redeemable. Reject a dust withdrawal; holders
can consolidate shares or combine authorized inputs to reach usable amounts.
Actual outputs must also satisfy CKB occupied capacity using caller funding.

Withdrawal must be directly constructible from chain data without an operator,
API key or batcher. This is permissionless access, not a guarantee of immediate
inclusion: competing transactions can still spend the same state first.

## 8. Composition with existing orders

A later atomic builder must preserve every existing order input i -> maker output
 i while allocating pool cells elsewhere. The model has no transaction indexes;
it proves none of those structural properties. No existing order lock gains pool
state, partial fills, fees, expiry or an upgrade path from this draft.

## 9. Executable reference and tests

`pool-model/src/model.ts` provides createPool, swap, deposit, withdraw, capacities,
circulatingShares and strict accounting validateTransition. It uses BigInt with
explicit U256 intermediate checks. It returns a fresh state and caller flows;
it performs no RPC requests, signatures, key reads, transactions or deployments.

```sh
npm run typecheck
npm run test:pool-model
npm run demo:pool-model
```

The model must be used as an oracle when a separate Rust implementation is built,
not imported as proof of a correct CKB contract. Current tests cover:

- Genesis, virtual shares, backing separation, both swap directions, user limits,
  maximal deposits, dust, all-circulating withdrawal and reactivation.
- Near-u64/u112/U256 boundaries, highly asymmetric large reserves and integer
  square-root inequalities.
- Altered reserve/fee/share/backing/flow claims and changed-state quote rejection.
- 25,992 small-reserve swap cases against an independent binary-search invariant
  oracle, including zero and extreme fees.
- 2,250 small deposit budget cases against bounded exhaustive share enumeration.
- 3,000 fixed-seed mixed operations with asset/share conservation.
- 1,000 swap round trips that cannot extract rounding profit.

These bounded cases are not a proof over all integers or adversarial market
strategies. Script identity, real xUDT issuance modes, wallet authorization, CKB
capacity validation, malformed wire bytes and pool contention still need VM/full
node tests once a contract prototype exists.

## 10. Next implementation gate

Review these prototype choices before freezing a wire ABI: virtual-share amount,
permanent storage commitment, immutable fee selection and exact-output rounding.
Then define byte layouts, script-role binding, scan bounds and stable error codes;
implement isolated Rust arithmetic and cross-language vectors before custody code.
No funding or deployment is authorized merely by passing this off-chain model.

Follow-up (2026-09-23): [wire/role draft revision 1](POOL_WIRE_FORMAT.md) now
specifies layouts, shared-binary role authentication, scan bounds and error codes.
The isolated `pool-arithmetic` Rust crate implements accounting and is compared
with the TypeScript model using `npm run test:pool-cross`. The separate
[shared-role validator](../../contracts/openswap-pool/README.md) now implements
the draft custody/state/LP checks with 20 real-xUDT VM tests (`make pool-test`).
This remains an undeployed prototype and does not freeze production parameters.

Research provenance: [LIQUIDITY_POOLS.md](LIQUIDITY_POOLS.md). Mathematical reference
ideas are implemented clean-room; no external contract implementation was copied.
