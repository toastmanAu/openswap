# ToastDEX static deployment on Cloudflare Pages

The site is prepared for Cloudflare Pages. **No public deployment or domain binding
has been performed by this change.** There are no Pages Functions, Workers, D1,
server secrets or hosted order services. CKB RPC/indexer and wallets remain external.

## Git-connected project

In Workers & Pages → Create application → Pages → Import a Git repository:

| Setting | Value |
| --- | --- |
| Repository | `toastmanAu/openswap` (ToastDEX application; OpenSwap lock) |
| Production branch | `main` |
| Framework preset | None |
| Root directory | Repository root |
| Build command | `npm ci && npm run typecheck && npm run build:frontend` |
| Build output directory | `frontend/dist` |
| Node version | `22` |
| Project name | `toastdex`, subject to availability |

No environment secrets are required. `wrangler.jsonc` describes the same output
for a direct-upload workflow if preferred. Use a Pages Git connection for automatic
builds, or direct uploads; choose one deliberately when creating the project.

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

## Domain and acceptance

After the Pages preview works, add `toastdex.org` through the project's **Custom
domains** flow. For an apex domain, Cloudflare requires the domain to be a zone
in the same account with Cloudflare nameservers. Do not guess or replace DNS
records; preserve existing mail and unrelated records. DNS details and access
are still needed from the owner. Do not paste API tokens into chat or source files.

Before switching the domain, verify preview and production HTTPS, mobile layout,
JoyID connect/switch/sign from the deployed origin, CKB decimal amounts, history,
custom endpoints, and a bounded two-wallet create/fill/cancel. Local browser and
chain tests cannot prove a new origin's passkey popup behavior.

Rollback: select the previous successful deployment in Pages. Published contract
code and outstanding order cells remain unchanged by frontend rollbacks.

References: [static deployment](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/),
[custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/),
[headers](https://developers.cloudflare.com/pages/configuration/headers/).
