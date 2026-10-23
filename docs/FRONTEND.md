# Testnet reference frontend

```sh
npm ci
npm run typecheck
npm run build:frontend
npm run dev:frontend
```

Open http://127.0.0.1:5173. The build emits static files in `frontend/dist`;
there is no application backend or hosted OpenSwap order API. The development
server binds only to localhost. The public testnet app is live at
https://toastdex.org on Cloudflare Pages; see [deployment instructions](CLOUDFLARE_PAGES.md).

## Trading flow

The default screen is a compact swap card. Choose the pay and receive tokens,
enter the receive amount, and payment is quoted from live lots automatically.
The optional maximum-payment limit is under Swap options. Available swaps list
live lots across markets with direct Review swap buttons. Review shows the exact
payment, received amount, fees and capacity before signing.

Orders contains order creation, your cancellations, and a collapsible full book.
Settings contains endpoints, scan diagnostics and the full connected address.
The catalog stays collapsed below the swap card; mainnet remains preview-only.

If a fill reports insufficient token funding, the taker needs the **ask token**
in their connected wallet. Offering CKB in a maker order does not create that
payment token. The app checks token funding and reports the required amount and
available wallet balance before building a fill. CKB fees/storage are separate.

## Implemented

- Explicit CKB testnet indicator and genesis verification.
- Separate HTTP(S) node and indexer settings. The indexer tip is compared with
  the node's header before switching. Endpoint switches disconnect the wallet
  and invalidate transaction reviews.
- CCC connector 2.2.2 with JoyID testnet support. The app never reads passkeys or
  private keys. Wallet actions use the same pinned SDK builders as the live
  Playground integration exercises.
- Live Data1 prefix scanning, directional books, integer prices, whole-lot fill,
  owner cancellation and multi-lot creation with rounding premium/capacity review.
- Canonical xUDT type-script entry and browser-local display labels. Labels are
  not verified token metadata; unsupported scripts require an AssetResolver.
- Instant swap: greedy price selection plus a bounded ten-lot tail subset search.
  Quotes show requested/delivered output, overfill, required input, effective
  rational price, selected lot count and tip. Transaction preparation calculates
  the network fee and net wallet capacity change. No expiry timestamp is invented.
- Before signing, the SDK checks live inputs, quote bounds and pinned payments.
  Spent quotes fail with a request to refresh/requote; no silent repricing occurs.

Amounts use **human-readable decimals** for CKB and catalog tokens (eight for
CKB and iCKB). Conversion uses exact bigint arithmetic. Test xUDT and manually
added tokens with unknown decimals use integer units; decimals are never guessed
from symbols. Existing on-chain orders retain their original amounts: an old
entry of 10000 shannons now displays as 0.0001 CKB.
The swap input budget excludes network fees and additional CKB storage funding;
review includes those capacity effects separately.

## Validation

`npm run test:sdk` exercises routing precision, overfill, tail improvement, budgets,
wrong networks, duplicate lots, stale quotes, altered quote totals and successful
funding/payment layout. The broader builder and solver suites run with it.

With the dev server running:

```sh
npm run test:frontend
```

Browser tests use an isolated local Chrome instance, not a user browser profile.
Set `CHROME_BIN` if Chrome is installed elsewhere. Current coverage includes
live testnet scanning, opening/closing the CCC JoyID selector, mobile layout and
invalid token input. These checks use public endpoints and therefore depend on
network availability. Screenshots are saved under ignored `frontend/test-results`.

## Recorded live and adversarial validation

- Eight isolated-browser tests pass, including decimal quote/reversal and catalog selection. Existing coverage includes: live scan/JoyID selector, mobile/input handling,
  a synthetic 120-lot book with malformed data and pagination, and endpoint mismatch.
- `scripts/test-frontend-live.ts` drove four actual UI transactions using a local
  secp signer restricted to the test wallet, four signatures and 0.01 CKB fees.
  The browser received only a public key. `scripts/verify-frontend-live.ts` checked
  cancellation and routed maker payments/conservation on both testnet nodes.
- `scripts/test-frontend-review.ts` tested account changes, endpoint changes and
  attempted use of stale reviews, and missing-iCKB fill funding with signing forbidden. No signing requests occurred.
- The reference solver completed three live competing-wallet rounds; see
  `deployments/race-soak-result.json`. This is bounded integration, not endurance testing.

The signed browser test refuses to repeat an existing journal automatically.
Its committed transactions are in `deployments/frontend-live-result.json` and
verification is in `deployments/frontend-live-verification.json`.

## JoyID passkey acceptance recipe

This extra human acceptance check uses the user's passkey and is not automated:

1. Open **https://toastdex.org** and keep the **TESTNET** endpoints.
2. Connect wallet A with JoyID and check its displayed public address.
3. Choose a small CKB/token trade using a token wallet B already holds. Create
   **one lot** from wallet A; review the amounts, recoverable capacity and fee.
4. Use the app's **Switch wallet** button to connect wallet B. Check the address
   changed and wallet A's own orders disappeared. Fill the lot from B and verify
   both wallets' received/payment amounts in Activity and their wallets.
5. Switch back to A, check the address, create another single small lot and cancel
   it. Cancellation needs a separate ordinary CKB cell for the owner proof.
6. Save four hashes labelled **create-for-fill**, **fill**, **create-for-cancel**,
   **cancel**, and confirm the browser origin was `https://toastdex.org`.

The token payment belongs to the maker; order capacity is recoverable and network
fees are spent. Use the app's decimal token units, not raw shannons. No private
key, recovery phrase or passkey export is needed. Trading remains on testnet.

Read-only two-node verification (no signatures or broadcasts):

```sh
npx tsx scripts/verify-public-wallet.ts <create-for-fill> <fill> <create-for-cancel> <cancel>
```

The verifier checks deployed Data1 identity, indexed maker payment, distinct
non-maker funding, exact 16-byte token conservation, owner cancellation proof
and spent orders. It writes `deployments/public-wallet-verification.json` only
when both nodes agree. Human confirmation of origin and passkey UX is recorded
separately: those facts cannot be inferred from a transaction hash.

## Wallet switching and self-fill prevention

The connected button becomes **Switch wallet**. This disconnects and clears the
previous CCC/JoyID session before opening the wallet selector. Switching accounts
inside the separate JoyID website alone does not replace CCC's cached connection.
The full connected CKB address is visible above trading and in each transaction
review. Account scripts are rechecked before preparing/reviewing/signing and when
the page regains focus; pending reviews are invalidated on account changes.

Own orders are marked **Your order / Manage order**, excluded from swap quotes,
and rejected by a fresh address check before direct fills. Ownership checks use
all CKB scripts exposed by the signer, not wallet names. The low-level permissionless
SDK/contract still permits self-settlement; the frontend prevents presenting it
as an economic trade. Browser tests include switching between distinct
accounts, clearing owned orders and restoring external quotes.

### Reported fill audit

`0xbab0973b321182b2fed969030ebafb092d051de9d173e942db0deb975fe66a90`
was checked independently against both testnet endpoints with
`scripts/verify-reported-fill.ts`; results are in
`deployments/reported-fill-verification.json`.

The 10,000 CKB order's maker and its iCKB funding account were the same script.
The indexed output paid the required 5,000 iCKB to that maker, and another output
returned 20,163.01435128 iCKB change to the same account. All 25,163.01435128 iCKB
remained under that account's control. This was valid settlement, not cancellation:
the order had no type script, while the indexed payment output had the iCKB type.
The fee was 0.00066378 CKB. This audit does not identify which account the user
intended to select in the wallet UI. No audit or regression check signs transactions.

## ToastDEX usability update

The application uses a cream/toasted-brown palette and the supplied ToastDEX
logo. Both swap assets display wallet balances; CKB is explicitly total
capacity, including cell storage. Activity is scoped by genesis and the full
connected script set. It queries up to 20 transactions for each of eight wallet
addresses, merges the last 20 local submissions, and shows at most 40 rows.
Local storage retains at most 200 entries. This is recent activity, not a complete
wallet/accounting export. Unknown status includes node lookup failures and is
never presented as confirmed failure. Saved links remain visible during outages.

Order creation estimates recoverable CKB storage before transaction building.
Reviews show protocol fee (zero), actual network fee, net wallet CKB change,
new/released order capacity and the change in token-cell storage reserves.
Displayed decimal unit prices are rounded down to eight places and marked as
approximate; settlement always uses exact integer amounts.

A review expires in the app after one minute (not an on-chain expiry). Every
submission still rechecks live cells. A callback records the transaction hash
immediately before broadcasting, so an ambiguous RPC timeout directs the user
to Activity instead of encouraging an automatic duplicate transaction.

Validation: 70 TypeScript tests, eight browser tests, and a read-only review test
cover account changes, insufficient funding, expired reviews and zero signature
requests. The new live two-wallet trade is recorded in
`deployments/two-wallet-trade-result.json`. Deployed-origin JoyID acceptance is recorded in
`deployments/public-wallet-verification.json`; independent audit remains outstanding.

All eight browser regressions also passed against both public origins,
`https://toastdex.org` and `https://toastdex.pages.dev`. These checks open the wallet
selector but do not complete a human passkey signature. To repeat:

```sh
TOASTDEX_BASE_URL=https://toastdex.org npm run test:frontend
```

## Deployed wallet acceptance evidence

On 2026-09-18 the user confirmed normal JoyID prompts on `https://toastdex.org`
for creation, a distinct-wallet fill and cancellation of an existing order. Both
testnet nodes agreed on exact maker payment, token conservation, separate taker
funding and the cancellation owner proof. See
[the verification journal](../deployments/public-wallet-verification.json).

## Pools tab (P7, offline only)

Status: **built and tested offline against a mocked node and a mock JoyID
signer. No live pool deployment, wallet prompt or browser acceptance exists.**
Live acceptance follows P6.

The tab loads `pool-manifest.json` at runtime. `build.mjs` copies it from
`deployments/pool-frontend.json` when that file exists. That file is generated
by `npm run pool:frontend-manifest` from the recorded P6 deployment
(`pool-testnet.json`, an evidence record with a different shape) and the verified
lifecycle, which supplies the pool ID. The generator validates its output with
this parser. If no manifest is served,
or the node's genesis differs, the tab says pools are not deployed. A malformed
manifest is an error, not a silent "not deployed". The strict schema is in
`frontend/src/pools/manifest.ts` and is roughly:

```json
{"version":1,"network":"testnet",
 "deployment":{"genesisHash":"0x…","codeHash":"0x…",
  "poolDep":{"outPoint":{"txHash":"0x…","index":"0"},"depType":"code"},
  "tokenDep":{"outPoint":{"txHash":"0x…","index":"0"},"depType":"code"}},
 "pools":[{"label":"CKB / TOKEN","poolId":"0x…",
  "token":{"symbol":"TEST","decimals":8,"typeHash":"0x…"}}],
 "joyid":{"codeHash":"0x…","hashType":"type","codeDeps":[{"dep":{…},"dataHash":"0x…"}],
  "cotaType":{…},"proofEndpoint":"https://…"},
 "policy":{"feeRate":"1000","maxFee":"10000","slippageBps":50,"reviewTtlMs":60000},
 "create":{"parameters":{"feeBps":"30","lockedShares":"1000","backing":{"state":"…","ckb":"…","token":"…"}},"tokenOwner":"0x…"}}
```

`cotaType`, `proofEndpoint` (needed for JoyID subkey sessions), `create` and a
pool's `token` are optional. Pools are listed by ID; their current state is always
discovered live.

`token` is display metadata only. It applies only when `typeHash` is the type
hash of the live pool's token. On a mismatch the tab refuses to show the pool,
so wrong decimals can never misstate amounts by orders of magnitude. With
`token`, amounts are shown and entered in whole tokens (for example `1.5 TEST`).
Without it they are exact raw base units ("token units"). Creation still takes
raw token units.

Every pool transaction follows the SDK path:
1. Reload the pool live and requote. Minimum output is the fresh quote reduced by
   `slippageBps`.
2. Run `resolveJoyIdWallet`, `fundPoolTransaction` and JoyID `prepare`.
3. Run `reviewPoolTransaction`, then show the frozen summary: identity, network,
   pool, exact pay and receive amounts, minimum, fee and cap, storage top-up, your
   outputs, pool after, permanent backing and expiry.
4. On explicit approval, run `bindReview().sign()`, then `PoolSubmissionRecovery.submit`.

Rules:
- Account, endpoint or network changes, Back and expiry all discard the review
  and release its funding.
- A wallet refusal sends and journals nothing.
- An ambiguous send is shown as unknown, with no retry control. Its inputs,
  including the pool state, stay reserved across reloads. Preparing against that
  state is refused with the blocking submission's hash.

`frontend/src/pools/journal.ts` is a localStorage-backed `ArchivableSubmissionJournal`
with the solver journal's record validation. A write from another tab poisons
the instance; reload and reconcile. Clearing site data loses it; the node remains
the authority on what was sent.

Real CKB nodes answer an unknown transaction hash with `transaction: null` and
status `unknown`, which CCC maps to "absent". This was checked on both testnet
endpoints on 2026-10-22. An earlier shared test fixture returned a bare `null`,
which real nodes do not send. The fixture now uses the real shape, and the UI
needs no special handling. Network failures still throw.

Tests: `frontend/test/pools.spec.ts`, 8 offline cases. They build a real SDK
genesis, serve it from a mocked node, and sign with a fixed-placeholder mock JoyID
signer. No signature is cryptographically valid and nothing touches a network.
