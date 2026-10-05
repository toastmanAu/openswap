# Pool protocol and SDK internal review

Review date: 2026-10-01. Baseline: `85731fe78371ee1d35d54ec056a9ee3d9ccce890`.
This is an internal code-and-test review by the implementation assistant, **not
an independent audit, certification, formal proof or production approval**.

## Remediation update — 2026-10-02

The user subsequently authorized fixing R1/R2. Both are addressed in the working
tree by SDK-only changes in `builders.ts`; contract binaries and ABI are unchanged.
Numeric witness iteration now requires an own, valid byte-string entry at every
position. Independent reviewed input snapshots anchor cache and freshness checks.
Any supplied candidate `cellOutput`/`outputData` must match those snapshots;
`undefined` caches are allowed independently for raw-deserialized transactions,
while false or null caches reject. Checks run before and after freshness awaits.

`review.test.ts` now contains four **rejection/policy regressions**, replacing the
two accepted-behavior characterizations. They cover genesis/transition holes,
inherited and malformed slots, counts, false capacity/lock/type/data caches,
honest/partial/absent caches, signature replacement, mutations during RPC awaits
and mutation of the original transaction's aliased caches. The baseline findings
and observations below remain historical evidence, not claims that these two
defects remain present. Other release gates remain open.

Remediation verification: typecheck, 24 pool SDK tests, 70 existing SDK/solver
tests and 21 pool VM tests pass. The VM suite includes the 32 randomized chained
real-signature transitions. Both binary identities remain unchanged.

## Decision and scope

Keep the milestone an offline prototype. Two low-severity SDK boundary findings
were reproduced; neither establishes an on-chain reserve theft or supply-inflation
path. Production release is blocked by the open gates below, regardless of passing
tests. The original review did not implement fixes; see the subsequent authorized
remediation update above.

Reviewed: Rust accounting and wire codecs, the shared-role validator, TypeScript
codecs/discovery/builders/CLI/transport, test fixtures, signature bridge and CI
configuration. The implementation was compared with
[transitions](POOL_TRANSITIONS.md), [wire format](POOL_WIRE_FORMAT.md), and the
[SDK boundary documentation](../../pool-sdk/README.md).

Only review documentation and characterization tests are added. No contract,
production SDK, ABI, deployment, wallet integration or frontend changes. All RPC
exercises use local mocks; signing tests use public deterministic fixture keys.
No live chain state, mempool behavior, external token deployment, external audit
or remote CI result is attested by this review.

## Threat model at the reviewed baseline

Protected assets are tradeable CKB and xUDT reserves, permanent Bs/Bx/By backing,
circulating LP supply, users' funding/change and the recipients/amounts they sign.
The immutable fee and virtual-share parameters are part of the pool identity's
economic promise, not a claim that every permitted parameter choice is safe.

| Actor / capability | Required boundary | Remaining trust |
| --- | --- | --- |
| Arbitrary transaction author can select inputs, outputs, deps and witnesses | Roles, exact sibling lineage, arithmetic and LP deltas checked by every invoked pool role | Honest CKB consensus, hash collision resistance and correct VM/syscalls |
| Malicious trader or LP can choose timing and route assets between pools | Cannot consume others' wallet cells without their lock authorization or redeem virtual M | Price impact, MEV, thin liquidity and adverse selection are economic risks, not prevented here |
| xUDT issuer can satisfy the configured owner lock | A pool transition must not itself invoke its own custody locks as token issuer authority | External issuer power remains; owner scripts can be permissionless or depend on another pool |
| Malicious/stale RPC or indexer can fabricate, reorder, omit or delay data | Exact requested points, role/shape checks, finite scans, response bounds and freshness checks | A coherent fabricated chain view is not disproved; genesis hash equality is not a chain proof |
| Wallet preparation or application code can mutate transaction objects | Reviewed raw bytes and witness layout remain fixed except the signature slot | Unsigned CCC cache/display metadata is not currently checked: R2 |
| Application passes a sparse/malformed JavaScript witness array | Missing witness positions should fail SDK integrity checks | Sparse holes currently evade iteration: R1; consensus validation is still required |

An arbitrary in-process attacker can execute JavaScript and replace methods; this
review does not claim to sandbox one. R1/R2 concern ordinary mutable data supplied
through the documented API, not overriding `hash()` or compromising the runtime.

## Baseline findings (severity ranked; R1/R2 subsequently fixed)

### R1 — Low: sparse witnesses bypass the integrity iterator

**Location:** [`builders.ts`](../../pool-sdk/src/builders.ts), `assertIntegrity`,
specifically `tx.witnesses.forEach` after its length check.

Deleting an array element retains `length`, and `forEach` skips the resulting
hole. Deleting witness 0 from a freshly built genesis candidate leaves the raw
transaction hash unchanged and `assertIntegrity(candidate)` succeeds. A dense
replacement with `"0x"` rejects. The current guard therefore does not establish
its advertised per-position witness invariant for all JavaScript arrays.

**Original reproduction:** the R1 characterization in
[`review.test.ts`](../../pool-sdk/test/review.test.ts). The original test asserted the hole
was genuinely absent, the length was unchanged, and the guard accepted it.
The current test requires rejection instead.

**Impact and prerequisites:** a wallet adapter/application must supply a sparse
array; ordinary JSON arrays cannot encode holes distinctly. Missing required
actions/signatures do not thereby become valid on-chain. Likely outcomes are
failed serialization, failed signing or consensus rejection, not reserve theft.
The reproduction does not assert which downstream serializer failure occurs.

**Proposed fix:** iterate all numeric positions, require own present entries of
the expected byte representation, then compare/parse every position. Add rejection
tests for holes at the action and wallet slots, undefined/null elements, missing
and extra witnesses. Convert the characterization to a rejection regression.

### R2 — Low: prepared-candidate input caches are not covered by freshness

**Location:** [`builders.ts`](../../pool-sdk/src/builders.ts), `assertIntegrity`
and `assertFresh(client, options, candidate)`.

CCC input `cellOutput` and `outputData` are cached resolved information, not raw
transaction fields. `assertIntegrity` checks the raw transaction hash and witnesses.
`assertFresh` reads the captured original inputs, not the candidate's optional
cache values. A cloned candidate with unchanged OutPoints but a cached capacity of
1 shannon and altered cached token amount passes both checks against honest
fixture responses.

**Original reproduction:** the R2 characterization in
[`review.test.ts`](../../pool-sdk/test/review.test.ts). It compares the candidate's
cache with the original funding, proves the raw hash/OutPoint stay unchanged,
and awaited successful candidate freshness validation. Current tests require
false caches to reject and honest/absent caches to pass.

**Impact and prerequisites:** a subsequent wallet/UI must trust those altered
cache values for displays or funding/fee decisions. Consensus resolves the real
OutPoints, so the altered cache cannot spend a different input or directly alter
signed outputs. This milestone has no wallet UI; no concrete user-loss path was
demonstrated. The API's broad mutation-rejection wording may encourage stronger
assumptions than it establishes.

**Proposed fix:** define the signed-byte versus advisory-metadata contract
explicitly. Either validate all supplied candidate caches against freshly resolved
cells, or strip/rebuild them from trusted resolutions before displaying or signing.
Handle missing optional caches intentionally so raw-deserialized transactions
remain usable. Derive user-facing summaries from validated data, not arbitrary
mutable summary objects. Add honest-cache, absent-cache and false-cache cases.

### Known limitations — not newly discovered consensus vulnerabilities

- Normal action witnesses are outside the ordinary wallet secp signing group.
  Changing a nonbinding minimum/budget can remain valid with unchanged signed
  outputs. The SDK guard is off-chain; it is not an on-chain intent commitment.
  Changed raw recipients/amounts remain signature-bound.
- The prototype xUDT profile pins code and exact data/args shape, not economic
  safety. An external owner can issue tokens under that asset's rules. In
  particular, an owner lock depending on another permissionless pool could be
  satisfiable by third parties. The current same-pool custody exclusion does not
  certify arbitrary external owner scripts; this is an asset-approval gate.
- Unsolicited output lookalikes are expressly not reserves. Their creation is
  permitted and recovery is not promised. Actual reserve inputs are bound to the
  state transaction hash and indexes. Missing an output-lock-count equality is
  therefore not, by itself, a duplicate-state or balance-authentication bypass.
- Freshness checks cannot reserve cells or eliminate changes after the last read.
  Bounded transport checks do not prove response truth or peer consensus.

## Requirement-to-code/test coverage matrix

“Covered” below means inspected code plus bounded test evidence, not exhaustive
proof. Rust test names are in [`tests.rs`](../../pool-tests/src/tests.rs) unless
another file is specified.

| Requirement | Enforcement / reasoning | Evidence and residual gap |
| --- | --- | --- |
| Exact canonical ABI and phase-specific action | `wire.rs`: exact lengths, reserved bytes, table offsets, Data1, bounded fields | 3,291 shared vectors; truncation/mutation/arbitrary-byte Rust tests; not every byte string |
| Bounded arithmetic with no floating point | `lib.rs`: checked U256 add/mul, nonzero denominators, bounded domains | 42,155 TS/Rust vectors, square-root tests, model exhaustive small cases; no formal equivalence proof |
| Genesis LP supply and unique identity | `validate`: hash first full CellInput + output index, absent input state, exact initial share delta | `genesis_identity_issuance_and_singleton_are_enforced`, nonzero-index/since tests; consensus supplies input uniqueness |
| Role and immutable code identity | `scan` rejects incompatible lock/type placement; counterpart hashes derived from running Data1 code | `forged_roles_wrong_assets_and_type_addressing_reject`; relies on hash/VM assumptions |
| Exact reserve lineage, no dep-only authorization | `sibling_inputs`, `balances`, input custody counts | exact-OutPoint and dep-state tests, reordered-index tests; live network reorgs not exercised |
| Immutable parameters and permanent backing | state equality excluding only L/rx/ry; `shape` occupied floors and exact state/Y capacity | immutable/profile, storage theft and occupied-capacity tests |
| Swap/deposit/withdraw accounting | evaluate transition then compare full `State` | all operation VM cases; deposit ceil and withdrawal floor cases in model tests |
| LP mint/burn/transfer authorization | checked LP sums, circulation bounds and exact delta; no-state branch permits conservation only | LP mint/burn, u128 aggregate, standalone transfer and two-pool isolation tests |
| M cannot be redeemed; pool remains reusable | burn at most L−M; next validates positive x/y and L≥M | full circulating withdrawal, reactivation and chained generations |
| Recipients authorized by funding wallet | raw outputs signed by ordinary owner lock, not pool action | `sdk.rs`: real secp, wrong/missing signature, recipient tamper and separate holder withdrawal |
| Action/transaction integrity across preparation | SDK raw-hash and witness checks, before/after async reads | mutation tests; R1 open; action-group limitation explicit; R2 cache boundary open |
| Wallet funding, change, storage and fee caps | explicit single wallet group; supported types, no issuer-mode funding; mandatory plain change | builder tests for conservation, dust, fee cap, wrong assets and storage top-up; arbitrary wallet scripts not audited |
| Discovery and stale-input handling | uncached exact-point reads, state recheck, profile and dependency hash checks | malformed/aliased RPC and simulated reorg tests; coherent dishonest node still trusted |
| RPC resource/write boundary | transport method allowlist, streamed byte cap, deadline/abort, no redirects; finite scans | local HTTP and actual CLI tests; custom injected transports remain caller responsibility |
| SDK-generated chained transitions | actual serialized TS builder output signed and verified in VM without dependency repair | 32 steps, two seeds, all four variants; modest domain and one standard owner group |
| Input/output/script size bounds | bounded raw syscalls, tail probe at index 256 | 256-input and 256-output cases separately, 512/513-byte script tests; combined worst-case cycles unproven |
| Existing protocol/binary preservation | separate crates and SDK tree; review changes tests/docs only | 90 order VM tests and immutable identity verifier; pool hash unchanged |

### Arithmetic inspection notes

Swap denominators are positive after state/amount validation and fee ≤9999;
intermediate multiplication and addition are checked. Deposits mint the minimum
of two floor ratios and charge each asset with ceil division. Withdrawals burn
at most L−M, strictly below L because M>0, so floor payouts cannot exhaust either
positive reserve. The resulting state is revalidated, including L²≤xy. The
binary-search square root compares using division rather than overflowing squares.
Ceil's final +1 is safe for positive denominator: denominator 1 has no remainder;
larger denominators leave headroom. These arguments complement, not replace,
the finite cross-language and VM tests.

### Test independence and CI limits

The TS accounting and Rust implementation agree on many vectors but can share a
specification mistake. Wire vectors use an independent sequential encoder; that
is useful evidence, not an independent security audit. Most adversarial contract
tests use always-success wallet owners; the separate SDK bridge uses real secp
and xUDT with deterministic public keys. In-memory Context verification does not
simulate network propagation, mempool replacement, reorg policy or a live wallet.

CI is configured to run the existing suites and will pick up the review test via
the `pool-sdk/test/*.test.ts` glob. No remote CI execution was requested or checked.
The original two tests intentionally characterized accepted behavior; green results
then meant R1/R2 reproduced, not remediation. The authorized follow-up replaced
them with four rejection/policy regressions described above.

## Reproduction and verification

From the repo root with installed pinned dependencies/toolchain:

```sh
node node_modules/tsx/dist/cli.mjs --test pool-sdk/test/review.test.ts
npm run typecheck
npm run test:pool-sdk
npm run test:sdk
npm run test:pool-model
npm run test:pool-cross
npm run test:pool-wire
cargo test --locked -p openswap-pool-arithmetic
make check
cargo test --locked -p openswap-pool-tests
cargo test --locked -p openswap-tests
python3 scripts/verify-fixtures.py
python3 scripts/check-contract-identity.py
```

The VM commands load the existing release binaries; use the documented build
commands on a fresh checkout before running them. This review did not change
either binary. Baseline SHA256 values:

- Pool: `d3a6520f08859787e34b5497d0f0f4c893b81b96fe7aaa280e50584024f67829`.
- Order: `060b0b73f91a960a965fcfaeb68dc40ada0557ff24e0c086c89611dd471340ab`.

Observed local results during this review: typecheck and `make check` pass;
22 pool SDK tests (including the two finding characterizations), 70 existing
SDK/solver tests, 13 model tests, 10 Rust arithmetic/wire tests, 21 pool VM tests
and 90 order VM tests pass. Cross-checks match 42,155 accounting and 3,291 wire
vectors. Fixture integrity and the immutable order identity verifier pass; the
pool SHA256 matches the baseline above. These results do not close R1 or R2.

## Release-readiness gates and next steps

| Gate | Current state | Required evidence before advancing |
| --- | --- | --- |
| R1/R2 disposition | Fixed in working tree, 2026-10-02 | SDK-only fixes and rejection/metadata-policy regressions; retain these gates in CI |
| Independent review | Not performed | Separate reviewer findings, resolution record and reviewed baseline hash |
| Combined resource envelope | Partial | Real-signature multi-pool/high-count/wide-script combinations, measured cycles and accepted limits with headroom |
| Economic/profile approval | Not approved | Chosen f/M/backing policy, liquidity/price risk disclosure, exact deployed token hash and owner/extension authority review |
| Wallet integration | Not implemented | Real target-wallet preparation/signing tests; trusted decoded receipts/fees; reject mutation/stale input and handle cancellation |
| Live contention/reorg validation | Not performed | Separately authorized controlled network tests with repeatable spent-input, replacement/reorg and ambiguous-submission handling |
| Deployment/release approval | Not authorized | Reviewed/frozen ABI, reproducible artifact identity, deployment manifest and explicit user authorization |

The original recommended R1/R2 SDK-only milestone is now implemented. Next add
combined resource and broader randomized VM coverage, retaining the explicit
cache/display trust policy. Contract changes are not justified by either
confirmed finding. Any new consensus finding must receive its own review and
authorization rather than silently changing the preserved binary/ABI.
