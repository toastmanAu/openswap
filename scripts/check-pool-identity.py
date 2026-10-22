#!/usr/bin/env python3
"""Pin the reviewed pool artifact; this is NOT a deployment manifest."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
EXPECTED = {
    'binarySha256': 'd3a6520f08859787e34b5497d0f0f4c893b81b96fe7aaa280e50584024f67829',
    'codeHash': '0xc58432bfaf1cfaab12532bd4d9ce7e5a43196bd0c867a43b63f19096727a12ed',
    'binaryBytes': 42176,
    'hashType': 'data1',
}


def verify(binary: Path) -> dict:
    data = binary.read_bytes()
    actual = {
        'binarySha256': hashlib.sha256(data).hexdigest(),
        'codeHash': '0x' + hashlib.blake2b(data, digest_size=32, person=b'ckb-default-hash').hexdigest(),
        'binaryBytes': len(data),
        'hashType': 'data1',
    }
    for key, value in actual.items():
        if EXPECTED[key] != value:
            raise ValueError(f'Pool artifact mismatch: {key}: expected {EXPECTED[key]}, got {value}')
    return actual


if __name__ == '__main__':
    binary = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'target/riscv64imac-unknown-none-elf/release/openswap-pool'
    try:
        print(json.dumps(verify(binary), indent=2))
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from error
    print('Build matches the pinned pool artifact (not live deployment approval).')
