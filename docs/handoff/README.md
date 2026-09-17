# OpenSwap v0.1 — Agent Handoff

OpenSwap is a proposed permissionless, open-source DEX primitive for Nervos CKB / CKB-resident RGB++ assets.

This package is intended to be handed directly to a capable coding agent. It contains the frozen v0.1 design, implementation order, Rust contract skeleton, wire format, security assumptions, test plan, TypeScript SDK plan, reference solver design, deployment requirements, and source references.

## Core idea

OpenSwap v0.1 deliberately uses a very small primitive:

> **ONE CELL · ONE LOT · ONE FILL · ONE MAKER PAYMENT**

Each order is an immutable CKB cell protected by `OpenSwapLock`.

An order can only:

- be filled once, or
- be cancelled by its owner.

There is no:
- sequencer,
- mandatory backend,
- canonical matcher,
- global mutable DEX state,
- admin key,
- protocol treasury,
- mutable partial-fill order,
- hard expiry in v0.1.

Partial-order UX is implemented by creating multiple independently fillable lots.

## Start here

A coding agent should read in this order:

1. `AGENT_PROMPT.md`
2. `PROTOCOL.md`
3. `WIRE_FORMAT.md`
4. `CONTRACT_IMPLEMENTATION.md`
5. `SECURITY.md`
6. `TEST_PLAN.md`
7. `SDK.md`
8. `SOLVER.md`
9. `DEPLOYMENT.md`
10. `TASKS.md`
11. `SOURCES.md`

## Expected repository target

```text
openswap/
├── Cargo.toml
├── Makefile
├── README.md
├── LICENSE
├── contracts/
│   └── openswap-lock/
├── tests/
│   ├── src/
│   └── vectors/
├── sdk/
│   ├── package.json
│   └── src/
├── solver/
│   ├── package.json
│   └── src/
├── frontend/
├── scripts/
│   ├── deploy-testnet.*
│   ├── inspect-order.*
│   └── scan-orders.*
└── docs/
    ├── PROTOCOL.md
    ├── WIRE_FORMAT.md
    ├── SECURITY.md
    ├── SDK.md
    ├── SOLVER.md
    ├── TEST_PLAN.md
    └── DEPLOYMENT.md
```

## Status

Architecture is considered frozen enough to begin implementation.

Any change to consensus behaviour should be treated as a protocol change, not a convenience refactor.
