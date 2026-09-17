# Testnet reference frontend

```sh
npm ci
npm run typecheck
npm run build:frontend
npm run dev:frontend
```

Open http://127.0.0.1:5173. The build emits static files in `frontend/dist`;
there is no application backend or hosted OpenSwap order API. The development
server binds only to localhost. No public deployment has been performed.

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

- Six isolated-browser tests pass, including decimal quote/reversal and catalog selection. Existing coverage includes: live scan/JoyID selector, mobile/input handling,
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

1. Open http://127.0.0.1:5173 and keep the **CKB TESTNET** endpoints.
2. Select **Connect wallet → JoyID** and check the connected public address.
3. On Swap, select receive **CKB** and pay **Test xUDT**. Open **Orders** and
   choose **Offer CKB, ask Test xUDT**.
4. Enter offer **0.00000001**, ask **1**, and **1** lot. Choose **Review order**.
5. Review capacity (about 249.00000001 CKB for the tested JoyID lock) and fee,
   then **Sign and submit** and complete the wallet prompt.
6. After confirmation, use **Cancel** under **Your orders**, review, and sign.
7. Retain both committed hashes from the status message. The order capacity returns on
   cancellation; fees are spent. A separate ordinary JoyID CKB cell is needed
   for the cancellation proof.

This checks the new app's passkey UX; earlier JoyID create/cancel and fill have
already committed using the same SDK via Playground. No private key, recovery
phrase or passkey export is required. No mainnet or public-hosting claim is made.

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
as an economic trade. Seven browser tests now include switching between distinct
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

The application now uses a cream/toasted-brown palette and temporary ToastDEX
wordmark. Both swap assets display wallet balances; CKB is explicitly total
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

Validation: 68 TypeScript tests, eight browser tests, and a read-only review test
cover account changes, insufficient funding, expired reviews and zero signature
requests. The new live two-wallet trade is recorded in
`deployments/two-wallet-trade-result.json`. External audit and deployed-origin
JoyID acceptance remain separate gates.
