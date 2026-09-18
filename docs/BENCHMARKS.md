# Contract measurements

Measured 2026-09-15 using Rust 1.98.1, ckb-std 1.1.0, ckb-testtool 1.1.1,
and the complete pinned Cargo.lock. Actual CKB-VM execution, Data1 scripts.

| Transaction | Total VM cycles |
|---|---:|
| UDT → UDT (isolated) | 58,047 |
| UDT → CKB (isolated) | 46,424 |
| CKB → UDT (isolated) | 55,853 |
| UDT cancellation (isolated) | 45,301 |
| Two orders (isolated) | 114,830 |
| Ten orders (isolated) | 675,510 |
| Twenty orders (isolated) | 1,642,400 |
| Real xUDT → xUDT | 90,833 |
| Real xUDT → CKB | 64,288 |
| CKB → real xUDT | 73,745 |
| Two real xUDT orders | 144,674 |
| Ten real xUDT orders | 733,850 |
| Signed secp cancellation | 1,745,861 |

Binary size: **28,592 bytes**. Identity: [binary-identity.json](binary-identity.json).
These are whole-transaction script cycles, including AlwaysSuccess fixtures,
token scripts and owner signatures where indicated. Signature verification can
vary slightly with transaction hash/signature. No cycle estimates are advertised
as live-network transaction validation.

Reproduce with:

```sh
make build
cargo test --locked -p openswap-tests -- --nocapture --test-threads=1
make hash
./scripts/check-reproducible.sh
```

Two fresh local target directories produced byte-identical binaries. A separate
GitHub-hosted Ubuntu 24.04 runner also produced the same SHA256, CKB code hash and
28,592-byte binary, including its own two clean builds. See
[remote build evidence](../deployments/remote-reproducibility.json). CI now fails
if the rebuilt binary differs from the immutable testnet deployment. This verifies
separate machines using the pinned toolchain, not arbitrary operating systems or
compiler versions.

Toolchain: Rust 1.98.1, riscv64imac-unknown-none-elf, rust-lld bundled with Rust,
release opt-level=s, LTO, one codegen unit, aborting panic, overflow checks,
stripped symbols. Build script remaps workspace and Cargo paths, fixes locale,
timezone and SOURCE_DATE_EPOCH, disables incremental compilation, and uses
--locked. No external RISC-V C linker is required by this contract configuration.
