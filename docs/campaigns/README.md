# Offline fuzz and endurance campaigns (T1)

Reproducible, seeded campaigns over the parsers, the pool arithmetic and the
pool validator. They need no network, keys or deployment. Run them with:

```
npm run campaign -- <target|all> [--seeds=A..B|--seed=N] [--cases=N] [--seconds=N] [--record]
```

`make pool-build` must have produced the pinned pool binary (`scripts/check-pool-identity.py`).
`--record` appends one JSON line per run to [results.jsonl](results.jsonl). Each
line holds the commit and both contract binary SHA256s. It also holds a dirty flag
listing any uncommitted non-documentation paths (`docs/` and root `*.md` cannot
affect results). Only records with `dirty: false` count as evidence.

## Targets

| Target | What each case does | Oracle | Default budget |
| --- | --- | --- | --- |
| `order-parser` | Mutated/truncated shared wire vectors and zero buffers into the order-lock args parser | No panic; accepted parses stay within declared bounds | 1,000,000 |
| `pool-wire` | Arbitrary bytes into every pool codec (args, state, action, script, both witness phases) | No panic | 1,000,000 |
| `pool-model-diff` | Random pool walks (wide parameter/magnitude ranges, boundary specials, slippage-edge minima, corrupted-state probes) | Each vector matches the Rust arithmetic exactly; every accepted TS transition passes `validateTransition` | 200,000 vectors |
| `pool-vm` | One long walk of real SDK-built, secp-signed transitions in CKB-VM, each spending the prior outputs | VM accepts within 6M cycles and 3,000 bytes; exact predecessor inputs; every 8th step a signed one-bit state mutation must be rejected | 100 steps |
| `split-vm` | One long walk of split routes. Each case places 1–32 random order lots (one base unit to 1,000 CKB / 10,000 tokens, with edge amounts) in a random direction. It fills them with a random pool swap in one SDK-built, secp-signed transaction, running the real order lock and pool validator, and continues from its outputs | VM accepts within 12,000 bytes. Lots are inputs `0..n-1` with payments at the same indices, the state is at `n`, and the reserve indices are `n+1`/`n+2`. Each case re-signs one tampered copy (swapped payments, moved action witness, payment redirected to the taker, maker underpaid by one unit), which must be rejected | 100 cases |

## Stopping criteria

Each run ends at exactly one of:

- `stop=budget`: the case budget completed. This is a pass.
- `stop=time`: the per-run `--seconds` budget expired. This is a partial pass,
  and `executed` records how far it got.
- `stop=failure`: the first failing case. The runner stops all remaining seeds,
  prints the panic/mismatch, and prints the command that reproduces it. The same
  seed regenerates the same case stream. For the Rust targets `failed_case`
  names the case index.

With no `CAMPAIGN_*` variables, each harness keeps its original fixed CI seed and
count. CI also runs a 20,000-vector `pool-model-diff` smoke, a six-step
`pool-vm` walk and a four-case `split-vm` walk.

## Recorded results (2026-10-22, commit `a82d72a`, clean tree)

| Target | Seeds | Executed | Stops | Notes |
| --- | --- | --- | --- | --- |
| `order-parser` | 1–10 | 10,000,000 | 10 budget | 13 s total |
| `pool-wire` | 1–10 | 10,000,000 | 10 budget | 178 s total |
| `pool-model-diff` | 1–5 | 1,000,001 vectors | 5 budget | All match Rust. About 545k accepted transitions all pass `validateTransition`. Every rejection code was hit except `OVERFLOW`, which earlier range checks appear to make unreachable. |
| `pool-vm` | 1–3 | 450 transitions | 3 budget | 107–119 of each operation type, no skips. 57/57 tampered states rejected. Peak 4.25M cycles, max 2,410 bytes. |

Raw records are in [results.jsonl](results.jsonl). `pool-model-diff` can exceed its
budget by one vector when a corrupted-state probe follows the last step.

## What a pass does and does not show

A pass shows no counterexample in the sampled space for these oracles at the
recorded commit and binaries. It is not coverage-guided fuzzing, not a proof,
and not independent review (R1). The `pool-vm` walk uses one public fixture
owner and the default fee/backing profile. Multi-owner composition and resource
extremes remain in the fixed resource tests. Live contention is out of scope
(P6).
