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

Results are recorded under `deployments/` and summarized here once they exist.
Nothing here is mainnet or production approval.
