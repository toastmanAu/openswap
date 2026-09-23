# Draft pool validator

Isolated prototype, not deployed or independently audited. One immutable Data1
binary handles state type, state lock, CKB reserve lock, token reserve lock and
LP type roles. It uses the [wire ABI](../../docs/research/POOL_WIRE_FORMAT.md) and
the independently cross-checked [accounting crate](../../pool-arithmetic/README.md).
The existing OpenSwap order contract is a separate binary with unchanged identity.

```sh
python3 scripts/verify-fixtures.py
make pool-test
make check
```

`scripts/build-pool.sh` supplies fixed build environment/path remapping. The VM
tests load the resulting release binary; they do not substitute a host validator.
Every variable-size cell script, relevant datum and witness is read into a fixed
buffer. Inputs/outputs each have a 256-cell bound with an explicit tail probe.
The common verifier executes independently for every invoked pool role; it does
not trust another script group or a state supplied as a cell dep.

The prototype profile pins the vendored devnet xUDT fixture's Data1 code hash:
`0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95`.
Its SHA256 is `e9b92e5783f692f6ee99ca20eeda5f3da282e0f4010eb4fbd3db4e3058239349`.
See [fixture provenance](../../tests/fixtures/manifest.json). VM tests confirm
32-byte owner args work and reject token inflation without an owner input.
Only exact 16-byte token amounts and this 32-byte args profile are accepted.
Extended flags and other token binaries are not enabled. The three custody lock
hashes are excluded as token owners; external issuer powers remain an asset risk.
This pins a local test fixture, not a production deployment choice or token audit.

## Verified boundary

| Requirement | VM evidence in `pool-tests/src/tests.rs` |
| --- | --- |
| Unique genesis, initial LP issue | Genesis identity/singleton cases, omitted/extra issue and incorrect L |
| Full first CellInput and output index | Nonzero state output index, changed since rejected |
| Exact reserve OutPoints | Identical lookalike substitution, missing reserves and dep-only state rejected |
| Role/code identity | Fake counterparts, wrong role placement, Type-addressed code rejected |
| Immutable backing and parameters | Capacity drains, occupied-capacity floors, fee/M/profile changes rejected |
| Exact accounting | Both swaps, proportional/unbalanced deposits, withdrawals, slippage and excess donation rejection |
| LP conservation | Transfers, mint/burn mismatches, absent authority, malformed amounts, aggregate overflow |
| Permanent pool and lineage | Full circulating withdrawal, re-entry, chained generations, reordered inputs/outputs |
| Per-pool isolation | Two simultaneous pools, cross-pool reserve/LP substitutions, shared witness fields |
| Bounded parsing/scans | Malformed executing args, data, witnesses, exact 256-cell and 512-byte Script limits |

These are bounded VM tests. Ordinary wallet locks use always-success test owners;
wallet signature coverage, live contention, scanners/builders, and independent
security review remain separate work. The pool accounts for reserve movements
and LP deltas; wallet signatures/builders must bind user recipients. No on-chain
intent or recipient-authentication layer is introduced here.

Initial measurements on the remapped release binary: 42,176 bytes, about 1.15M
cycles for genesis and 2.20–2.24M for single-pool transitions with these fixtures.
The tested 256-input/output genesis boundaries cost about 7.25M/6.83M cycles.
These are observed cases, not worst-case proofs or production fee estimates.
Each VM test has a 100M-cycle ceiling. No network transactions were submitted.
