# ToastDEX static deployment on Cloudflare Pages

The testnet app is live at **https://toastdex.org**, with
**https://toastdex.pages.dev** as an alternate URL. The Pages project `toastdex`
uses direct uploads; pushing Git commits does not automatically deploy it.
There are no Pages Functions, Workers, D1, server secrets or hosted order services.
CKB RPC/indexer and wallets remain external.

The [deployment record](../deployments/frontend-pages.json) identifies the deployed
source commit, immutable deployment URL and verified asset hashes. The supplied
`toastDexLogo.png` is included unchanged in the static build.

## Verify and publish a static artifact

```
npm ci
npm run typecheck
npm run test:sdk
npm run release:frontend
```

The release command deletes only generated `frontend/dist`, builds twice and
compares all output hashes. It writes a deterministic tar archive, file manifest,
and SHA256SUMS under ignored `release/`. Reproducibility is established for the
same pinned lockfile and Node/toolchain environment, not claimed across all OSes.
The extracted contents can be hosted by any static server or mirrored independently.
Headers enforce revalidation, MIME checking, no framing and no referrer leakage.
Wallet popup messaging remains enabled; no restrictive opener policy is set.

After verification, publish using the authenticated Wrangler account:

```sh
npm exec --yes --package=wrangler@4.134.0 -- wrangler pages deploy frontend/dist --project-name toastdex --branch main
TOASTDEX_BASE_URL=https://toastdex.org npm run test:frontend
```

`wrangler.jsonc` specifies the static output directory. No application environment
secrets are required. Keep Wrangler credentials outside the repository.

## Domain and acceptance

The custom domain is registered with the Pages project. The domain owner set the
proxied apex CNAME `@` to `toastdex.pages.dev`; mail and unrelated records should
remain intact. The deployment account had Pages access but no DNS write access.
Both public origins serve HTTPS and byte-identical HTML, JavaScript, CSS and logo
matching the local release. All eight browser regressions passed on both origins.

Human JoyID create/fill/cancel acceptance on `https://toastdex.org` completed on
2026-09-18. The user confirmed normal wallet prompts and two nodes independently
verified distinct taker funding, indexed maker payment and owner cancellation.
See [wallet evidence](../deployments/public-wallet-verification.json). Browser
tests alone do not establish passkey signing; follow the repeatable recipe in
[the frontend guide](FRONTEND.md) after wallet integration changes.

## 2026-10-24 deployment: pools and routing

Source commit `b327f03`, deployment `https://9a6189e2.toastdex.pages.dev`. It adds
the Pools tab and Swap-tab routing, and serves `pool-manifest.json`. Both origins
serve files byte-identical to the reproducible release.

- **Browser tests:** all 22 pass on toastdex.pages.dev. The network guard now
  allows the origin named by `TOASTDEX_BASE_URL`; before this, every live run
  was blocked.
- **toastdex.org** first failed the guard. Cloudflare Web Analytics on that
  zone injected `static.cloudflareinsights.com/beacon.min.js` into HTML served
  to browsers, which is third-party script on a page that drives wallet signing.
  The domain owner disabled automatic injection. HTML served to browsers is
  again byte-identical to the release, and all 22 tests pass on toastdex.org.
  Keep Web Analytics injection off. The guard fails if it comes back.
- **JoyID signing on the deployed origin:** the user made a routed Swap-tab swap
  on toastdex.org, `0x1961a4a3…2340`, block 22,842,588. It paid 40.76289968 tCKB
  for 100.00000001 TEST, and the Swap tab showed the outcome. Verified on both
  endpoints: it matches the pool model, the fee was 2,705 shannons, and every
  wallet output pays the user's JoyID.

Follow-up deployment `https://991cef6a.toastdex.pages.dev` (source `75ced03`,
2026-10-24): faster pool review preparation. Files on all origins are
byte-identical to the reproducible release, and all 22 browser tests pass on
both origins. On toastdex.org, the pay-TEST review was ready in 12.5 s, down
from 20–24 s.

Rollback: select the previous successful deployment in Pages. Published contract
code and outstanding order cells remain unchanged by frontend rollbacks.

References: [static deployment](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/),
[custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/),
[headers](https://developers.cloudflare.com/pages/configuration/headers/).
