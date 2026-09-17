# OpenSwap v0.1 Contract Implementation

## Dependency baseline

Start from current stable CKB Rust line used at implementation time.

The researched baseline was:

```toml
[package]
name = "openswap-lock"
version = "0.1.0"
edition = "2024"

[dependencies]
ckb-std = "=1.1.0"

[profile.release]
overflow-checks = true
opt-level = "s"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

Tests researched against:

```text
ckb-testtool 1.1.1
```

If newer versions are used, pin them and document why.

---

## Modules

```text
contracts/openswap-lock/src/
├── main.rs
├── entry.rs
├── error.rs
├── args.rs
├── asset.rs
├── cancel.rs
├── settle.rs
└── sys.rs
```

---

## Error codes

Freeze explicit values.

```rust
#[repr(i8)]
pub enum Error {
    IndexOutOfBound = 1,
    ItemMissing = 2,
    LengthNotEnough = 3,
    Encoding = 4,

    ScriptTooLarge = 20,
    ArgsTooShort = 21,
    OwnerScriptTooLarge = 22,
    OwnerScriptInvalid = 23,
    AskScriptTooLarge = 24,
    AskScriptInvalid = 25,
    ArgsLengthInvalid = 26,
    UnsupportedVersion = 27,
    UnsupportedFlags = 28,
    ReservedNonZero = 29,

    NonceZero = 30,
    AskAmountZero = 31,
    SelfOwnerLock = 32,
    InvalidGroupInputCount = 33,
    InputIndexNotFound = 34,

    OfferDataInvalid = 40,
    OfferAmountZero = 41,
    CapacityRefundInvalid = 42,
    SameAsset = 43,

    OrderRecreated = 50,
    PaymentOutputMissing = 51,
    PaymentOwnerMismatch = 52,
    AskAssetMismatch = 53,
    AskDataInvalid = 54,
    AskAmountInsufficient = 55,
    PaymentCapacityInvalid = 56,
    CkbAskUnrepresentable = 57,

    CancelRecoveryInvalid = 60,
    CancelProofMissing = 61,
}
```

Never renumber published consensus errors casually.

---

## Main flow

```rust
pub fn main() -> Result<(), Error> {
    let running = load_running_script_bounded()?;

    let group_out_point = require_single_group_input()?;
    let order_index = locate_input(&group_out_point)?;

    let args = running.args();

    let owner = parse_owner_prefix(args)?;

    let owner_hash = hash(owner.script);
    let running_hash = load_script_hash()?;

    if owner_hash == running_hash {
        return Err(Error::SelfOwnerLock);
    }

    if is_recovery_output(order_index, &owner_hash)? {
        return validate_cancel(order_index, &owner_hash);
    }

    let terms = parse_terms(args, owner)?;

    validate_settlement(
        order_index,
        &running_hash,
        &terms,
    )
}
```

Cancellation deliberately occurs before full-tail validation.

---

## Bounded parsing

Avoid dynamic allocation on hostile sizes.

Do not use `high_level::load_cell_data()` on untrusted order/payment cells.

Use raw fixed-buffer syscalls.

### Running Script

Use a fixed buffer:

```rust
const MAX_RUNNING_SCRIPT_BYTES: usize = 4096;
```

Call `syscalls::load_script()`.

If it returns `LengthNotEnough`, return `ScriptTooLarge`.

### UDT data

Exactly 16 bytes:

```rust
fn load_u128_data(
    index: usize,
    source: Source
) -> Result<u128, Error>
```

Use `[u8; 16]`.

Reject:
- 0 bytes,
- 1..15 bytes,
- 17+ bytes,
- `LengthNotEnough`.

### Empty data

Use a 1-byte probe to distinguish empty from non-empty.

---

## Single group input

Because identical lock scripts execute once per lock group:

```rust
load_input_out_point(0, Source::GroupInput)
```

must succeed and:

```rust
load_input_out_point(1, Source::GroupInput)
```

must return `IndexOutOfBound`.

This blocks grouped double-spend/underpayment bugs.

---

## Absolute order index

Load the unique GroupInput OutPoint, then scan global transaction inputs until a matching OutPoint is found.

Do not use `QueryIter` in this critical path; use an explicit loop and deterministic error handling.

---

## Offer extraction

### CKB

Requirements:

```text
type == None
data == empty
capacity_refund >= occupied_capacity
capacity_refund < input.capacity
```

Then:

```text
offer_amount = input.capacity - capacity_refund
```

### UDT

Requirements:

```text
type != None
data.len == 16
u128(data) > 0
capacity_refund == input.capacity
```

Offer asset ID is type-script hash.

---

## Same-asset test

CKB ask + CKB offer => reject.

UDT offer + UDT ask where type hashes are equal => reject.

---

## Order recreation

Scan all `Source::Output` lock hashes.

If any output lock hash equals the current OpenSwap lock script hash:

```text
OrderRecreated
```

Do not depend on `Source::GroupOutput` for lock output discovery.

---

## UDT payment

At `Output[order_index]`:

```text
lock hash == owner lock hash
type hash == ask Script hash
data.len == 16
u128(data) >= ask_amount
capacity == capacity_refund
```

---

## CKB payment

At `Output[order_index]`:

```text
lock hash == owner lock hash
type == None
data == empty
capacity >= capacity_refund + ask_amount
```

Calculate required capacity in `u128`, reject if above `u64::MAX`.

---

## Cancellation

### Recovery output

At same absolute index as order input:

```text
lock == owner_lock
type_hash == input.type_hash
data_hash == input.data_hash
capacity >= input.capacity
```

### Authorization proof

Find another input:

```text
index != order_index
lock == owner_lock
type == None
data == empty
```

and same-index output:

```text
lock == owner_lock
type == None
data == empty
output.capacity < input.capacity
```

A single proof may authorize multiple lots in the same owner-signed cancellation transaction.

---

## Production deployment

OpenSwap contract Script:

```text
hash_type = data1
code_hash = data hash of exact binary
```

Existing orders are therefore bound to immutable contract bytes.

A future v2 contract uses another code hash and coexists with v1.

---

## Testtool trap

`ckb-testtool::Context::build_script()` historically defaulted to `ScriptHashType::Type`.

Tests must explicitly construct OpenSwap using `ScriptHashType::Data1`.
