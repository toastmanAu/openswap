#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - "$@" <<'PY'
import hashlib,json,sys
from pathlib import Path
p=Path(sys.argv[1] if len(sys.argv)>1 else 'target/riscv64imac-unknown-none-elf/release/openswap-lock')
b=p.read_bytes()
print(json.dumps({'binary':str(p),'sha256':hashlib.sha256(b).hexdigest(),'codeHash':'0x'+hashlib.blake2b(b,digest_size=32,person=b'ckb-default-hash').hexdigest(),'hashType':'data1','bytes':len(b)},indent=2))
PY
