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

Still required: explicit operator resolution/archival for rejected and permanently
absent transactions, broader crash-boundary and live contention validation, and
production invocation wiring. This conservative implementation does not release
inputs or retry automatically. The SDK callback supplies
the hash and exact signed bytes and awaits persistence; rejection prevents send.
Runner wiring must use those bytes, not unsigned builder bytes.
