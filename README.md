# ToastDEX

ToastDEX is a permissionless CKB exchange with a static frontend and a clean-room
OpenSwap v0.1 full-lot lock contract:

**ONE CELL · ONE LOT · ONE FILL · ONE MAKER PAYMENT**

Every order input pays its maker at the same absolute output index, or follows
an independently authorized owner recovery path. No global state, protocol fee,
admin key, expiry, sequencer, or hosted matching API.

## Build and test

Requires Rust 1.98.1, the `riscv64imac-unknown-none-elf` target, a host C compiler,
Python 3, and Make. `rust-toolchain.toml` pins Rust and the target.

```sh
make test                    # build the actual RISC-V binary; run CKB-VM tests
make check                   # formatting and clippy with warnings denied
make hash                    # SHA256, CKB data hash, binary size
./scripts/check-reproducible.sh
```

The reproducibility check builds both order and pool contracts in two temporary
target directories, compares their bytes, and checks pinned identities. The pool
identity gate (`python3 scripts/check-pool-identity.py`) is an artifact check,
not a live deployment manifest or authorization.

`npm run test:frontend` starts its own local server and runs eight isolated browser
regressions with mocked RPC. Locally it uses `/usr/bin/google-chrome` (override with
`CHROME_BIN`); CI installs the pinned Playwright Chromium. `TOASTDEX_BASE_URL` can
select an already-running test server. These tests do not perform live acceptance.

All OpenSwap tests explicitly use **Data1**. Runtime code reads the running
Script into 4096 bytes, token amounts into 16 bytes, and probes empty data with
one byte. It does not load arbitrary cell data into allocated vectors.

## Implementation status

For current order-versus-pool readiness and remaining release gates, start with
[the staged readiness matrix](docs/READINESS.md). Historical counts below describe
the order product; newer pool work is tracked separately.

Contract settlement and rescue are implemented. The suite includes isolated
adversarial tests, real xUDT conservation, signed secp cancellation and real ACP
regressions. See [implementation status](docs/STATUS.md),
[test coverage](docs/TEST_COVERAGE.md), and [measurements](docs/BENCHMARKS.md).

The immutable Data1 contract is deployed on CKB testnet. Recorded checks cover
JoyID/secp cancellation, indexed maker payments, reciprocal solver settlement,
three competing-solver rounds, and browser create/cancel/swap flows.
The current suites contain **90 Rust tests**, **70 SDK/solver/UI-helper tests**,
and **8 browser tests**. A fresh two-wallet app test was also reported successful
by the user after the wallet-switch fix; its transaction hashes are not recorded.

This is a testnet reference implementation, not an audited mainnet release.
See [status and validation limits](docs/STATUS.md),
[SDK usage](docs/SDK_USAGE.md), and [deployment evidence](deployments/).

## Run the app

Requires Node.js 22 or newer and npm.

```sh
npm ci
npm run dev:frontend
```

Open **http://127.0.0.1:5173**, or use the live testnet app at **https://toastdex.org**.
The app uses the supplied ToastDEX logo and a brown/cream palette. It scans the
CKB indexer directly; there is no mandatory hosted order API. The development
server binds only to localhost.

- **Swap:** choose pay/receive tokens, enter the receive amount, and review the
  automatically quoted payment. Live lots also have direct review buttons.
- **Orders:** place orders, split them into lots, or cancel your own orders.
- **Activity:** recent wallet transactions from the indexer, plus locally saved
  submission hashes and fresh node status. History is scoped to the account.
- Prices use token decimals. Reviews separate network fees, order capacity,
  recoverable token-cell storage and net wallet CKB change.
- CKB amounts are entered/displayed in **CKB**, with exact decimal conversion.
  Existing orders retain their original on-chain amounts.
- Built-in catalog: iCKB, the explorer's top 20 sUDTs by holder count, and
  UTXOSwap featured tokens. **Mainnet catalog entries are preview-only**;
  current trading is testnet. Bitcoin-bound RGB++ spending requires a separate
  leap integration. See [catalog provenance and compatibility](docs/TOKEN_CATALOG.md).
- Use **Switch wallet inside ToastDEX** when changing accounts. The app clears
  the old session and displays the actual connected CKB address. Changing the
  account in a separate JoyID tab alone does not replace CCC's cached connection.
  Own orders are excluded from the app's swap routes.

A taker must hold the token requested by the maker, plus CKB for fees/storage.
Amounts use catalog decimals; manually added tokens without metadata and the
reference test token use integer units. Review the connected address and exact
payment before signing. See [frontend guide](docs/FRONTEND.md).

```sh
npm run typecheck
npm run test:sdk
npm run build:frontend
# With the development server running and Chrome installed:
npm run test:frontend
```

## Static hosting and independent review

The testnet app is live at **https://toastdex.org** on Cloudflare Pages, with
**https://toastdex.pages.dev** as an alternate URL. HTTPS and release asset hashes
were verified on both origins; all eight browser tests passed on each. See the
[deployment record](deployments/frontend-pages.json) and
[deployment runbook](docs/CLOUDFLARE_PAGES.md). `npm run release:frontend` builds
twice, compares output hashes and produces a static archive under `release/`.

Deployed-origin JoyID create/fill/cancel passed with distinct-wallet funding and
two-node verification. A separate GitHub-hosted runner reproduced the deployed
contract binary; see [release validation](docs/RELEASE_VALIDATION.md).

The [independent-review brief](docs/EXTERNAL_REVIEW.md) identifies the exact
contract, security questions and evidence. No external audit has been completed.
A new [two-wallet trade](deployments/two-wallet-trade-result.json) was verified on
both nodes with distinct maker/taker accounts; the lock binary remains unchanged.

## Key handling

Never commit private keys, recovery phrases or wallet exports. Local test keys
are stored under ignored `.local/`; `.env*`, dependencies, build outputs and
browser artifacts are also ignored. Scripts that submit transactions require
explicit execution and a locally supplied signer. Deployment journals contain
public addresses, transaction hashes and public transaction data only.

## Deployment tooling

```sh
npm ci
npm run deploy:prepare -- <testnet-funding-address>
```

See [deployment runbook](docs/DEPLOYMENT_RUNBOOK.md). Production order scripts
must use the exact binary's CKB data hash with `hashType: "data1"`.

## Layout

- `contracts/openswap-lock`: bounded consensus implementation and stable errors
- `tests`: real CKB-VM tests and pinned external token/owner-lock fixtures
- `sdk`: wire codec, asset resolution, scanning and transaction builders
- `solver`: bounded matching and permissionless settlement runner
- `scripts`: reproducible build, hashing, fixture checks, and deployment tools
- `docs`: measured results, remaining release gates, and operational instructions
- `docs/handoff`: original supplied handoff, preserved before implementation

The root protocol/specification files remain authoritative. Original handoff
checksums apply to `docs/handoff` (including its original README), not this
implementation README. No Nervina SDL implementation code was used.

## License

New implementation code is MIT. External test fixtures retain their upstream
license and provenance in `tests/fixtures`.

## Liquidity-pool research

A separate [draft pool specification](docs/research/POOL_TRANSITIONS.md) and
[integer accounting model](pool-model/README.md) explore permissionless CKB/xUDT
pools alongside existing orders. Arithmetic, an isolated on-chain validator,
unsigned SDK and extensive VM tests are implemented; pools are not deployed or
integrated into the app. JoyID-first wallet integration is the current milestone.
See [the integration plan](docs/research/POOL_INTEGRATION_PLAN.md) and
[resource measurements](docs/research/POOL_RESOURCE_ENVELOPE.md).
