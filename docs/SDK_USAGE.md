# SDK and live wallet exercise

## Verify locally

```sh
npm ci
npm run typecheck
npm run test:sdk
npm run orders -- scan
npm run orders -- inspect <transaction-hash> <output-index>
```

Node 22 or newer is required. `CKB_RPC_URL` selects a testnet endpoint supporting
CKB RPC and indexer methods. Scanning and inspection check the genesis hash.
These CLI commands do not sign or broadcast transactions.

The workspace packages currently export TypeScript source. Import
`@openswap/sdk` and `@openswap/solver` through a TypeScript-aware application or
bundler. `createOrder`, `fillOrders` and `cancelOrders` return a completed
transaction and `assertLayout`; `submit` rechecks live inputs and requests a
signature through the supplied CCC signer. All amounts are bigint base units.

`defaultResolver(client)` supports native CKB and the chain's known canonical
xUDT script with exactly 16-byte amounts. Unknown token scripts and extension
profiles require an explicit `AssetResolver`; listing never requires protocol
registration. The parser can report unsupported orders for inspection, while
builders refuse them without a compatible resolver.

`ReferenceSolver` accepts the same builder context and an optional event callback.
Call `tick()` for a scan and unsigned build, or `tick(true)` to use the supplied
signer and broadcast. It refreshes live cells on each tick, tracks local pending
settlements, and bounds reciprocal/multi-lot search. Callers control scheduling
and retry after conflicts; the search does not promise an optimal bundle.
No hosted order API or privileged matcher is required.

## Live JoyID create/cancel

**Verified on testnet:** the supplied create/cancel pair committed and passed
independent checks through two RPC endpoints. See
[recorded evidence](../deployments/joyid-smoke-result.json). The instructions below
are for repeating the exercise; no repeat is needed for the recorded pair.

Recheck the recorded transactions without signing:

```sh
npx tsx scripts/record-joyid-smoke.ts 0xe014e0446d18075a389377883a32bc705650061761df6d34d05179a13f3399a5 0xc2e48f2635bb8e907aa39efbf39af2151f03a020200921b0552301f27f4251f9
```

Deployment is already committed. This exercise checks the deployed lock's
cancellation path using the replacement JoyID account ending `svl02uvq`.

1. Open https://live.ckbccc.com/, select **Testnet**, and connect that JoyID wallet.
2. Replace **all** editor contents with
   `deployments/joyid-create-cancel.playground.ts`.
3. Run the script. Confirm the console says
   `OPENSWAP JOYID CREATE/CANCEL TEST`.
4. At each `render` pause, inspect the transaction and use **Continue**.
5. Complete the **create** and then **cancel** wallet signature prompts.
6. Retain both `CREATE TX HASH` and `CANCEL TX HASH`. The final success message is
   `JOYID CREATE/CANCEL COMMITTED`.

The order offers one shannon for an unissued canonical xUDT. Creation temporarily
locks approximately **249.00000001 CKB**. Cancellation recovers the order capacity;
both transactions spend network fees (each capped at 1 CKB). The read-only live
create check estimated **0.00057707 CKB**; wallet preparation and chain fee rates
can change the final fee. No signature is produced by merely connecting a wallet.

If creation commits but cancellation is interrupted, set `resumeCreateTxHash`
in the Playground script to the printed create hash and run again. This resumes
cancellation without creating another order. If the order is already spent,
inspect its transaction history before retrying.

Regenerate the bundle after SDK or smoke-entry changes:

```sh
npm run build:smoke
```

Live signed fills, solver races and repeated integration remain outstanding.
Passing unit tests and this single cancellation exercise do not establish the
complete v0.1 release gate.

## Live two-lot fill exercise

**Verified on testnet:** the two-lot create/fill pair committed and passed
checks through both RPC endpoints. See
[recorded fill evidence](../deployments/fill-smoke-result.json).
No repeat is needed for this pair; the instructions below allow a fresh exercise.

Use `deployments/joyid-two-lot-fill.playground.ts` in CCC Playground on Testnet.
Replace all editor contents, connect the same JoyID wallet ending `svl02uvq`,
and check the banner says `OPENSWAP JOYID TWO-LOT FILL TEST`.

There are three wallet signatures, with a render/Continue pause before each:

1. Mint 1,000 base units of a canonical xUDT owned by this wallet.
2. Create two independent CKB orders offering 1 and 2 shannons for 1 and 2 tokens.
3. Fill both orders together; maker payments must occupy outputs 0 and 1.

Retain `MINT TX HASH`, `FILL CREATE TX HASH`, and `FILL TX HASH`. The last message
is `JOYID TWO-LOT FILL COMMITTED`. To resume, set `resumeMintTxHash` and/or
`resumeCreateTxHash` in the script to the hashes already printed. Setting the
create hash skips both minting and order creation. Do not rerun a completed pair.

Mint storage is 144 CKB; the two order capacities total 498.00000003 CKB. After
settlement, roughly 642 CKB remains in wallet-owned token cells (two maker
payments plus token change); it is not automatically consolidated into plain
CKB. Network fees are spent, with a 1 CKB cap per transaction. No storage is
permanently committed by this exercise.

This is a self-fill integration check: the same JoyID account owns the orders,
funds the taker, and issues the token. It verifies OpenSwap settlement layout but
does not establish independent-taker behavior or xUDT non-owner enforcement.
Real xUDT conservation is also checked in the local CKB-VM suite; a distinct
live taker and reciprocal live solver settlement remain future integration steps.

Verify the resulting hashes without signing:

```sh
npx tsx scripts/record-fill-smoke.ts <fill-create-hash> <fill-hash>
```

## Separate secp solver and non-owner xUDT exercise

**Verified:** setup, secp creation/cancellation, reciprocal creation and solver
settlement committed. Both RPC endpoints confirmed owner-proof cancellation,
indexed payments, spent lots and conservation without an issuer input. See
[verification evidence](../deployments/solver-integration-verification.json).
Total scenario fees: 0.00182558 CKB. Do not repeat the setup for this completed
scenario; the commands below document reproduction and verification.

The public solver address is in `deployments/solver-wallet.json`. The generated
private key stays in `.local/testnet-solver-key`, excluded from Git and restricted
to the local account. Do not delete it while that wallet holds testnet funds.
Never use this integration wallet for mainnet assets.

In Playground, replace all code with `deployments/joyid-solver-setup.playground.ts`.
Select Testnet and connect JoyID ending `svl02uvq`. The banner must say
`OPENSWAP SEPARATE SOLVER SETUP`. Review the transaction, Continue, and sign once.
Retain `SOLVER SETUP TX HASH`.

The setup transfers **2,142 CKB and 100 existing token units** to the local solver:
2,000 CKB plain funding plus a 142 CKB token cell. It also creates a JoyID-owned
one-shannon lot with 249.00000001 CKB capacity. Remaining token and CKB change
returns to JoyID. No new tokens are minted. The network fee is capped at 1 CKB;
read-only completion estimated 0.00080963 CKB.

After setup commits:

```sh
# Read-only setup checks:
npx tsx scripts/run-solver-integration.ts <setup-hash>
# Sign only with the local testnet key; capped fees and restricted fixture orders:
npx tsx scripts/run-solver-integration.ts <setup-hash> --execute
# Verify all results independently through two RPC endpoints:
npx tsx scripts/verify-solver-integration.ts
```

The execution creates and cancels a secp order, creates a reciprocal token lot,
then scans and settles the reciprocal pair using `ReferenceSolver`. The fill
must contain no token-issuer JoyID input, so xUDT's non-owner transfer path is
exercised. Maker and solver use different locks. This tests distinct wallets
but does not claim unrelated human operators or live solver-race coverage.

Transaction hashes are journaled in `deployments/solver-integration-result.json`.
Rerunning resumes recorded steps; an indexer lag can require another run.
Do not delete the journal to retry. If interrupted immediately after broadcast
before its hash was saved, inspect chain history before repeating a step.
The local solver retains its unspent capacity, token change and recovered cells;
this scenario does not automatically return them to JoyID.

The generic solver's optional `acceptOrder` filter restricts a local strategy;
it introduces no consensus permission or registration requirement. Other solvers
can fill these publicly visible orders first. In that case, stop and inspect the
spent outpoints before preparing a replacement scenario.
