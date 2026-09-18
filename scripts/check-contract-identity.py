#!/usr/bin/env python3
"""Assert that a clean build matches the immutable testnet deployment."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parent.parent
binary = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'target/riscv64imac-unknown-none-elf/release/openswap-lock'
data = binary.read_bytes()
deployment = json.loads((root / 'deployments/testnet.json').read_text())
actual = {
    'binarySha256': hashlib.sha256(data).hexdigest(),
    'codeHash': '0x' + hashlib.blake2b(data, digest_size=32, person=b'ckb-default-hash').hexdigest(),
    'binaryBytes': len(data),
    'hashType': 'data1',
}
for key, value in actual.items():
    if deployment[key] != value:
        raise SystemExit(f'Deployed binary mismatch: {key}: expected {deployment[key]}, got {value}')
print(json.dumps(actual, indent=2))
print('Build matches the immutable testnet deployment.')
