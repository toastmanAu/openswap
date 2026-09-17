# OpenSwap v0.1 Agent Task Breakdown

## Milestone 0 — Repo bootstrap

- create workspace
- add MIT or MIT/Apache-2.0 license
- pin dependencies
- configure build scripts
- create docs folders
- CI formatting/lint/test skeleton

Deliverable:
- clean build,
- empty test harness.

---

## Milestone 1 — Rust parser/security boundary

Implement:
- `main.rs`
- `error.rs`
- `sys.rs`
- bounded running Script loader
- fixed 16-byte data reader
- empty-data probe
- owner-prefix parser
- full terms parser
- single GroupInput check
- absolute input index lookup

Tests:
- all args vectors,
- oversized/malformed parser cases.

Gate:
- no attacker-controlled OOM path.

---

## Milestone 2 — Cancellation

Implement:
- recovery-output detection,
- owner-proof scan,
- cancellation path before full-tail parse.

Tests:
- positive cancel,
- malformed-tail rescue,
- no proof,
- wrong proof,
- equal/increased proof capacity,
- current order as fake proof.

Gate:
- all cancellation tests green.

---

## Milestone 3 — Settlement

Implement:
- offer classification,
- CKB capacityRefund logic,
- UDT 16-byte logic,
- same-asset rejection,
- recreated-order rejection,
- UDT payment validation,
- CKB payment validation.

Tests:
- all three trade directions,
- underpayment,
- wrong owner,
- wrong asset,
- capacity attacks,
- grouped-input regression.

Gate:
- adversarial matrix green.

---

## Milestone 4 — Real xUDT

Integrate actual xUDT.

Tests:
- CKB->xUDT,
- xUDT->CKB,
- xUDT->xUDT,
- reciprocal batch,
- token conservation.

Gate:
- token + OpenSwap scripts execute together.

---

## Milestone 5 — Owner lock integrations

- secp create/cancel
- JoyID create/cancel
- ACP non-owner regression

Gate:
- documented supported owner locks.

---

## Milestone 6 — Bench/reproducibility

- cycle benchmarks
- binary-size report
- reproducible build script
- binary hashes

Gate:
- reproducible testnet candidate.

---

## Milestone 7 — Testnet deploy

- deploy `data1` contract
- record deployment JSON
- verify from fresh node/client
- direct manual fill/cancel test

Gate:
- immutable testnet contract live.

---

## Milestone 8 — SDK codec

- TS types
- encode/decode
- shared golden vectors
- capacity calculator
- AssetResolver

Gate:
- Rust/TS vector equality.

---

## Milestone 9 — Order creation/cancel/fill builders

- create N lots
- cancel N lots
- direct fill
- pinned input/output assertions
- CCC dep resolution

Gate:
- end-to-end testnet transactions from SDK.

---

## Milestone 10 — Chain scanner/orderbook model

- `findCells` prefix query
- strict parser
- directional books
- metadata abstraction
- logical batch grouping by creation tx

Gate:
- rebuild book from chain only.

---

## Milestone 11 — Solver

- direct reciprocal matcher
- bounded multi-lot bundle matcher
- fee wallet
- pending OutPoint cache
- liveness recheck
- broadcast/retry

Gate:
- two competing solver instances safely race.

---

## Milestone 12 — Frontend

Build only now.

Initial surfaces:

### ORDER BOOK
- pair selection
- bids/asks
- place order
- lot plan
- CKB storage estimate
- cancel
- fill

### SWAP
- amount in/out
- selected lots
- effective price
- overfill
- fee
- final wallet confirmation

Also:
- JoyID
- custom RPC
- explicit network indicator
- direct chain mode

Gate:
- no hosted OpenSwap API required.

---

## Milestone 13 — Release candidate

- full integration suite
- malformed spam
- large book benchmark
- testnet soak
- independent review
- audit preparation

No mainnet until external review/audit.
