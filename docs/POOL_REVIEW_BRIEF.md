# ToastDEX pool external-review brief

Status: **prepared for an independent reviewer; no external audit completed.**
The pool validator is an undeployed prototype. The order lock has its own brief,
[EXTERNAL_REVIEW.md](EXTERNAL_REVIEW.md). Both are covered by one frozen
[review package](REVIEW_PACKAGE.md).

## Consensus target

| Item | Value |
| --- | --- |
| Pool binary | `target/riscv64imac-unknown-none-elf/release/openswap-pool`, built by `scripts/build-pool.sh` |
| Size / SHA256 | 42,176 bytes / `d3a6520f08859787e34b5497d0f0f4c893b81b96fe7aaa280e50584024f67829` |
| Data1 code hash | `0xc58432bfaf1cfaab12532bd4d9ce7e5a43196bd0c867a43b63f19096727a12ed` |
| Token profile | Vendored xUDT fixture, Data1 `0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95`, 32-byte owner args, 16-byte amounts |
| Deployment | None. No live dependency OutPoint exists in any approved manifest |

`scripts/check-pool-identity.py` verifies the size, SHA256 and Data1 hash.
`scripts/check-reproducible.sh` builds both contracts twice in separate target
directories and compares the bytes.

## Components in scope (priority order)

1. **Validator** (`contracts/openswap-pool/src`, about 300 lines). One Data1 binary
   serves five roles: state type, state lock, CKB reserve lock, token reserve lock
   and LP type. Check role authentication from executing args, the exact sibling
   lineage of the first CellInput and output index, and the 256-cell and
   512-byte bounds with tail probes. Check that every invoked role re-verifies
   independently and never trusts another group or a dep-supplied state.
2. **Arithmetic and wire** (`pool-arithmetic/src`, about 730 lines, `no_std`).
   Check constant-product swaps with fee, proportional deposits with virtual
   shares, withdrawals, and the integer square root. Check U256 intermediates and
   the RANGE/OVERFLOW/SHARES/ZERO_OUTPUT/SLIPPAGE rejections. Check that the
   codecs accept only canonical encodings.
3. **Pool SDK** (`pool-sdk/src`):
   - **Builders and review:** the builders pin layout. `review.ts` rebuilds the
     transaction from independent snapshots and freezes the disclosures the user
     approves.
   - **JoyID:** `joyid.ts` and `joyid-proof.ts` cover bounded dependency, CoTA
     and proof resolution, plus one-shot signing bound to a review and session.
   - **Funding:** `funding.ts` does bounded selection with process-local
     reservations.
   - **Submission and recovery:** `recovery.ts` handles durable submission.
     `solver/src/resolution.ts` holds the explicit resolution checks.
4. **Shared journal** (`solver/src/journal.ts`). Check the atomic snapshot and
   archive writes, scope binding, the single-writer lock and fail-closed
   poisoning.

## Priority questions

1. Can any transaction move reserve CKB or tokens, mint or burn LP, or change
   fee, virtual shares (M) or backing without the exact accounting delta? Include
   cross-pool substitution, duplicate or lookalike successors, reordered cells,
   and dep-only state.
2. Can permanent backing, or the virtual-share floor, be redeemed or drained,
   for example by full withdrawal, re-entry or rounding at small reserves?
3. Do the TypeScript model and Rust arithmetic agree everywhere the contract
   accepts a transition? 42,155 fixed vectors and the recorded seeded campaigns
   are evidence, not proof. Which regions are under-sampled?
4. Can malformed args, data, witnesses or oversized scripts cause a panic,
   unbounded work or acceptance? Check cycle growth near the 256-cell limits
   (see the [resource envelope](research/POOL_RESOURCE_ENVELOPE.md)).
5. Signing boundary: the action witness is outside the wallet's signature group
   (see the limitations below). Can a third party change any economically binding
   term after the user signs? Is the SDK guard sufficient for the supported flows?
6. JoyID: is the dependency/CoTA/proof resolution sound for main_key and sub_key
   sessions? Is anything trusted that an RPC, an indexer or the connector could
   forge? The offline proof fixture is synthetic.
7. Submission: is there any path that sends before the exact signed bytes are
   durable? Any path that releases a reservation while the signed transaction
   can still commit? Any path that retries automatically? Is the
   abandon-after-conflict rule sound given reorgs?

## Known limitations (stated, please challenge)

- **Action witness is unsigned.** Normal action witnesses are outside the
  wallet secp signing group. A nonbinding minimum or budget can change while the
  signed outputs stay valid. Recipients and amounts in raw outputs are
  signature-bound. There is no on-chain intent commitment.
- **Token issuer power.** The xUDT profile pins code and shape, not economic
  safety. An external issuer can mint under that asset's rules. An owner lock
  that depends on another permissionless pool may be satisfiable by third
  parties.
- **Lookalike outputs.** Unsolicited lookalike outputs are not reserves, and
  recovering them is not promised.
- **Freshness.** Freshness checks are not reservations or atomic snapshots. A
  coherent malicious RPC view is not disproved.
- **Abandoned submissions.** An abandoned submission can still commit if the
  conflicting spend that justified abandoning it is reorganized away.
- **Economic risk.** Price impact, MEV, thin liquidity and parameter choice are
  economic risks.

Full detail, the internal R1/R2 findings and their fixes are in the
[internal review](research/POOL_INTERNAL_REVIEW.md).

## Reproduce

```
npm ci
npm run typecheck
make check
make pool-test                   # builds the pinned binary, runs all pool VM tests
python3 scripts/check-pool-identity.py
./scripts/check-reproducible.sh
npm run test:pool-model && npm run test:pool-cross && npm run test:pool-wire
npm run test:pool-sdk && npm run test:sdk
npm run campaign -- all --seed=1          # seeded campaigns, see docs/campaigns
```

No keys, network access or deployment are needed for any of these.

## Evidence index

| Evidence | Where |
| --- | --- |
| VM boundary cases (roles, lineage, accounting, LP, isolation, bounds) | `pool-tests/src/tests.rs`; table in [validator README](../contracts/openswap-pool/README.md) |
| Real SDK transactions with real secp and xUDT, chained lifecycles, regimes | `pool-tests/src/sdk.rs` |
| Multi-pool/multi-owner composition and 77 authorization negatives | `pool-tests/src/sdk/composition.rs`, [resource envelope](research/POOL_RESOURCE_ENVELOPE.md) |
| TS/Rust arithmetic and wire vectors | `pool-model/src/cross-check.ts`, `pool-model/src/wire-vectors.ts` |
| Seeded fuzz/endurance campaigns with provenance | [campaigns](campaigns/README.md), `docs/campaigns/results.jsonl` |
| JoyID, review, signing, funding and submission tests (mock signer and mock chain only) | `pool-sdk/test/*.test.ts`, `solver/test/*.test.ts` |
| Internal review, threat model, coverage matrix | [POOL_INTERNAL_REVIEW.md](research/POOL_INTERNAL_REVIEW.md) |
| Staged readiness and open gates | [READINESS.md](READINESS.md) |

## Not yet evidenced

There is no deployment, no live JoyID authorization, and no node admission,
contention or reorg evidence (P6). There is no pool UI (P7) and no independent
review. Report findings using [REVIEW_REPORT_TEMPLATE.md](REVIEW_REPORT_TEMPLATE.md).
