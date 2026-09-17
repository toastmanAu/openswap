#!/usr/bin/env python3
"""Verify vendored integration binaries against their immutable source manifest."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent / 'tests/fixtures'
for name, expected in json.loads((root / 'manifest.json').read_text()).items():
    data = (root / name).read_bytes()
    assert hashlib.sha256(data).hexdigest() == expected['sha256'], name
    assert '0x' + hashlib.blake2b(data, digest_size=32, person=b'ckb-default-hash').hexdigest() == expected['ckbDataHash'], name
print('Integration fixture hashes verified')
