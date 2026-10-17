# Owner runtime integration

Status: implementation in progress. The bounded View foundation is available;
owner transaction boundaries, worker-to-owner calls and execution integration
are being developed. This document describes the intended guarantees and the
evidence still required. It does not certify full owner or wire conformance.

## Current checkpoint

Views are the sixth plugin primitive, including contributions, resolution,
application composition, deterministic build discovery and public exports. The
[View guide](../views.md) defines the experimental one-shot renderer boundary.
The renderer requires an authorized host projection, isolates mutable context
snapshots and revokes each session's capabilities before disposing it.

The current dependency pin does not supply the new worker-originated transport.
Generic reverse calls are tested against the separately developed Oxian source
with an explicit test-only mapping
([Oxian PR 28](https://github.com/AxionCompany/oxian-js/pull/28), tree
`ad92a4a6c9a4a7c7a2321a9ec82bd6a0ecb57202`). They are not available through that
pin. No package publication or merge is part of this work.

## Responsibility boundary

Copilotz owns durable execution on its existing application tables: nodes,
edges, events, event bodies/deliveries, operation and content catalog records.
Owner fences, receipts and alarms supplement those tables; they do not replace
them with a generic record store. Oxian owns transport, admission, authenticated
worker sessions, bounded dispatch and reverse invocation on the same connection.

The first fixture uses one explicit owner ID and existing storage configuration.
It does not introduce a database-directory schema or choose a new deployment.
Detailed public factory options remain subject to integration review. The
internal opt-in schema enforces one owner ID per SQL schema with a database
uniqueness guard, and refuses a conflicting owner at acquisition and receipt
lookup. This bounded restriction prevents separate owner locks racing the
existing event deduplication key; it is not a permanent public placement
contract. Only empty event schemas are supported. Existing-data migration is not
implemented.

## First transaction slice

A worker submits typed, ordered operation data for registered Collection
operations. It cannot submit SQL, executable closures, authorization functions
or projected database rows. The host obtains principal, namespace, grants and
assignment identity from admitted state, then checks current policy inside the
command transaction. Authorization also binds the command key to its stable
invocation and namespace before receipt lookup, including duplicate calls. A
later handler scope callback alone cannot authorize receipt replay.

Every group begins with a locking update of its owner's current epoch row. Each
command has its own savepoint and command timestamp. Its application writes,
receipt, event sequence allocation and any alarm changes share that transaction.
A failed command rolls back its own effects without consuming sequence numbers.
Existing events.position cursors remain intact; they are not a gap-free
sequence. Owner events.seq must be allocated transactionally rather than by
BIGSERIAL.

No single-write shortcut, content-adoption fallback or nested transaction may
commit independently. Materialization publication, event dispatch, cache notices
and caller results remain behind the outer durable commit. Post-commit dispatch
uses a separately bounded, ordered delivery queue outside the serialized
command-loop critical section, so dependent worker calls cannot block the owner
behind the execution they need to finish.

Receipts compare stable logical intent independently of execution attempts,
connection generations and owner epochs. Receipt recovery precedes retry
preparation. Authentication as the same worker permits a narrow owner-scoped
receipt read after takeover; it does not restore mutation or protected-value
hydration authority.

An uncertain commit stops the holder. A successor reacquires through the locking
epoch row and resolves receipts before accepting new commands. Reconnecting a
SQL session does not make the previous epoch ready again.

### Approved transaction replay contract

The legacy local Collection transaction API recomputes callback return values
and supports some partial-plan retries under one operation key. A whole-command
owner receipt instead requires compatibility of the entire ordered intent and a
durable operation result. The existing implementation remains untouched while
the internal command boundary is built. Before public integration, both
in-process and connected owner paths must use the same canonical-plan replay
rules. The approved contract keeps callback return values as local computation;
the owner records canonical ordered operations and their durable outcome.
Same-key retries with a changed whole plan fail in both placements. Closures and
arbitrary callback returns are never wire payloads.

An internal shared planner now implements this separation for the bounded JSON
Collection subset. It reruns the local callback on replay, returns only stable
ID references during planning, drains outstanding registrations, and submits
only registered operation data. It never executes Collection mutate functions on
the caller. Reads, write options, content, relations and vectors fail explicitly
until their owner-bound capability paths exist. This planner does not yet
migrate the public context or choose the factory API.

## Connected execution and Views

The target path is an ingress-capable HTTP worker, owner/dispatcher, Action
worker, owner mutation, authorized owner-rendered context, then worker output.
Only the owner opens persistence. A real Processor reacts after durability.
Recording model/channel adapters provide evidence without live provider calls.

Worker identity, provisioning attempt, incarnation, connection generation,
execution attempt/lease and owner epoch remain separate. Payloads can reference
an assignment but cannot manufacture its authority. Named-owner unavailability
must refuse or wait boundedly, never select another ordinary workload target.
Forwarded HTTP authority retains the caller's route-specific exposure and
constraints; the worker's own grant cannot widen it.

Reverse/control admission is bounded independently of dependent execution slots.
The complete HTTP-to-Action-to-owner cycle must progress or refuse boundedly at
saturation, including when waiting HTTP handlers occupy all Action capacity.
Cancellation, half-close, connection replacement and ambiguous completion retain
the transport's guarantees.

Owner context rendering uses an explicit authorized data-reference binding.
Hidden/protected fields cannot enter the generic fallback. The first captured
context remains stable across retries even if its source changes. Rendering does
not declassify protected values into unlabelled worker text. Channel rendering
prepares output; the renderer itself does not deliver it.

## Implemented internal prerequisites

- Fenced outer transactions and per-command savepoints, reference-only
  Collection receipts, insertion-time owner event sequence, command-time lease
  checks, and bounded ordered post-commit scheduling
- Registered JSON Collection operations against existing nodes, edges and
  events; content operations and snapshots fail explicitly in this subset
- Private owner-call adapter with bounded aggregate bodies, host-derived
  assignment authority, cancellation, narrow same-worker receipt recovery, and
  conservative unknown outcomes after possible execution
- Real sibling Oxian in-process and WebSocket tests; normal test runs skip these
  two opt-in cases unless `COPILOTZ_OXIAN_SOURCE_ROOT` selects that checkout.
  The [portable sibling fixture runner](owner-connected-testing.md) validates an
  explicit checkout and derives its scoped dependencies without changing
  production pins or requiring a machine-specific test configuration
- Private Context-resource-to-View bindings with mandatory authorized projection
  and an input hook inside the actual `callLlm.prepare` capture callback. An
  invoked receipt replay skips projection and rendering even after source data,
  resources and View implementations change

The prompt hook is not connected to the default message router. Public owner
factories, HTTP/Action worker placement, protected View output preparation, full
readiness/reconciliation, restart alarm discovery, real PostgreSQL
connection-loss recovery and a default owner-bound Collection context remain
unfinished. PGlite transaction tests and injected unknown-commit failures do not
prove a real PostgreSQL ambiguous-COMMIT recovery protocol.

## Evidence ledger

Completed for the View checkpoint:

- Registry, composition, factory, build and package tests: 113 passed, one
  PostgreSQL-only ignore
- Execution compatibility batch: 183 passed, ten PostgreSQL-only ignores; two
  application tests overlap the preceding batch
- Native Node renderer tests: 15 passed
- Architecture and package checks passed
- Quiet serial parallel-plan tests passed on pristine main and candidate

The full repository suite remains incomplete. An earlier aggregate-only
parallel-Tool failure remains unexplained; quiet targeted success does not prove
that failure is preexisting.

Current owner-checkpoint verification:

- Owner boundary, private connection, Collection command and event sequence: 49
  passed
- Shared callback planner: nine tests cover local non-JSON returns, canonical
  replay on direct/encoded ports, stable references, failures and lifetime
- Actual sibling in-process and WebSocket Collection/Processor/View fixtures:
  two passed, including captured-text replay and commit-gated output
- Owner kernel, Context View capture, plugin boundary/layout and selected
  existing Collection/prompt regressions: 34 passed, seven PostgreSQL-only
  ignores
- Entire existing events suite: 39 passed, two PostgreSQL-only ignores
- Package contracts: 28 passed; generated/core-ownership checks passed

Current owner-checkpoint verification also exposes an intentional unfinished
integration gate: `deno task check` fails package reachability for the internal
`runtime/owner/{boundary,collections,connection,schema,transaction}.ts` modules.
They are not wired into the exported production graph yet. The checker remains
unchanged; no provisional public export is added merely to bypass that gate.
This draft is not release-ready.

Required for the owner slice:

- Real-table atomic mutation, compatible/conflicting receipts and whole-group
  rollback; one failed command between successful commands
- No visibility or dispatch before outer commit; gap-free sequence after
  savepoint/outer rollback; command-time lease checks
- Stale owner, connection and execution attempt refusal; bounded queues
- Same-worker cross-epoch receipt recovery without renewed mutation/hydration
- Unknown-commit stop and successor recovery; restart alarm discovery
- Complete connected flow and the same interface in process, including
  saturation
- Authorized pure View projection, first-capture replay, cancellation and
  cleanup

Content writers, snapshots, full readiness/reconciliation, cross-shard routing,
live change repair, complete host-specific builds and live React rendering
retain their separate obligations. A narrow Collection fixture is not phase
completion.

### Capability-only Action context seam

The existing direct Action host and engine now share
`runtime/actions/execution-context.ts` for invocation context assembly. Its
executable dependency closure contains only that assembly, transaction identity
composition and the private protected-event resolver attachment. Storage-related
types are erased imports; no persistence constructor, SQL driver, Collection
kernel or content storage implementation is loaded by this seam.

This is a behavior-preserving prerequisite. The existing host and engine still
own their previous persistence/lifecycle behavior. A database-free general
worker must additionally supply owner-bound capabilities, named owner
preparation, claim/lease/settlement authority and explicit refusals for
capabilities that have not been converted. This extraction alone does not
establish that worker or public embedded/connected parity.

### Ephemeral current-authorized projections

The internal owner boundary also accepts named trusted projection handlers. They
share command queue bounds, the exact owner fence, current authorization,
cancellation and output gating, but do not write receipts or receive mutation or
publication helpers. Handler SQL is trusted core implementation, not a sandbox
or an automatically read-only SQL executor; registered projection handlers must
not perform business writes.

A durable claim records safe job/delivery references. Input hydration is a
separate current-authorized projection, never parentless receipt recovery.
Cancellation or owner retirement while COMMIT is in flight suppresses projected
output, even after its handler has finished. Durable mutation receipt semantics
are unchanged. Transport delivery and full claim/attempt integration remain
separate acceptance gates.
