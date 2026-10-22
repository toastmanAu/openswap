#!/usr/bin/env python3
"""Offline negative regressions for the pinned pool identity verifier."""
from pathlib import Path
import runpy
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
VERIFIER = runpy.run_path(str(ROOT / 'scripts/check-pool-identity.py'))


class PoolIdentityTests(unittest.TestCase):
    def test_current_artifact(self):
        binary = ROOT / 'target/riscv64imac-unknown-none-elf/release/openswap-pool'
        self.assertEqual(VERIFIER['verify'](binary), VERIFIER['EXPECTED'])

    def test_modified_truncated_empty_and_missing_artifacts(self):
        original = (ROOT / 'target/riscv64imac-unknown-none-elf/release/openswap-pool').read_bytes()
        changed = bytearray(original)
        changed[len(changed) // 2] ^= 1
        with tempfile.TemporaryDirectory(prefix='pool-identity-test-') as directory:
            target = Path(directory) / 'candidate'
            for data in (changed, original[:-1], b'', original + b'\x00'):
                target.write_bytes(data)
                with self.assertRaisesRegex(ValueError, 'Pool artifact mismatch'):
                    VERIFIER['verify'](target)
            with self.assertRaises(FileNotFoundError):
                VERIFIER['verify'](Path(directory) / 'missing')


if __name__ == '__main__':
    unittest.main()
