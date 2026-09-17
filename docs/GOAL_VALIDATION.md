# Frontend, router and integration milestone validation

This report covers the requested next milestones, not a mainnet release or an
exhaustive audit of OpenSwap. Contract consensus code and the deployed Data1
binary were not changed by this milestone.

| Requirement | Implementation | Evidence |
|---|---|---|
| Minimal testnet orderbook | `frontend/src/main.ts`, `frontend/index.html` | Live empty-book browser check; synthetic 120-lot book, exact ordering and pagination check |
| CCC/JoyID | Pinned connector 2.2.2, testnet client and public connection events | JoyID selector opens/closes; existing real JoyID create/cancel and fill evidence; frontend live signing exercised with secp through the same review/submit path |
| Direct chain scanning | `sdk/src/indexer.ts` uses CCC `findCellsOnChain` with Data1 prefix | Live scans, malformed-cell and speculative-cache exclusion tests |
| Custom RPC/indexer | Independent URL fields, genesis and indexer-tip/header checks | Mismatched-indexer rejection; successful endpoint switching disconnects wallet and invalidates review |
| Create/fill/cancel | Existing SDK builders and explicit transaction review | `deployments/frontend-live-verification.json`: four UI-originated transactions independently checked on two nodes |
| Full-lot swap router | `sdk/src/quote.ts`, `sdk/src/tx/swap.ts` | Budget, overfill, integer precision, bounded tail improvement, stale/altered quote and funded-output tests; live UI routed swap |
| Indexed maker payments | Builder assertions retained through signing | Both-node verification of exact output index/payment and token conservation for UI swap and race winners |
| Broader adversarial integration | Scanner, quote, pending-cache, review and endpoint regressions | 55 SDK/solver tests; four browser tests; `frontend-review-verification.json` proves zero signing requests after account/endpoint changes |
| Competing-solver race | `scripts/run-race-soak.ts` | Two different fee wallets and disjoint funding; both candidates submitted via different nodes; exactly one committed winner per round, verified on both nodes |
| Bounded soak | Three resumable create/pair/race/verify/rescan rounds | `deployments/race-soak-result.json`; all three rounds complete, six orders consumed |
| Reproducible local app build | Pinned npm graph, esbuild build, workspace type-check | `npm run typecheck`, `npm run build:frontend`, `npm run test:sdk`, `npm run test:frontend` pass |
| Wallet steps prepared | `docs/FRONTEND.md` | Concrete JoyID UI acceptance recipe; no secrets requested or bundled |

## Concrete defects found and fixed

1. The connector overlay intercepted the wallet close button. The close control
   now remains reachable; the regression test exercises it.
2. A losing broadcast left speculative change in CCC's client cache, making the
   next build select an input that never committed. Submission stopped safely.
   `recoverConflictedTransaction` now invalidates losing outputs and restores
   only inputs reported live with pool state included. Pending status is read
   without cached `sent` fallback. Subsequent live rounds passed in one process.
3. General CCC cell collection can include speculative/stale cached orders.
   Public orderbook scanning now uses the public chain-only iterator. This is a
   deliberate SDK refinement of the handoff's generic `findCells` suggestion;
   it preserves the protocol and prevents phantom orders in a refreshed book.
4. Wallet and endpoint changes invalidate prepared reviews. Stale attempts were
   tested with signing disabled and produced zero signature requests.
5. The UI disables conflicting actions while signing/confirming, and preserves
   the submitted hash in error messages if confirmation or refresh fails.

## Scope and limitations

- The race/soak is **three rounds**, not hours or days of endurance testing. It
  includes a restart after the first round exposed the cache defect. The fixed
  process then completed the remaining rounds with recovery between them.
- Browser wallet execution used a local secp test key held in Node, with only its
  public key exposed to the isolated browser. Four signatures were permitted,
  all destinations were restricted to the test wallet or its one-shannon orders,
  and the fee cap was 0.01 CKB per transaction. No production test hook or secret
  was added to the frontend bundle.
- JoyID passkey signing was previously validated live through CCC Playground.
  Its new frontend selector and integration are tested, but a human completing
  a passkey prompt from this frontend is a separate acceptance check. A concrete
  recipe is provided; the agent cannot perform a user's passkey interaction.
- The app runs locally. Public hosting, mainnet operation, independent-machine
  contract reproducibility, extended fuzzing and external audit are not claimed.
- Both solver wallets retain their unspent testnet funds under ignored local
  key files. Do not delete `.local` while those wallets hold funds.
