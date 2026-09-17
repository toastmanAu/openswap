# Frozen Design Decisions

This file exists so an agent does not accidentally re-open already-settled architecture questions.

## Chosen

- independent order cells
- no singleton/global DEX state
- no sequencer
- no mandatory API
- `data1` immutable contract reference
- full owner Script embedded
- full requested UDT type Script embedded
- absolute input index -> same output index payment binding
- full-fill lots only
- partial UX via multiple lots
- explicit `capacity_refund`
- exact refund capacity for UDT asks
- separate plain-CKB owner decrease proof for cancellation
- malformed-tail rescue path
- no expiry v0.1
- protocol fee 0
- solver spread allowed
- reference SDK: canonical xUDT + CKB
- custom UDT through adapter
- direct chain/indexer order discovery
- OutPoint canonical order ID

## Rejected for v0.1

- mutable partial-fill order
- global entity cell
- master-cell order lineage
- header-dep expiry
- `since` as expiry
- centralized sequencer
- best-execution oracle
- protocol treasury
- mandatory token registry
- hardcoded JoyID in contract
- AMM as protocol core
- Fiber as protocol core
- OTX as hard dependency

## Why full-fill lots won

Mutable partial fill caused:
- output discovery complexity for lock scripts,
- remainder-state complexity,
- repeated maker payment-cell capacity subsidy,
- more consensus arithmetic,
- more state transitions,
- larger attack surface.

Independent terminal lots fit CKB's cell model better and leave OTX/partial execution for a later version.
