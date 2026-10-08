# Draft pool SDK and unsigned CLI

Isolated, Node-oriented prototype for the [pool validator](../contracts/openswap-pool/README.md).
No deployment, signer, private-key loading, transaction submission, generic coin
selection, frontend integration or mainnet defaults. Existing order SDK behavior
and deployed order binary are unchanged. Not independently audited.

## Verify locally

```sh
npm ci
npm run typecheck
npm run test:pool-sdk
npm run test:pool-wire
make pool-test
```

Node 22 and the pinned Rust toolchain are required. `make pool-test` now also
invokes the actual TS builders from Rust and checks their serialized transactions
in CKB-VM with real xUDT and bundled secp256k1 scripts. Public deterministic test
keys exist only in that in-memory fixture; they are not funded wallets.

## SDK boundary

Import from `pool-sdk/src/index.ts` using the repository's pinned CCC version.

- `codec.ts`: canonical args, state, action, Script and WitnessArgs codecs.
  All 3,291 independent wire vectors agree with the Rust codec checks.
- `scanPools` / `loadPool`: uncached direct node/indexer reads; exact state and
  reserve OutPoints, role scripts, occupied capacity, backing, accounting and
  pinned xUDT profile are checked. Reserve lookalikes are not accepted.
- `buildCreate` / `buildTransition`: synchronous, offline **unsigned** builders
  for creation, exact-input swaps in either direction, deposit and withdrawal.
- `assertIntegrity`: pins raw fields and all witness positions except replacement
  of the designated 65-byte wallet signature. Sparse/inherited slots, invalid
  bytes, changed action fields and changed witness layouts reject. Optional CCC
  input caches are checked against isolated reviewed input snapshots: any supplied
  `cellOutput` or `outputData` must match exactly. Either cache may be absent
  (`undefined`), including after raw deserialization; `null` is not an absent cache.
- `assertFresh`: verifies explicit genesis and direct pool/xUDT dependency data
  hashes, re-reads every selected input, and rechecks pool state last. Call just
  before signing; freshness is not an atomic snapshot or an input reservation.
  Integrity is checked before and after RPC awaits. Pass a wallet-prepared copy
  as `assertFresh(client, options, candidate)` to check that exact transaction;
  only its designated 65-byte signature may differ.

Cached input metadata is advisory, not signed transaction data. Honest or absent
caches are supported; false capacity, lock, type or data caches reject before
and after freshness RPC awaits. Applications should derive displays from validated
inputs and transaction outputs, not arbitrary mutable result/summary objects.
Removing optional caches does not authenticate a replacement summary. These
checks do not sandbox arbitrary in-process code or reserve live cells.

Supply exact `PoolDeployment` genesis/code hashes and dependency OutPoints.
The xUDT Data1 binary is deliberately pinned to the vendored prototype fixture,
not inferred from a name, token ticker or network default. Pool and xUDT deps
must be direct `code` cells; wallet deps are explicit and may include dep groups.
Wallet lock/dependency correctness must be checked by the caller/signing wallet;
the local VM tests cover the bundled standard secp lock, not arbitrary wallets.

Every funding cell must belong to the one supplied wallet lock. Supported funding
is empty-data plain CKB, exact-profile xUDT, and that pool's LP token. No foreign
types, mixed signing groups, duplicate inputs or xUDT issuer-mode funding.
Builders use all supplied funding cells and return surplus assets to explicit
change locks. They do not search wallets, merge other signing groups, or support
JoyID/ACP/custom witness layouts. This is a 65-byte secp-compatible signing shape.

All CKB/Y/LP recipients, change lock, fee rate (shannons per 1,000 bytes), fee cap
(shannons), and positive operation minima are explicit. Token/LP receipt cells
receive occupied storage capacity from wallet funding. A CKB receipt smaller
than its occupied capacity is topped up from wallet funds and reported separately
as `ckbReceiptTopUp`; it is not extra pool proceeds. A separate plain CKB change
cell is mandatory. Insufficient storage, dust change or an excessive fee fails;
no dust is silently absorbed as fees. Permanent Bs/Bx/By backing is preserved.

Genesis uses first funding input + state output index 0 to derive pool ID. State,
X and Y outputs are indexes 0, 1 and 2. Normal inputs start with those exact three
pool cells, followed by wallet funding; the wallet witness index is therefore 3
(0 for creation). The action is outputType at witness 0 for genesis, inputType
at witness 0 otherwise. All input witness positions are present and dependencies
are deduplicated. Fee estimation includes the full 65-byte signature placeholder.

### Signature caveat

Standard secp signatures commit raw transaction fields, including recipients,
amounts and dependencies, and the wallet's signing-group witnesses. They **do not**
commit a different pool input group's action witness. Economically meaningful
action changes are checked by pool accounting; a nonbinding change to a minimum
or deposit budget can still validate against unchanged outputs. The SDK integrity
guard rejects even those changes before signing/export, but is not an on-chain
witness commitment. Do not claim that every action-byte mutation invalidates a
wallet signature. This milestone does not change the pool ABI or add an intent
authentication layer.

## Read-only CLI

Provide one JSON object on stdin; stdout is JSON, stderr is errors. Input is
limited to 1 MB. Use decimal **strings** for amounts to avoid JSON precision loss.

```sh
npm run --silent pools < request.json
```

Common fields (replace placeholders with explicit prototype deployment values):

```json
{
  "rpcUrl": "http://127.0.0.1:8114",
  "command": "scan",
  "deployment": {
    "genesisHash": "0x<32-byte-genesis-hash>",
    "codeHash": "0x<32-byte-pool-Data1-code-hash>",
    "poolDep": {"outPoint": {"txHash": "0x<hash>", "index": "0x0"}, "depType": "code"},
    "tokenDep": {"outPoint": {"txHash": "0x<hash>", "index": "0x0"}, "depType": "code"}
  },
  "scan": {"pageSize": 50, "maxPages": 20, "maxCandidates": 1000}
}
```

The endpoint must serve CKB node and indexer methods. It is the only endpoint
used: no public fallbacks or known-script lookups. CCC's testnet client decoders
borrow `poolReadTransport`; address/default-script helpers are not used.
The transport allows only `get_header_by_number`, `get_live_cell` and `get_cells`,
rejects redirects, HTTP failures and mismatched JSON-RPC envelopes, and limits
streamed responses to 4 MiB before JSON parsing, counting decompressed bytes.
Decimal amount strings are limited to 39 digits; live cell data to 1 MiB;
indexer cursors to 2,048 bytes of hex.
Discovery trusts the selected node's chain view; it is not a light-client proof.
Default RPC deadline is 15 seconds. SDK callers can pass `AbortSignal` and a
1–60,000 ms per-read deadline. Cancelled queued reads are not dispatched. SDK
deadlines stop awaiting a read; an injected third-party transport may continue
work. `poolReadTransport` additionally aborts fetch/body reads on its own deadline
or supplied signal. Use a bounded transport for pre-JSON limits: post-decoding
checks cannot bound an arbitrary injected transport's allocations.
Scans cap candidates (including duplicates), pages and page size;
nonprogressing cursors and transport failures fail explicitly. Malformed/stale
candidates are reported/skipped, not silently treated as validated pools. Bounded
scan absence does not prove there are no pools.

For `create` or `transition`, additionally supply:

```json
{
  "funding": [{"txHash": "0x<hash>", "index": "0x0"}],
  "wallet": {
    "lock": {"codeHash": "0x<hash>", "hashType": "data1", "args": "0x<args>"},
    "change": {"codeHash": "0x<hash>", "hashType": "data1", "args": "0x<args>"},
    "deps": [{"outPoint": {"txHash": "0x<hash>", "index": "0x0"}, "depType": "code"}],
    "feeRate": "1000", "maxFee": "10000"
  },
  "recipients": {"ckb": "<Script object>", "token": "<Script object>", "lp": "<Script object>"}
}
```

Replace each recipient placeholder with a full CCC Script object, even if the
operation does not issue that asset. For creation add:

```json
{"create": {"feeBps": "30", "lockedShares": "1000",
 "backing": {"state": "34000000000", "ckb": "8000000000", "token": "16000000000"},
 "x": "1000000000000", "y": "4000000000000", "minShares": "1",
 "tokenOwner": "0x<32-byte-xUDT-owner-lock-hash>"}}
```

For a transition add the exact current state OutPoint as `state` and one action:

```json
{"action": {"kind": "swap", "direction": "xToY", "amountIn": "10000000000", "minOut": "1"}}
{"action": {"kind": "deposit", "maxX": "10000000000", "maxY": "40000000000", "minShares": "1"}}
{"action": {"kind": "withdraw", "shares": "1000", "minX": "1", "minY": "1"}}
```

`yToX` is also supported. These are separate action examples, not one JSON file.
Returned transaction object uses CCC field names (not node RPC snake_case);
`transactionBytes` is the canonical Molecule serialization. Results include
accounting flows, fee, storage top-up and wallet witness index. The CLI runs
freshness/dependency checks before export. It never signs, invokes `send_transaction`,
deploys code or requests a wallet connection. It does not run a remote dry-run VM;
"dry-run" here means checked unsigned construction.

## Adversarial regression coverage

SDK tests cover cancellation before dispatch, mutation during asynchronous
freshness checks, prepared transaction copies, mutable RPC arguments/snapshots,
simulated reorg removal, malformed pages and resource limits. Local HTTP tests
exercise the real CLI and transport, including oversized/chunked bodies, response
IDs, redirects, writes, HTTP failures, timeouts and cancellation.

The VM bridge also runs 32 chained mixed operations using deterministic seeds
`0xc0ffee` and `0xdeadbeef` (16 each). Every successor spends the previous SDK
transaction's output OutPoints and uses real xUDT and public-fixture secp signing.
All four operation variants are required to appear. These tests run in the
existing SDK and pool VM CI gates; they are not exhaustive fuzzing or a security
audit. A coherent dishonest node can still fabricate its chain view, and a cell
can be spent/reorged after the last read. No input reservation or live-network
reorg safety guarantee is claimed.

The [resource report](../docs/research/POOL_RESOURCE_ENVELOPE.md) adds four
fee/reserve/share regimes with full withdrawal/re-entry (56 more steps; 88 total)
and combined 1/2/4-pool boundary measurements. Its test-only composer and resource
budgets are not a production batching API or target-node relay approval.

Before any live pool work: independent adversarial review, chosen-network token
profile/deployment approval, and a wallet integration with reviewed signing and
freshness UX are still required. Live contention/reorg behavior is not claimed
from the in-memory tests.
