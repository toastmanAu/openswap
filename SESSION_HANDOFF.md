# ToastDEX — next-session handoff

Saved 2026-10-12 (Australia/Adelaide). Read this first when resuming.

## Current request and stopping point

### Rings in the Markets tab (2026-10-30)

Markets recognises solver settlements from the fills (`settlements()`, pool-sdk
market-stats): a "Solver settlements" panel lists matches and rings with each fill,
the spread kept and a link to each leg's market; trades from a settlement are
labelled in the trades list and tooltip. Fixtures now include the live multi-order
and ring settlements. Live since Pages deploy `af6bc486`.

### Three-asset rings (2026-10-29)

`matchRing` settles a cycle of three orders (A->B->C->A) when no direct match
exists; verified offline and on the real v2 binary (60 rings, both orientations).
Run live 2026-10-30 (`scripts/lock-v2-ring.ts`): CKB->TEST2->TEST3->CKB settled in
`0x21543cfa…9f0fa` (block 22,901,977), verified on both endpoints; the solver kept
16 CKB. Remainders stay live: 2,000 TEST2 (contention wallet) and 400 TEST3 (maker).

### Fee rate cap (2026-10-29)

Order-book transactions now use the node's fee estimate bounded to 1,000–5,000
shannons/KB, max 0.01 CKB per transaction, with the review stating the rate and any
capping (`frontend/src/fees.ts`). Live since Pages deploy `5c7cc88e`.

### Multi-order solver matching (2026-10-29)

`matchBook` settles several v2 orders (and whole v1 lots) per side of one market in
one transaction; verified offline (solver tests) and on the real v2 binary (60
matcher-built books, up to 8 legs, conservation checked from cells), and live:
four orders from two owners settled in one transaction `0x8c7a20aa…12fe4`
(`deployments/lock-v2-multi.json`). A's buy order remainder (648 CKB) stays live
until it expires.

### Market data (2026-10-29)

New Markets tab: trades, stats, price and depth charts read from the chain (no
server). Extraction (`pool-sdk/src/market*.ts`) is verified against every recorded
live fill/route on both endpoints (`scripts/market-verify.ts`). Live on
toastdex.org since Pages deploy `cc8fc43f` (verified). Faster refresh done (relevant inputs only, incremental refresh, saved history;
first visit ~5.3 s, returning ~1.8 s), live since Pages deploy `2ac8f6bb`.

### Order lock v2: partial fills and expiry (2026-10-29)

The user chose one v2 lock covering both features, then approved the defaults:
soft expiry with permissionless return, timestamp only, no keeper tip, and v2-only
creation after deploy. Design and status: [ORDER_LOCK_V2](docs/research/ORDER_LOCK_V2.md).
Steps 1–2 (spec, TS model, vectors, contract, VM tests) are done offline and
pushed. The v1 binary still matches the deployment. Step 3 (SDK) is done offline:
planners, builders, discovery, mixed v1/v2 quotes, and a VM replay campaign of
SDK-planned chains (`lock-v2-sdk`). Step 4 (solver) is done offline:
`ReferenceSolverV2` with partial pair matching and an expiry keeper. Step 5
(frontend) is done, gated on a served v2 manifest. Step 6: the v2 lock is
deployed on testnet (user approved; tx `0xf2d18570…8457`, recorded in
`deployments/testnet-v2.json`), and a local-key live run of create, partial fill,
final fill, CKB-offer partial fill, cancel and keeper return passed on both
endpoints (`deployments/lock-v2-live.json`). Builds now ship the v2 manifest, but
toastdex.org has v2 since Pages deploy `0754cabe` (source `e1f617c`, verified).
The user's JoyID partial fill on toastdex.org (tx `0xddf59ef8…5979`, 350 of 2,000
TEST3 at 2 CKB) is verified (`deployments/lock-v2-joyid.json`); 1,650 TEST3 of
that order stays live until about 2026-10-30 06:59 UTC. The live campaign
(`scripts/lock-v2-campaign.ts`, `deployments/lock-v2-campaign.json`) passed: 27
transactions, 6 two-taker races each with exactly one commit, 14 fills (8
partial), a solver match with a partial leg, a fill after expiry and a two-order
keeper return. Step 6 is done. Live leftovers: 1,650 TEST3 (JoyID test order) and
550 TEST3 (solver match) remain on the book until they expire.

### Multi-hop routing and more pools (2026-10-29)

User direction: hold the audit until after feature work and a public testnet
round, then seek a grant. Started with multi-hop routing and more pools.

Done, committed locally and not pushed:
- `buildRoute` and `quoteRouteExactOut`: token A to CKB to token B through two
  pools in one transaction. No contract change was needed.
- A route intent in funding and review. The Swap tab compares two-pool routes
  for token-to-token requests, with a two-leg review.
- Tests: VM test `sdk_two_pool_route`, `route.test.ts`, and a browser case.
  Full offline suite green.
- Live on testnet with local keys only: TEST2 and TEST3 minted, CKB/TEST2 and
  CKB/TEST3 pools created, and one maker-signed route verified on two
  endpoints ([run](docs/research/POOL_TESTNET_RUN.md#more-pools-and-a-live-two-pool-route-2026-10-29)).
  The user's JoyID holds 20,000 TEST2 and 1,000 TEST3 for trying routes.
- The manifest lists all three pools, and the local app quotes live routes.

Next, all needing the user:
- A JoyID-signed two-pool route from the local build (`npm run dev:frontend`).
- Push, and a Pages deploy so toastdex.org lists the new pools.
- The review freeze at `e9aa38c` predates this work; refreeze after features.

### Status check, no code change (2026-10-29)

Tree clean at `5e7f61b`, equal to `origin/main`. Offline check at HEAD: typecheck
clean; order SDK/solver 81, pool SDK 70, pool model 15 tests pass. Live testnet:
two open order lots (both owned by one JoyID lock not recorded in this repo) and
the P6 test pool at state `0x3dbe5e92…1cdd`. Both `toastdex.org` and
`toastdex.pages.dev` serve the recorded deployment of `09ca6f9`.
Update (2026-10-29): both now serve the recorded deployment of `99dfe12`
(two-pool routes and the TEST2/TEST3 pools; see [Pages](docs/CLOUDFLARE_PAGES.md)).
The user signed a two-pool route with JoyID there (tx `0xf035abad…ec0c`),
verified on both endpoints by `scripts/pool-route-verify.ts`.

Since 2026-10-23 (see [readiness](docs/READINESS.md) and
[Pages](docs/CLOUDFLARE_PAGES.md)): routed and split swaps deployed and signed
live; split-vm campaign recorded clean on `dd4e9d0`; review package frozen
locally at `9f8f520` (three commits behind HEAD); Release-inputs action and own-
order cancellation from the Swap tab deployed on 2026-10-26.

All plan stages (P1–P7) are done. What remains is a user decision:
- R1 reviewer engagement. **Prep done 2026-10-29:** all five campaigns rerun
  clean on `5e7f61b`, readiness refreshed, package frozen at `e9aa38c`
  (archive SHA256 `19067488…`, local `release/` only; see
  [package](docs/REVIEW_PACKAGE.md)). Next is the user's: pick a reviewer
  ([candidates](docs/REVIEW_CANDIDATES.md)), send the inquiry, share the commit,
  archive hash and manifest. Local commits are not pushed.
- CoTA proof service for JoyID subkey sessions (offline only today).
- R2 mainnet/real funds (blocked on R1 by `TASKS.md`).


### P7 live acceptance passed (2026-10-23)

A JoyID swap, deposit and withdrawal through the local Pools tab
(`npm run dev:frontend`) were verified on two endpoints. Fixes made along the way:
- token decimals;
- inline errors and progress;
- single-flight preparation;
- submission status labels and archival;
- dev bundle versioning.

Next candidates, all user decisions:
- public UI hosting;
- order/pool routing;
- the reviewer engagement;
- the CoTA proof service for subkeys.

### P6 testnet pool lifecycle passed (2026-10-23)

The pool code was deployed and the test token minted. All seven lifecycle steps
were signed by the user's JoyID and verified on two endpoints. Evidence is in
`deployments/pool-*.json` and `docs/research/POOL_TESTNET_RUN.md`. Fixes found
live: the signing deadline is now 60 s, and `submit` maps any post-persistence
failure to an `unknown` outcome. `deployments/pool-frontend.json` is generated.
Next: P7 live acceptance (serve the frontend and use the Pools tab with JoyID on
testnet). Open: reviewer engagement and the CoTA proof service (user decisions).
Local commits not yet pushed.

### T1 campaigns and R1 review package (2026-10-22)

S1 committed as `e7dd66c`. T1 code is `30f1676`, and the provenance fix is
`a82d72a`: the ledger itself had marked later runs dirty, and a trimmed git
status corrupted a path. Recorded clean campaigns on `a82d72a` all passed:
10M order-parser, 10M pool-wire, 1M differential vectors and 450 VM
transitions (57 tampered rejections). See docs/campaigns.
R1 adds `docs/POOL_REVIEW_BRIEF.md`, `docs/REVIEW_PACKAGE.md` and
`scripts/prepare-review-package.sh`, and links them from the order brief and
the draft inquiry. No reviewer was contacted. Nothing has been pushed since
`5d08496`.
Open: reviewer engagement (user decision); P6 approval (network, deployment,
signer, fee budget); P7 after P6.

### S1 solver operator resolution (2026-10-22)

P4 committed locally as `625e187` (not pushed). Uncommitted on top:
- `solver/src/resolution.ts` holds the shared archive/abandon checks;
  `PoolSubmissionRecovery` now delegates to it.
- `npm run solver-journal`: list/status/archive-committed/abandon-conflicted.
  Read-only RPC with no signer; fails clearly when the solver holds the lock.
- `scripts/run-solver-integration.ts` now passes a `.local` journal shared via
  `scripts/solver-journal-config.ts`. It refuses to tick while unresolved rows
  exist. Not executed: no live run is authorized.
- Four new solver tests, including lost reply -> reserved -> operator abandon ->
  restarted solver rebuilds. 80 SDK/solver, 61 pool SDK, 14 model tests pass.
Remaining offline-able gates: T1 fuzz/endurance campaigns, R1 review package.
P6 (controlled-network pool lifecycle) needs explicit user approval of network,
deployment, signer and fee budget.

### P4 signing coverage (2026-10-22)

P5 committed locally as `867f297` (not pushed). Uncommitted on top: four new
`joyid-session.test.ts` tests, mock signer only, plus a plan/readiness update.
- Primary and subkey sessions sign a seven-step lifecycle. Only the wallet lock
  changes; the subkey proof is preserved.
- Cancellation/deadline during the wallet await discard the late result.
- Expiry before and during signing is rejected.
- Stale funding/CoTA inputs, revision/account/network changes and bindReview
  network/witness/dependency mismatches fail with pinned reasons.
- One end-to-end resolve, review, sign and durable submit flow sends once.
No source changes were needed. 60 pool SDK, 76 SDK/solver and 14 model tests pass.
Next: S1 solver operator resolution and production wiring. P6 needs approval.

### P5 pool submission and resolution (2026-10-22)

User authorized a local checkpoint commit and work on P5. Checkpoint `60e958b`
(local, not pushed) holds all work through 2026-10-17. On top of it, uncommitted:

- `PoolSubmissionRecovery.submit`: requires prior `reconcile`; checks review
  integrity/expiry, non-zero wallet lock, hash identity with review and funding,
  reservation ownership and freshness; persists exact signed bytes, synchronously
  hands the reservation to recovery, sends once. Journal failure prevents send;
  send failure returns `unknown` and keeps the row/inputs held. No retry.
- Explicit resolution: `archiveCommitted` (default 24 confirmations) and
  `abandonConflicted` (acknowledged reorg risk, at least one spent input, status
  neither committed nor in flight before and after input reads). All-live rows are
  refused. `FileSubmissionJournal.archive` appends to fsynced `archive.jsonl` first.
- Shared `pool-sdk/test/funding-fixture.ts`; six new recovery tests with a real
  file journal, mock chain and mock-signed create fixture, including restart.
- Typecheck, 56 pool SDK, 76 SDK/solver, 14 model tests pass. No live operation.

Next: P4 sign coverage (primary/lifecycle, cancellation/expiry during awaits,
stale inputs), then S1 operator resolution wiring in the solver. P6 still needs
explicit network/deployment/signer/budget approval.

### Durable runner / pool recovery continuation (2026-10-17)

Runner execution now requires an explicit scoped journal; legacy integration
scripts without one fail closed. Startup reloads signed bytes before scan, checks
account/network, excludes recorded funding inputs and speculative outputs, and
persists at the pre-send boundary. Missing status no longer releases orders.
Committed rows remain tracked for reorgs; rejected rows stay held pending deliberate
operator reconciliation. File-backed restart/lost-reply and storage-failure tests
pass with mock signing/send only.

Added PoolSubmissionRecovery: bounded read-only status/live-input reconciliation
with restored reservations and persisted observations. No automatic retry/release.
Pool pre-send wiring and explicit terminal resolution/archival remain unfinished.
Typecheck, 76 SDK/solver tests and 50 pool SDK tests passed; final reservation/reorg
refinements passed 11 targeted tests. No live operations, keys, commits or pushes.
Earlier runner-in-memory statements below are superseded by this section.

### Latest continuation — mock-only approval granted (2026-10-13)

The user explicitly approved implementing signing capability and persistence
integration with mock-only tests. This resolves the earlier automatic-review
approval question below. No live signing, key access or broadcast is authorized.

- Existing SDK `submit` now awaits its pre-send callback and passes exact signed
  bytes as a second argument. It clones the signer result to isolate wallet-owned
  references. Callback rejection prevents send. Mock tests verify persistence
  ordering and byte identity; all 74 SDK/solver tests pass.
- Resolved JoyID wallets now expose `bindReview(review)`, returning the frozen
  identity/disclosures and an explicit one-shot `sign()` operation. It verifies
  account/genesis/dependencies/proof, freshness, expiry and captured session around
  the signature request; only the reviewed lock field may change. Unsigned zero
  placeholders are rejected. No broadcast method is added.
- Mock signer tests cover successful subkey signing, refusal, raw/proof mutation,
  unsigned results, session changes, timeout/late result and duplicate attempts.
  Typecheck and all 49 pool SDK tests pass. No actual JoyID signer was invoked.
- Next: extend sign tests to primary/all transitions, cancellation/expiry during
  awaits and stale inputs; wire the durable solver store into startup/pre-send
  recovery and implement safe pool submission/reconciliation. Storage-only tests
  do not prove the runner restart gate. Overall readiness goal remains incomplete.

All changes remain uncommitted. Earlier evidence/approval statements below are
historical where superseded by this section.

### Ordered readiness goal — JoyID first (2026-10-12)

The user requested a gap analysis, then an active goal to close the identified
gaps in order. They explicitly selected **JoyID first**, not secp-first. The goal
remains active and incomplete; do not redefine completion as these initial tests.
Baseline `5d08496` was pushed to origin/main on 2026-10-09. No further commit or
push has been requested. Current edits are uncommitted.

Start with [READINESS.md](docs/READINESS.md) and the
[integration plan](docs/research/POOL_INTEGRATION_PLAN.md). They separate proposed
offline parameters from live approval and track every supporting CI, solver,
fuzz/endurance and independent-review gap. Stage order: profile/criteria,
offline JoyID wallet integration, explicitly authorized controlled-network
lifecycle, then pool UI/routing. No deployment, funded signing/broadcast, user-key
access, paid review engagement, mainnet or publication without separate approval.

Implemented this turn:

- Inspected installed JoyID 1.2.3/core 1.21.0 preparation/signing source. It reserves
  1,000 signature bytes and may put a subkey proof in wallet `outputType`.
- Added explicit `wallet.witness: {kind:'joyid', outputType?: resolvedProof}` to
  pool builders. Default secp layout/65-byte policy stays unchanged. JoyID permits
  a bounded 1..1,000-byte lock replacement and at most 3,000 proof bytes; every
  other witness field, action, raw field and optional input cache stays pinned.
- JoyID genesis puts minted LP at output 0, state at 1, X/Y at 2/3, action at
  witness 1 and wallet proof at witness 0. This avoids the subkey/create-action
  collision without changing the contract or ABI. `built.stateOutputIndex` is
  explicit; one-input genesis has two witnesses. Fees reserve the full placeholder.
- Four new SDK tests exercise actual connector preparation using offline mock
  connections/dependencies and a synthetic pre-resolved proof. These do NOT
  authenticate a real JoyID credential/proof or exercise live popup signing.
- New Rust `sdk_joyid_layout_with_secp_authorization` verifies two genesis layouts
  and ten chained transitions with real xUDT/secp. Full withdrawal/re-entry passes.
  This proves pool layout/accounting, NOT JoyID/WebAuthn authorization.
- Typecheck, all 28 pool SDK tests, 70 existing SDK/solver tests, `make check`,
  fixture hashes and both contract identities pass. Full 24-test VM run passed.
  After final canonical wallet-witness round-trip enforcement was added, typecheck,
  all 28 SDK tests and both JoyID-layout/legacy-resource VM tests passed again.

Continuation evidence (2026-10-12, still uncommitted):

- Added `joyid.ts`: bounded direct-code/CoTA dependency resolution, pinned content,
  account/key/client/genesis/session-revision checks, cancellation and overall
  deadlines. Actual installed connector preparation is checked before and after
  freshness reads. Pre-resolving proof avoids its unbounded CoTA scan. The caller
  must advance session revision on account/network/disconnect events.
- Added `joyid-proof.ts`: explicit read-only proof HTTP adapter with no redirects,
  16 KiB streamed response cap, exact RPC envelope and 1..3,000-byte proof checks.
  This validates encoding, not cryptographic proof authenticity.
- Added `funding.ts`: bounded exact-owner eligible-asset selection, deterministic
  asset/capacity order, typed funding-only retries, fee-cap fail-closed behavior,
  live checks and atomic process-local input reservations with cleanup. Reservations
  are not durable and must remain held across ambiguous submission outcomes.
- Current verification: typecheck, **42 pool SDK tests and 70 existing SDK/solver
  tests pass**. Includes nine resolver/proof tests and five funding tests. No live
  JoyID signing, deployment, broadcast or external proof service was used. Prior
  VM evidence above is unchanged; the VM suite was not rerun for this increment.

Further continuation: selector tests now consume exact predecessor outputs across
creation, both swaps, deposit, full circulating withdrawal and re-entry. Concurrent
selectors permit only one overlapping reservation; competing transitions with
disjoint wallet funding still conflict on pool inputs, without leaking reservations.
Typecheck and the full **45-test pool SDK suite pass**. This increment changes
tests/docs only; the prior 70 order/solver and VM evidence remains historical.

Further continuation: `pool-sdk/src/review.ts` now reconstructs the supported
layout from explicit intent/policy and independent input snapshots, verifies exact
unsigned prepared bytes and decodes the action. Frozen disclosures cover asset
identity, recipients, token/LP output amounts, fees, occupied capacity, permanent
backing and previous/next accounting. Independent transaction copies, signature-only
integrity checks and expiry/freshness checks are exposed. This reuses the existing
model/builder, not an independent validator or RPC trust proof. Two new regressions
test mutation, forged builder summaries, expiry/cancellation/stale inputs; the
selector lifecycle also exercises transition reviews. Typecheck, all **47 pool SDK
tests and 70 existing SDK/solver tests pass**. No VM rerun was needed for this
SDK-only increment; no live operation or commit occurred.

Next: bind review to the resolved JoyID session and implement offline-tested
signing orchestration and durable submission/recovery. The review module does not
itself check JoyID identity or request a signature. Include expiry during awaits,
late wallet results, refusal and account/network changes in orchestration tests.

Approval boundary encountered in subsequent continuation: the automatic reviewer
rejected adding a `signOnlyTransaction` wrapper because that introduces a real
wallet-signing capability, despite the intended mock-only tests. Read-only checking
confirmed the rejected patch did not land. Do not bypass this rejection. Ask the
user to approve implementing the signing capability with mock-only execution;
funded/live signing, user-key access and broadcasts remain separately prohibited.
No new tests were run in that continuation and no signing method was invoked.
Safe parallel preparation while signing approval is pending: removed the pool
model's `node:util` runtime dependency using strict expected-record comparison.
Parity tests cover extra/missing keys, symbols, prototypes, numeric types and
cycles. Replaced read transport's Buffer concatenation with Uint8Array/TextDecoder.
The public SDK now bundles for browsers and initializes/runs a mocked read without
Buffer/process/require in a JS realm. This smoke runs in the existing pool SDK CI
command; it is not actual browser UI or wallet acceptance. Typecheck, 14 model
tests, 48 pool SDK tests and 70 existing SDK/solver tests pass. Signing remains
unimplemented and approval remains unanswered; no wallet/key access occurred.
Do not present this as completed wallet support.
Further safe supporting work: added `scripts/check-pool-identity.py` with pinned
42,176-byte/SHA256/Data1 expectations and `scripts/test-pool-identity.py` negative
regressions (modified, truncated, empty, appended, missing binaries). Core CI calls
both. `check-reproducible.sh` now builds both contracts in each of two disposable
target directories, compares bytes and verifies both identities. Full local run
passed; both contract hashes remain unchanged. Two verifier tests and shell syntax
checks passed. Hosted execution is not claimed for uncommitted workflow changes.
Signing approval is still unanswered; no signing implementation was retried.
Browser CI continuation: added an isolated workflow job installing Chromium from
the pinned Playwright package. The config now manages its own local server and
uses bundled Chromium in CI (local CHROME_BIN remains supported). Shared test RPC
fixtures supply headers/indexer/empty history; existing populated-book and activity
routes override with fallback. Unhandled external requests fail and service workers
are blocked. All eight browser regressions and typecheck passed locally. These are
now explicitly offline regressions, not renewed live testnet acceptance. No real
wallet signing occurred. Hosted CI still requires publication and a recorded run.
Live dependencies/economic policy/fee-work budget are still unapproved. All later
readiness gates remain open; earlier stopping points below are historical.

Solver storage continuation: added Node-only `solver/src/journal.ts` (not exported
through the browser-facing SDK). Atomic same-directory snapshot replacement with
file/directory fsync, explicit network/account scope, canonical byte/hash/input-key
validation, single-writer lock, independent reads and fail-closed write errors.
No RPC or signing methods. `solver/README.md` records limits and operator recovery.
Runner remains in-memory: next solver step is exact signed-byte pre-send persistence
and startup/reservation/reorg reconciliation. The existing SDK pre-send hook only
passes a hash; do not journal unsigned builder bytes as signed transactions.
Signing-capability approval remains unanswered and its rejected patch was not retried.
Storage validation: all 73 SDK/solver tests pass, including persisted byte/scope
checks, competing writers, corruption/interrupted-write obstacles and abrupt child
process exit with explicit test-only lock recovery. This proves the storage layer,
not integrated solver restart or ambiguous-send recovery.

### Distinct-owner milestone commit (2026-10-09)

The user authorized committing the completed distinct-owner composition
milestone. This commit contains the tests and documentation described below;
earlier uncommitted-status statements are historical. The goal is complete.
No push or new goal was requested.

### Distinct-owner composition measurements (2026-10-08)

Resource milestone was committed locally as `714cb69`; it was not pushed.
The next offline goal is implemented in tests/docs and remains uncommitted.
Read [POOL_RESOURCE_ENVELOPE.md](docs/research/POOL_RESOURCE_ENVELOPE.md) for
fixture assumptions, measurements and remaining limits.

- New `pool-tests/src/sdk/composition.rs` builds verified SDK genesis/deposit
  fixtures with public secp keys and real xUDT. It measures four pools with
  interleaved owners A/B/A/B, then 8/16/36 pools with one owner each. No synthetic
  ALWAYS_SUCCESS padding is used in this new compact-action profile.
- Each unmerged deposit consumes six inputs and produces seven outputs. The
  test derives a 36-pool layout-specific maximum: 216 inputs/252 outputs; a 37th
  would require 259 outputs. This is not a universal protocol maximum.
- Observed sizes/cycles: 7,994 bytes/~25.94M; 16,112/~93.74M; 32,008/~328.00M;
  71,748/~1.528B. Final regression ceilings: 33M/120M/415M/1.920B cycles and
  9,000/17,000/34,000/75,000 bytes, with roughly 25% rounded cycle headroom.
- All 62 measured owner-group instances reject an individually removed
  signature. Both interleaved owners and the final owner in each larger batch
  additionally reject wrong-key signatures, one-byte signature mutations and
  later group-witness mutations: 77 negative cases in total, attributed to the
  intended input lock rather than accepting cycle exhaustion or pool errors.
- Asserts exact genesis predecessor points, unique pools/inputs, explicit
  dependencies, occupied capacities and exact combined fee accounting. Only
  final plain wallet change is repriced; every owner signs the resulting raw tx.
- Targeted composition test passed. Typecheck, 24 pool SDK tests, 70 existing
  SDK/solver tests, 90 order VM tests, fixture hashes and `make check` passed.
  Final full 23-test pool VM run with tightened ceilings passed, including all
  77 authorization-negative cases and the existing 88 chained transitions.
  Both contract identities match baseline; production SDK/ABI are unchanged.

CI's existing full pool-test invocation automatically includes this test and
prints COMPOSITION/COMPOSITION_AUTH rows. No remote CI result is claimed.
The largest compact fixture exceeds 1.5B cycles; VM success is not relay or
production approval. Remaining gaps include distinct tokens, merged/alternative
layouts, combined wide-witness/many-owner extremes and independent review.
Live wallet/node integration still needs separate scope and authorization.
No deployment, broadcast, funded transaction, user-key, frontend or mainnet work.
No further commit or push without a separate user request. Earlier stopping
points below are historical.

### Resource milestone commit and next piece (2026-10-08)

The user authorized committing the completed resource-measurement milestone and
moving to the next piece. This commit contains that milestone; uncommitted-status
statements below are historical. No push was requested.

Next goal: offline measurements of distinct real wallet signing groups and larger
pool compositions, with missing/wrong-signature rejection tests, explicit fees,
cycle/byte regression ceilings and documented fixture limits. Preserve both
contract identities, the ABI and production SDK behavior. Use public fixture keys
only; no deployment, broadcast, funded transactions, user-key access, frontend or
mainnet work. Further commits and pushes require a separate request.

### Resource envelope and broader sequence coverage (2026-10-05)

Review and fixes were committed locally as `f5dcc94`; no push was requested.
The subsequent offline resource/coverage milestone is implemented in tests and
documentation only, and remains uncommitted. Read
[POOL_RESOURCE_ENVELOPE.md](docs/research/POOL_RESOURCE_ENVELOPE.md) for exact
measurements, reproduction commands, fixture assumptions and remaining limits.

- New `pool-tests/src/sdk/resource.rs` composes real SDK deposit transitions for
  1/2/4 independent pools with 256 inputs AND 256 outputs, 512-byte padding Scripts
  and 4,096-byte action WitnessArgs. Core wallet inputs use real secp and real
  xUDT; padding alone uses ALWAYS_SUCCESS. Group-aware signing handles interleaved
  wallet inputs. Fees are recalculated after composition from wallet change.
- Final observed peaks: ~63.23M / 123.50M / 241.59M cycles and 155,712 / 157,486 /
  161,034 bytes. Regression budgets are 80M / 155M / 305M cycles with roughly 25%
  rounded headroom, plus explicit byte ceilings. Two-pool 257-input, 257-output,
  513-byte Script and 4,097-byte witness cases reject with bound error 2.
- Added four seed-budgeted regimes: fee 0/30/9999/100, M from 1 to 10^12,
  asymmetric reserves and a large y=2^110 case. Each has 12 mixed steps plus full
  withdrawal and re-entry. Exact predecessor points and non-reuse are asserted;
  L=M and subsequent L>M are checked. With the original 32 steps, 88 chained
  SDK-generated transitions are verified. New regime peak ~4.19M cycles and
  2,358 bytes; regression budgets are 6M cycles / 3,000 bytes.
- Resource test now runs independently from sequence tests. CI uses `--nocapture`
  so `ENVELOPE` and `REGIME` measurements remain visible on passing runs.
- Typecheck, 24 pool SDK tests, 70 existing SDK/solver tests, `make check`, and
  all 22 pool VM tests pass. Fixture checks and immutable order identity pass;
  pool SHA256 remains `d3a6520f08859787e34b5497d0f0f4c893b81b96fe7aaa280e50584024f67829`.

These are VM measurements, not a universal worst-case proof or live relay
approval. The previous 100M allowance was a test budget, not a consensus limit.
Large fixtures exceed it and may exceed a target node's independent byte/cycle
policy; that policy was not queried. Four pools/one real owner group is a measured
sample, not the maximum possible composition. The composer is test-only, not a
new SDK batching API. Contracts/ABI and production SDK code are unchanged.
No deployment, broadcast, funded transaction, user-key, frontend or mainnet work.

Next safe milestone: broaden distinct-owner/maximum-composition measurements or
obtain an independent review; target-wallet/live-node integration still needs
separate scope and authorization. Earlier next-step statements below are history.

### Review/fix commit and next milestone (2026-10-05)

The user authorized committing the internal review and R1/R2 SDK fixes together
and moving to the next piece. This commit includes that review, remediation,
regression tests and documentation. Earlier uncommitted-status statements below
are historical. No push was requested.

Next milestone: offline combined resource-envelope measurements and broader
deterministic randomized SDK-to-VM coverage. Exercise high input/output counts,
wide scripts, multiple pools and real signatures together; record reproducible
cycle/size measurements and conservative operational guidance, not a formal
worst-case proof. Preserve both contract binaries and the ABI. No deployment,
funded transactions, user-key access or frontend work is authorized.

### SDK findings R1/R2 fixed (2026-10-02)

The user authorized fixing both internal-review findings. `builders.ts` now
requires an own valid witness entry at every numeric index, rejecting sparse,
inherited, malformed, missing and extra entries (R1). It also takes independent
reviewed input snapshots and checks each supplied candidate cache against them
before and after freshness RPC awaits (R2). Capacity, lock, type or data changes
reject. Either cache may be `undefined` for raw-deserialized/partially cached
transactions; null caches reject. The signature slot still accepts exactly 65
bytes without changing raw transaction fields or other witness fields.

The two characterization tests have become four rejection/policy regression
tests, covering both genesis and transition witness layouts, honest/partial/
absent caches, signature replacement, asynchronous cache mutation and mutation
of the original transaction's caches. README and review report now document
the policy and distinguish the historical findings from remediation.

Verification for this fix: typecheck, all 24 pool SDK/CLI tests, all 70 existing
SDK/solver tests and all 21 pool VM tests pass, including the 32 randomized
real-signature transitions. The immutable order identity verifier passes and
the pool SHA256 remains
`d3a6520f08859787e34b5497d0f0f4c893b81b96fe7aaa280e50584024f67829`.

Changes remain uncommitted; no push, deployment or live transaction is authorized.
Contract code, ABI, order behavior, frontend and user keys remain untouched.
The remaining release gates in the review report still apply; fixing two SDK
findings is not independent audit or production approval. Earlier next-step and
unfixed-status statements below are historical.

### Internal review completed (2026-10-01)

SDK/hardening milestone committed locally as
`85731fe78371ee1d35d54ec056a9ee3d9ccce890`; it has not been pushed by this session.
The subsequent offline internal review is documented in
[POOL_INTERNAL_REVIEW.md](docs/research/POOL_INTERNAL_REVIEW.md). It includes a
threat model, requirement/code/test matrix, severity-ranked findings, evidence,
coverage gaps and explicit release-readiness gates. It is not an independent
audit or production approval.

Two low-severity SDK findings were reproduced in `pool-sdk/test/review.test.ts`:

- **R1:** deleting a witness array element keeps its length but makes `forEach`
  skip that slot, so the integrity guard accepts a sparse missing witness.
- **R2:** a prepared transaction copy can carry false cached input capacity/data
  while raw OutPoints/hash stay unchanged; integrity and freshness validate the
  signed fields/original inputs, not that copy's advisory caches.

Neither reproduction demonstrates an on-chain reserve-theft or inflation path.
The characterization tests intentionally pass when the findings reproduce;
they are not evidence of remediation. No production code or protocol fixes were
made. The report proposes SDK-only fixes and a clear cache/display trust policy
as the next implementation milestone, subject to user authorization.

Current verification: typecheck, `make check`, 22 pool SDK tests, 70 existing
SDK/solver tests, 13 model tests, 10 Rust arithmetic/wire tests, 21 pool VM tests,
90 order VM tests, 42,155 accounting vectors, 3,291 wire vectors and fixture
checks pass. Both contract hashes are unchanged and the immutable order identity
verifier passes. VM tests use existing binaries and public fixture keys; RPC
tests use local mocks only. Review changes consist only of this handoff, the
report and the new test file, and remain uncommitted. No push, deployment,
funded transaction, user-key access, frontend or mainnet work was performed.

Open release gates remain independent review, combined worst-case resource
measurements, token/issuer and economic-parameter approval, actual target-wallet
integration, separately authorized live race/reorg testing, and deployment
approval. Earlier suggested next milestones below are historical.

### Commit and next milestone (2026-10-01)

The user authorized committing the SDK and hardening milestones together and
continuing to the next piece. This commit contains both milestones below;
their earlier uncommitted-status statements are historical. No push was requested.
Next: an offline evidence-based protocol/SDK review with reproducible findings,
coverage gaps and explicit release-readiness gates. This is an internal review,
not independent audit certification. No live deployment or wallet integration
is authorized by this next milestone.

### Adversarial pool SDK hardening (2026-09-30)

The user authorized the next offline hardening goal after the SDK milestone.
Both milestones remain uncommitted; no commit, push or deployment was requested.

- Reproduced and fixed queued RPC dispatch after cancellation and successful
  freshness completion after raw transaction mutation during an RPC await.
  Integrity now runs at both ends; `assertFresh(client, options, candidate)`
  can check the exact wallet-prepared transaction copy.
- Isolated RPC OutPoint arguments, returned cell snapshots, indexer candidates
  and recipient scripts from mutable caller/client objects. Tests cover wrong
  OutPoints, aliased state changes and simulated reorg removal during funding reads.
- Added bounded read-only HTTP transport for the CLI: only three required read
  methods, no redirects/fallbacks, 4 MiB streamed response cap, 15-second deadline,
  cancellation, HTTP failure and JSON-RPC envelope validation. Post-decoding
  bounds include 1 MiB live data and 2,048-byte cursors. Amount strings cap at
  39 digits; CLI stdin retains its 1 MB cap.
- Added actual CLI subprocess and local HTTP adversarial tests. No external node
  was contacted. SDK callers injecting another transport remain responsible for
  its pre-JSON byte limits and cancellation behavior.
- Extended real-xUDT/real-secp VM bridge with 32 chained randomized transitions:
  seeds `0xc0ffee` and `0xdeadbeef`, 16 steps each, all four variants covered,
  spending actual preceding transaction output OutPoints. Public fixture keys only.
- Existing CI gates automatically run the expanded SDK and VM tests. Typecheck,
  20 pool SDK/CLI/transport tests, `make check`, 21 pool VM tests, all 90 order VM
  tests, existing SDK/model suites, cross-language vectors and fixture checks pass.
  Both binary hashes remain unchanged: pool SHA256
  `d3a6520f08859787e34b5497d0f0f4c893b81b96fe7aaa280e50584024f67829`;
  order immutable deployment identity check also passes.

Remaining limitations: simulated races are not live-network reorg testing;
freshness is not atomic and cannot reserve inputs; a coherent dishonest node is
not detected without a chain proof. Normal pool witnesses remain outside the
wallet signing group; the SDK guard is not an on-chain commitment. Random tests
are finite and do not replace independent review. No contract/ABI, frontend,
funded transaction, user-key, deployment or mainnet work occurred.

Suggested next milestone: independent review of the draft pool protocol and
SDK, with explicit findings and release-readiness criteria before any separately
authorized wallet integration or live deployment. Earlier next-goal suggestions
below are historical and superseded by this update.

### Pool SDK and unsigned CLI goal (2026-09-29)

The user requested the next goal after pushing the validator milestone. Commits
`682bab3` and `9105e59` were pushed to `main`; the last verified remote head was
`9105e59a8bdd4296914670723c6fd6974e482bfe`. Earlier statements below that they were
not pushed describe their historical stopping points and are superseded here.

The next goal implemented the isolated off-chain SDK and read-only CLI. These
new changes are **uncommitted**; no commit or push was requested for this goal.

- `pool-sdk/src/codec.ts`: canonical TS codecs checked against all 3,291 shared
  independent wire vectors; existing Rust wire cross-check also passes.
- `pool-sdk/src/pools.ts`: bounded uncached direct node/indexer discovery,
  explicit genesis binding, exact state/reserve sibling OutPoints, full role,
  asset-profile, capacity/backing and accounting checks. Deadlines/cancellation,
  duplicate/page/cursor bounds, malformed reporting and stale-state checks.
- `pool-sdk/src/builders.ts`: explicit-input unsigned create, both exact-input
  swap directions, deposit and withdrawal. Explicit recipients/minima, preserved
  permanent backing, Y/LP/CKB change, storage top-up disclosure, fee caps,
  dependency/witness placement, exact transaction integrity and fresh-input
  guards. Freshness checks also verify direct pool/xUDT dependency data hashes.
- `npm run --silent pools < request.json`: read-only JSON CLI for scan/create/
  transition. Requires explicit endpoint/genesis/deps/funding/recipients; exports
  canonical unsigned transaction bytes and an accounting summary. Does not sign,
  submit, deploy, connect a wallet, load keys or invoke remote VM execution.
- `pool-tests/src/sdk.rs` invokes the actual TS builders and verifies their bytes
  with real xUDT and bundled secp256k1 in CKB-VM, without `complete_tx` repairing
  deps. All operations pass; unsigned/wrong signatures, recipient redirection,
  economically meaningful action tampering and missing xUDT deps reject. A
  separate LP recipient withdraws without a creator/operator input or signature.
- CI runs pool SDK tests and installs Node/npm dependencies for the VM bridge.
  `make pool-test` therefore now requires `npm ci` and Node 22 as well as Rust.

Important signing boundary: normal pool action witnesses are outside the wallet
secp signing group. Signed raw outputs bind recipients and amounts; the pool
checks accounting. A nonbinding minimum/budget witness change can still validate
on-chain. The SDK guard rejects those changes too, but is not an on-chain witness
commitment. Do not claim that every action-byte mutation breaks the signature.
Creation's action shares the first wallet witness and is covered there.

Verification: typecheck, pool SDK tests, 70 existing SDK/solver tests, 13 model
tests, 42,155 TS/Rust accounting vectors, 3,291 wire vectors, fixture manifest,
`make check`, 21 pool VM tests and all 90 order VM tests pass. Rebuilt order ELF
still matches the immutable testnet binary (28,592 bytes; SHA256
`060b0b73f91a960a965fcfaeb68dc40ada0557ff24e0c086c89611dd471340ab`).
No contract code/ABI changes, deployment, broadcasts, user-key access, funded
transactions, frontend changes or mainnet work occurred.

Read [pool-sdk/README.md](pool-sdk/README.md) for input schema, signing constraints
and explicit trust boundaries. This is a single 65-byte secp-compatible wallet
group builder, not JoyID/ACP/custom-wallet integration. Discovery trusts the
selected node; freshness is not an atomic reservation. No live contention or
reorg behavior was established by these in-memory tests.

Suggested next goal (not started): adversarial hardening of the off-chain/chain
boundary, particularly stale/reorg races, malicious RPC responses, witness
integrity across wallet preparation, and randomized SDK-to-VM operation sequences.
Keep it offline and preserve both binary identities. Separately authorize any
chosen-network deployment/profile approval or funded wallet integration.

### Pool validator goal update (2026-09-23)

Arithmetic/codec work was committed locally as **682bab3**. It was not pushed.
The next user-authorized goal implemented the isolated draft pool validator.
The user authorized committing these changes after verification; they are included
in the validator milestone commit. No push or deployment was requested:

- `contracts/openswap-pool`: one Data1 binary with five role tags and a common
  bounded verifier. Authenticates first-input/index genesis, exact sibling
  OutPoints, immutable metadata/backing, actual occupied capacity, and LP deltas.
- `pool-tests`: 20 passing CKB-VM tests using real xUDT. Covers all operations,
  forged role/code identities and reserves, dep-only state, missing/duplicate
  successors, storage theft, LP inflation/burn/overflow, malformed bytes,
  256-cell/512-byte bounds, re-entry after full withdrawal, independent pools,
  reordered indexes and genesis/transition sharing one witness.
- Prototype profile selects the existing devnet xUDT fixture Data1 hash
  `0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95`.
  Manifest SHA256/CKB hash checks pass; VM confirms 32-byte owner args and
  non-owner conservation. This is not a production token-profile approval.
- `make pool-test` builds the new binary through `scripts/build-pool.sh`.
  CI and `make check` include the new crates. Existing 90 order tests pass;
  rebuilt order binary still matches immutable testnet identity (28,592 bytes).
- Pool binary currently 42,176 bytes; SHA256
  `d3a6520f08859787e34b5497d0f0f4c893b81b96fe7aaa280e50584024f67829`.
  Observed genesis ~1.15M cycles, normal transitions ~2.20–2.24M; tested
  256-input/output genesis boundaries ~7.25M/~6.83M. Not worst-case guarantees.

Read `contracts/openswap-pool/README.md` and the updated wire specification next.
Remaining work: deeper independent hardening/review, direct scanner/builders and
wallet-signing coverage before separately authorized live pool testing. Test
wallet locks are always-success fixtures; no user signing is implemented by them.
No funded transaction, deployment, frontend change or mainnet work occurred.

Earlier milestones below are historical; their "next step" text is superseded
by this update.

### Resumption update (2026-09-23)

The user requested continuation, then authorized committing this milestone.
The following changes are included in the pool arithmetic/codec milestone;
no push or deployment is part of that commit request:

- `docs/research/POOL_WIRE_FORMAT.md`: draft exact state/args/action layouts,
  shared Data1 role tags, genesis/sibling identity, LP authentication, scan bounds
  and error assignments. Still draft ABI, with no on-chain validator.
- `pool-arithmetic`: isolated no_std Rust accounting, exact-pinned uint 0.10.0,
  host vector checker, and CKB RISC-V library compilation.
- `pool-model/src/cross-check.ts`: 42,155 deterministic TypeScript/Rust cases,
  including all state/flow fields, rejection codes and square roots. Run with
  `npm run test:pool-cross`; `--emit` emits reusable JSONL vectors.
- Dedicated pool CI job and pool Clippy check. Typecheck, the 13 TS model tests,
  Rust arithmetic tests and cross-language comparison passed locally.
- `make check` and all 90 existing order Rust tests passed. Rebuilt order binary
  matches the immutable testnet SHA256/code hash and remains 28,592 bytes.
- Follow-up goal requested by the user: bounded pool wire codecs. Implemented
  `pool-arithmetic/src/wire.rs` for args/state/actions, canonical pool Script and
  WitnessArgs with phase-specific selection; no allocation or CKB syscalls.
- Ten pool Rust tests cover numeric/structural bounds, all truncations, 103,936
  state/action single-byte mutations and 20,000 fixed-seed arbitrary byte cases.
  `npm run test:pool-wire` compares 3,291 independent TypeScript wire vectors;
  CI now runs that command as well. Codec lint and RISC-V compilation pass.

Next step is common state/custody/LP validators and adversarial
real-xUDT VM tests. Select and verify the profile's immutable xUDT code hash before
enabling it; the wire draft deliberately leaves this unassigned. No pool deployment,
funded transactions or frontend work was performed or authorized by this stage.

The earlier stopping-point narrative below is retained as historical context.

The user asked to save details for a clean handoff. Do not launch transactions or
start deploying pools merely because this file exists.

Last completed implementation commit: **efbc3848784e3d3ab0654c5995df52c5f5e7a4cc**
(`Specify draft pool transitions and add integer accounting model`). It was pushed
to `main`; its full CI run passed:
https://github.com/toastmanAu/openswap/actions/runs/35498445801

The working tree was clean when this handoff was started. This handoff may be a
later documentation-only commit; it does not change the implementation milestone.

The next proposed technical step is **define the pool byte layout and script-role
bindings, then implement isolated Rust arithmetic cross-checked against the
existing TypeScript integer model**. No pool contract or pool deployment exists.

## Project and user preferences

- Application name **ToastDEX**, domain **toastdex.org**, user alias toastman.
- Internal protocol/SDK names remain OpenSwap; preserve existing code identity.
- User wants a low-maintenance, permissionless exchange with a static frontend and
  direct CKB node/indexer access. No operator/protocol cut.
- Cream/brown toast palette. Current header/favicon asset is `toastDexLogo.png`,
  supplied by the user with transparency. Preserve the supplied artwork.
- User prefers action without repeated permission questions. Never sign with the
  user's JoyID passkey or request keys/recovery phrases.
- **User will arrange the independent security reviewer.** No reviewer has been
  contacted and no paid engagement has been authorized.
- No subagents unless the current user/instructions explicitly authorize them.

## Repository and live site

Workspace: `/home/phill/openswap-agent-handoff-v0.1/openswap-agent-handoff`

Public remote: `https://github.com/toastmanAu/openswap.git`, branch `main`.

- Site: https://toastdex.org
- Alternate origin: https://toastdex.pages.dev
- Cloudflare Pages project: `toastdex`, **direct upload**, not automatic Git deploy.
- Deployment receipt: `deployments/frontend-pages.json`.
- Latest deployed logo release URL recorded there: https://d52df91a.toastdex.pages.dev
- Subsequent hardening/pool-model commits did not require a frontend redeployment.
- Domain owner configured proxied apex CNAME to `toastdex.pages.dev`.
- Wrangler account had Pages access but no DNS write access; preserve mail records.
- `wrangler.jsonc`, `docs/CLOUDFLARE_PAGES.md` document deployment.

Repeatable commands, only when a new frontend deployment is actually requested:

```sh
npm run release:frontend
npm exec --yes --package=wrangler@4.134.0 -- wrangler pages deploy frontend/dist --project-name toastdex --branch main
TOASTDEX_BASE_URL=https://toastdex.org npm run test:frontend
```

Do not create another Pages project or use the project-creation `--force` workaround.
Do not print Wrangler configuration or credentials. There are no app server secrets.

## Immutable order protocol — preserve

Authority: `PROTOCOL.md`, `WIRE_FORMAT.md`, `CONTRACT_IMPLEMENTATION.md`,
`SECURITY.md`, `DECISIONS.md`; original handoff also under `docs/handoff`.

ONE CELL / ONE LOT / ONE FILL / ONE MAKER PAYMENT:
order input at absolute index i pays its maker at output i, unless the explicit
owner-authorized cancellation/rescue path is satisfied.

No admin/upgrade key controlling existing orders, global mutable DEX state,
mandatory API/matcher/registration, treasury, mutable partial-fill orders or hard
on-chain expiry. Clean-room implementation; do not copy Nervina SDL code.

New pool research is a **separate primitive**, not a redesign of that order lock.
Reference assets are CKB and exact-16-byte canonical xUDT; unknown profiles need a
resolver. Catalog inclusion alone does not authorize an unfamiliar token profile.

Testnet lock (`deployments/testnet.json`):

- Data1 code hash: `0x1d4e322540cbec1d1fdf2ca4a13b12521401d6c1ed5f0432c01cce84ea94eddf`
- SHA256: `060b0b73f91a960a965fcfaeb68dc40ada0557ff24e0c086c89611dd471340ab`
- Size: 28,592 bytes.
- Code cell: `0x070bdab0b200bb12faca14662c2c7ebbaeaecf51b1da05170e4d5de5c4dc3fca`, output 0.
- No mainnet trading deployment. Mainnet token catalog is preview-only.

## Completed release validation

See `docs/RELEASE_VALIDATION.md`, `docs/STATUS.md`, `docs/TEST_COVERAGE.md`.

- **90 Rust tests**, including 88 VM tests plus shared vectors and a fixed-seed
  20,000-case host parser corpus. VM structural byte mutations return stable errors.
- **70 SDK/solver/UI-helper tests**.
- **8 browser tests** previously passed on both public origins.
- **13 separate pool-model tests** now also run in CI.
- User confirmed JoyID create/fill/cancel through toastdex.org with normal prompts.
  Two nodes independently verified distinct taker funding, maker payment, token
  conservation and cancellation owner proof. Evidence:
  `deployments/public-wallet-verification.json`.
- Cancellation used an existing order; its creation was traced automatically.
- **12 live race rounds** passed: three historical baseline plus nine new rounds.
  Evidence: `deployments/race-endurance-result.json`. Three process invocations
  resumed journaled work; every round had exactly one winner checked on two nodes.
- A safe funding stop exposed token-cell fragmentation. A single same-owner
  consolidation preserved 98 token units and released 1234.99972691 CKB of plain
  capacity, fee 0.00027309 CKB. Evidence:
  `deployments/race-funding-consolidation.json`. Final rounds then completed.
- Solver fix in `solver/src/runner.ts`: record pending reservations in submit's
  `beforeBroadcast` callback, so an accepted transaction with a lost reply remains
  tracked. Tests cover repeated status/indexer outages and recovery.
- Separate GitHub-hosted Ubuntu machine reproduced the immutable binary:
  `deployments/remote-reproducibility.json`.
- `scripts/check-contract-identity.py` now rejects builds that differ from deployed
  identity; called by CI and `scripts/check-reproducible.sh`.
- These are bounded tests, not days of endurance, exhaustive fuzzing or an audit.

Independent review handoff:

- `docs/EXTERNAL_REVIEW.md`
- `docs/REVIEW_REPORT_TEMPLATE.md`
- `docs/REVIEW_CANDIDATES.md` (research only; user will arrange reviewer)
- Ignored `release/review-manifest.json` and its source tar archive identify
  **4d2a21c**, the order-core hardening commit before pool-model work. Do not claim
  that archive contains the later pool model. Regenerate a separately identified
  snapshot if the reviewer needs newer scope.

## Pool research and model — where to resume

Read in this order:

1. `docs/research/LIQUIDITY_POOLS.md` — sourced alternatives and architecture.
2. `docs/research/POOL_TRANSITIONS.md` — draft transition specification, revision 1.
3. `pool-model/README.md`
4. `pool-model/src/model.ts`, `pool-model/test/model.test.ts`.

The user authorized the specification/model stage after research. These are draft
prototype choices, **not frozen consensus or production parameters**:

- Native CKB X and canonical xUDT Y; one pool state cell plus two reserve cells.
- Per-pool state, no global factory/state or privileged sequencer.
- Constant-product exact-input swaps; one direction per transition.
- Fee denominator 10,000; fee numerator explicitly supplied and immutable.
  Example 30 basis points is not a production default.
- Explicit virtual locked shares M: never issued, transferable or redeemable.
  Total accounting shares L include M; circulating supply is L-M.
- Permanent pool: all circulating shares can be redeemed, leaving M, positive
  reserves and fixed storage backing. No close operation. Creators must see cost.
- Backing Bs/Bx/By is immutable and excluded from tradeable reserves. State cell
  capacity Bs, CKB reserve capacity Bx+x, token reserve capacity By.
- x is bounded by u64 capacity minus Bx; y by u112; shares by u128; checked U256
  intermediate arithmetic. State additionally requires L*L <= x*y.
- Create: L=floor_sqrt(x*y); mint L-M; enforce creator minimum.
- Swap X→Y: out=floor(a*(D-f)*y/(x*D+a*(D-f))); full a enters x; fee stays in pool.
- Deposit: choose m=min(floor(maxX*L/x),floor(maxY*L/y)); charge ceil(m*x/L) and
  ceil(m*y/L). Leave unused budgets to wallet change, avoiding silent donations.
- Withdraw b: floor(b*x/L), floor(b*y/L), with b<=L-M and positive/minimum receipts.
- LP type must enforce exact issuance/burn deltas with an authenticated pool
  transition. Ordinary LP transfers preserve supply; generic UDT mint authority
  alone is insufficient. LP supply/authentication is NOT implemented on chain yet.

Proposed cell identity binding (spec only): successor state records reserve output
indexes; its creating transaction hash identifies exact sibling reserve OutPoints
on the next spend. A matching lock alone is insufficient. Genesis uses unique
Type-ID-style derivation. Role bindings must avoid circular code-hash dependencies;
a shared Data1 binary with role-tagged args is a candidate, not implemented ABI.

The model uses BigInt, enforces checked arithmetic, returns new states and flows,
and has no RPC/signing/deployment logic. It does NOT prove authentic OutPoints,
script-role binding, actual occupied capacity, signatures, token issuance modes or
contract safety. Virtual backing figures in the demo are illustrative only.

Tests include 25,992 small-reserve swaps against an independent invariant/binary
search oracle; 2,250 small deposits against exhaustive share enumeration; 3,000
seeded mixed operations; 1,000 round trips; large asymmetric/boundary cases.

## Concrete next implementation sequence

When the user resumes implementation:

1. Define canonical bounded state/args/action byte layouts, asset identity and
   pool/reserve/LP role authentication. Keep genesis and successor index binding
   explicit. Define scan bounds and stable future consensus error codes.
2. Implement isolated no_std-compatible Rust arithmetic with reviewed/pinned wider
   integer support. Existing v0.1 lock remains untouched and needs no U256.
3. Generate deterministic cross-language vectors from the TS model; compare
   independently implemented Rust outputs/errors, including boundaries and rounding.
4. Only then implement custody/state/LP validators and adversarial real-xUDT VM tests.
5. Subsequent steps: direct scanner/builders, testnet races and withdrawal without
   an operator, atomic order-plus-pool composition, independent pool review.

Do not jump to frontend, mainnet, funded pool deployment or new live transactions.
Do not assume iCKB is permanently 1:1 CKB or that Bitcoin-bound RGB++ cells can be
spent without separate leap/signing integration.

## Commands and tooling

```sh
npm run typecheck
npm run test:pool-model
npm run demo:pool-model
npm run test:sdk
make check
make test
./scripts/check-reproducible.sh
python3 scripts/check-contract-identity.py
```

Only run checks appropriate to actual changes. Root package.json and tsconfig.json
include the isolated pool model; no new npm dependency was added.

Rust toolchain 1.98.1; exact dependencies and lockfiles already pinned. Before any
new CCC integration, inspect current docs/agent guidance and installed/upstream
public APIs. Existing dependencies are pinned in package-lock.json.

## Key safety and operational caveats

- `.local/` contains funded dedicated testnet keys. Preserve it, never print,
  publish, move or delete its contents. They are not the user's JoyID credentials.
- Never blindly rerun `--execute` integration scripts. Completed journals are
  resumable, with bounded work/fees; increasing rounds creates more transactions.
- The prior race extension is complete. No outstanding scenario cleanup is required.
- Gitleaks binary used: `/tmp/openswap-secret-audit/gitleaks` (may not survive).
  `.gitleaks.toml` narrowly permits exact verified public transaction-hash false
  positives; do not replace these with broad exclusions.
- Before publishing changes, scan the staged tracked snapshot, not a directory
  containing ignored keys. Never include `.local`, wallet state or auth config.
- Prior environment shell sandbox failed with bwrap; require_escalated shell calls
  were used with explicit justifications. Reassess current environment rather than
  assuming those permissions persist.
- A previous automatic approval review blocked a Git push for an unverified
  destination. Read-only checks established exact origin URL, PUBLIC visibility,
  and remote main at the previously published commit; retry was then approved.
  Verify destination and explain evidence if this recurs; do not bypass rejection.
- Browser regressions use an isolated Chrome via Playwright, not a personal wallet
  profile. Live passkey prompts are completed only by the user.

Suggested resumption prompt: "Read SESSION_HANDOFF.md and continue with the pool
wire layout, script-role binding and isolated Rust arithmetic stage."
