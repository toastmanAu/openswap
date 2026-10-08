# Pool VM resource measurements and sequence coverage

2026-10-05. Offline evidence on baseline `f5dcc94` plus test-only changes.
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
cargo test --locked -p openswap-pool-tests sdk_transactions_real_secp_and_xudt -- --nocapture
```

The first command targeting a test emits `ENVELOPE` rows; the second emits
`REGIME` rows and runs the original signature/adversarial cases. Run the complete
suite with `cargo test --locked -p openswap-pool-tests -- --nocapture`. CI now uses
that invocation after building the pool, so successful measurement rows appear
in logs as well as assertion failures. No remote CI run is claimed here.

Pinned artifact SHA256 values remain:

- Pool: `d3a6520f08859787e34b5497d0f0f4c893b81b96fe7aaa280e50584024f67829`.
- Order: `060b0b73f91a960a965fcfaeb68dc40ada0557ff24e0c086c89611dd471340ab`.

## Operational interpretation and remaining limits

Prefer ordinary single-pool SDK transactions until a separately authorized target
node and wallet integration verifies its own size/cycle/fee policies. Do not
interpret a successful VM test as proof that a 156–161 KB transaction is relayed
or accepted under a particular node's transaction/block policy. Neither that
policy nor live capacity/fee conditions were queried in this offline milestone.
The test composer is not a production multi-pool SDK API.

The growth between one, two and four pools is evidence that per-role full scans
compound. Four pools is the largest measured composition, not the largest
possible composition under the ABI. Do not extrapolate these numbers to all
256-cell layouts, many signature groups, arbitrary xUDT workloads, custom wallet
locks, all 512-byte scripts, or every arithmetic branch. More distinct tokens,
maximum feasible pool count, many genuine owner groups and measured node policy
headroom remain follow-up work. Fuzzing and independent review remain separate
gates. No consensus or production SDK defect requiring a change was established
by these successful fixtures.
