# Frozen independent-review package

Status: **package process prepared; no reviewer contacted or engaged.** Choosing
and engaging a reviewer, sharing the package and accepting findings are explicit
user decisions.

One package covers both consensus targets and their off-chain paths:

| Target | Brief |
| --- | --- |
| Order lock `openswap-lock` (deployed on testnet) | [EXTERNAL_REVIEW.md](EXTERNAL_REVIEW.md) |
| Pool validator `openswap-pool` and pool SDK (testnet only) | [POOL_REVIEW_BRIEF.md](POOL_REVIEW_BRIEF.md) |

Findings are reported with [REVIEW_REPORT_TEMPLATE.md](REVIEW_REPORT_TEMPLATE.md).
The draft inquiry is in [REVIEW_CANDIDATES.md](REVIEW_CANDIDATES.md).

## Freezing

```
./scripts/prepare-review-package.sh
```

The script refuses a dirty working tree. From `HEAD` it produces, under the
ignored `release/` directory:

- `toastdex-review-<commit>.tar`: a `git archive` of committed sources and public
  evidence only. Ignored test keys, wallet state, `node_modules` and build output
  are excluded.
- `toastdex-review-<commit>.manifest.json`, which records:
  - commit, archive SHA256 and creation time;
  - both contract identities, rebuilt and checked against the pinned values;
  - toolchain versions (`rust-toolchain.toml`, rustc, cargo, node, npm) and the
    `Cargo.lock` / `package-lock.json` hashes;
  - a summary of the clean campaign records, each with the commit it ran on and
    the list of non-documentation paths changed between that commit and the
    frozen one.

Give the reviewer the commit, archive SHA256 and manifest. They should rebuild the
binaries and recompute the hashes independently, not trust the manifest.

## Latest freeze (2026-10-25, local only)

- **Commit:** `9f8f520edee42012cd20134a923f789903a226ea`
- **Archive SHA256:** `61d3a4b45d3a6c77f58f8a8ec1dc5feb650b4a3d7b1ab015b8145601828d84fa`

The archive and manifest are in ignored `release/`. Nothing has been shared or
uploaded. The rebuilt identities match the pins: order lock `060b0b73…`, pool
`d3a6520f…`.

The manifest lists every clean campaign record, including the failed `split-vm`
runs. The `split-vm` pass is on `dd4e9d0`; its only later non-documentation
change is the deployment record. The other four targets were recorded on
`a82d72a`, which is 61 non-documentation paths behind this freeze. A reviewer may
ask for them to be rerun on the frozen commit.

## Freeze rules

- Freeze only from a commit whose readiness index and evidence are committed. Do
  not refreeze to fold in fixes silently. A remediation is a new commit, reviewed
  as a diff against the frozen one.
- The deployed order binary is immutable. Any order-lock fix requires a new
  deployment and identity, not a change under the same hash.
- The pool binary identity in the brief must match the frozen build. If pool code
  changes, update the pinned identity and the brief in the same commit before
  freezing again.

## Not included

The package contains no private keys, passkey exports, recovery phrases or
`.local/` journals. Public testnet records are included: the pool deployment,
the live JoyID and contention runs in `deployments/` and
`docs/research/POOL_TESTNET_RUN.md`. These are testnet acceptance records, not
review evidence. No mainnet deployment exists.
