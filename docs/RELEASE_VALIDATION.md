# ToastDEX release validation

This records testnet release hardening. It is not an independent security audit
or approval to operate on mainnet. The immutable contract binary is unchanged.

## 1. Deployed wallet acceptance — passed

The user confirmed normal JoyID wallet prompts through `https://toastdex.org`.
Two testnet nodes independently verified:

- Creation and fill using distinct maker and taker locks.
- Maker payment at the order's absolute input index.
- Exact token conservation and spent order cells.
- Cancellation of an existing order with unchanged type/data, recovered capacity
  and a separate same-index owner capacity-decrease proof.

[Public transaction evidence](../deployments/public-wallet-verification.json).
The original creation for the cancelled order was traced from its input. No extra
creation was needed. Origin/passkey UX is user-confirmed; it is not inferred from
on-chain data. Repeat with `scripts/verify-public-wallet.ts` and the frontend recipe.

## 2. Stress and reproducibility

- **90 Rust tests pass**, including 88 CKB-VM tests, shared wire vectors and a
  fixed-seed 20,000-case host parser corpus. Byte mutations with invalid structure
  return the matching stable parser error in CKB-VM.
- **70 TypeScript tests pass**. New recovery tests exercise a broadcast accepted
  before the response is lost, 20 failed status reads, 20 pending checks and
  recovery, plus 20 indexer outages followed by a successful build/submission.
- The solver now reserves inputs before broadcast, so a lost reply preserves
  pending tracking. This fixes an implementation gap found during this work.
- Two clean local contract builds match the deployed binary. The independent
  GitHub-hosted Ubuntu runner also matches SHA256, CKB code hash and byte length.
  [Remote reproduction evidence](../deployments/remote-reproducibility.json).
- `scripts/check-contract-identity.py` now guards CI and clean-build checks.
  A negative check confirmed that an altered binary is rejected.
- **12 live race rounds passed: nine new rounds plus the three-round baseline.**
  Both nodes agreed on exactly one winner in every round, indexed payments, token
  conservation, absent issuer inputs and spent orders. Three process invocations
  reused journaled work; no new funding transfer was needed.
  Extended live race results are in
  [race-endurance-result.json](../deployments/race-endurance-result.json).
  This journal retains the original three rounds as its baseline. Inspect its
  `runs` and final `completedAt` for the extension and process restart evidence.
- The longer run safely stopped before signing when token-cell fragmentation
  exhausted plain CKB. `scripts/consolidate-race-funding.ts` prepares a bounded,
  same-owner consolidation, preserving every token unit and capping its fee at
  0.01 CKB. Its two-node evidence is in
  [race-funding-consolidation.json](../deployments/race-funding-consolidation.json).
  This is dedicated test-wallet maintenance, not an automatic app feature.

The live harness accepts `--rounds=3..30` and `--journal=<name>.json`, defaults to
read-only dry-run, uses only the dedicated testnet keys, and caps every new
accepted transaction's fee at **0.01 CKB**. It writes hashes before submission and
atomically replaces its journal. An ambiguous uncommitted hash stops progress;
it must be investigated rather than cleared and blindly resubmitted. Run only
one process per journal. A new journal can transfer 300 testnet CKB to the second
local wallet; the recorded extension reused existing funding.

```sh
# Existing completed journal: dry-run or read-only re-verification of its rounds.
npx tsx scripts/run-race-soak.ts --rounds=12 --journal=race-endurance-result.json
# --execute signs only missing work; never increase rounds without a fee/work budget.
```

These are bounded tests, not days of endurance or exhaustive fuzzing. A separate
machine with the same pinned toolchain does not prove all compiler/OS combinations.
The site's eight browser regressions already passed on both deployed origins;
this hardening does not change its frontend bundle.

## 3. Independent review — handoff ready, review outstanding

The [review brief](EXTERNAL_REVIEW.md) identifies the immutable binary, protocol
invariants, priority questions and evidence. The
[report template](REVIEW_REPORT_TEMPLATE.md) asks for reproducible findings,
remediation verification and an explicit release conclusion.

A reviewer must be selected and independently examine the committed snapshot.
No external party has been contacted and no review opinion is claimed. Mainnet
requires a separate deployment plan after the review outcome is accepted.
