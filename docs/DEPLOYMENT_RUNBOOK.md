# Testnet deployment

## Current deployment

Committed transaction: `0x070bdab0b200bb12faca14662c2c7ebbaeaecf51b1da05170e4d5de5c4dc3fca`, output 0.
Code bytes and live immutable storage were verified through both testnet.ckb.dev
and testnet.ckbapp.dev. Use `deployments/testnet.json` for the dependency.
The earlier unsigned deployment files are historical preparation artifacts;
use the following process only when preparing a new deployment.

Next: [live JoyID cancellation exercise](SDK_USAGE.md).

## Build the candidate

```sh
make test
make check
./scripts/check-reproducible.sh
make hash
npm ci
```

The measured candidate must match `docs/binary-identity.json`. Preparation fails
if its SHA256 or CKB data hash differs. Revalidate changed contract bytes before
updating that report.

## Prepare with the funding address

```sh
npm run deploy:prepare -- <ckt1-funding-address>
npm run deploy:check
```

Set `CKB_RPC_URL` to use another testnet endpoint. Both preparation and recording
check the chain genesis hash, not merely the address prefix.

Preparation creates:

- `deployments/testnet-candidate.json`: cost, binary identity, unsigned tx hash.
- `deployments/testnet-unsigned.json`: CCC transaction JSON, no valid signatures.
- `deployments/deploy-testnet.playground.ts`: self-contained wallet signing code.

The code output has no type and a zero-code-hash Data1 lock. Its testnet capacity
is permanently committed to code availability. Existing orders reference the
binary **data hash**, never a type ID or mutable deployment identity.

Current candidate: 28,592-byte binary; 28,633 CKB code-cell capacity. The replacement
JoyID funding address ends in `svl02uvq`. The current candidate uses one
100,000 CKB plain cell, returning change to that exact wallet. Fee is estimated using a 1000-byte
JoyID witness placeholder; real wallet/subkey preparation may change it. The
signing handoff enforces a maximum 1 CKB network fee.

## Review and sign using JoyID

1. Open [CCC Playground](https://live.ckbccc.com/) and select **Testnet**.
2. Connect the supplied JoyID funding wallet.
3. Paste the complete `deployments/deploy-testnet.playground.ts` into the editor.
4. Use Step to inspect outputs, funding, fee and change; Run requests the wallet
   signature and broadcasts only after wallet authorization.
5. Complete JoyID's passkey prompt and retain the printed deployment tx hash.

The generated script checks the exact funding wallet, chain genesis, binary hash,
immutable code lock, change destination and fee cap, and rechecks live funding
inputs before signing. If a funding cell is spent, regenerate the candidate.

The passkey interaction must be performed by the wallet owner. The generated script has
been executed against live chain data through its final signing boundary using
a read-only signer; no signature or broadcast occurs in that check. The current deployment has since been signed by the user and committed.
Future deployments require their own wallet signature.

## Record and verify the live deployment

```sh
npm run deploy:record -- <committed-deployment-tx-hash>
```

The recorder checks committed status, loads output zero as a live cell, verifies
its bytes against the measured code hash and validates its immutable lock before
writing `deployments/testnet.json`. Run it again using another `CKB_RPC_URL` for
fresh-node verification.

Then perform live create/fill/cancel integration, including JoyID cancellation.
Do not call the v0.1 core complete until the handoff's remaining gates pass.

## Reproducibility scope

The two-clean-build comparison uses independent target directories on one host.
It is not evidence of two independent machines reproducing the binary. Pin the
same Rust toolchain, dependency lock, build flags and source on another machine
before publishing a mainnet candidate.
