#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
build_root=$(mktemp -d)
trap 'rm -rf "$build_root"' EXIT
CARGO_TARGET_DIR="$build_root/first" ./scripts/build-reproducible.sh
CARGO_TARGET_DIR="$build_root/second" ./scripts/build-reproducible.sh
cmp "$build_root/first/riscv64imac-unknown-none-elf/release/openswap-lock" \
    "$build_root/second/riscv64imac-unknown-none-elf/release/openswap-lock"
./scripts/hash-contract.sh "$build_root/first/riscv64imac-unknown-none-elf/release/openswap-lock"
echo 'Two clean local target directories produced identical binaries.'
