# OpenSwap v0.1 Protocol

## Philosophy

OpenSwap is designed so basic trading continues to work if every official OpenSwap service disappears.

The protocol must not require:
- official website,
- official API,
- canonical matcher,
- API key,
- admin signing key,
- upgrade key,
- centralized custody,
- global mutable DEX state,
- treasury,
- permission to list,
- permission to solve.

A third party with:
- a CKB node/indexer,
- the OpenSwap contract binary,
- this protocol specification,

must be able to discover, interpret, fill, and cancel orders.

---

## Order model

Each order is one independent CKB cell.

Lifecycle:

```text
CREATE -> LIVE -> FILLED
              \-> CANCELLED
```

There is no persistent partial-fill state.

To allow practical partial execution, the maker creates several independent lots.

Example:

```text
Sell 10,000 TOKEN-A
at >= 0.05 TOKEN-B per A

10 lots:
1000 A -> >= 50 B
...
1000 A -> >= 50 B
```

A taker/solver may atomically consume one, several, or all lots.

---

## Canonical order identity

Canonical order ID:

```text
OutPoint
```

A random 128-bit nonce is still embedded in each lot's lock args so two otherwise identical lots normally have distinct lock scripts and therefore distinct CKB lock groups.

The nonce is not the canonical order ID.

---

## Assets

### Native CKB

Offer cell:

```text
type = None
data = empty
```

The maker explicitly declares `capacity_refund`.

Effective offer amount:

```text
offer_amount = input.capacity - capacity_refund
```

Requirements:

```text
capacity_refund >= input.occupied_capacity
capacity_refund < input.capacity
offer_amount > 0
```

The reserve exists so the maker can receive a future UDT payment cell without the solver subsidizing storage capacity.

### UDT-like asset

Offer cell:

```text
type = Some(type_script)
data = exactly 16 bytes
```

Amount:

```text
u128 little-endian
```

Requirements:

```text
amount > 0
capacity_refund == input.capacity
```

All CKB capacity attached to a UDT order remains maker-owned.

The reference client treats canonical xUDT as supported and unknown 16-byte UDT-like types as adapter-dependent.

---

## Ask asset

Ask asset is embedded as the complete requested type Script.

```text
ask_script_size == 0
=> native CKB

ask_script_size > 0
=> requested UDT-like asset
```

Storing the complete ask Script makes a live order self-describing and lets an independent solver construct the maker's payment output without a token-script registry.

---

## Payment index binding

The most important composability rule is:

```text
payment_output_index == order_input_index
```

Example:

```text
INPUTS
[0] Alice order
[1] Bob order
[2] Charlie order
[3+] funding

OUTPUTS
[0] Alice payment
[1] Bob payment
[2] Charlie payment
[3+] proceeds/change
```

This prevents a single seller output from being counted against multiple orders.

---

## UDT ask settlement

When the maker requests UDT:

```text
Output[i].lock == owner_lock
Output[i].type == ask_type_script
Output[i].data.length == 16
u128_le(Output[i].data) >= ask_amount
Output[i].capacity == capacity_refund
```

The exact-capacity rule prevents accidental solver-to-maker CKB subsidy.

---

## CKB ask settlement

When the maker requests native CKB:

```text
Output[i].lock == owner_lock
Output[i].type == None
Output[i].data == empty
Output[i].capacity >= capacity_refund + ask_amount
```

The sum is evaluated in a wider integer domain and rejected if not representable by CKB's u64 capacity.

---

## Same-asset rejection

Reject:

```text
CKB -> CKB
```

and reject UDT trades where:

```text
offer_type_hash == ask_type_script_hash
```

---

## Terminality

A publicly filled v0.1 order must be terminal.

Scan all outputs and reject any output whose lock hash equals the exact current OpenSwap lock hash.

This prevents recreating the same order state during settlement.

---

## Cancellation / rescue

Cancellation must remain possible even if buggy software created a malformed OpenSwap tail.

Validation sequence:

1. Parse only the leading owner Script.
2. Resolve current order input absolute index.
3. Detect an exact recovery output at the same index.
4. Require a separate owner-authorization proof.
5. If valid, return success without requiring the remainder of OpenSwap args to decode.

### Recovery output

At `Output[order_index]`:

```text
lock == owner_lock
type hash == original input type hash
data hash == original input data hash
capacity >= original input capacity
```

### Owner proof

A separate input `j != order_index` must be:

```text
Input[j]
lock == owner_lock
type == None
data == empty
```

and same-index output:

```text
Output[j]
lock == owner_lock
type == None
data == empty
Output[j].capacity < Input[j].capacity
```

The strict decrease is intended to distinguish real owner-authorized withdrawal-like behaviour from ACP-style permissionless deposit increases.

Compatibility definition:

> A cancellation-compatible owner lock must require owner authorization when a plain CKB cell protected by it is recreated with strictly less capacity.

Initial reference support should explicitly test:
- secp256k1/blake160,
- JoyID,
- ACP regression.

---

## No expiry in v0.1

Do not implement hard expiry.

Reasons:
- `since` is a not-before condition, not not-after.
- header deps are spender-selected historical headers and therefore are not a trusted current-time oracle.

UI wording:

```text
LIVE UNTIL FILLED OR CANCELLED
```

A deadline mechanism belongs in a later OTX/CoBuild phase.

---

## Solver economics

Protocol fee:

```text
0
```

Maker guarantees:

```text
maker receives >= ask_amount
```

Protocol does not guarantee:
- best execution,
- oracle price,
- absence of MEV.

A permissionless solver may retain residual spread after satisfying all maker constraints and token conservation.

---

## Atomic reciprocal matching

For:

```text
Order A:
offers A
asks B

Order B:
offers B
asks A
```

an inventory-free two-order match exists when:

```text
A.offer >= B.ask
B.offer >= A.ask
```

No special counterparty relation is encoded on-chain.

---

## Batch matching

For reciprocal sets:

```text
L = orders selling A for B
R = orders selling B for A
```

Define:

```text
A_available = sum(L.offer)
A_required  = sum(R.ask)

B_available = sum(R.offer)
B_required  = sum(L.ask)
```

An inventory-free bundle exists when:

```text
A_available >= A_required
B_available >= B_required
```

Network fee and CKB capacity accounting are handled separately by the transaction builder.

---

## Wallet independence

The contract does not contain JoyID-specific or secp-specific code.

Owner is an arbitrary CKB Script.

Reference SDK should initially support:
- JoyID,
- secp,
- later OmniLock / multisig / PQ locks as tested.

---

## Decentralization acceptance test

If these disappear:

```text
openswap website
openswap API
reference solver
reference metadata registry
```

the protocol must still function through:

```text
CKB node/indexer
contract binary
independent wallet/client
independent solver
```
