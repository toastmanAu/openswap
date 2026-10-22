# Single-pool JoyID integration acceptance plan

2026-10-12. User choice: **JoyID first**. Implementation baseline `5d08496`.
This plan authorizes offline development, not live deployment or economic policy.

## Profile and approval boundary

| Field | Offline definition / proposed live scope |
| --- | --- |
| Network | Proposed CKB testnet. Existing order manifest records genesis `0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606`; revalidate on the authorized target. Mocks use explicitly separate fixture genesis values. |
| Pool code | Data1 `0xc58432bfaf1cfaab12532bd4d9ce7e5a43196bd0c867a43b63f19096727a12ed`; SHA256 `d3a6520f08859787e34b5497d0f0f4c893b81b96fe7aaa280e50584024f67829`; 42,176 bytes. No live pool dependency OutPoint exists in the approved manifests. |
| Y asset | Exact vendored xUDT Data1 `0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95`, 32-byte owner args and 16-byte amounts. Direct code dependency required. A catalog token/name or the existing order token is not interchangeable. |
| Issuer | Explicit owner-lock hash required; review issuer mint/burn/extension authority. No wallet funding that activates issuer mode; no pool custody as issuer. Offline owner hashes are fixtures, not deployed issuers. |
| Wallet | Installed `@ckb-ccc/joy-id` 1.2.3 / core 1.21.0. Support CKB primary and subkey preparation as separate cases. Bind exact connected lock, identity/key type, client/genesis and session epoch. Other credential modes require evidence, not silent fallback. |
| Witness | Connector reserves 1,000 lock bytes, then returns a variable-length signed lock field. Preserve all non-lock fields, raw inputs/outputs/deps and other witnesses. Reject oversize rather than reducing a signed fee or silently accepting arbitrary witnesses. |
| Parameters | Offline proposed fee 30 bps, virtual locked shares M=1,000, permanent backing 340/80/160 CKB (state/X/Y). These match existing fixtures, not endorsed live economics. Initial liquidity and all operation budgets/minima must be explicit. |
| Fee policy | Offline fixture rate 1,000 shannons/1,000 bytes, cap 10,000 shannons per operation; reserve the bounded witness size before review. Actual signature can be shorter, leaving a disclosed conservative fee. Live rate/cap/total work budget need approval. |
| Dependency policy | Pool/xUDT direct code data hashes checked; JoyID code/dependencies and any account-specific CoTA dependency/proof explicitly resolved before review, bounded and revalidated. No new deps after review. No arbitrary network defaults. |

Before Stage 3, request approval for network/endpoints, precise deployment and
dependency manifest, token/issuer, account, parameters/liquidity, transaction
count, per-transaction/total fee and funding budget. Do not read `.local` keys or
reuse previously funded test wallets merely because earlier milestones used them.

## JoyID-specific layout issue and proposed resolution

Primary source inspected locally: installed connector
`node_modules/@ckb-ccc/joy-id/src/ckb/index.ts` (`prepareTransaction`,
`prepareTransactionForSubKey`, `signOnlyTransaction`). Preparation writes a
1,000-byte lock placeholder. Subkey preparation may add CoTA cell dependencies
and an unlock proof in the first wallet witness's `outputType`. Signing clears
input caches and returns wallet-produced transaction bytes.

The old genesis places its create action at witness 0 `outputType`, colliding
with that subkey field. For the JoyID layout, place the minted LP output at 0,
state at 1, X/Y at 2/3 and the create action at witness 1 `outputType`; keep wallet
proof at witness 0. Derive pool ID with state output index 1. A single funding
input therefore needs an extra witness at index 1. The existing contract already
supports nonzero genesis indexes. Preserve default secp genesis at state index 0
and 65-byte signatures. Normal transitions retain state output 0 and first wallet
input 3, so their action/proof witnesses are separate already.

This is an SDK layout change, not a contract/ABI revision. Prove it with pool VM
tests as well as connector preparation tests. A secp-signed layout test does not
prove JoyID/WebAuthn authorization; real JoyID acceptance remains a separate gate.

## Acceptance checklist

- [ ] **Profile:** validated explicit identity/dependency manifest; no hidden token
  or wallet fallback; economic defaults clearly separated from live approvals.
- [ ] **Layout:** actual installed connector preparation for primary/subkey cases;
  nonzero genesis action/ID/siblings verified by unchanged pool VM; legacy secp
  bytes and existing regressions preserved. No subkey proof/action collision.
- [ ] **Funding:** bounded deterministic selection from uncached eligible cells;
  one account, no issuer/foreign types, no duplicates, exact LP/token accounting,
  occupied-capacity/dust/fee-cap failures. Never swallow malformed/spent-input
  errors as “try more funding.” Reserve selected points against concurrent work.
- [ ] **Review:** derive from validated snapshots and final prepared bytes, not
  mutable returned summaries. Show identity, direction, minima, exact receipts,
  fee, storage/top-up, LP changes and permanent backing. Freeze review and expiry.
- [x] **Preparation/signing (offline, mock signer 2026-10-22):** reject raw-field/dependency/action/non-wallet witness
  and cache mutations; allow only the reviewed wallet lock field replacement.
  Recheck inputs and session before and after awaits. Account/network/endpoint
  changes, cancellation, expired review and wallet refusal cause no submission.
  Browser bundle smoke must pass without Node-only runtime dependencies.
- [x] **Lifecycle (offline, mock signer 2026-10-22):** offline primary/subkey cases for create, both swap directions,
  deposit, partial/full circulating withdrawal and re-entry. No claim of closing
  the permanent-backed pool or redeeming virtual M.
- [x] **Submission (offline, file journal/mock chain 2026-10-22):** explicit send boundary, persist signed hash/bytes and input
  reservations before send; journal failure prevents send; uncertain result stays
  unknown, not automatically retried. Reconcile pending/committed/rejected/absent
  transactions and input state; handle restart/reorg without phantom change.
- [ ] **Live acceptance (approval required):** target wallet prompts and each
  lifecycle operation; independently checked receipts/fees/deps, node admission,
  contention, stale inputs, ambiguous response and reorg/recovery evidence. List
  any scenario that cannot be exercised rather than claiming it from mocks.
- [ ] **UI/routing (after live path):** add single-pool routing with conservative
  bounds and freshness; LP create/add/remove screens; browser wallet mutation,
  cancellation, errors and existing order regressions; no automatic publishing.

Offline ticks above mean mock-signer/mock-chain evidence only. Real JoyID
authorization, popup behaviour, node admission and reorg handling stay under
live acceptance.

## Threat and evidence limits

Raw transaction fields are signed, but pool-group action witnesses are not
universally covered by another group's wallet signature. Preserve exact action
bytes with the SDK guard; do not claim on-chain full-intent authentication.
Pool accounting constrains meaningful output changes; economically nonbinding
action changes remain the documented caveat. If a stronger commitment becomes a
requirement, propose a separately reviewed design rather than changing the ABI.

Freshness is not a reservation or atomic chain snapshot. Coherent malicious RPC
data, wallet compromise, price movement/MEV, issuer authority and illiquidity are
not solved by UI checks. Primary and subkey proof/credential validity must not be
inferred from a fake proof used in a unit test. External review remains outstanding.

Supporting CI, solver durability, fuzz/endurance and review-package gates are
tracked separately in [READINESS.md](../READINESS.md); do not drop them when the
wallet path becomes functional.

## Implementation evidence (2026-10-12, in progress)

The proposed witness separation is implemented behind explicit `wallet.witness`
selection; default secp remains unchanged. Four new SDK tests cover the actual
installed JoyID connector's preparation for primary/pre-resolved-subkey fixtures,
all operation layouts, bounded signature sizes, fees and mutation rejection.
Typechecking and all 28 pool SDK tests pass. `sdk_joyid_layout_with_secp_authorization`
passes the unchanged VM for two genesis profiles and ten transitions including
full withdrawal/re-entry. Its real secp authentication is intentionally not
represented as JoyID authentication.

Subsequent offline increments add bounded direct-code/CoTA dependency and proof
resolution, session/account/client/genesis binding and checked connector preparation.
The proof HTTP adapter bounds response size, deadlines and cancellation; synthetic
proofs are not cryptographic acceptance. Funding now uses deterministic eligible
selection and process-local reservations, tested across the lifecycle and concurrent
reviews (including different wallet inputs competing for the same pool). Typecheck
and all 45 pool SDK tests passed at that increment.

The review increment reconstructs canonical prepared bytes from captured cells
and explicit intent/policy, decodes action bytes and freezes disclosures with
expiry. Tests cover changed outputs/actions/caches/policy, mutable builder
summaries, stale inputs and cancellation; lifecycle tests also reconstruct each
transition review. Typecheck, 47 pool SDK tests and 70 order/solver tests pass.
Review/session binding, signing/submission state machine, durable recovery and
live acceptance remain open. Review reconstruction shares the existing builder
and accounting model; it is not independent validation or proof of RPC honesty.

Broader verification: all 24 pool VM tests, 70 existing SDK/solver tests and
`make check` passed; fixture and both binary identities match. After the final
canonical wallet-witness check, typecheck, all 28 SDK tests and the JoyID-layout
and legacy resource VM tests passed again. No live wallet/network operation,
deployment, commit or push was performed in this implementation step.
