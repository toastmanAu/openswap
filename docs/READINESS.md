# Project readiness and staged evidence

Updated 2026-10-12; baseline `5d08496` (pushed 2026-10-09).
This is the current readiness index. Older milestone reports retain historical
test counts and deployment evidence; neither historical green tests nor this
checklist is independent review or mainnet approval.

## Delivery sequence

The user selected **JoyID first** for pools. Follow the
[pool integration plan](research/POOL_INTEGRATION_PLAN.md) in order:

1. Define the profile, signing boundary and acceptance criteria. Wallet choice
   is confirmed; economic values below are offline proposals, not live approval.
2. Implement and verify offline single-pool JoyID integration for creation,
   both swap directions, deposit and withdrawal, including adverse wallet/RPC cases.
3. Obtain explicit network/deployment/signer/work-budget approval, then validate
   the lifecycle and contention/recovery on that controlled network.
4. Only after that path works, implement pool UI/routing and browser acceptance.

## Gates (keep incomplete work visible)

| ID | Deliverable | Current evidence / missing proof |
| --- | --- | --- |
| O1 | Preserve existing orders | Baseline: 90 Rust tests, 70 SDK/solver tests, eight recorded browser regressions; recorded testnet acceptance in [release validation](RELEASE_VALIDATION.md). Recheck affected paths for new changes. |
| P1 | Pool profile and acceptance plan | [Plan](research/POOL_INTEGRATION_PLAN.md); JoyID selected. Live parameters/dependencies/issuer remain unapproved. |
| P2 | JoyID witness/dependency compatibility | Partial: bounded layout, direct-code/CoTA resolution, bounded proof HTTP adapter and installed connector preparation tests pass offline; relocated lifecycle passes unchanged pool VM with secp authentication. Real JoyID proof/authentication remains unproven. |
| P3 | Funding selection and trusted review | Partial: bounded selection/reservations and lifecycle/concurrency tests pass. Review reconstructs prepared bytes from independent snapshots/policy and freezes decoded disclosures with expiry. Review-to-session/signing orchestration remains missing. |
| P4 | Wallet orchestration | Offline coverage complete (2026-10-22, mock signer only). Primary and subkey sessions sign create, both swaps, deposit, partial/full withdrawal and re-entry, changing only the wallet lock. Covered: cancellation/deadline mid-sign with late results discarded, and review expiry before/during signing. Also covered: stale funding/CoTA inputs, session/account/network changes and bindReview mismatches. One end-to-end resolve→review→sign→durable-submit test runs too. Real JoyID authorization and browser/wallet acceptance remain open (P6/P7). |
| P5 | Submission and recovery | Offline implementation complete (2026-10-22): reconcile-gated `submit` persists exact signed bytes before one send, hands reservations to recovery and records ambiguous sends as unknown; explicit `archiveCommitted` (confirmation depth) and `abandonConflicted` (spent input, acknowledged reorg risk) archive and release. File-journal/mock-chain tests only; live send, contention and reorg evidence belong to P6. |
| P6 | Live pool lifecycle/admission | Passed on testnet (2026-10-23, user-approved). The pinned pool code was deployed by the user's JoyID. All seven steps were signed by the JoyID main key and verified on two endpoints against the model, the fee cap and the recipients: create, both swaps, deposit, partial/full withdrawal and re-entry. Two deadline incidents sent nothing; both are fixed. See [testnet run](research/POOL_TESTNET_RUN.md). Not covered: contention, reorgs, subkey/CoTA sessions, mainnet. |
| P7 | Pool UI and routing | The Pools tab has manifest gating, frozen review, one-shot signing, a browser journal with node-status labels, and archival at 24 confirmations; 20 browser tests cover it. Live acceptance passed on testnet (2026-10-23): a JoyID swap, deposit and withdrawal through the local build all committed and were verified on two endpoints against the model ([run](research/POOL_TESTNET_RUN.md)). Best-single-venue routing between the order book and listed pools is implemented offline (browser-tested). The pool token trades in both venues through a pinned Data1 xUDT resolver. Public deployment and live routed-swap acceptance passed (toastdex.org, 2026-10-24). Split routes (whole order lots plus a pool swap in one transaction) are implemented offline (2026-10-24): contract-VM tests run the real order lock and pool validator together in both directions and at the 32-lot maximum, with SDK and browser tests. Live split-route acceptance passed on testnet (2026-10-24): a JoyID swap filled two order lots from another wallet plus the pool in one transaction, verified on two endpoints ([run](research/POOL_TESTNET_RUN.md)). Split routes are deployed on toastdex.org (2026-10-24). |
| C1 | Browser CI | Offline browser job added with pinned Playwright Chromium installation and managed local server. Shared RPC fixtures reject unhandled external requests; all eight local browser regressions pass. Hosted run passed (GitHub Actions run 39755262422, commit `652660d`, 2026-10-22). |
| C2 | Pool artifact CI | Implemented in workflow: pinned size/SHA256/Data1 verification, negative verifier tests and two-directory clean-build comparison for both contracts. Local execution passed with unchanged identities. Hosted run passed (GitHub Actions run 39755262422, commit `652660d`, 2026-10-22). |
| S1 | Durable reference solver | Offline complete (2026-10-22). The journal is required for execution, with signed-byte pre-send persistence, scoped startup reload and conservative reorg/unknown reservations. Shared operator resolution (`archive-committed` by confirmation depth, acknowledged `abandon-conflicted`) is exposed via `npm run solver-journal`, a read-only RPC CLI with no signer. The testnet integration runner uses a private `.local` journal. Tests cover a restart after resolution re-enabling the orders. Live contention/crash validation needs P6-style approval. See [solver status](../solver/README.md). |
| T1 | Fuzzing/endurance | Offline complete (2026-10-22). Seeded campaigns (`npm run campaign`) stop on budget, time or first failure and record provenance. Recorded on clean `a82d72a`: 10M order-parser, 10M pool-wire, 1M TS/Rust differential vectors and 450 signed VM transitions with 57 tampered-state rejections; no failures. See [campaigns](campaigns/README.md). Not coverage-guided; live endurance needs approval (P6). |
| D1 | Current documentation | This index and integration plan added; update component docs as code lands. Historical records are not overwritten to claim new evidence. |
| R1 | Independent review | Package prepared (2026-10-22): the new [pool brief](POOL_REVIEW_BRIEF.md) adds to the existing order brief. [Package process](REVIEW_PACKAGE.md) and `scripts/prepare-review-package.sh` (clean-tree archive, rebuilt identities, toolchain/lockfile hashes, campaign summary) are in place. Outstanding: reviewer selection, engagement, findings and acceptance, all of which are user decisions. No outreach has occurred. |
| R2 | Release/deployment approval | Not authorized. No mainnet, paid engagement, funded signing, broadcast or publishing inferred from this goal. |

The pool baseline has 23 VM tests, 24 SDK tests, 88 chained transitions and 77
authorization-negative cases. Measurements reach 36 real owners but are not a
production batching API or relay-policy proof; see the
[resource report](research/POOL_RESOURCE_ENVELOPE.md).

No OTX, gossip or Fiber implementation is required to close this milestone.
Current offline integration check (2026-10-22, P4 at `625e187` plus S1):
typecheck, 61 pool SDK, 80 SDK/solver and 14 model tests pass. Synthetic proof
fixtures do not prove JoyID authorization.
Do not commit or push further changes without a separate request.
