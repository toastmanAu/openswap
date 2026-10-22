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
| P4 | Wallet orchestration | Partial: session-bound review and one-shot signing implemented following explicit mock-only approval (2026-10-13). Mock refusal/mutation/session/timeout tests pass; broader primary/lifecycle/cancellation/expiry coverage remains. Browser bundle smoke passes; real browser/wallet acceptance remains open. |
| P5 | Submission and recovery | Partial: bounded read-only startup reconciliation restores reservations and persists observations. Pool pre-send wiring and terminal resolution remain open; no automatic retry/release. |
| P6 | Live pool lifecycle/admission | Not authorized or demonstrated; VM and mocked connector results cannot close this gate. |
| P7 | Pool UI and routing | Not implemented; dependent on P6. Keep existing orders usable. |
| C1 | Browser CI | Offline browser job added with pinned Playwright Chromium installation and managed local server. Shared RPC fixtures reject unhandled external requests; all eight local browser regressions pass. Hosted execution of uncommitted workflow remains unverified. |
| C2 | Pool artifact CI | Implemented in workflow: pinned size/SHA256/Data1 verification, negative verifier tests and two-directory clean-build comparison for both contracts. Local execution passed with unchanged identities. Hosted run of these uncommitted changes remains unverified. |
| S1 | Durable reference solver | Partial: journal required for execution, signed-byte pre-send persistence, scoped startup reload and conservative reorg/unknown reservations. File-backed restart/storage-failure tests pass. Operator resolution and production invocation wiring remain. See [solver status](../solver/README.md). |
| T1 | Fuzzing/endurance | Existing deterministic corpus/VM checks and 12 recorded live races are bounded. Add reproducible campaigns with explicit stopping criteria; live extension needs approval. |
| D1 | Current documentation | This index and integration plan added; update component docs as code lands. Historical records are not overwritten to claim new evidence. |
| R1 | Independent review | Outstanding for both orders and pools. Prepare frozen commit/artifact package; reviewer engagement, findings and acceptance need actual external evidence/user direction. |
| R2 | Release/deployment approval | Not authorized. No mainnet, paid engagement, funded signing, broadcast or publishing inferred from this goal. |

The pool baseline has 23 VM tests, 24 SDK tests, 88 chained transitions and 77
authorization-negative cases. Measurements reach 36 real owners but are not a
production batching API or relay-policy proof; see the
[resource report](research/POOL_RESOURCE_ENVELOPE.md).

No OTX, gossip or Fiber implementation is required to close this milestone.
Current offline integration check: typecheck, 49 pool SDK tests and 74 SDK/solver
tests pass; 14 model tests passed before this signing-only increment. Synthetic proof
fixtures do not prove JoyID authorization.
Do not commit or push further changes without a separate request.
