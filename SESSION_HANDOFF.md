# ToastDEX — next-session handoff

Saved 2026-10-05 (Australia/Adelaide). Read this first when resuming.

## Current request and stopping point

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
