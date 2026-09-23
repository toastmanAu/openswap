# ToastDEX — next-session handoff

Saved 2026-09-23 (Australia/Adelaide). Read this first when resuming.

## Current request and stopping point

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
