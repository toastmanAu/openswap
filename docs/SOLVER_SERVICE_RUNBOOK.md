# Solver service on a server (testnet)

How to run the always-on solver (SOLVER.md, "Always-on service") continuously on a
small Linux server with systemd. **Testnet only.** The server holds the testnet
solver key; nothing here touches mainnet or real funds.

Files: `deploy/solver/openswap-solver.service`, `openswap-solver-health.service`,
`openswap-solver-health.timer`, `solver.env.example`.

## Rules

- **One running instance per solver wallet.** Two copies with the same key and
  separate journals would race for the wallet's own cells. Stop the development
  machine's copy before starting the server's, and never run both.
- The journal admits one writer. Stop the service before any `solver-journal` command.
- The service never resends, replaces or abandons a submission on its own. Rows that
  need a decision show in the status file and fail the health check.

## Server

Ubuntu 24.04 LTS or similar, 1 vCPU and 1 GB RAM is plenty. No inbound ports beyond
SSH (key-only); the service only makes outbound HTTPS calls to the CKB RPC.

```sh
# Node 22 (any install that puts node on /usr/bin or /usr/local/bin)
node --version   # v22.x

# Service user, code, dependencies (code owned by root, read-only to the service)
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin openswap
sudo git clone https://github.com/toastmanAu/openswap.git /opt/openswap
cd /opt/openswap && sudo git checkout <commit>      # pin what you run
sudo npm ci
sudo npx tsx --test solver/test/*.test.ts           # optional sanity check
```

## Key and configuration

On the development machine, first stop its service (Ctrl-C; it finishes the cycle in
progress) and make sure its journal holds nothing unresolved:

```sh
npm run solver-journal -- status --journal-dir=.local/solver-service/journal
# Archive each committed row once 24 blocks deep:
npm run solver-journal -- archive-committed <tx-hash> --journal-dir=.local/solver-service/journal
npm run solver-journal -- list --journal-dir=.local/solver-service/journal   # expect 0
```

Then copy the key over (never paste it into a shell or a chat):

```sh
scp .local/testnet-solver-key root@<server>:/etc/openswap/testnet-solver-key
```

On the server:

```sh
sudo mkdir -p /etc/openswap
sudo chown root:root /etc/openswap/testnet-solver-key && sudo chmod 600 /etc/openswap/testnet-solver-key
sudo cp /opt/openswap/deploy/solver/solver.env.example /etc/openswap/solver.env
sudo chown root:openswap /etc/openswap/solver.env && sudo chmod 640 /etc/openswap/solver.env
sudo cp /opt/openswap/deploy/solver/openswap-solver*.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
```

The key reaches the service through `LoadCredential` (a private copy only that process
can read); the service refuses a key file that group or others can read, and checks it
matches `deployments/solver-wallet.json`.

## First start: one dry cycle, then live

```sh
sudo systemd-run --wait --pty --uid=openswap --gid=openswap \
  -p WorkingDirectory=/opt/openswap -p StateDirectory=openswap-solver \
  -p LoadCredential=solver-key:/etc/openswap/testnet-solver-key \
  -E OPENSWAP_SOLVER_STATE_DIR=/var/lib/openswap-solver \
  /opt/openswap/node_modules/.bin/tsx scripts/solver-service.ts --once
```

It prints what it would settle or return and sends nothing. If that looks right:

```sh
sudo systemctl enable --now openswap-solver.service openswap-solver-health.timer
journalctl -u openswap-solver -f            # one JSON event per line
```

## Watching it

- `sudo cat /var/lib/openswap-solver/status.json`: mode, state, pause reasons,
  balance, fees in the last 24 h, last built and sent, journal rows needing attention.
- `/var/lib/openswap-solver/events.jsonl`: every event, appended.
- `systemctl status openswap-solver-health` / `journalctl -u openswap-solver-health`:
  the 5-minute health check. For alerts, set `OPENSWAP_HEALTH_PING_URL` and
  `OPENSWAP_HEALTH_FAIL_URL` in `/etc/openswap/solver.env` (for example a
  healthchecks.io check, which also alerts when pings stop).
- Check what it sent from any machine:
  `npx tsx scripts/solver-service-verify.ts <tx-hash>`.

## Changing it

```sh
sudo systemctl stop openswap-solver        # waits for the cycle in progress
cd /opt/openswap && sudo git fetch && sudo git checkout <commit> && sudo npm ci
sudo systemctl start openswap-solver
```

Options (interval, balance floor, fee budget) live in `SOLVER_ARGS` in
`/etc/openswap/solver.env`; restart to apply.

## Funding

The solver wallet is `deployments/solver-wallet.json`. It pays fees and the capacity
of its own spread outputs. Below the floor (500 CKB) sending pauses and the health
check fails; above 1.5 times the floor, no warning. Top it up from the testnet faucet.

## When something needs you

**Paused: 24 h fee budget spent.** Sending resumes as old fees age out. Investigate why
fees are high before raising `--daily-fee-budget`.

**Submission needs attention** (rejected, or unresolved for 30 min). Its inputs stay
reserved. Stop the service, then (running as the service user, from `/opt/openswap`):

```sh
J=--journal-dir=/var/lib/openswap-solver/journal
T="sudo -u openswap /opt/openswap/node_modules/.bin/tsx"
$T scripts/solver-journal.ts status $J
$T scripts/solver-journal.ts archive-committed <tx-hash> $J          # committed, 24+ deep
$T scripts/solver-journal.ts abandon-conflicted <tx-hash> --acknowledge-reorg-risk $J
```

`abandon-conflicted` is refused while every input is still live (the signed bytes
could still commit). Start the service again afterwards.

**Journal locked** (`Solver journal is locked`, the service will not start). A hard
kill (SIGKILL, out of memory, power loss) left `journal/writer.lock`. Confirm nothing
is running (`systemctl status openswap-solver`, `pgrep -u openswap`), check the
journal with `solver-journal status` as above, then remove the lock and start:

```sh
sudo rm /var/lib/openswap-solver/journal/writer.lock
sudo systemctl reset-failed openswap-solver && sudo systemctl start openswap-solver
```

Never remove the lock while a solver process might still be writing.

## Moving it back or elsewhere

Stop it, resolve the journal to empty as in "Key and configuration", then start the
other copy. Copying `status.json` along carries the 24 h fee record; the journal
itself should be empty, not copied.
