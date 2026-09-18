# ToastDEX / OpenSwap v0.1 external-review brief

Status: **prepared for an independent reviewer; no external audit completed**.
ToastDEX is the application brand. The deployed consensus binary remains the
clean-room `openswap-lock` v0.1. No contract modification accompanies the UI work.

## Consensus target

- Data1 code hash: `0x1d4e322540cbec1d1fdf2ca4a13b12521401d6c1ed5f0432c01cce84ea94eddf`
- SHA256: `060b0b73f91a960a965fcfaeb68dc40ada0557ff24e0c086c89611dd471340ab`
- 28,592 bytes; immutable testnet code at `deployments/testnet.json`.
- Authority: root PROTOCOL.md, WIRE_FORMAT.md, CONTRACT_IMPLEMENTATION.md,
  SECURITY.md and DECISIONS.md. Preserved original handoff is under docs/handoff.

## Review scope and priority questions

1. `contracts/openswap-lock/src`: bounded syscalls, canonical args, single-group
   input, absolute input-to-payment binding, exact 16-byte amounts and all
   integer/capacity boundaries. Check malformed/oversized data cannot panic/OOM.
2. Owner rescue: unchanged type/data/capacity plus a separate plain owner input
   whose capacity decreases at the matching output. Confirm ACP-style anyone
   authorization cannot substitute for maker authorization. Review custom-lock
   assumptions and malformed-tail recovery independently.
3. Fill settlement: maker identity and type/data, CKB reserve return, zero or
   overflow amounts, multi-input groups, recreated order rejection and cross-lot
   substitution. No mainnet, admin, treasury, sequencer or hard expiry exists.
4. SDK: pinned outputs, fresh cells before signatures, token conservation,
   fee caps, unknown UDT profiles, iCKB's explicitly pinned owner-mode profile,
   sUDT's exact supported data profile, stale wallet accounts and broadcast errors.
5. Frontend: account changes clear ownership/reviews; self-fills excluded;
   decimals do not change consensus units; net capacity and storage are distinct
   from fees; pending/unknown transactions do not encourage automatic retries.
6. Solver: bounded search, no privileged matching, competition/conflict recovery,
   restart handling and avoidance of speculative change from losing transactions.

## Reproduce and examine evidence

```
npm ci
npm run typecheck
npm run test:sdk
make check
make test
./scripts/check-reproducible.sh
make hash
```

Use docs/TEST_COVERAGE.md and docs/BENCHMARKS.md for local VM coverage/cycles.
Deployment journals record public transaction data. In particular:

- `solver-integration-verification.json`: separate-wallet reciprocal settlement.
- `race-soak-result.json`: original three competing-solver rounds.
- `race-endurance-result.json`: extended bounded run, including its original
  three-round baseline and separate process invocations; inspect `runs` and
  `completedAt` rather than assuming an hours/days endurance test.
- `race-funding-consolidation.json`: same-owner maintenance after the extended
  run exposed token-cell capacity fragmentation; check conserved tokens and fee.
- `public-wallet-verification.json`: human-confirmed deployed-origin JoyID
  create/fill/cancel and independent two-node checks.
- `remote-reproducibility.json`: separate GitHub-hosted machine matched the
  immutable deployed binary using the pinned toolchain.
- `frontend-review-verification.json`: read-only account/review checks, no signing.
- `reported-fill-verification.json`: diagnosed self-payment; it was valid
  settlement, not an unpaid fill. The app now prevents this misleading UX.
- `two-wallet-trade-result.json`: explicit maker/taker distinction, token gain,
  CKB debit, exact maker output and two-node verification.

Only dedicated ignored local test keys may run live integration scripts. A fresh
reviewer can run VM/unit/browser tests without those keys. Never send keys or
recovery phrases with a review request.

## Deliverables expected from the independent reviewer

Record the reviewed commit and binary hashes, methods and tool versions, findings
with reproducible cases and severity, remediation verification, and unresolved
assumptions. A passing test suite is not an audit opinion. Mainnet release remains
blocked on an explicitly accepted review outcome and separate deployment plan.

## Review handoff

Use [REVIEW_REPORT_TEMPLATE.md](REVIEW_REPORT_TEMPLATE.md) to record findings and
an explicit release conclusion. The implementation team's tests and fixes are
preparation for review, not an independent review opinion.

Create a review source snapshot from a specific committed revision:

```sh
mkdir -p release
review_commit=$(git rev-parse HEAD)
git archive --format=tar --prefix=toastdex/ --output="release/toastdex-review-${review_commit}.tar" "$review_commit"
sha256sum "release/toastdex-review-${review_commit}.tar"
```

`git archive` includes committed sources and public evidence; ignored test keys,
wallet state, node_modules and build output are excluded. Supply the commit, archive
hash, deployed binary identity and this brief to the chosen reviewer. No reviewer
has been contacted and no paid engagement has been initiated by these checks.

A [candidate shortlist and draft inquiry](REVIEW_CANDIDATES.md) is prepared from
primary published CKB audit evidence. No outreach or engagement has occurred.
