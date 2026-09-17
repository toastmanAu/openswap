# OpenSwap v0.1 Test Plan

## Test stack

Use `ckb-testtool` with deterministic context where possible.

Recommended test layout:

```text
tests/src/
├── lib.rs
├── fixture.rs
├── builders.rs
├── assertions.rs
└── tests/
    ├── args.rs
    ├── ckb_to_udt.rs
    ├── udt_to_ckb.rs
    ├── udt_to_udt.rs
    ├── cancel.rs
    ├── batch.rs
    ├── capacity.rs
    ├── malformed.rs
    └── adversarial.rs
```

Use `Context::new_with_deterministic_rng()` for stable OutPoints/fixtures.

---

## Phase 1: isolated lock semantics

Use AlwaysSuccess as fake type code with distinct Script args to create TOKEN-A and TOKEN-B identities.

This isolates OpenSwap validation from real token conservation.

---

## Positive tests

1. valid CKB-ask args
2. valid UDT-ask args
3. UDT-A -> UDT-B exact fill
4. UDT-A -> UDT-B token overpayment
5. UDT-A -> CKB exact fill
6. CKB -> UDT-B exact fill
7. two independent reciprocal orders
8. ten independent lots
9. twenty independent lots
10. three-asset ring if transaction structure permits
11. same owner, unique nonce lots
12. valid CKB lot cancellation
13. valid UDT lot cancellation
14. multi-lot cancellation using one owner proof
15. malformed tail + valid owner recovery
16. maximum representable u128 UDT ask
17. solver surplus output allowed
18. additional funding inputs allowed
19. additional change outputs allowed

---

## Adversarial tests

### Args

- zero nonce
- unsupported version
- unknown flags
- non-zero reserved
- zero ask
- malformed owner Script
- owner Script > max
- malformed ask Script
- ask Script > max
- trailing garbage
- args too short

### Grouping

- two identical OpenSwap inputs same lock
- duplicate nonce and identical args in same public settlement
- current order input attempts to serve as cancel proof

### Offer shape

- CKB offer with data
- UDT data length 0
- UDT data length 15
- UDT data length 17
- UDT data 64 KiB
- zero UDT amount
- invalid CKB refund below occupied
- invalid CKB refund == capacity
- UDT refund != input capacity

### Payment

- wrong payment index
- wrong owner lock
- wrong ask type
- ask underpaid by 1
- UDT payment capacity below refund
- UDT payment capacity above refund
- CKB payment with type
- CKB payment with data
- CKB payment short by 1 shannon
- CKB required value > u64 max

### Terminality

- recreate exact same OpenSwap lock output

### Cancellation

- no owner proof
- proof wrong owner
- proof type present
- proof data non-empty
- proof output missing
- proof output same capacity
- proof output larger capacity
- recovery lock wrong
- recovery type changed
- recovery data changed
- recovery capacity reduced

### Self-reference

- owner lock equals current OpenSwap lock

---

## Hostile-size tests

Explicitly construct:

```text
64 KiB order data
```

Expected:
- deterministic contract error,
- no dynamic allocation of full hostile data,
- no OOM.

Also construct oversized running Script args over configured maximum.

Expected:
- `ScriptTooLarge`.

---

## Phase 2: real xUDT integration

Use actual xUDT type script.

Required:
- xUDT A -> xUDT B
- xUDT -> CKB
- CKB -> xUDT
- reciprocal xUDT orders
- several xUDT lots in one settlement
- token conservation failure rejected by xUDT
- unsupported extended-data xUDT hidden/rejected by reference client

---

## Owner-lock integration

### secp

Create/cancel order using actual secp lock flow.

### JoyID

Create/cancel using CCC/JoyID flow.

### ACP regression

Attempt non-owner ACP-like increase path and verify it does not satisfy cancellation proof.

Then verify a true owner-authorized decrease can satisfy the proof.

---

## Golden wire vectors

Rust and TypeScript must consume identical test vectors.

CI should fail if either encoder/parser disagrees.

---

## Cycle/binary reporting

Record:
- contract binary bytes,
- cycles for UDT->UDT,
- cycles for UDT->CKB,
- cycles for CKB->UDT,
- cycles for cancellation,
- cycles for 2-order settlement,
- cycles for 10-order settlement,
- cycles for 20-order settlement.

Keep historical report in:

```text
docs/BENCHMARKS.md
```
