.PHONY: build test check hash pool-build pool-test lock-v2-build lock-v2-test
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
	cargo clippy --locked -p openswap-lock-v2 --release --target riscv64imac-unknown-none-elf -- -D warnings
	cargo clippy --locked -p openswap-lock-v2-tests --all-targets -- -D warnings
pool-build:
	bash scripts/build-pool.sh
pool-test: pool-build
	cargo test --locked -p openswap-pool-tests
lock-v2-build:
	bash scripts/build-lock-v2.sh
lock-v2-test: lock-v2-build
	cargo test --locked -p openswap-lock-v2-tests
hash:
	./scripts/hash-contract.sh
