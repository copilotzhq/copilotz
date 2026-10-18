# Prepared child admission: current authority checkpoint

This private prerequisite extends the existing child admission lifetime fence to
named preparation. It does not enable local named preparation by itself.

## Reused mechanism

`authorizePreparedTarget` validates the current parent and registered target,
snapshots the full normalized command and caller before awaiting policy, and
binds the exact private parent proof into the child's existing
`authorizationProofs` WeakMap. The handler's target recheck cannot replace that
command binding. The owner boundary now includes the fixed prepared-admission
kind, only when preparations are configured, in the same current-authorization
allowlist as ordinary child admission and result projection. There is no
additional authority registry, renderer, table, lease or retry protocol.

Original source/resource permission is still required on replay. That permission
and the parent's current private lifetime are distinct checks.

## Failure boundaries

Five causal regressions keep SQL grants and original-source permission unchanged
while revoking only the private parent lifetime:

- the framework's second receipt lookup on duplicate admission
- fresh receipt insertion after child capture
- receipt-reader insertion
- savepoint release / final group check
- the actual database transaction's COMMIT reply

The first four roll back the whole relevant durable change and publish nothing.
The savepoint case uses the existing definitive isolated retry, whose fresh
parent authorization refuses with `ActionOwnershipLost`. A revocation after
COMMIT cannot roll back that transaction: the exact capture, receipt, reader and
child publication remain committed, but the caller receives no outcome.
Rendering and mapping occur once.

The original baseline returned success in all five targeted cases. The initial
post-fix run passed 22 cases and failed only the savepoint error-code
expectation; that expectation was corrected to preserve the existing retry
semantics.

## Validation and fixture corrections

The frozen candidate passes 393 cases in actual PostgreSQL-configured gates: 87
preparation, 114 core and the complete 17-file / 192-case connected inventory.
All use ordinary typechecking with no failed or skipped cases. These gate files
also include pure cases; this is not a claim that every case performs SQL.

The role-bundle gate adds 12 passing cases, and the two corrected source fixture
files pass 21 cases on PGlite. Lint, formatting and six architecture/package
checks, including the strict surface, pass (46 exports, 16 external imports, 725
production modules). All 1,600 frozen source files and nine changed paths match
their manifest; reviewed sibling source hashes remain unchanged. All 380 test
databases were created/dropped once, no sessions remained, and PostgreSQL was
stopped.

The root ran the isolated reviewer-created harness after an execution handoff;
source, frozen artifacts and results received separate independent review. These
are root-executed gates with independent evidence review, not a claim that the
reviewer independently reran the final candidate.

The expanded PostgreSQL check also exposed old test data setup that passed raw
JavaScript arrays into explicit JSONB placeholders. Three fixture binds now
encode JSON explicitly, and those two fixture constructors close their database
on setup failure. A new reader assertion was corrected to use the existing
canonical JSON principal tuple. These are fixture corrections, not runtime
permission changes. Failed runs and their cleanup records remain in the
evidence.

The initial expanded check caught two stale mock method names during
typechecking. A later canonical run caught a composition regression:
unconditionally listing the prepared command violated the boundary's
registered-kind validation on hosts without preparation. The allowlist now
follows the existing conditional handler registration. That failed run and the
subsequent complete rerun are preserved.

This is a scoped checkpoint. It does not replace historical full-suite evidence,
activate Processor effects, support retained local history, or expose public
local placement. No merge or package publication is authorized by this result.
