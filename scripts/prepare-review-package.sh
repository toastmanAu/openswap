#!/usr/bin/env bash
# Freeze an independent-review package from HEAD (see docs/REVIEW_PACKAGE.md).
# Local only: never contacts a reviewer, uploads or publishes anything.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
 echo "Refusing to freeze: the working tree is not clean." >&2
 exit 1
fi
commit=$(git rev-parse HEAD)
mkdir -p release
archive="release/toastdex-review-${commit}.tar"
manifest="release/toastdex-review-${commit}.manifest.json"
git archive --format=tar --prefix=toastdex/ --output="$archive" "$commit"

# Rebuild both contracts with the pinned toolchain and check pinned identities.
make build >/dev/null
make pool-build >/dev/null
python3 scripts/check-pool-identity.py >/dev/null

python3 - "$commit" "$archive" "$manifest" <<'PY'
import hashlib,json,subprocess,sys,datetime
from pathlib import Path
commit,archive,out=sys.argv[1:]
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def identity(path):
    b=Path(path).read_bytes()
    return {'binary':path,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),
            'codeHash':'0x'+hashlib.blake2b(b,digest_size=32,person=b'ckb-default-hash').hexdigest(),'hashType':'data1'}
order=identity('target/riscv64imac-unknown-none-elf/release/openswap-lock')
pinned=json.loads(Path('docs/binary-identity.json').read_text())
if order['sha256']!=pinned['sha256'] or order['codeHash']!=pinned['codeHash']:
    sys.exit('Order lock rebuild does not match docs/binary-identity.json')
pool=identity('target/riscv64imac-unknown-none-elf/release/openswap-pool')
run=lambda *a:subprocess.run(a,capture_output=True,text=True,check=True).stdout.strip()
def code_unchanged(since):
    # Documentation cannot change results; any other path can.
    return subprocess.run(['git','diff','--quiet',since,commit,'--','.',':(exclude)docs',':(exclude,glob)*.md']).returncode==0
campaigns={}
ledger=Path('docs/campaigns/results.jsonl')
for line in (ledger.read_text().splitlines() if ledger.exists() else []):
    r=json.loads(line)
    if r['dirty']:continue
    c=campaigns.setdefault(r['target'],{'runs':0,'seeds':[],'executed':0,'stops':{},'commits':{}})
    c['runs']+=1;c['seeds'].append(r['seed']);c['executed']+=r['executed']
    c['stops'][r['stop']]=c['stops'].get(r['stop'],0)+1
    c['commits'].setdefault(r['commit'],{'codeUnchangedSinceCampaign':code_unchanged(r['commit'])})
manifest={'commit':commit,'archive':Path(archive).name,'archiveSha256':sha(archive),
 'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
 'contracts':{'orderLock':order,'pool':pool},
 'toolchain':{'rustToolchainToml':Path('rust-toolchain.toml').read_text().strip(),'rustc':run('rustc','--version'),
  'cargo':run('cargo','--version'),'node':run('node','--version'),'npm':run('npm','--version'),
  'cargoLockSha256':sha('Cargo.lock'),'packageLockSha256':sha('package-lock.json')},
 'campaigns':campaigns,
 'briefs':['docs/EXTERNAL_REVIEW.md','docs/POOL_REVIEW_BRIEF.md','docs/REVIEW_PACKAGE.md','docs/REVIEW_REPORT_TEMPLATE.md'],
 'note':'Preparation evidence only. Reviewers should rebuild and rehash independently. No reviewer engaged.'}
Path(out).write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'commit':commit,'archive':archive,'archiveSha256':manifest['archiveSha256'],'manifest':out},indent=2))
PY
