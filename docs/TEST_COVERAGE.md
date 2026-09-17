# Current consensus coverage

`cargo test --locked -p openswap-tests`: **88 test functions**, including
parameterized hostile-length cases and every truncated prefix of a valid args
encoding. 87 execute the compiled RISC-V contract in CKB-VM using Data1;
one verifies shared wire vectors against the Rust parser.

`npm run test:sdk`: **55 tests** covering shared vectors, hostile codec inputs,
capacity and lot arithmetic, asset profiles, builder ordering/conservation,
malformed-tail recovery, spent inputs, wallet mutations, bounded matching,
scanner filtering/bounds, pending reservations and competing solver races.
Router coverage adds budget/overfill bounds, exact arithmetic, live quote
revalidation and successful routed funding.
The deterministic solver race is supplemented by three live two-wallet races
verified on two nodes; see `deployments/race-soak-result.json`. Cache recovery
and chain-only scanning regressions cover the defect found during that run.
Builder tests use real CCC transaction completion with deterministic mock cells;
they do not replace signed full-node integration.

| Area | Evidence |
|---|---|
| Wire parsing | Version, flags, both reserved bytes, nonce, amount, bad offsets, owner/ask size limits, trailing bytes, every truncation, max-size scripts |
| Hostile lengths | 0/1/15/17/65536-byte order/payment data; oversized running Script; successful recovery of 64 KiB data by hashes |
| Offer extraction | All three directions, zero tokens, CKB data, occupied-capacity boundary, refund equality/mismatch, same assets |
| Settlement | Wrong index/owner/type, missing output, underpayment, exact UDT capacity, CKB data/type, u64 and u128 overflow boundaries |
| Composition | 2/10/20 orders, three-asset ring, same-owner nonces, underpaid final lot, funding/change/surplus, order recreation |
| Rescue | Before malformed-tail parsing, valid CKB/UDT recovery, shared multi-lot proof, missing/wrong/equal/increased proofs, proof output/data/type/owner mutations |
| Grouping | Identical lock inputs rejected for both settlement and cancellation |
| Real xUDT | All trade directions, reciprocal 2/10-lot bundles, unfunded token creation fails type validation, extended order data rejected |
| Real secp | Correct signature cancels; unsigned/wrong signatures fail |
| Real ACP | Signed decrease succeeds; unsigned decrease fails; actual deposit increases cannot cancel |

## Important limits

- `ckb-testtool::verify_tx` checks script execution and output-data alignment; it
  is **not full node consensus validation** (capacity conservation, occupied
  capacity, cellbase maturity, etc.). Isolated lock tests deliberately use fake
  assets or impossible capacities to exercise rejection boundaries. Real xUDT
  positive settlement cases include conservation; full-node testnet exercises
  remain necessary.
- AlwaysSuccess owner tests establish OpenSwap proof structure only. Actual
  authorization is tested separately with secp and ACP.
- The real ACP deposit regression includes a matching ACP token input for the
  recovery output. That prevents ACP's own unmatched-output rejection from
  masking OpenSwap's required `CancelProofMissing` error.
- A literal self-owner lock would require a Script to contain itself as a proper
  byte prefix (impossible for finite encodings), or a cryptographic hash
  fixed point/collision. The runtime hash guard exists; no fabricated fixture
  claims to exercise a real hash fixed point.
- `CancelRecoveryInvalid` remains reserved. An inexact recovery falls through to
  ordinary settlement validation, as the handoff's main flow specifies.
- Running Script bounds and single-input grouping apply before rescue. An
  oversized running Script or duplicated exact lock group cannot use rescue.
- A live JoyID create/cancel pair now passes on testnet; see
  `deployments/joyid-smoke-result.json`. A live two-lot self-fill also passes
  indexed payment and token-balance checks on two nodes; see
  `deployments/fill-smoke-result.json`. It does not cover a distinct taker or
  non-owner xUDT enforcement by itself. The separate-wallet scenario now covers
  both, plus live secp cancellation; two-node evidence is in
  `deployments/solver-integration-verification.json`. Additional wallet variants, mainnet
  fixtures, property fuzzing, permutation fuzzing,
  longer endurance runs and additional live adversarial coverage remain release
  work. Three bounded race/soak rounds and frontend create/cancel/swap now pass.
