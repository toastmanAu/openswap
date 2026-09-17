# OpenSwap v0.1 Security Model

## Threat model

Assume:
- makers can create malformed cells,
- takers/solvers are adversarial,
- token type scripts may be malicious,
- multiple solvers race,
- metadata can be wrong,
- frontends can disappear,
- RPC/indexer endpoints can be unavailable,
- hosted caches can lie,
- users may use unusual owner locks.

Consensus must only trust CKB transaction state and script execution.

---

## Key defenses

### 1. One GroupInput per public settlement

Stops identical-lock grouping attacks.

### 2. Absolute-index payment binding

```text
Input[i] -> Output[i]
```

Stops multiple same-owner orders from reusing one maker-payment output.

### 3. Terminal fill

Exact OpenSwap lock cannot be recreated during public settlement.

### 4. Exact UDT payment capacity

Prevents hidden CKB transfer/subsidy to maker on UDT settlement.

### 5. Explicit `capacity_refund`

Ensures CKB offer amount is:

```text
input.capacity - capacity_refund
```

rather than relying on occupied capacity as economic intent.

### 6. Bounded parser

Reject huge cell/script data without dynamic attacker-sized allocation.

### 7. Malformed-order rescue

Owner prefix is parsed before full tail, allowing owner recovery from buggy creation software.

### 8. Separate owner proof

Current order input cannot authenticate its own cancellation.

### 9. Strict decrease proof

Makes ACP-style permissionless deposit behaviour unsuitable as a fake cancellation authorization.

---

## Known non-guarantees

OpenSwap does not guarantee:
- token authenticity,
- token issuer honesty,
- correct token metadata,
- market price,
- best execution,
- liquidity,
- absence of MEV,
- front-running resistance,
- execution before another solver,
- safety of arbitrary custom owner locks,
- safety of arbitrary token type scripts.

---

## Token risk

The OpenSwap lock only verifies:
- requested asset type identity,
- requested amount,
- payment owner,
- CKB capacity rules.

Token conservation belongs to the token's type script.

A malicious type script can behave maliciously.

Reference UI should distinguish:
- verified canonical xUDT,
- recognized but unverified,
- unsupported custom asset.

---

## Owner-lock compatibility

Cancellation requires:

> A plain CKB cell protected by the owner lock cannot be recreated with less capacity unless the owner authorizes the spend.

Explicitly test:
- secp,
- JoyID,
- ACP.

Unknown custom owner locks should not be assumed cancellation-compatible without testing.

---

## Solver race behaviour

Two solvers may race for the same order.

Expected outcome:
- one consumes the order,
- one fails on dead input.

Do not implement a global reservation service.

---

## Malformed order spam

Anyone can create malformed outputs using the OpenSwap code hash because lock scripts do not execute at output creation.

Therefore:
- indexer must parse strictly,
- malformed cells are hidden from normal orderbook,
- parser must be bounded,
- owner rescue should remain possible if owner prefix is valid.

---

## No expiry

Do not use arbitrary header deps as a current-time oracle.

Do not misrepresent `since` as an expiry mechanism.

---

## Source-code lineage

OpenSwap should be clean-room from this spec.

Do not copy Nervina SDL code unless its license is independently clarified.

---

## Pre-mainnet security gates

- parser fuzzing,
- capacity-boundary fuzzing,
- transaction permutation fuzzing,
- grouped-input regression,
- malformed-size regression,
- real xUDT integration,
- JoyID integration,
- secp integration,
- ACP regression,
- reproducible build,
- independent review,
- external audit,
- testnet soak,
- solver-race tests,
- large-orderbook scan benchmark.
