.PHONY: build test check hash pool-build pool-test
build:
	./scripts/build-reproducible.sh
test: build
	cargo test --locked -p openswap-tests
check:
	cargo fmt --all -- --check
	cargo clippy --locked -p openswap-lock --release --target riscv64imac-unknown-none-elf -- -D warnings
	cargo clippy --locked -p openswap-tests --all-targets -- -D warnings
	cargo clippy --locked -p openswap-pool-arithmetic --all-targets -- -D warnings
	cargo clippy --locked -p openswap-pool --release --target riscv64imac-unknown-none-elf -- -D warnings
	cargo clippy --locked -p openswap-pool-tests --all-targets -- -D warnings
pool-build:
	bash scripts/build-pool.sh
pool-test: pool-build
	cargo test --locked -p openswap-pool-tests
hash:
	./scripts/hash-contract.sh
