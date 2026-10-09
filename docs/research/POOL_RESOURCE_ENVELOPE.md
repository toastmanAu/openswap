# Pool VM resource measurements and sequence coverage

Updated 2026-10-08. Original measurements were committed in `714cb69`;
the distinct-owner extension uses that baseline plus test-only changes.
These are measured fixtures, **not a formal worst-case bound, network relay
approval, independent audit or production approval**. Neither contract nor ABI
was changed.

## Combined boundaries

[`pool-tests/src/sdk/resource.rs`](../../pool-tests/src/sdk/resource.rs) composes
actual SDK-generated deposit transitions from separately verified genesis
transactions. It relocates successor reserve indexes and action witnesses, keeps
the exact predecessor OutPoints, and signs the combined raw transaction with the
real bundled secp256k1 lock. One owner signing group spans interleaved pools.
Real xUDT and each pool's LP/state/custody roles execute. Dependencies are explicit;
`complete_tx` does not repair them.

Each case has **256 inputs and 256 outputs together**, 512-byte serialized
padding-lock Scripts, and 4,096-byte canonical WitnessArgs at every pool state
input. Deposit action payloads remain the valid maximum 56 bytes; the additional
WitnessArgs bytes are in the unused pool lock field, not a noncanonical action
extension. Economically relevant wallet inputs use real secp. Wide padding uses
the synthetic ALWAYS_SUCCESS lock with 459-byte args; it is not evidence about
arbitrary 512-byte real wallet scripts or many distinct expensive signing groups.

One measured run after fixture fee recalculation:

| Independent pools | Serialized transaction bytes | Fee, shannons | VM cycles observed | Cycle regression ceiling | Byte ceiling |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 155,712 | 155,716 | 63,232,781 | 80,000,000 | 160,000 |
| 2 | 157,486 | 157,490 | 123,495,083 | 155,000,000 | 165,000 |
| 4 | 161,034 | 161,038 | 241,586,346 | 305,000,000 | 170,000 |

Fees are recalculated after composition at the fixture's 1,000 shannons per
1,000 bytes, including the four-byte size overhead used by the SDK. They are
deducted from ordinary wallet change, not pool backing. This is not a live fee
recommendation. Signatures retain constant size but their bytes and execution
cost can vary; seeds control operations, not a guarantee of identical cycle logs.

The cycle budgets are rounded above 125% of observed peaks (approximately
26–27% headroom). Byte budgets are rounded above the measured exact layouts.
These ceilings make fixture regressions fail visibly; they are not new protocol
limits. A future change exceeding them requires investigation and updated
measurements rather than blindly raising the limits.

For the two-pool combined fixture, all of the following are re-signed and must
fail with the pool's bound error **2**, not merely any failure:

- 257 inputs;
- 257 outputs, produced by splitting a padding output without creating capacity;
- a 513-byte inspected Script;
- a 4,097-byte action WitnessArgs.

Removing the authentic wallet signature also fails for each valid-size case.
The generic original VM suite's 100M-cycle test allowance is insufficient for
these two- and four-pool fixtures. Their larger explicit budgets are confined to
these tests; **100M was a local harness budget, not a claimed CKB consensus limit**.

## Distinct real wallet groups and larger compositions

The 2026-10-08 extension in
[`pool-tests/src/sdk/composition.rs`](../../pool-tests/src/sdk/composition.rs)
uses the same pinned pool/xUDT/secp binaries and actual SDK genesis/deposit
builders. There is **no ALWAYS_SUCCESS padding** in this profile. Every ordinary
wallet input uses the standard secp lock. Public fixture keys are distinct;
the four-pool case orders owners A/B/A/B to exercise noncontiguous signing groups.
Larger cases have one distinct owner per pool and share one xUDT type.

One measured run (compact actions, no padding):

| Pools | Real owners | Inputs / outputs | Transaction bytes | Fee, shannons | VM cycles observed | Cycle ceiling | Byte ceiling |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 2 | 24 / 28 | 7,994 | 7,998 | 25,938,457 | 33,000,000 | 9,000 |
| 8 | 8 | 48 / 56 | 16,112 | 16,116 | 93,737,827 | 120,000,000 | 17,000 |
| 16 | 16 | 96 / 112 | 32,008 | 32,012 | 327,997,292 | 415,000,000 | 34,000 |
| 36 | 36 | 216 / 252 | 71,748 | 71,752 | 1,528,021,068 | 1,920,000,000 | 75,000 |

These cycle ceilings are rounded above 125% of the measured run (about 26–28%
headroom); byte ceilings provide about 5–13% over the fixed layouts. Signatures
can vary in cost between runs. The 36-pool result exceeds 1.5 billion cycles
despite being smaller in bytes than the padded fixtures. Neither those cycles
nor these byte sizes imply admissibility under any target node's policy.

Each unmerged deposit consumes six inputs (state, two reserves, and the genesis
LP/token/CKB change) and produces seven outputs (state, two reserves, minted LP,
token change, existing LP change and plain CKB change). Consequently the largest
fixture of this shape is `min(floor(256/6), floor(256/7)) = 36` pools: **216 inputs,
252 outputs**. A 37th would require 259 outputs. Tests derive and assert these
counts from actual builder output. This is not a universal maximum: merging
change, choosing different funding, or using different operations changes the
layout. No production batching API was added.

The composer asserts unique pool identities and input OutPoints, retains exact
verified genesis predecessors, relocates successor reserve indexes and the
state action witnesses, and keeps explicit identical dependencies without
`complete_tx`. It recomputes the combined fee from serialized size plus four
bytes, adjusts only the last owner's plain change, and asserts total capacity
and every output's occupied-capacity minimum. All owners sign that final raw
transaction; this test-only fee allocation is not a multi-party fee policy.
Action witnesses remain compact canonical deposit actions, rather than the
4,096-byte padded boundary profile above.

Every measured signing group has its signature replaced individually with the
unsigned zero placeholder; each must fail at that specific input lock. Both
interleaved owners and the final owner at each larger size also reject another
owner's signature, a one-byte signature mutation, and a mutation to a later
witness in their own group. The interleaved latter witness is beyond the other
owner's intervening pool. These checks retain the raw transaction hash and do
not accept cycle exhaustion or unrelated validator failures as signature proof.
They do not expand wallet signatures to cover another pool group's action
witness; the previously documented nonbinding-action caveat still applies.
Across the four layouts there are 62 missing-signature checks and 15 additional
wrong-key/signature/later-witness checks: **77 authorization-negative cases**.

## Broader SDK-generated sequences

The original two seeds still contribute 32 mixed-operation steps. Four additional
regimes each execute 12 seed-budgeted operations (all four variants, repeated),
then full circulating withdrawal and re-entry: **56 more transitions, 88 chained
steps total**. Each new regime has its own genesis/funding identity. The bridge
uses production SDK builders; it does not substitute a Rust transaction builder
or a different accounting rule.

| Seed | Fee bps | Virtual M | Initial x (shannons) | Initial y (base units) | Observed peak cycles |
| --- | ---: | ---: | ---: | ---: | ---: |
| 7 | 0 | 1 | 10^12 | 4×10^12 | 4,184,616 |
| 29 | 30 | 1,000 | 10^10 | 10^18 | 4,175,601 |
| 101 | 9,999 | 1,000,000 | 10^12 | 4×10^12 | 4,188,789 |
| 999 | 100 | 10^12 | 10^16 | 2^110 | 4,184,568 |

Largest transaction in each additional regime was 2,358 bytes. Final sequence
regression ceilings are **6M cycles / 3,000 bytes**: about 43% and 27% above the
observed peaks. Those larger relative margins accommodate different operation
mixes/signatures, not arbitrary inputs or wallets. Fee 9,999, tiny M and extreme
ratios are stress cases, not approved economic parameters.

Each additional sequence asserts exact preceding output OutPoints, rejects reuse
of consumed fixture inputs, verifies real signatures and pool/xUDT scripts, checks
L=M after full withdrawal and L>M after re-entry. The existing VM accounting
checks compare actual successor reserves/shares to the Rust transition. Thus
these are SDK-to-consensus checks, not merely TS quote tests. In-memory fixtures
still do not model a node's UTXO database, mempool or reorg behavior.

## Reproduce and inspect CI evidence

```sh
npm ci
make pool-build
cargo test --locked -p openswap-pool-tests sdk_combined_resource_envelope -- --nocapture
cargo test --locked -p openswap-pool-tests sdk_distinct_owner_compositions -- --nocapture
cargo test --locked -p openswap-pool-tests sdk_transactions_real_secp_and_xudt -- --nocapture
```

The targeted tests emit `ENVELOPE`, `COMPOSITION`, and `REGIME` rows respectively;
the last also runs the original signature/adversarial cases. Run the complete
suite with `cargo test --locked -p openswap-pool-tests -- --nocapture`. CI now uses
that invocation after building the pool, so successful measurement rows appear
in logs as well as assertion failures. No remote CI run is claimed here.
The distinct-owner test also emits `COMPOSITION_AUTH` counts after each layout's
negative cases. Expect multi-minute execution; the test runner's message that a
test has run for over 60 seconds is not itself a failure.

Pinned artifact SHA256 values remain:

- Pool: `d3a6520f08859787e34b5497d0f0f4c893b81b96fe7aaa280e50584024f67829`.
- Order: `060b0b73f91a960a965fcfaeb68dc40ada0557ff24e0c086c89611dd471340ab`.

Local verification on 2026-10-08: all **23 pool VM tests** passed with the final
ceilings (including the 77 new authorization-negative cases and existing 88
chained transitions). Typecheck, 24 pool SDK tests, 70 existing SDK/solver tests,
90 order VM tests, `make check`, external fixture hashes and the immutable order
identity check passed. The pool SHA256 still matches the value above. Production
contract, arithmetic/model and SDK source trees are unchanged from `714cb69`.

## Operational interpretation and remaining limits

Prefer ordinary single-pool SDK transactions until a separately authorized target
node and wallet integration verifies its own size/cycle/fee policies. Do not
interpret a successful VM test as proof that a 156–161 KB transaction is relayed
or accepted under a particular node's transaction/block policy. Neither that
policy nor live capacity/fee conditions were queried in this offline milestone.
The test composer is not a production multi-pool SDK API.

The growth across compositions is evidence that per-role full scans compound.
The largest measured composition is now 36 pools/36 genuine signing groups,
the maximum for the unmerged six-input/seven-output SDK deposit shape. It is
not the maximum over every layout permitted by the ABI. Do not extrapolate to
all 256-cell layouts, arbitrary xUDT workloads, custom wallet locks, all 512-byte
scripts, or every arithmetic branch. The new compact-wallet profile is separate
from the older padded maximum-width profile; a combination of both extremes was
not measured. More distinct tokens, optimized/alternative composition layouts,
and measured node policy headroom remain follow-up work. The VM harness checks
scripts and output-data shape; it does not run a full node's transaction admission
pipeline. Additional fixture assertions check occupied capacities, exact input
lineage, duplicate inputs and balanced fees, not live UTXO availability. Fuzzing
and independent review remain separate gates. No consensus or production SDK
defect requiring a change was established by these fixtures.
