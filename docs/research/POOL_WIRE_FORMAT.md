# Pool wire format and role binding — draft revision 1

2026-09-23. Proposed ABI for the isolated pool prototype, not frozen consensus,
an implemented validator, or a deployment authorization. Accounting is specified
in [POOL_TRANSITIONS.md](POOL_TRANSITIONS.md). This document selects the shared
binary candidate and makes its required authentication rules explicit.

## Encoding and bounds

Integers are unsigned little-endian; offsets start at zero. Exact lengths are
mandatory: reject trailing bytes, unknown versions/tags, nonzero reserved bytes,
noncanonical Molecule containers, and values outside the accounting domains.
No implicit defaults or optional extension tails. X is native CKB. Script hashes
use CKB's personalized Blake2b-256 over the complete canonical Molecule Script.

Draft transaction scan limits: at most 256 inputs and 256 outputs, independently.
Probe index 256 to detect excess instead of accepting an unchecked tail. Each
role scans both sides, including unrelated cells, so unsupported oversized
transactions reject even for LP transfers. Each inspected Script is at most 512
serialized bytes. Inspect data lengths first; load only the bounded relevant
state/amount data. Unrelated cell data is not copied. Relevant action witness is
at most 4096 bytes. These bounds require VM cycle measurements before freezing.
Indexes are absolute u32 values below the relevant transaction count and 256;
they are not group-relative. Type script absence differs from an empty Script.

## One immutable code identity, five roles

Every pool-owned script uses the same binary's data hash H and hash_type Data1
(byte 2). H is obtained from the executing Script, never from state or a witness.
Construct counterpart Scripts with that same H, Data1, and these exact args:

| Offset | Bytes | Field |
| --- | --- | --- |
| 0 | 4 | ASCII `TPL1` |
| 4 | 1 | ABI version = 1 |
| 5 | 1 | Role |
| 6 | 32 | Pool ID P |

Args length is exactly 38. Role 0 = state type, 1 = state lock, 2 = CKB reserve
lock, 3 = token reserve lock, 4 = LP type. Reject all other tags. Roles 0 and 4
must execute as type scripts; 1–3 as locks. Confirm execution placement using
the current script group and full Script comparison, not just an args match.
Do not accept Type hash_type, another H, a supplied LP hash, or a resolver-selected
custody script. This avoids circular cross-binary hashes and upgrade indirection.

State cells have exactly role-1 lock and role-0 type. CKB reserves have role-2
lock, absent type, empty data. Token reserves have role-3 lock, the full Y type,
and exactly 16 bytes LE u128 amount. LP cells have role-4 type, exactly 16 bytes
LE u128 circulating shares, and ordinary owner-selected locks. Zero LP amounts
are allowed; sums use checked U256 and must not exceed u128 on either side.

## State data

Exactly 190 bytes. Reserves are read from authentic sibling cells, not duplicated
in state bytes. This avoids two competing balance sources.

| Offset | Bytes | Field |
| --- | --- | --- |
| 0 | 4 | ASCII `TPS1` |
| 4 | 1 | Version = 1 |
| 5 | 1 | Asset profile = 0 (canonical xUDT, 32-byte owner args) |
| 6 | 2 | f, immutable fee numerator; denominator fixed at 10000 |
| 8 | 16 | M, immutable virtual locked shares |
| 24 | 16 | L, accounting shares including M |
| 40 | 8 | Bs |
| 48 | 8 | Bx |
| 56 | 8 | By |
| 64 | 4 | rx, CKB sibling output index |
| 68 | 4 | ry, token sibling output index |
| 72 | 32 | Y.code_hash |
| 104 | 1 | Y.hash_type, exactly Data1 (2) in this profile |
| 105 | 1 | Y args length, exactly 32 |
| 106 | 32 | Y.args (owner lock hash, no extension flags) |
| 138 | 52 | Reserved zero bytes |

The reserved bytes allow a fixed initial size, not silent future interpretation;
using them requires another ABI version and code identity. The complete Y Script
is reconstructed from its fields and compared byte-for-byte to the reserve type.
The prototype must bind profile 0 to an explicitly reviewed xUDT binary hash in
the future validator; arbitrary code hashes must not be accepted merely because
their data is 16 bytes. That deployment-specific hash is intentionally unassigned
at this stage. Extended xUDT, Type-addressed/upgradable token code, iCKB and RGB++
are outside this draft profile. A catalog entry cannot expand it.

Y's owner hash must differ from the hashes of this pool's three custody locks;
consuming a pool cell must never activate token owner issuance. External token
issuer powers remain an asset risk. Real-xUDT tests must verify the selected
binary's owner/extension behavior before the profile is enabled.

Only L, rx and ry may change. All other state bytes and the complete state scripts
are immutable. Require Bs/Bx/By each to cover the occupied capacity of its actual
cell, with Bx itself covering CKB reserve storage. Under this exact layout the
occupied byte counts are state 340, CKB reserve 79, token reserve 160: capacity
8 + lock (33 + 38 args) + optional type (33 + args) + data. Thus minimum backings
are respectively 340, 79, 160 CKB (times 10^8 shannons). Validators must calculate
capacity from actual fields, not trust these illustrative derived constants.

## Pool identity and lineage

Define P = CKB Blake2b-256(first serialized CellInput || LE_u64(state output
index)), following the Type-ID-style derivation. CellInput is exactly 44 bytes,
including since; the index is encoded as eight bytes even though ABI indexes are
u32. There is no additional domain prefix. Role/version/H separate script identity.
See [CKB RFC 0022](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0022-transaction-structure/0022-transaction-structure.md).

Genesis requires no matching input state and exactly one matching output state;
recompute P, validate all three outputs and the exact initial LP delta. At least
one transaction input is required. An output role-0 state triggers these checks
even if no pool lock runs. LP input sum must be zero at genesis. A hypothetical
preexisting LP balance for this identity is rejected rather than legitimized.

Normal transition requires exactly one role-0 state input and output for (H,P).
From the input state's previous_output.tx_hash T and its stored rx/ry, locate
exactly the consumed OutPoints (T,rx) and (T,ry). Require the three input indexes
to be distinct, and reject a recorded reserve index equal to the input state's
own previous_output.index. Validate capacities, data and scripts on those exact
cells. Locate successor reserves at output rx/ry; all three output indexes must
also be distinct. Outputs create the next generation of sibling bindings.

Every state/reserve lock invocation performs the same authenticated transition
checks, including input role-0 state presence. Cell deps are never state proofs.
Every input in one of these custody lock groups must be the authenticated state
or corresponding reserve for that role. Spending an extra lookalike with the
same lock rejects that transaction; unspent unsolicited lookalikes are never
enumerated and cannot obstruct a valid transition. Extra output lookalikes do
not become reserves, alter balances, or authorize issuance. No recovery path is
promised for them. Destruction and multiple successors always fail.

## Action witness

Use canonical WitnessArgs at the absolute state input index for a normal
transition; its input_type Bytes contains the action. At genesis use the witness
at the absolute state output index and its output_type Bytes. Distinct fields
allow genesis and a different pool's input state to share a witness index.
Each pool reads only its assigned field. The witness lock field belongs to the
ordinary signing scheme and is not interpreted as pool authorization.

Action header: ASCII `TPA1` at 0..4, version 1 at offset 4, tag at offset 5,
two zero reserved bytes at 6..8. All payload fields below are LE u128:

| Tag | Action | Payload in order | Exact total bytes |
| --- | --- | --- | --- |
| 0 | Create | minShares | 24 |
| 1 | Swap X→Y | amountIn, minOut | 40 |
| 2 | Swap Y→X | amountIn, minOut | 40 |
| 3 | Deposit | maxX, maxY, minShares | 56 |
| 4 | Withdraw | shares, minX, minY | 56 |

Genesis x/y/parameters come from validated output cells; normal pre-state comes
from authenticated input cells. Only Create is valid at genesis; it is invalid
with an input state. Evaluate the exact integer transition, then compare every
successor balance and L. Backing cannot pay transaction fees. Minima are checked
against calculated flows; they do not authenticate a user, recipient or intent.
Ordinary wallet signatures must protect the complete direct transaction and
receipts. No pool action alone promises output payments to a named recipient.

## LP authentication and supply

Scan exact role-4 Scripts for (H,P), not arbitrary same-args tokens. Sum LP inputs
and outputs in checked U256, each sum bounded by u128. For genesis/deposit require
output sum = input sum + minted; withdrawal requires input sum = output sum +
burned; swaps require equality. The state validator checks this even if no LP
script group executes (e.g. omitted issuance). Also bound each sum by the relevant
state's circulating supply L-M when a state is present. M never appears in an LP
cell or issuance delta.

The LP validator independently finds and validates the matching state transition
whenever either matching state side exists. One-sided state presence cannot fall
back to transfer mode. If neither state side exists, require strict LP sum
equality; no mint, burn, owner mode or dep-based authorization. Existing LP owner
locks authorize consumption. Validators share a common verification function,
not recursive script execution or an assumption about another group's result.

## Draft stable errors and validation order

Reserve the following positive i8 exit codes. These assignments are stable within
this draft. The host/no_std codecs implement codes 2, 3, 4, 5, 7 and 21 where
applicable to local byte validation; transaction-level custody checks remain
unimplemented.

| Code | Meaning |
| --- | --- |
| 1 | Unexpected syscall failure |
| 2 | Scan/field-size bound exceeded |
| 3 | Malformed/noncanonical bytes |
| 4 | Unsupported version, role, profile or action |
| 5 | Script identity or execution placement mismatch |
| 6 | Genesis identity/cardinality violation |
| 7 | State/reserve lineage or cardinality violation |
| 8 | Immutable field mismatch |
| 9 | Actual capacity/data/type mismatch or insufficient backing |
| 10 | LP supply mismatch |
| 21 | RANGE |
| 22 | OVERFLOW |
| 24 | STATE (economic invariant) |
| 25 | ZERO_OUTPUT |
| 26 | SLIPPAGE |
| 27 | SHARES |
| 29 | Claimed successor differs from calculated transition |

Validate bounded decoding and role placement, cardinality/lineage, immutable
fields and actual cell shape, arithmetic, successor comparison, then LP delta.
Within arithmetic, validation order follows model revision 1 (parameters, pre-state,
operation domains, operation-specific checks, post-state). Multi-fault structural
precedence needs fixed traversal-order VM vectors before becoming consensus.
Rust's typed API cannot represent JS INTEGER/unknown-operation errors; wire
decoding rejects these earlier. Negative/over-U256 model inputs have no wire form.

## Implementation boundary

`pool-arithmetic::wire` implements bounded, allocation-free args/state/action
encoding and decoding, canonical pool Script containers, and canonical
WitnessArgs decoding with phase-specific action selection. It validates every
WitnessArgs BytesOpt, including unselected fields, but does not interpret lock
signatures. Pool Script decoding requires Data1; it does not authenticate its
code hash, pool ID or execution placement. No xUDT hash is enabled by the codec.

Local state checks enforce f, M, L>=M, positive backing, Bx<u64::MAX, distinct
rx/ry and indexes below 256. Actual transaction counts, the state cell's own
index, backing's occupied capacity and L²<=x*y need cell context. Actions require
positive values with X<=u64::MAX-1, Y<=2^112-1 and shares<=u128::MAX; the exact
CKB limit u64::MAX-Bx and economic constraints are checked by arithmetic later.
`StateData::accounting` validates arithmetic after caller-supplied balances;
those balances must eventually come from authenticated reserve cells.

Codec error precedence: reject an overall size bound first, then structural
header/version/tag/container rules, then local domains. Args/state lengths above
their fixed size use Bound (2), shorter lengths use Malformed (3). Action lengths
above 56 use Bound; a tag-specific length mismatch at or below 56 uses Malformed.
Incorrect magic/reserved bytes/args length are Malformed; unknown version/role/
profile/action is Unsupported (4); a pool Script with non-Data1 hash_type is
Identity (5). Local range failures use 21; out-of-bound sibling indexes use 2,
equal sibling indexes use 7. Witness phase/action mismatch uses 4. Absent and
Some(empty) witness fields are distinct canonical BytesOpt forms; neither is a
valid selected action. Encoders validate typed values before producing bytes.
This decoder-local precedence is tested; multi-fault transaction ordering remains
part of the future validator work.

Next gate: common state/custody/LP validation with adversarial
real-xUDT CKB-VM tests, occupied-capacity checks, malformed bytes, fake counterparts,
duplicate successors, independent pools, witness placement and scan-bound tests.
No contract safety or real-xUDT compatibility follows from accounting/codec tests.
