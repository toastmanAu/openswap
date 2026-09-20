# Pool accounting reference model

**Research only. Not a CKB contract, SDK pool builder or deployed product feature.**

[Draft transition specification](../docs/research/POOL_TRANSITIONS.md) defines the
CKB/xUDT prototype. The model is isolated from the current order SDK and frontend.
No new dependency is required; it runs with the repository's pinned TypeScript tools.

```sh
npm run test:pool-model
npm run demo:pool-model
```

The demo prints integer amounts as strings. Fee = 30 basis points and virtual
locked shares = 1000 are explicit demonstration values, not production defaults.
Backing amounts are illustrative; actual occupied capacity awaits a wire layout.

The deposit rule first chooses mintable shares, then rounds each required asset
contribution **up**. Withdrawal receipts round **down**. Every share-supply change
must eventually be enforced by a new on-chain LP type tied to a new pool validator.
M virtual shares are never issued. Complete circulating withdrawal leaves a
permanent pool and its storage backing; this cost must be disclosed to creators.

Tests check accounting only. Authentic state/reserve OutPoints, role-script
binding, token/LP mint authority, signatures and real capacity are separate
requirements for the future contract implementation and review.
