# Root Coding-Agent Prompt

You are implementing **OpenSwap v0.1**, a permissionless DEX primitive for Nervos CKB.

Do not redesign the protocol unless you find a concrete correctness or security flaw. The handoff files in this package define the intended behaviour.

## Primary goal

Build a clean-room, open-source implementation of OpenSwap v0.1 with:

- a Rust CKB lock contract,
- exhaustive `ckb-testtool` tests,
- a TypeScript/CCC SDK,
- direct chain scanning through the CKB indexer,
- create/fill/cancel transaction builders,
- a reference permissionless solver,
- a minimal testnet orderbook frontend after the protocol core is stable.

## Consensus invariant

The core invariant is:

```text
ONE CELL
ONE LOT
ONE FILL
ONE MAKER PAYMENT
```

For every OpenSwap order input at absolute transaction index `i`:

```text
Input[i]  = OpenSwap order
Output[i] = maker payment
```

unless the transaction is an owner-authorized cancellation.

## Non-negotiable protocol properties

Do not introduce:

- a centralized sequencer,
- a mandatory hosted API,
- a privileged matcher,
- a protocol admin key,
- an upgrade key controlling existing orders,
- a global mutable DEX entity/state cell,
- a protocol treasury,
- mandatory registration to list tokens,
- mandatory registration to run a solver,
- mutable partial-fill order state in v0.1,
- hard on-chain expiry in v0.1.

## v0.1 supported reference assets

Reference implementation:
- native CKB,
- canonical xUDT profile with exactly 16-byte LE `u128` amount data.

Consensus code should not hardcode one xUDT type hash, but the reference SDK/solver should support known canonical xUDT and treat unknown UDT-like scripts as requiring an `AssetResolver`.

## Required implementation order

Do not start with the frontend.

1. Scaffold repository.
2. Pin Rust dependencies.
3. Implement bounded syscall helpers.
4. Implement args parser.
5. Implement single-group-input invariant.
6. Implement absolute input-index resolution.
7. Implement owner cancellation / rescue path.
8. Implement CKB offer extraction.
9. Implement 16-byte UDT offer extraction.
10. Implement UDT ask settlement.
11. Implement CKB ask settlement.
12. Implement recreated-order rejection.
13. Complete adversarial `ckb-testtool` tests.
14. Add real xUDT integration tests.
15. Record cycle counts and binary size.
16. Add reproducible binary hash process.
17. Deploy to CKB testnet.
18. Implement TypeScript wire codec + golden vectors.
19. Implement `AssetResolver`.
20. Implement capacity estimator and lot planner.
21. Implement live-cell scanner / parser.
22. Implement create/cancel/fill builders.
23. Implement direct reciprocal matcher.
24. Implement bounded multi-lot solver.
25. Add CLI inspection/scan tools.
26. Build orderbook frontend.
27. Add JoyID/CCC integration.
28. Add instant-swap router.
29. Add custom RPC/indexer controls.
30. Perform adversarial integration tests.

## Coding rules

- Prefer bounded raw syscalls where attacker-controlled size is involved.
- Avoid `ckb_std::high_level::load_cell_data()` on untrusted cells.
- Avoid `QueryIter` in critical paths where unexpected syscall errors could panic.
- No floating point in consensus.
- No U256 is required by v0.1 consensus.
- Every custom consensus error code must be explicitly assigned and stable.
- No attacker-controlled malformed-order path should panic.
- Use `hash_type = data1` for the production contract.
- Tests must explicitly use `Data1` too.
- Use current CCC public APIs, not remembered signatures.
- Before coding CCC integration, inspect the current CCC docs/agent guidance and repository.

## Clean-room rule

OpenSwap should be implemented from this specification.

Do not copy implementation code from Nervina SDL because its licensing is unclear. LSDL may be used as behavioural reference only.

## Definition of done for v0.1 core

Core is done only when:

- all positive tests pass,
- all adversarial tests pass,
- oversized/malformed data tests pass without OOM,
- real xUDT tests pass,
- JoyID cancellation flow works,
- secp cancellation flow works,
- ACP-style non-owner cancellation regression fails correctly,
- cycle counts are documented,
- binary build is reproducible,
- testnet deployment is repeatable.
