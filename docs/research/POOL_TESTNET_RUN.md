# P6 controlled testnet pool run

## Approval (2026-10-22, user)

| Decision | Approved value |
| --- | --- |
| Network | CKB testnet, genesis `0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606` |
| Pool code deployer | User's JoyID, signing a generated CCC playground script. No local key involved |
| Token issuer | New dedicated local secp key in ignored `.local/testnet-pool-issuer-key`, funded by the user. It is used only to mint this test token |
| Pool parameters | Fee 30 bps, virtual locked shares M=1,000, permanent backing 340/80/160 tCKB (state/X/Y) |
| Initial liquidity | 1,000 tCKB plus 4,000 tokens (8 decimals, 4×10^11 base units) |
| Fees | Cap 0.0001 tCKB (10,000 shannons) per pool transaction, at most 25 transactions |
| Total budget | About 44,000 tCKB, mostly the code cell |
| P7 | Build offline in parallel. Live UI acceptance only after P6 passes |

Not approved here: mainnet, publication, a CoTA aggregator/proof service (so no
subkey sessions), any reuse of other `.local` keys, or automatic retries.

Two costs are permanent by design. The code cell uses the same always-fail lock
as the order deployment, so its ~42,300 tCKB is unrecoverable and the code
immutable. The 580 tCKB pool backing can never be withdrawn.

## Live profile (read-only checks, 2026-10-22)

- **Pool code:** 42,176 bytes, Data1 `0xc58432bf…a12ed`, SHA256 `d3a6520f…67829`
  (pinned in `scripts/check-pool-identity.py`, mirrored in `scripts/lib/pool-live.ts`).
- **xUDT:** the testnet code cell
  `0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f:0` (33,696
  bytes) has Data1 `0x50bd8d66…1b95`, exactly the pinned profile. The token is a
  fresh Data1-referenced xUDT with the issuer's 32-byte lock hash as args. It is
  distinct from type-referenced xUDT tokens.
- **JoyID lock:** type `0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac`.
  It uses five direct code dependencies, with no dep group, each pinned by
  OutPoint and data hash in the deployment manifest. Only main-key sessions
  are supported.

## Steps and evidence

1. `npm run pool:issuer`. Creates the issuer key and prints its address for
   funding (about 300 tCKB).
2. `npm run pool:deploy-prepare`. Writes `deployments/pool-deploy.playground.ts`.
   The user runs it with JoyID. Then `npm run pool:record -- <tx>` checks the
   live code cell through two RPC endpoints and writes `deployments/pool-testnet.json`.
3. `npm run pool:mint -- <joyid-address> [--execute]`. The issuer mints 10,000
   tokens to the user's JoyID, verified through two endpoints.
4. `deployments/pool-lifecycle.playground.ts`. The user signs, one at a time:
   create, xToY, yToX, deposit, partial withdrawal, full circulating withdrawal
   and re-entry. Each step goes through funding, JoyID preparation, the frozen
   review, one-shot signing and durable pre-send persistence. Each step is
   verified independently.

Nothing here is mainnet or production approval.

## Results (2026-10-22/23): P6 passed

- **Deployment:** `0xfc8c182adf14387e29be1a4bdcba21d49f28a3c1d6ec37e14984969f31306f7d:0`,
  signed by the user's JoyID. The code cell holds exactly the pinned binary on
  the always-fail lock. Verified on both endpoints (`deployments/pool-testnet.json`).
- **Mint:** `0x4adeb9603a8888982b3b67a670fca961f18ba63bb34714b65df8e726db0d8e2e`.
  10,000 tokens to the JoyID, fee 604 shannons (`deployments/pool-mint-result.json`).
- **Lifecycle:** pool `0x48bde5ee099ec7afe35eeab11a78f1e04d68a6e49afbde93771768071b7120b2`.
  All seven steps were signed by the JoyID main key and verified with
  `npm run pool:verify` on both endpoints (`deployments/pool-lifecycle-result.json`).
  Each one spends the previous pool cells. Each next state equals the model
  transition, each fee is under the cap, and every wallet output pays the
  user's JoyID.

| Step | Tx | Fee (shannons) | Reserves after (tCKB / tokens) | Total shares |
| --- | --- | --- | --- | --- |
| create | `0xaeac32ba…b364` | 2,803 | 1,000 / 4,000 | 200,000,000,000 |
| xToY 100 tCKB | `0xae090fb4…d264` | 2,705 | 1,100 / 3,637.36 | unchanged |
| yToX 400 tokens | `0x2b9bef35…3db7` | 2,868 | 991.31 / 4,037.36 | unchanged |
| deposit 200 tCKB | `0xcf4b01f6…95ce` | 2,991 | 1,191.31 / 4,851.90 | 240,350,548,727 |
| partial withdraw | `0x7c704c14…5c62` | 3,102 | 595.66 / 2,425.95 | 120,175,274,864 |
| full withdraw | `0x9fad38a1…c45d` | 2,884 | 496 / 2,019 base units | 1,000 (locked only) |
| re-enter 100 tCKB | `0xeaee1587…40f7` | 2,991 | 100.000005 / 407.06 | 20,161,291,322 |

Nine transactions in total, all within the 25-transaction budget. The seven
pool fees total 20,344 shannons. After the full withdrawal, only dust and the
1,000 locked shares stay in the pool. Re-entry then works as designed.

**Incidents, both with nothing sent:**
1. The first lifecycle attempt aborted with "Pool operation deadline exceeded".
   JoyID approval was inside the 15 s read deadline. Signing now uses the
   maximum bounded 60 s deadline (`5875a39`, lifecycle and Pools tab).
2. The same error recurred once at re-entry. The rerun resumed cleanly from
   saved progress. Investigating it found an SDK bug. If the overall deadline
   fired during the send itself, `submit` threw a plain error rather than the
   ambiguous `unknown` outcome. That would have been misleading, although the
   journaled row still blocked a re-sign. Fixed so that every failure after
   persistence maps to `unknown`, with a regression test.

The Pools tab manifest `deployments/pool-frontend.json` is generated from this
evidence (`npm run pool:frontend-manifest`). P7 live acceptance is next.

## P7 live swap through the Pools tab (2026-10-23)

The user ran the local build with JoyID (main key) and swapped 10 tCKB for TEST:
`0x2b50e473bdff5e6cfd4fb6944fb7784a7730801ff608f262084a362f0c493c80`, committed in
block 22,835,599. Checked on both endpoints. It spends the re-entry pool cells,
and the next state equals the model. It received 36.90418151 TEST against a
minimum of 36.53513969 (1% bound). The fee was 2,705 shannons, and every wallet
output pays the user's JoyID. Pool after: 110.00000496 tCKB / 370.15229029 TEST.

Add liquidity through the Pools tab:
`0xcd8100f0a73d7294ede34dfae0c787b217ed5dc66a9ddfdea55f59d62502e2ec`, block
22,836,055. Checked on both endpoints with the same checks. The budget was a
maximum of 100 tCKB and 100 TEST. The deposit took 29.71749949 tCKB and 100 TEST;
the other 70.28250051 tCKB stayed in the wallet. It minted 5,446,755,795 LP
shares (minimum 5,392,288,237), and the fee was 2,991 shannons. Pool after:
139.71750445 tCKB / 470.15229029 TEST, 25,608,047,117 total shares.

Remove liquidity through the Pools tab:
`0x92cba3363fc06267e149c59f802485217f384880b9a04ab618ee27cc538db214`, block
22,836,113. Checked on both endpoints. It burned 10,000 LP shares and received
0.00005455 tCKB and 0.00018359 TEST, against minimums of 0.000054 and 0.00018175.
The fee was 3,102 shannons. The new submission-status view showed the row as
COMMITTED with its confirmation depth, and had already archived the earlier rows.

With this, the live UI has covered a swap, a deposit and a withdrawal. Each
transaction committed and matched the model.

## Routed swaps from the Swap tab (2026-10-24)

The user asked for 5 TEST on the Swap tab. The router picked the pool, and the
normal pool review opened. The user approved it three times, because the Swap tab
showed no result. Each approval was a separate review and signature, so these are
three swaps, not one transaction resent:

| Tx | Block | Paid (tCKB) | Received (TEST) | Fee (shannons) |
| --- | --- | --- | --- | --- |
| `0xbaed7f3e…` | 22,836,567 | 1.506366 | 5.00000000 | 2,705 |
| `0xc5a9b1df…` | 22,836,579 | 1.53915152 | 5.00000002 | 2,705 |
| `0xf628def7d154107d4fce6aa66e81472eb24fdd95c58f7f8b11cb6581828a9a66` | 22,836,798 | 1.5730186 | 5.00000003 | 2,705 |

Each was checked on both endpoints:
- it spends the previous pool cells;
- the next state equals the model;
- minOut is exactly the requested 5 TEST;
- the fee is under the cap;
- every wallet output pays the user's JoyID.

Pool after: 144.33598602 tCKB / 455.15210665 TEST.

Defect: a routed review reported its outcome only on the hidden Pools tab. A
click during sending then showed only "Wait for the current pool transaction".
Now a routed review reports to the Swap tab's status line. The Swap button is
also disabled while a pool transaction is being prepared, signed or sent.

Deployed-origin check: from the Swap tab on https://toastdex.org (deployment of
`b327f03`), the user swapped 40.76289968 tCKB for 100.00000001 TEST (minimum
exactly 100). Tx `0x1961a4a3dff3959e942c347c28d237fa4dcf4db0ddcbf94c2cbf3e223ef52340`,
block 22,842,588, fee 2,705 shannons. It was checked on both endpoints with the
same checks, and the Swap tab reported the submission in place. Pool after:
185.0988857 tCKB / 355.15210664 TEST.

## Live split route (2026-10-24)

A dedicated maker wallet (new key in ignored `.local/testnet-split-maker-key`,
funded from the faucet; address in `deployments/split-maker.json`) placed two
CKB-for-TEST lots priced above the pool with `scripts/split-live-test.ts place`.
Tx `0x3271ecf6256d19438e3300f4d4de15d4a42c2e284be017b8b1f5eab63257f358`, fee 945
shannons at a fixed 1,000 shannons/KB. The node's 33,222 shannons/KB estimate
would have exceeded the fee cap, so the SDK builders gained an optional `feeRate`.

| Lot | Maker pays | Maker asks | CKB/TEST |
|---|---|---|---|
| `:0` | 20 tCKB | 35.53176908 TEST | 0.5629 |
| `:1` | 30 tCKB | 54.82044372 TEST | 0.5472 |

Pool margin at the time: 0.5196 tCKB per TEST after fee.

From the Swap tab of the local build, the user's JoyID requested exactly 70 tCKB
for TEST. The frontend quoted "split, 2 order lots + pool in one transaction".
Tx `0x16027a46a7919ebae45589baf924d4950d6b39663a2801b76af235957c8444a5`, block
22,844,350, fee 3,429 shannons, one JoyID signature:

- Lots: 50 tCKB to the taker; makers paid 90.35221280 TEST at outputs #0 and #1.
- Pool: 20 tCKB out for 43.15241347 TEST in. The pool state was input/output #2.
- Total: 133.50462627 TEST for 70 tCKB. The pool alone would have needed about
  216.64 TEST, so the split saved about 83 TEST.

`scripts/split-live-test.ts verify` checked both endpoints: committed, both lots
spent, each maker payment byte-equal to the order lock's required payment at its
lot's index, and the pool state directly after the lots. Pool after:
165.0988857 tCKB / 398.30452011 TEST.

UI defects found and fixed during P7:
- Errors appeared only in the page-bottom status line.
- Opening Pools during startup could hang on "Loading live pools…".
- Token amounts were shown in raw base units.
- A repeated Review click cancelled the in-flight preparation and collided with
  its funding reservation.
- Submissions showed UNKNOWN after a successful send and were never archived.
- The dev server let browsers keep a stale bundle across restarts.
