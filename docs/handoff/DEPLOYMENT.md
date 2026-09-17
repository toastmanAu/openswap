# OpenSwap v0.1 Deployment & Reproducibility

## Contract deployment

Use:

```text
hash_type = data1
```

Production code hash:

```text
data hash of exact openswap-lock binary
```

No admin/upgrade key.

A future contract version uses another code hash.

---

## Reproducible build

Document:
- Rust toolchain version,
- target,
- linker/toolchain,
- Cargo.lock,
- ckb-std version,
- build command,
- binary SHA256,
- CKB data hash,
- file size.

Provide:

```text
scripts/build-reproducible.sh
scripts/hash-contract.sh
```

Expected output should include:

```text
openswap-lock SHA256
openswap-lock CKB data hash
binary bytes
```

At least two clean environments should reproduce the same binary before mainnet.

---

## Testnet deployment

Provide:
- deployment tx hash,
- output index,
- code cell OutPoint,
- data hash,
- contract Script template,
- network genesis/hash identifier where useful.

Machine-readable:

```json
{
  "network": "testnet",
  "codeHash": "0x...",
  "hashType": "data1",
  "cellDep": {
    "outPoint": {
      "txHash": "0x...",
      "index": "0x0"
    },
    "depType": "code"
  },
  "binarySha256": "..."
}
```

Store as:

```text
deployments/testnet.json
```

Do the same later for mainnet.

---

## Node/indexer

Reference frontend and solver should support:
- public default CKB endpoint,
- user-supplied custom endpoint.

Basic trading must not require OpenSwap infrastructure.

---

## UI network safety

Mainnet and testnet must be visually unmistakable.

Do not silently reuse an order/quote between networks.

---

## Testnet soak

Before mainnet:
- sustained order creation,
- repeated fills,
- repeated cancel batches,
- multiple competing solvers,
- stale order races,
- malformed cell spam,
- large live order set,
- custom node test,
- frontend rebuilt from chain only,
- solver restarted with no local DB and fully recovered.
