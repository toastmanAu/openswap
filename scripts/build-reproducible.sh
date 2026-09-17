#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export LC_ALL=C
export TZ=UTC
export SOURCE_DATE_EPOCH=0
export CARGO_INCREMENTAL=0
export RUSTFLAGS="--remap-path-prefix=$(pwd)=/openswap --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
cargo build --locked --release -p openswap-lock --target riscv64imac-unknown-none-elf
