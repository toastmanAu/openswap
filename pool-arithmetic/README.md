# Isolated pool arithmetic and codecs

Draft, allocation-free `no_std` accounting for create, swaps, deposit and withdrawal.
Includes bounded draft wire codecs, but no CKB validators, RPC, signing or deployment. See the
[transition specification](../docs/research/POOL_TRANSITIONS.md) and proposed
[wire/role specification](../docs/research/POOL_WIRE_FORMAT.md).

`uint = 0.10.0` is exact-pinned with default features disabled and lockfile checksums.
The [upstream package](https://docs.rs/crate/uint/0.10.0) provides fixed-width,
stack-based integers. The prototype uses four limbs; additions/products are
checked and divisions have validated positive denominators. Subtractions are
preceded by bounds checks. Square root uses division-based binary search,
independently of the TypeScript model's Newton iteration. This is a bounded
implementation review, not an independent dependency/security audit. VM cycle
costs and contract suitability remain to be measured.

Public numeric values use U256 so domain violations can be compared before
narrowing; the accepted state remains u64 CKB/u112 token/u128 shares. Typed
operations have no unknown-operation or noninteger form. Error discriminants
match the draft wire document. The host-only JSON checker uses serde_json as a
dev dependency; it is not linked into the library.

```sh
cargo test --locked -p openswap-pool-arithmetic
cargo check --locked -p openswap-pool-arithmetic --lib --target riscv64imac-unknown-none-elf
npm run test:pool-cross
npm run test:pool-wire
```

The deterministic TypeScript generator streams expected states, all eight flow
fields and error codes to the independently implemented Rust checker. It includes
small-reserve cases, extreme fees, rounding/dust, invalid pre-states/parameters,
u64/u112/u128/U256 boundaries, mixed sequences, complete circulating withdrawal,
reactivation and square roots around powers of two. Emit the same JSONL corpus
with `npm exec -- tsx pool-model/src/cross-check.ts --emit` for external reuse.
Generation or Rust failure fails the command; no stale generated fixture is used.
The original TypeScript tests retain their independent invariant/enumeration
oracles. Cross-language agreement does not prove correctness or validate custody.

The `wire` module encodes/decodes exact args, state data and actions, and canonical
pool Script containers. It also decodes bounded WitnessArgs, validates all three
BytesOpt fields, and selects the action for genesis or transition. It uses native
fixed-width fields and checks local domains. Transaction counts, role placement,
authentic OutPoints, actual occupied capacity, xUDT code support and LP issuance
remain obligations of the future validators. `StateData::accounting` accepts
caller-supplied reserve balances; it does not establish their origin.

Ten Rust tests (one arithmetic and nine codec tests) include every truncation,
unknown tags, reserved bytes, numeric/index boundaries, malformed Molecule
offsets, phase selection, the 4096-byte witness limit, 103,936 state/action
single-byte mutations and 20,000 fixed-seed arbitrary byte cases. The independent
TypeScript sequential encoder supplies 3,291 wire vectors with expected decoded
fields or explicit error codes. Successful Rust decodes must re-encode to the
same bytes for args/state/action/Script. Emit the corpus with
`npm exec -- tsx pool-model/src/wire-vectors.ts --emit`. These are host tests,
not CKB-VM tests or exhaustive fuzzing.
