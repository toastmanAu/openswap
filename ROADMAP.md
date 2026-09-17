# OpenSwap Roadmap

## v0.1

Immutable on-chain funded lots.

Provides:
- CKB/xUDT limit orders,
- permissionless fills,
- permissionless solvers,
- atomic batch settlement,
- orderbook,
- instant-swap router over lots.

## v0.2 — CoBuild OTX

Goal:
- off-chain signed orders,
- funds remain under normal user cells until settlement,
- stronger deadline mechanics,
- reduced CKB storage overhead,
- partial execution strategies.

Do not make v0.1 depend on OTX maturity.

## v0.3 — AMM adapters

Router can consume:
- OpenSwap lots,
- AMM cells,
- OTX orders.

AMMs are liquidity sources, not protocol authority.

## v0.4 — P2P order/solver gossip

Optional discovery acceleration without central server.

## v0.5 — Fiber / fast-path adapters

Explore:
- Fiber CKB,
- CCH / cross-network atomic liquidity,
- other channel-based execution paths.

Keep base CKB settlement independent.
