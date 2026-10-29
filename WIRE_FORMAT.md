# OpenSwap v0.1 Wire Format

## Lock args

```text
OpenSwapArgsV1 =
    owner_lock: Molecule Script
    +
    tail
```

The leading owner Script is a canonical CKB Molecule `Script`.

Its first 4 bytes encode its Molecule total size.

## Tail

Offsets are relative to `owner_lock.end`.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | version |
| 1 | 1 | flags |
| 2 | 2 | reserved |
| 4 | 16 | nonce |
| 20 | 8 | capacity_refund |
| 28 | 4 | ask_script_size |
| 32 | N | ask_type_script |
| 32+N | 16 | ask_amount |

Encoding:

```text
version          u8
flags            u8
reserved         u16 LE
nonce            [u8;16]
capacity_refund  u64 LE
ask_script_size  u32 LE
ask_type_script  N bytes Molecule Script
ask_amount       u128 LE
```

Fixed tail bytes excluding ask Script:

```text
48 bytes
```

## v1 constraints

```text
version = 1
flags = 0
reserved = 0
nonce != 0x00000000000000000000000000000000
ask_amount > 0
```

Limits:

```text
MAX_RUNNING_SCRIPT_BYTES = 4096
MAX_OWNER_SCRIPT_BYTES   = 1024
MAX_ASK_SCRIPT_BYTES     = 1024
```

## Ask asset

```text
ask_script_size == 0
=> ask asset = native CKB
```

Otherwise:

```text
args[ask_start..ask_end]
```

must decode as a complete canonical Molecule `Script`.

## Exact total length

Let:

```text
O = owner_script_size
A = ask_script_size
```

Then:

```text
args.len() == O + 48 + A
```

No trailing bytes.

## Order ID

Canonical order ID is the order cell OutPoint.

The nonce prevents accidental identical lock grouping but is not the identifier.

## Golden vectors

The implementation should include JSON golden vectors shared between Rust and TypeScript.

Recommended structure:

```json
{
  "name": "udt_to_ckb_basic",
  "ownerScriptHex": "0x...",
  "nonceHex": "0x...",
  "capacityRefund": "25000000000",
  "askScriptHex": null,
  "askAmount": "50000000000",
  "expectedArgsHex": "0x..."
}
```

Required vector classes:
- CKB ask,
- UDT ask,
- zero nonce,
- unsupported version,
- non-zero flags,
- non-zero reserved,
- malformed owner Script,
- oversized owner Script,
- malformed ask Script,
- oversized ask Script,
- zero ask amount,
- trailing garbage.

---

## Version 2 (order lock v2, not deployed)

Separate binary (`contracts/openswap-lock-v2`, new `data1` code hash) that accepts
only version 2 tails. Design and spend rules: [ORDER_LOCK_V2](docs/research/ORDER_LOCK_V2.md).

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | version = 2 |
| 1 | 1 | flags = 0 |
| 2 | 2 | reserved = 0 |
| 4 | 16 | nonce (non-zero) |
| 20 | 8 | capacity_refund u64 LE (CKB offer: payment cell capacity; UDT offer: 0) |
| 28 | 8 | expiry u64 LE (0, or absolute timestamp `since`: top byte 0x40, value > 0) |
| 36 | 4 | ask_script_size u32 LE |
| 40 | N | ask_type_script |
| 40+N | 16 | ask_amount u128 LE (> 0) |
| 56+N | 16 | offer_amount u128 LE (> 0) |
| 72+N | 16 | min_fill u128 LE (1..=offer_amount) |

`args.len() == O + 88 + A`. Shared vectors: `lock-v2-tests/vectors/wire.json`
(codec) and `fill.json` (fill verdicts from `sdk/src/v2/model.ts`, run against the
binary). Regenerate with `npx tsx scripts/generate-lock-v2-vectors.ts`.

New error codes: 35 zero offer amount, 36 invalid min fill, 37 invalid expiry,
62 expiry not reached, 70 duplicate remainder, 71 remainder type, 72 remainder
data, 73 remainder capacity above input, 74 nothing filled, 75 fill below minimum,
76 remainder below minimum. v1 codes keep their meaning.
