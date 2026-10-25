# Project readiness and staged evidence

Updated 2026-10-25 at `1febadb`. This is the current readiness index. Older
milestone reports keep their historical test counts and deployment evidence.
Neither green tests nor this checklist is independent review or mainnet approval.

## Delivery sequence

The user selected **JoyID first** for pools and approved each live stage
separately. The [pool integration plan](research/POOL_INTEGRATION_PLAN.md) has
run in order:

1. Profile, signing boundary and acceptance criteria. Done.
2. Offline single-pool JoyID integration with adverse wallet/RPC cases. Done (P2–P5).
3. Approved testnet lifecycle, then contention and recovery. Done (P6). Reorgs are
   not covered.
4. Pool UI, routing, split routes and browser acceptance, local and public. Done (P7).

What remains needs user decisions: independent review (R1), any mainnet or
real-funds step (R2), and a CoTA proof service for JoyID subkey sessions.

## Gates (keep incomplete work visible)

| ID | Deliverable | Current evidence / missing proof |
| --- | --- | --- |
| O1 | Preserve existing orders | The order lock binary is unchanged and deployed. Order flows have testnet acceptance in [release validation](RELEASE_VALIDATION.md). Later changes touching order code: the synchronous `decodeOrder` (which `parse` uses), and an optional fixed `feeRate` on the order builders, with the default unchanged. All order SDK/solver tests (81), Rust order tests and browser regressions pass on the current tree. |
| P1 | Pool profile and acceptance plan | [Plan](research/POOL_INTEGRATION_PLAN.md). Live parameters, dependencies and issuer were approved on 2026-10-22 for testnet only ([run](research/POOL_TESTNET_RUN.md#approval-2026-10-22-user)). |
| P2 | JoyID witness/dependency compatibility | **Main key: proven live** (P6/P7). JoyID signed every pool action, routed and split swaps on testnet against the pinned layout and dependencies. **Subkey/CoTA sessions: offline only.** They use a synthetic proof fixture and need a proof service the user has not approved. |
| P3 | Funding selection and trusted review | Complete. Selection and reservations are bounded. The review rebuilds the prepared bytes from independent snapshots and freezes the disclosures with an expiry, then is bound to one signing session (`bindReview`). It is used for every live pool transaction, including split routes (lots, maker payments, pool leg, totals). |
| P4 | Wallet orchestration | Complete for the main key. Offline coverage (2026-10-22) includes primary and subkey sessions, cancellation and deadlines mid-sign, review expiry, stale inputs, and session/account/network changes. Live JoyID authorization passed in P6/P7. Subkey sessions are still offline only (see P2). |
| P5 | Submission and recovery | Complete. Sends are reconcile-gated, persist the exact signed bytes before one send, and record ambiguous outcomes as unknown. Resolution is explicit: `archiveCommitted` by confirmation depth, and `abandonConflicted` once an input is spent, with reorg risk acknowledged. Live evidence: P6 sends, and contention resolution in two rounds (P6). Known limitation: a send the node rejects outright stays `unknown` and reserved until resolved by hand ([brief](POOL_REVIEW_BRIEF.md#known-limitations-stated-please-challenge)). |
| P6 | Live pool lifecycle/admission | Passed on testnet. **Lifecycle (2026-10-23):** pool code deployed by the user's JoyID. Create, both swaps, deposit, partial/full withdrawal and re-entry were signed by the JoyID main key and verified on two endpoints. **Contention (2026-10-25):** in two rounds, two wallets swapped against the same pool state through different nodes. Exactly one committed each time; the loser was abandoned through recovery with its funding released, a stale quote was refused, and a fresh rebuild committed. See [testnet run](research/POOL_TESTNET_RUN.md). Not covered: reorgs, subkey sessions, mainnet. |
| P7 | Pool UI and routing | Passed, deployed on toastdex.org. The Pools tab has manifest gating, frozen review, one-shot signing, a browser journal and archival. Swap-tab routing compares order book, pool and split routes and picks the cheapest. Split routes fill whole order lots plus a pool swap in one transaction. **Live (testnet):** JoyID swap, deposit and withdrawal (2026-10-23); routed swaps locally and on toastdex.org (2026-10-24); split swaps locally and on toastdex.org (2026-10-24/25), each verified on two endpoints ([run](research/POOL_TESTNET_RUN.md), [deployments](CLOUDFLARE_PAGES.md)). Not deployed yet: the one-lot split fix (`a1cfaa9`) and the fee-cap message (`dd4e9d0`). The router does not size splits against the fee cap; splits of roughly 28 or more token-paid lots are refused before signing ([limits](FRONTEND.md#split-routes-2026-10-24-live-2026-10-25)). |
| C1 | Browser CI | The hosted browser job runs all browser tests (23 now) with pinned Playwright Chromium and RPC fixtures that reject unhandled requests. It passes on every push through `30c4621` (run 40158642423). |
| C2 | Pool artifact CI | Hosted CI checks pinned size, SHA256 and Data1 hashes, runs the negative verifier tests, compares two clean builds of both contracts, and runs all pool VM tests, including the split tests and a short `split-vm` campaign. It passes on every push. |
| S1 | Durable reference solver | Offline complete (2026-10-22). The journal is required for execution, with pre-send persistence and conservative reservations. Operator resolution is via `npm run solver-journal`, a read-only CLI with no signer. See [solver status](../solver/README.md). Live solver contention or crash testing has not been run; pool-side contention is covered in P6. |
| T1 | Fuzzing/endurance | Seeded campaigns (`npm run campaign`) stop at the budget, the time limit or the first failure, and record provenance. Recorded on clean `a82d72a`: 10M order-parser, 10M pool-wire, 1M TS/Rust differential vectors, and 450 signed VM transitions with 57 tampered-state rejections. **New `split-vm` target (2026-10-25):** random 1–32-lot split routes in CKB-VM, one tampered copy per case. Its runs found the one-lot split builder bug (fixed in `a1cfaa9`) and fee-cap refusals at about 28 token-paid lots, which are policy and now counted as skips (`dd4e9d0`). Results are in [campaigns](campaigns/README.md). Not coverage-guided. |
| D1 | Current documentation | This index was refreshed on 2026-10-25. The [review brief](POOL_REVIEW_BRIEF.md) and [package](REVIEW_PACKAGE.md) cover the testnet deployment, split routes and live evidence. Historical records are not rewritten to claim new evidence. |
| R1 | Independent review | Package ready to freeze: [order brief](EXTERNAL_REVIEW.md), [pool brief](POOL_REVIEW_BRIEF.md), [package process](REVIEW_PACKAGE.md) and `scripts/prepare-review-package.sh`. Outstanding: choosing a reviewer, the engagement, findings and acceptance, all user decisions. No outreach has occurred. |
| R2 | Release/deployment approval | Testnet only. No mainnet deployment, real funds, paid engagement or publication beyond the testnet frontend has been authorized. |

## Current offline check (2026-10-25)

typecheck clean; order SDK/solver 81, pool SDK 68, pool model 15, browser 23,
pool VM 29 tests pass; `cargo fmt` and clippy clean. Synthetic proof fixtures do
not prove JoyID subkey authorization. Resource measurements are in the
[resource report](research/POOL_RESOURCE_ENVELOPE.md). Split routes measure up
to 12.8M cycles (32 CKB-paid lots) and about 9.3 KB (32 token-paid lots).

No OTX, gossip or Fiber implementation is required for this milestone.
