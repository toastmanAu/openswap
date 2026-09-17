# Research Sources / References

This is a source map for the coding agent. Re-check current APIs before implementation.

## CKB / ckb-std

- https://github.com/nervosnetwork/ckb-std
  - high-level syscall helpers
  - `load_input_out_point`
  - `load_cell_occupied_capacity`
  - `load_cell_lock_hash`
  - `load_cell_type_hash`
  - raw `syscalls::load_script`
  - raw `syscalls::load_cell_data`
  - current baseline researched: ckb-std 1.1.0

- https://github.com/nervosnetwork/ckb
  - script grouping implementation
  - lock groups collect input indices
  - type groups collect output indices
  - verifier behaviour

- https://github.com/nervosnetwork/rfcs
  - transaction structure / script groups
  - Anyone Can Pay RFC
  - xUDT / extensible UDT RFCs

## ckb-testtool

- https://github.com/nervosnetwork/ckb-testtool
  - current baseline researched: 1.1.1
  - deterministic Context
  - `deploy_cell`
  - `build_script_with_hash_type`
  - `create_cell`
  - `complete_tx`
  - `verify_tx`

Important:
- use `ScriptHashType::Data1` explicitly for OpenSwap tests.

## CCC

- https://github.com/ckb-devrel/ccc
- https://docs.ckbccc.com/

Relevant current concepts:
- `ccc.Script` is Molecule-encoded and exposes `toBytes()` / `fromBytes()`
- `ccc.numLeToBytes()`
- `ccc.CellOutput.from(..., outputData)` minimum-capacity calculation
- `client.findCells()`
- script search modes: prefix/exact/partial
- `KnownScript.XUdt`
- transaction addInput/addOutput/completion helpers

Agent guidance may be available at:
- https://docs.ckbccc.com/skill.md
- https://docs.ckbccc.com/llms.txt

Always re-check the current exact API before coding.

## RGB++

- https://github.com/ckb-cell
- https://github.com/ckb-cell/rgbpp-sdk
- current RGB++ docs / SDKs

v0.1 assumption:
- Bitcoin-side RGB++ assets leap to CKB first,
- DEX operates on CKB-resident xUDT representation.

## UTXOSwap

- https://github.com/UTXOSwap/utxoswap-sdk-js

Useful findings:
- MIT SDK,
- constant-product AMM math,
- intent model,
- client-side transaction construction,
- centralized backend/sequencer dependency in public SDK paths,
- no fully open production sequencer/backend stack found during research.

Do not inherit centralized sequencer architecture.

## Open Transaction / CoBuild

- Nervos Talk: CKB Open Transaction (OTX) CoBuild Protocol Overview
- Nervos Talk: An Orderbook DEX Design Using Cobuild OTX
- CKB issue/discussion threads around Open Transaction
- `cobuild-otx-contracts` reference/testbed

Use as future v0.2 direction, not v0.1 dependency.

## iCKB Limit Order

- https://github.com/ickb/contracts

Useful:
- checked wide arithmetic patterns,
- partial matching concepts,
- adversarial audits,
- orderbook contract design lessons.

Do not reuse master-cell lineage pattern.

## User projects

### LSDL
- https://github.com/toastmanAu/ckb-lsdl

Useful lessons:
- self-contained owner Script encoding,
- owner cancellation,
- cell-market lock patterns.

Identified issues to avoid:
- identical-lock group bug,
- broken header-dep expiry logic,
- epoch decoding issue,
- hardcoded secp assumptions,
- licensing ancestry concern due Nervina SDL.

### CellSwap / marketplace
- https://github.com/toastmanAu/ckb-cell-marketplace

Useful frontend architecture:
- React/Vite/TypeScript,
- CCC/JoyID,
- direct indexer use,
- static hosting,
- client-side transaction construction.

## Nervina SDL

- https://github.com/nervina-labs/ckb-dex-contract

Reference only.

Licensing was unclear during research; do not copy implementation code into OpenSwap unless rights are independently confirmed.

## Spectrum / ErgoDEX

Conceptual eUTXO reference:
- permissionless executors,
- on-chain validation,
- off-chain order discovery/execution.

No code reuse required.
