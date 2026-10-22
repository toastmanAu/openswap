# Reference solver recovery status

`runner.ts` requires an explicit `journal` option for `tick(true)`. Existing live
integration scripts that omit it now fail closed and must be wired to an explicit
private journal directory before any separately authorized run. Dry-run without
a journal remains supported. The runner reloads records before scanning, checks
account/network scope, and persists exact signed bytes before send. Unknown,
pending, rejected and previously committed records remain tracked and their inputs
excluded. Committed records are rechecked for reorgs; missing status is not failure.

`src/journal.ts` is a Node-only, inert submission store. It has no signer, network
client or broadcast operation. `FileSubmissionJournal(directory, scope)` requires
explicit genesis and account-lock hashes, limits records to 1,000 and the snapshot
to 8 MiB, checks canonical transaction bytes/hash and input-backed order keys, and
returns independent record copies. Transaction bytes, timestamp and order keys
are immutable once recorded; status may change during later reconciliation.

Writes use a same-directory temporary file, file fsync, atomic rename and directory
fsync. Any write failure poisons the instance: stop, reopen and reconcile rather
than assuming persistence failed or releasing reservations. A crashed writer leaves
`writer.lock`; never remove it automatically based on age. An operator must confirm
no writer remains before recovering the lock. An interrupted `submissions.next`
also requires deliberate inspection; a valid older snapshot does not prove the
latest transaction was never sent. The directory must be private to the operator;
this is crash recovery, not protection against a hostile filesystem owner.

`FileSubmissionJournal.archive(hash, resolution)` appends the record to fsynced
`archive.jsonl` before removing it from the snapshot.

## Operator resolution

`src/resolution.ts` holds the read-only checks shared with pool recovery:
`archiveCommittedSubmission` needs a committed status at the requested depth
(default 24). `abandonConflictedSubmission` needs explicit reorg-risk
acknowledgement, at least one input spent in committed state, and a status that
is neither committed nor in flight before and after the input reads. A row whose
inputs are all live is refused, because its signed bytes can still commit. Release
it only by deliberately spending a conflicting input.

Stop the solver first; the journal's single-writer lock enforces this. Then run:

```
npm run solver-journal -- list                      # offline
npm run solver-journal -- status                    # node status, live inputs
npm run solver-journal -- archive-committed <hash> [--min-confirmations=24]
npm run solver-journal -- abandon-conflicted <hash> --acknowledge-reorg-risk
```

The CLI uses `CKB_RPC_URL` (default public testnet) for reads only. It has no
signer and never sends. The default directory is
`.local/solver-journal/<network>-<account-lock-hash prefix>`, also used by
`scripts/run-solver-integration.ts`; `--journal-dir` overrides it. A restarted
solver no longer reserves archived rows' orders.

Still required: broader crash-boundary and live contention validation. Wiring a
long-running production service is out of scope (only the integration runner
exists). This conservative implementation does not release inputs or retry
automatically. The SDK callback supplies
the hash and exact signed bytes and awaits persistence; rejection prevents send.
Runner wiring must use those bytes, not unsigned builder bytes.
