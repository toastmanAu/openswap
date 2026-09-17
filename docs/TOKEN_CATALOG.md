# Built-in token catalog

Snapshot: 2026-09-17. Public metadata is bundled locally; browsing and trading do not depend on an explorer or UTXOSwap API. Token identities are type-script hashes, never symbols. Catalog inclusion is not an endorsement or proof of liquidity.

## Sources and scope

- The [Nervos explorer ranking](https://explorer.nervos.org/tokens?sort=addresses_count.desc), fetched through its documented public API at `https://mainnet-api.explorer.nervos.org/api/v1/udts?sort=addresses_count.desc&page=1&page_size=20`, supplies the top 20 mainnet sUDTs by holder count. Counts are a dated snapshot, not a live ranking.
- [UTXOSwap's public featured-token metadata](https://utxoswap.xyz/utxo-swap/api/v1/sequencer/token/tops) supplies 19 distinct mainnet tokens after deduplication and identity validation: common tokens including USDI, ccBTC, RUSD and iCKB, plus tokens from its RGB++ ecosystem list such as Seal, CAT++, Otter and RGB++. This is the featured list, not every asset ever listed. DRAGON is excluded because its supplied script does not hash to its supplied type hash.
- [iCKB's official deployments](https://github.com/ickb/whitepaper#deployments) supply the testnet iCKB entry and network-specific dependency groups. Its `0x80000000` flag enables owner-by-input-type mode; it is handled only for the exact published iCKB script.

There are 39 mainnet entries and one testnet entry. CKB and the existing OpenSwap test token remain available separately. Mainnet tokens are preview-only in the current testnet application. No mainnet OpenSwap deployment exists in this app. Never substitute mainnet token identities into testnet markets.

The mainnet sUDT snapshot is YOK, USDC, BNB|bsc, ETH, KOI, USDC|bsc, dCKB, WBTC, CPAX, COFFEE, COOP, USDT, BTCB|bsc, CUSDT, USDT|bsc, TAI, BUSD|bsc, ETH|bsc, WBNB|bsc and DAI.

## Compatibility

`CatalogAssetResolver` adds the exact catalog sUDT scripts and iCKB to the default unextended canonical xUDT resolver. It uses CCC's network-specific sUDT dependency and iCKB's published dependency group. Cell data must still be exactly 16 bytes. Unknown or extended token profiles need an explicit resolver. USDI, ccBTC and RUSD are discoverable metadata entries; their custom contracts are not enabled by merely appearing in the catalog.

RGB++ describes cross-chain ownership, not a new fungible amount encoding. The picker identifies CKB-side tokens. Spending Bitcoin-bound RGB++ cells requires a separate leap/Bitcoin signing integration, which this application does not provide.

## Refresh and verification

Fetch the two public JSON endpoints above, project only name, symbol, decimals, script, type hash, and holder ranking into `sdk/src/catalog-data.ts`, and review the diff. Preserve mainnet/testnet separation. Recompute every script hash; reject inconsistencies rather than guessing corrections. Verify new profiles and dependencies before enabling transfers. Run `npm run typecheck`, `npm run test:sdk`, `npm run build:frontend`, and `npm run test:frontend` with the local frontend server running.

Tests cover all snapshot hashes, deduplication, the 20 ordered holder counts, network separation, strict amount data, exact iCKB identity/dependencies, unknown-script rejection, and browser search/selection/mainnet gating. No mainnet transfers were submitted. iCKB adapter tests do not constitute a live iCKB create/fill/cancel integration test.
