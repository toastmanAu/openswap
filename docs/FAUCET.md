# Test-token faucet (testnet only)

Testers get testnet CKB from the [Nervos faucet](https://faucet.nervos.org). This faucet
gives them the app's test tokens: **250 TEST, 1,000 TEST2 and 500 TEST3** per account,
once per token while the account holds less than one claim. In the app: **Test tokens**
in the header, then **Claim with wallet**.

## How a claim works

A dedicated faucet wallet (secp256k1, `deployments/faucet.json`) holds stock cells of
each token. It holds nothing else and never pays CKB.

1. The app builds the claim (`buildFaucetClaim`, `sdk/src/faucet.ts`):
   - It picks one stock cell per token at random, so two claims rarely use the same one.
   - It returns the rest of each stock cell to the faucet with the same capacity.
   - It sends the grant to the claimant.
   - The claimant's own CKB pays for the new token cells (about 144 CKB each, which stays in the claimant's cell) and the fee.
2. The claimant's wallet signs first.
3. `POST /api/faucet` (`functions/api/faucet.ts`, a Cloudflare Pages Function) resolves the inputs from the testnet node and runs `checkFaucetClaim`. Only then does it add the faucet's signature and broadcast.

`checkFaucetClaim` accepts a claim only if all of these hold:

- **What the faucet gives:** it loses exactly one grant of each token it gives, and no CKB. Its outputs keep at least the capacity of its inputs.
- **Faucet outputs:** they are the configured tokens with plain 16-byte amounts, and there are no more of them than there were inputs (no splitting).
- **The claimant:** every other input is a plain CKB cell of one lock, the claimant's, and every other output goes to that lock.
- **Eligibility:** the claimant currently holds less than one grant of each token given.
- **Fee:** it is positive and at most 0.01 CKB.

The faucet signs with sighash-all, so it commits to exactly the checked transaction. The claimant's signature covers only the claimant's own witness, so the faucet can add its signature afterwards without invalidating it.

**Limits:**
- **Eligibility is stateless:** it is read from the chain at claim time. Someone with many accounts, or someone who moves tokens away, can claim again. They get only test tokens, and the stock is refilled by minting.
- **Concurrent claims:** two claims sent at the same moment by the same account can both pass the balance check.
- **Bot protection:** none, beyond the stock running out. If that becomes a problem, add a Cloudflare rate-limiting rule on `/api/faucet` (one rule is free) or Turnstile.

## Live record

- **Seeded:** `0x6f2458d0…032b`, fee 0.00006033 CKB, committed on both endpoints (`deployments/faucet-seed.json`). It holds 8 stock cells per token, enough for 200 claims each.
- **First claim:** the tester wallet claimed through the function, run locally under `wrangler pages dev` against testnet: `0x9a9c30d3…86cb`, block 23,036,597.
  - It received 250 TEST, 1,000 TEST2 and 500 TEST3 for a fee of 0.00001893 CKB, paid by the tester.
  - It was checked again on both endpoints, and the tester's balances rose by exactly the grants (`deployments/faucet-claims.json`).
  - The tester is now ineligible for further claims.

## Operate

```sh
npx tsx scripts/faucet-wallet.ts prepare          # keys in .local, writes deployments/faucet.json
npx tsx scripts/faucet-wallet.ts seed [--execute] # mint 8 stock cells per token (25 claims each)
npx tsx scripts/faucet-wallet.ts status [ckt1…]   # stock left, and what an address may claim
npx tsx scripts/faucet-wallet.ts claim <url>/api/faucet [--execute]  # end-to-end claim by the tester wallet
```

**Seeding:** one transaction mints the stock. Each issuer key signs, because xUDT owner mode needs an input of each issuer. The TEST issuer pays the stock cells' capacity (3,408 CKB) and funds the claim-tester wallet with 1,000 CKB.

**Refilling:** to refill a token, mint more stock cells to the faucet address with the same layout (plain amount, secp lock).

**Health:** `GET /api/faucet` reports whether the key is set and matches the published faucet lock.

**The key:**
- The faucet key is the Pages secret `FAUCET_KEY`. Set it with:
  ```sh
  npm exec --yes --package=wrangler@4.134.0 -- wrangler pages secret put FAUCET_KEY --project-name toastdex < .local/testnet-faucet-key
  ```
  It is never printed.
- For a local run with `wrangler pages dev frontend/dist`, put `FAUCET_KEY=…` in the ignored, owner-only `.dev.vars`.
- If the key leaks, the most anyone can take is the test-token stock and its cells' CKB. Rotate it with `prepare` on a new key file, then seed the new wallet again.
