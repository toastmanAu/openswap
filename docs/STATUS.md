# Implementation status

## Implemented and locally verified

- MIT Rust workspace, exact direct dependencies, Cargo.lock and toolchain pin.
- Fixed-buffer Script/data syscalls and strict canonical Molecule parser.
- Single group input and absolute-index payment binding.
- Owner cancellation/rescue before tail parsing.
- CKB and exactly-16-byte UDT offers, both ask settlement paths, same-asset and
  exact-order recreation rejection, stable assigned errors.
- 87 CKB-VM test functions, including real xUDT, secp and ACP fixtures.
- CI formatting/clippy/test/fixture integrity checks.
- Cycle and binary-size report; two clean local builds match byte-for-byte.
- Direct testnet deployment preparation with CCC, unsigned transaction and
  JoyID-compatible playground signing handoff, committed-code verification tool.

## Deployed and implemented

Testnet deployment committed and independently checked through two RPC endpoints:
`0x070bdab0b200bb12faca14662c2c7ebbaeaecf51b1da05170e4d5de5c4dc3fca`, output 0.
`deployments/testnet.json` records its Data1 identity and cell dependency.

- TypeScript wire codec with 15 shared Rust/TypeScript golden cases.
- AssetResolver, canonical xUDT profile, capacity estimator and lot planner.
- Direct indexer scanner/parser and inspection CLI with configurable RPC.
- Create/fill/cancel builders with pinned payment indexes, exact token funding,
  owner-proof cancellation, fee caps and live-input checks before signing.
- Bounded reciprocal/multi-lot matcher and reference solver with local pending
  tracking and fresh scans. Dry-run by default; execution needs a supplied signer.
- 68 TypeScript tests; 88 Rust tests (87 VM tests plus shared-vector test).

## Live JoyID cancellation verified

The replacement JoyID wallet ending `svl02uvq` completed creation and cancellation:

- Create: `0xe014e0446d18075a389377883a32bc705650061761df6d34d05179a13f3399a5`
- Cancel: `0xc2e48f2635bb8e907aa39efbf39af2151f03a020200921b0552301f27f4251f9`

Both committed transactions were checked through two public testnet endpoints.
Order input 0 recovered its full 249.00000001 CKB at output 0 with unchanged
type/data and the expected owner lock. Separate plain JoyID input 1 decreased
at output 1 by the cancellation fee, satisfying the owner proof. The order is
spent. Total create/cancel fees: 0.00112192 CKB.

Machine-readable evidence: `deployments/joyid-smoke-result.json`.
Repeatable verifier: `scripts/record-joyid-smoke.ts <create-hash> <cancel-hash>`.
This establishes this live JoyID cancellation case; broader wallet variants and
adversarial integration remain separate coverage.

## Live two-lot fill verified

- Deterministic solver tests cover dry runs, pending reservations, rejection and
  retry, two competing instances, and concurrent tick protection.
- Scanner tests cover Data1 prefix queries, malformed spam, unsupported assets,
  network mismatch, abort and invalid bounds.
- `deployments/joyid-two-lot-fill.playground.ts` prepares a three-signature live
  mint/create/fill exercise. Creation and filling committed and passed verification
  on both testnet endpoints. Same-wallet filling does not establish a distinct
  permissionless taker's live behavior. Because this wallet is also the token
  issuer, this exercise does not test xUDT's non-owner conservation enforcement;
  the local real-xUDT tests cover that separately.
- `scripts/record-fill-smoke.ts` checks committed status, indexed maker payments,
  spent orders, no recreation, and token conservation through two RPC endpoints.

Live evidence: `deployments/fill-smoke-result.json`.

- Create: `0x2d19439e6034c898c0c1b3b72139c7d7a83a38c2a6730ac719108e88e5c9487b`
- Fill: `0x0a308b21df2f0b10a039d6513666b736fc2a048599488ac25f24b1e447b18563`
- Order inputs 0 and 1 paid the exact maker outputs at indexes 0 and 1.
- Both orders are spent, neither lock was recreated, and token totals balance.
- Create fee: 0.00067574 CKB; fill fee: 0.00076345 CKB. Combined:
  0.00143919 CKB, excluding minting.
- Mint: `0x0ef9fdd3503374452f207b43980b727837950e78140800d7e2e10fd8a18525a2`.
  Both nodes confirm 1,000 canonical token units minted to the expected owner,
  and that output was consumed by the fill. Mint fee: 0.00056112 CKB; total
  mint/create/fill fees: 0.00200031 CKB.

## Separate-wallet integration verified

The setup and all four local transactions committed. Independent verification
through both testnet endpoints passed:

- Secp create/cancel with the required separate same-index owner proof.
- A reciprocal pair settled by the reference solver, restricted to the scenario.
- Different JoyID maker and secp solver locks, exact indexed maker payments,
  spent orders and no recreated order locks.
- Canonical xUDT token conservation with no JoyID issuer input in the fill.

Setup: `0x93665e434258ca91f36ad90c7d97076a15aa460cf558a52a99383ce67730a8e4`.
Solver fill: `0x28f10b5a5e46d1b80a5a635d3dc89c8c12b9a602ddc6ccb0f728c48125c50c51`.
All transaction hashes and checks are in
`deployments/solver-integration-verification.json`.
Total fees for setup plus four local transactions: **0.00182558 CKB**.

The public solver wallet is in `deployments/solver-wallet.json`; its local key
remains in ignored `.local/testnet-solver-key` (mode 600). Unspent solver funds
remain under that key. No additional JoyID signature is needed for this completed
scenario. These are distinct wallets operated in one integration environment,
not evidence of unrelated operators or a live competing-solver race.

## Frontend, router and bounded integration milestones validated

The static app supports CCC/JoyID selection, independent testnet RPC/indexer
settings, chain-only books, pagination, create/fill/cancel and full-lot swaps.
The router uses bigint prices and a bounded tail subset search; live preparation
checks quote limits and indexed payments. Type-checking and production build pass.

- 55 SDK/solver tests and four isolated Chrome tests pass.
- Four UI-originated secp transactions (create/cancel and create/routed swap)
  committed and passed independent two-node verification. Total fees:
  **0.00087443 CKB**. See `deployments/frontend-live-verification.json`.
- Account changes and endpoint switches invalidate reviews without signing;
  see `deployments/frontend-review-verification.json`.
- Three real two-wallet race/soak rounds completed with exactly one committed
  winner each. Two-node checks prove indexed payments, no issuer input, token
  conservation and spent orders; see `deployments/race-soak-result.json`.
- The live race exposed speculative cache recovery and stale-book issues. Both
  were fixed and regression tested; remaining rounds then completed successfully.

See `docs/GOAL_VALIDATION.md` for the requirement-by-requirement evidence and
`docs/FRONTEND.md` for local commands and a concrete JoyID UI acceptance recipe.

## Remaining release limitations

- Human JoyID passkey acceptance from the new frontend (live JoyID SDK signing
  already passed via Playground); no agent can complete a user's passkey prompt.
- Longer endurance runs, broader fuzzing, independent-machine reproducibility
  and external review. The three-round bounded soak is not a long-duration soak.
- Public hosting and mainnet release are not performed or claimed.

## Source verification

- ckb-std 1.1.0 and ckb-testtool 1.1.1 match the handoff baseline; pinned source was
  inspected for syscall widths and explicit Data1 construction.
- CCC docs (`skill.md`, `llms.txt`) and upstream source at commit
  `58a3f4c40b755494951c93243a450697ccde7c09` were read before integration.
  Installed public APIs were then checked against shell 1.3.12/core 1.21.0;
  package-lock.json pins the complete dependency graph.
- No Nervina SDL implementation source was copied or consulted.

## Latest app acceptance

The user reported a successful two-wallet app test after the explicit wallet-switch
flow and self-fill prevention were added. Transaction hashes for that new test
have not been supplied, so this is user acceptance evidence rather than a new
independently verified chain journal. Seven browser regressions pass, including
account switching and stale-order clearing. See docs/FRONTEND.md.

## ToastDEX usability and release preparation

- Account-scoped indexer/local activity with pending/unknown status and links.
- Pay/receive balances, decimal unit prices and separate fee/storage accounting.
- Quote freshness, review timeout, actionable errors and pre-broadcast hash storage.
- ToastDEX cream/toasted-brown styling; final logo pending.
- A new bounded two-account trade committed and was verified on both nodes;
  see deployments/two-wallet-trade-result.json.
- External-review brief and Cloudflare Pages configuration prepared. Actual
  independent review and public custom-domain deployment are not completed.
