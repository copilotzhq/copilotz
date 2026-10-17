# Private same-owner local Processor host composition

The fresh owner host now composes local Actions and Processors through one
private `{ actions?, processors? }` bundle. Both use the same aggregate capacity
map as workers. The older private Action-only argument shape is removed and its
callers migrated. This is not a public placement API or a change to ordinary
embedded defaults.

## Execution and retry boundary

Selection, policies, capability factories and bounds are captured before the
host's first initialization await. Selection is sticky: refusal never falls back
to a worker. The registered Processor driver and bound owner port perform actual
input, Collection and settlement commands; the host supplies genuine private
attempt witnesses rather than caller-provided authority.

A retry combines the generation ledger's known ended receipt and real quiescence
with exact persisted predecessor retirement in the new start transaction. That
retirement is checked again after input/grant policy callbacks: a row lock does
not prevent the same transaction from changing its own predecessor. The proof is
tied to the exact live command context, caller, binding, ordinal and start
facts.

Completion retires the SQL assignment before scheduling a retry. The scheduling
hook therefore uses the still-live private settlement entry, not a lookup that
requires an unretired assignment. After its grant callback, it verifies the
exact retired binding, event/consumer, owner/namespace, settlement/action
scopes, ordinal, maximum attempts, clear lease and lossless retry timestamp. The
exact operation must still be accepted/running with no cancellation request.
Changes roll back the command, receipt and alarm together.

SQL determines due time. Delivery alarm selection retains timestamp text and
uses a SQL comparison instead of rounding through JavaScript milliseconds.
A due retry alarm is retained while its predecessor still occupies capacity; a
generation's release notification only requests another durable scan. It is not eligibility
or authority and is not counted as active shutdown work.

## Collections, capacity and shutdown

Local Processor Collections use the existing `delivery:<id>:` logical identity,
actual source event/delivery scope, current input policy, and an attempt witness
kept privately by the owner. Policy is rechecked before receipt replay. Local
Actions, local Processors and worker tasks reserve the same capacity pool.

Unknown completion acknowledgements stop the owner and retain uncertain local
occupancy even when SQL visibly committed. Shutdown revokes authority
immediately but waits for actual noncooperative capability factories to return.
Returning from such a factory cannot reactivate authored execution.

## Scoped evidence

The ordinary checked PGlite batch passes thirteen actual-host cases plus three
pure configuration/capture cases. It covers worker and local Processors over
both transports, Collection writes and replay denial, actual ordinal-two retry,
NULL-lease handling, predecessor mutations during grant/event policy, scope and
cancellation mutations during retry grants, held start/completion
acknowledgements, unknown committed completion, all three placements sharing one
slot, and shutdown with a held factory. Existing local Action host compatibility
passes 22 cases. The original worker assertions remain; local nested Action
calls are explicitly unavailable rather than counted as worker-equivalent
coverage.

Two actual causal regressions are retained: the earlier draft committed a retry
after a policy changed its settlement scope or requested cancellation. Both now
refuse and roll back. Fixture synchronization waits for detached work's own
completion rather than assuming it finishes before faster local execution.

The held acknowledgements in these host cases delay the database transaction's
return after COMMIT and therefore also hold the serialized owner command pump.
They do not prove an unrelated owner command progresses during a separately held
caller-facing reply. A true caller-facing held-reply alarm case and an actual
sub-millisecond host scheduling probe remain additional evidence gates.
Independent PostgreSQL 17.11 validation passes the same thirteen host cases plus
three pure cases, with zero failures or skips. All thirteen disposable databases
were exported and dropped and the service stopped. The isolated 1,595-file
source snapshot and seven worktree overlay hashes stayed unchanged; source lint
and formatting checks passed.

## Remaining scope

Retained local history/restart, cross-owner recovery, local nested Actions,
effects, named preparation, public placement selection and full capability
parity remain open. Completing those replacements must retire the superseded
public runtime paths under the [cleanup plan](refactor-cleanup.md); this private
host increment does not close that broader migration.
