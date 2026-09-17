.PHONY: build test check hash
build:
	./scripts/build-reproducible.sh
test: build
	cargo test --locked -p openswap-tests
check:
	cargo fmt --all -- --check
	cargo clippy --locked -p openswap-lock --release --target riscv64imac-unknown-none-elf -- -D warnings
	cargo clippy --locked -p openswap-tests --all-targets -- -D warnings
hash:
	./scripts/hash-contract.sh
