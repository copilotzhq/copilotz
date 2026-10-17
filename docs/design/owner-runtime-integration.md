# Owner runtime integration

Status: implementation in progress. The bounded View foundation is available;
owner transaction boundaries, worker-to-owner calls and execution integration
are being developed. This document describes the intended guarantees and the
evidence still required. It does not certify full owner or wire conformance.

## Approved simplification in progress

The [owner-controlled attempt amendment](owner-attempt-authority.md) supersedes
per-job worker leases, renewal heartbeats and running-attempt alarm maintenance.
The current patch is under validation. Earlier checkpoint sections below retain
the historical tests/implementation that introduced those mechanisms; they are
not a requirement to keep them. Epoch/session/attempt authority, independent
clocks, raw drain and effect uncertainty remain required.

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

### Logical identity and replacement workers

Owner command identity is `(owner, domain, key)`. The original `worker_id` on a
receipt is provenance, not an extra deduplication dimension. An authorized
compatible replay records a receipt-reader association in the same transaction;
only those associated authenticated workers can use parentless recovery.
Guessing a key or submitting conflicting intent never grants that read
association. Record IDs and Collection/event step identities bind stable
invocation identity, not the current execution worker. Exact
attempt/session/epoch checks still gate commands independently of logical
replay. The private schema validator rejects the older worker-partitioned
receipt key; this is fresh-schema support, not an existing-data migration.

### Registered Action worker prerequisite

The private registered worker holds the complete plugin registry and executes a
registered ordinary-JSON Action using capability-only context assembly and the
shared transaction planner. Named owner ports require a durable claim before
current-authorized input projection; completion and recovery return safe
references. Captured capability signals expire on every exit before settlement,
unsupported capabilities remain latched failures even if Action code catches
them, and an ambiguous completion never automatically reexecutes business code.
An executable import-closure contract excludes database/persistence runtimes.

This bounded prerequisite does not yet compose the actual owner lifecycle ports,
Processor dispatch, public factory or default HTTP execution. Its capacity is a
worker-lifetime assignment bound including completed entries and ambiguous
attempts; a full instance requires host-coordinated recovery/replacement, rather
than silently recycling unresolved execution identities.

Owner-backed lifecycle insertion can pass the captured command timestamp through
`createActionLifecycleAppender` into its existing delivery lease predicate.
Legacy callers retain their database-time behavior. Receipt replay still needs
current assignment/lease authorization before deduplication; insertion-time
ownership checks alone do not authorize replay.

The private `copilotz.owner.complete` route is limited to logical
`execution.complete` commands. Its current host assignment settlement grant is
separate from the general context grant; parentless completion is refused. The
boundary still revalidates current assignment/lease authority before replay. A
data-only shared worker port maps fixed claim/input/completion operations and
safe receipt recovery. It can recover a settled exact assignment from reference
receipts, but an incomplete prior claim refuses execution rather than guessing
whether business work previously ran. No SQL implementation enters this mapper.

The private inert readiness probe verifies the exact owner protocol/features
through a separately authenticated parentless route. Its host readiness check
runs again after body admission, and stopped/replaced owners cannot reply ready
after an asynchronous policy check. This confers no context or input authority.
Connected worker composition must repeat it for each transport session and gate
all user execution on that session's result. The data-only execution mapper is
per immutable authenticated parent assignment and privately binds its successful
claim reference before allowing completion; it cannot be rebound to another
assignment or complete using an old delivery/attempt reference.

### Named owner Action execution

The internal execution adapter now implements actual fenced claim, authorized
input projection and status-independent logical terminal completion using the
existing delivery, Action lifecycle, open-Action and operation-scope tables. It
revalidates the host-owned assignment/session/attempt before receipt lookup,
uses the command timestamp, preserves cancellation precedence, and records only
safe reference outcomes for recovery. Captured ordinary input is read only after
current authorization; unsupported protected/content/deferred forms refuse.
Failure codes are allowlisted so arbitrary worker strings cannot become safe
receipt output. Claim and terminal publication wait for outer durability.

Table-backed tests exercise a registered Action's owner Collection transaction
and a real existing Processor observer, rollback, lost completion reply, stale
assignment/lease/epoch, revoked input policy with restricted completion, and
competing terminal outcomes. The Processor in this fixture still uses the legacy
executor. Owner-only general Processor execution, lease renewal for long
Actions, complete readiness/recovery, and the common public factory remain
separate gates.

### Connected registered execution checkpoint

The private database-free owner-worker wrapper now composes the actual
registered Action lifecycle adapter over in-process and WebSocket transports. An
inert session-scoped readiness probe gates user execution; each WorkContext
receives its own immutable parent-bound owner port. Stale probes cannot stop a
replacement session, and a failed current probe stops that worker. The
selected-sibling runner covers readiness/claim/terminal output gates, current
SQL parent binding, restricted completion after ctx revocation, and ambiguous
claim refusal without rerunning user code. Twelve actual transport cases pass,
with separate lifecycle, source-import-closure and runner setup checks.

This remains internal composition. Its Processor observer uses the legacy
executor. Public common factory/facade, owner-only Processors, general lease
renewal, full readiness/recovery and HTTP ingress still have separate gates.

### Bounded expired-delivery recovery checkpoint

Owner-mode expired-delivery recovery now uses the fenced command executor and
captured time, including body-bearing terminal events. Up to100 scanned rows
share one ordered afterCommit publication callback, avoiding the command's
callback limit while still attempting later publications after one failure. Nine
actual-table recovery cases cover rollback of bodies/receipts/readers, alarms,
authority, duplicates and unknown outcomes;20 focused and41 legacy tests pass
(two legacy PostgreSQL opt-ins ignored). Full catalog reconciliation,
effect-aware replay, continuation discovery and alarm readiness remain open.

### Pure authoring import prerequisite

Action definition validation now obtains its unchanged secret-schema predicate
from the pure secret module; protected lifecycle keeps the same re-export. An
emitted-ESM closure test proves ordinary definition imports do not evaluate
persistence/body-store code, including the distinction between erased type
imports and retained empty runtime imports. Nineteen focused authoring/protected
lifecycle tests pass. The role-specific whole-application bundle and public
factory mapping remain separate integration work.

### Ordinary execution lease renewal

Registered Action execution now uses owner-fenced renewal occurrence identities
and one serial bounded heartbeat tied to its immutable assignment/session.
Current authority is checked even on duplicate renewal, deadlines conservatively
discount transit time, and renewal drains before completion. Refusal or
uncertain renewal closes execution capabilities; late replies cannot reactivate
them. A reproduced timeout/abort race is latched as uncertainty rather than safe
failure. Independent54 worker/mapper/actual-table cases and14 real sibling
transport cases pass, including Actions longer than their original lease. This
does not implement open-body renewal or effect-aware recovery.

### Named input normalization boundary

Private executeInput commands snapshot bounded payloads and run their registered
normalizer inside the command savepoint before current authorization or receipt
lookup. Caller-provided digests cannot bypass that definition. Authorization and
the handler receive separate normalized snapshots; receipts store only the
derived canonical intent and safe result. Plain execute refuses these kinds.
Nine real-table tests cover payload mutation, current-policy duplicate checks,
rollback, bounds, cancellation and owner stop during normalization. The stopped
owner lifetime gap was reproduced before fixing. Existing boundary/connection
compatibility passes59 cases. Root admission and its public transport remain
separate integration work.

### Registered root admission prerequisite

Named Action admission derives its versioned canonical digest from the entire
normalized input/metadata/provenance payload, then persists only safe refs in
receipts and the original input in the existing body/event/delivery path.
Current host policy must validate trusted provenance and scope before every
receipt lookup, including compatible replay. Fourteen actual-table tests prove
canonical replay/conflict, atomic bounded admission (default128 pending rows),
rollback, original capture and outer-commit scheduling. Normal three-attempt
policy remains unchanged. Protected/content/deferred Actions and data that the
legacy content canonicalizer would alter are explicitly refused in this subset.
The trusted constraints absent-key codec and admission-group policy remain
integration work. Public scheduling is not enabled before effect-aware recovery.

### Durable assignment reservations

A narrow owner assignment control table binds the exact worker provisioning,
connection/session generation, parent stream/operation and dispatch attempt to
existing source event/delivery and logical Action refs. Reservation is fenced,
capacity-bounded and unique per live delivery. It does not grant execution:
resolution checks fresh current Started transport state before and after SQL.
Retirement revokes future commands without touching business/effect outcomes or
receipt-reader associations; successor owners can retire old-epoch reservations.
Ten actual-table cases and independent review cover tuple mismatches, no-Open
recovery, rollback, currentness races and exact schema validation. The original
nullable-retired schema defect was reproduced and fixed. Real PostgreSQL schema
validation and production pre-Open dispatch wiring remain separate gates.

### External-effect receipt core

Fixed logical effect steps record begun/confirmed/not-started state through the
same fenced receipt boundary. A stored receipt never contains a reusable proceed
permission: only a fresh known-committed begin acknowledgement permits dispatch;
duplicate or ambiguous replies consult current state and cannot resend. Confirm
and not-started are mutually exclusive, with current settlement authorization
and owner-verified exact dispatch evidence. Nineteen independently reviewed
owner/client/emitted-closure cases cover lost commit replies, takeover,
conflicting outcomes, forged evidence and revocation-safe settlement. The pure
worker client has no persistence runtime imports. Action context/reconcile
integration, provider conversion and effect-aware lost-delivery recovery remain
subsequent gates.

### Authorized Action results

Current-authorized projections read original admission and lifecycle data
through the owner transaction without adding receipts. Distinct internal
purposes preserve three waiting boundaries: ordinary Action calls wait for their
terminal receipt, HTTP results additionally wait for that Action's own streams,
and operation results wait for authoritative catalog settlement. Sixteen
independently reviewed actual- table cases cover exact source/run/delivery
binding, current policy, cancellation, rollback and historical
protected/content-shaped value refusal. Production ingress and facade wiring
remain pending; projection never infers operation completion.

### Trusted admission groups and metadata restrictions

New admissions can select their trusted group through current host policy inside
the fenced transaction. The existing key/actor grouping is capped atomically
at32 accepted/running catalog operations and recorded with the original
operation. Compatible replay does not allocate a slot or rewrite that original
group when policy grouping changes; current authorization still precedes replay.
The separate owner pending-delivery cap remains128. A private values/absentKeys
codec preserves explicit undefined metadata restrictions across transport; null
and omission do not satisfy absence. Independent16 admission plus3 codec tests
pass. Nested ContentRef inputs now refuse before capture to match this
ordinary-result subset. Actual ingress must reconstruct and enforce current
trusted policy using these seams; the codecs and selectors do not themselves
confer authority.

The group selector carries generic trusted operation metadata; conversational
field mapping stays in the server/host layer. Reserved identity-key collisions
are rejected. The unchanged architecture rule caught the initial conversational
field in this runtime seam; the retained correction passes focused group tests
and all four filtered runtime architecture checks without changing the rule.

### Two-phase owner operation settlement

The existing catalog readiness and terminal transition now have a transaction-
only owner seam. Durable alarms and post-commit wakeups schedule bounded checks;
successful current relay drains happen outside SQL, followed by a fresh fenced
readiness check. Terminal catalog state, semantic owner-sequenced event, receipt
and alarm removal commit atomically. Rejected/ambiguous drains cannot be
replayed; unresolved checks retain capacity and post-submission timeouts remain
unknown. Claim and completion scheduling is commit-gated; renewals and
duplicates do not republish. Captured time and original source correlation
propagate through Action recovery/terminal events. Independent stabilized
settlement13 and execution settlement6 cases pass, with earlier remaining
execution24 and legacy17 evidence. Actual host alarm recovery, retained relay
reservations and readiness composition remain required; result projection does
not substitute for this terminalization.

### Action effect capabilities and declared reconciliation

Action definitions can declare reconciliation with explicit confirmed,
not-started-evidence or indeterminate outcomes. The invocation-bound effect
capability uses named owner ports, drains pending calls before terminal
settlement, refuses missing capabilities and cyclic reconciliation dependencies,
and never reissues proceed from a repeated step. Pure client/worker import
closure remains database-free. The reviewed checkpoint passes72 focused cases,8
native Node pure cases and46 independent cases. Restricted transport effect
routes, provider conversion and effect-aware owner recovery remain required
before general retry.

### Fixed root Action transport routes

Parentless Action admission and ordinary result projection have separate,
default-deny current ingress authentication. Readiness, receipt recovery and
worker ctx grants confer no root route authority. Exact owner and immutable host
binding are rechecked after body streaming; SQL authorization still checks
current policy/provenance/absence restrictions before replay or hydration. The
route only admits the registered Action input command and fixes result purpose
to ordinary Action terminal semantics. Independent36 connection cases pass,
including queued revocation, forged route/constraints and unknown admission
without retries. Final principal/route-policy and public facade composition
remain separate work.

### Durable dispatch bridge

The private host bridge waits for known durable assignment binding before Open,
keeps bounded scheduled-reference and call-witness maps, and revokes authority
synchronously on cancellation/completion. Only Oxian's validated live Started
reverse-call admission establishes a call witness; the earlier onStart callback
cannot grant execution. Current exact session/owner/full binding is checked in
SQL. Unknown binds stop the owner, and unresolved retirement stays visible and
charged for authoritative recovery. Nineteen independently reviewed table/port
cases and six unchanged architecture checks pass. Actual transport drop-Start
and assembled owner-host readiness remain the next integration proofs.

### Restricted effect transport

Current parent-bound effect settlement and safe effect-state routes are distinct
from privileged begin/ordinary commands. They accept only fixed registered
kinds, revalidate current SQL authority, and grant no parentless mutation or
arbitrary projection. Each worker effect port captures its own WorkContext. The
retained malformed-kind regression failed before strict type validation and now
passes; independent connection coverage is 39 cases plus the original
reproducer. Two wrapper lifecycle cases also pass. The expanded worker closure
and effect-aware retry gate are a separate pending checkpoint; provider
conversion remains open.

### Host-normalized ordinary Action calls

A private fixed Action-call route accepts only registered alias, ordinary input
and an optional local operation key. A mandatory host hook derives trusted
principal/route facts; current owner, ingress binding and cancellation are
rechecked after normalization. The derived named admission command is bounded
and independently authorized in SQL before replay. Unsupported call-option
fields refuse rather than disappear. All 41 connection tests pass independently.
Actual host policy normalization and the common public facade remain separate
work.

### Remaining-attempt effect recovery

Retry claims capture a bounded immutable inventory of prior effect obligations.
Before ordinary execution resumes, declared reconciliation runs outside SQL;
owner projection, mutations and successful completion remain fenced behind that
barrier. Confirmed outcomes replay without permission to send again, and closed
or unresolved steps cannot manufacture proceed. Trusted retry eligibility
defaults to refusal for unconverted implementations. Callback arguments are
detached from private assignment/input snapshots, with the reproduced mutation
regression retained. Independent review passed 64 cases plus 38 final
owner/isolation cases; local focused70, compatibility50 and
architecture/closure7 batches passed. The shared heartbeat extraction preserves
existing Action behavior. Exhausted recovery, provider conversion,
index/query-plan scaling evidence and full startup recovery remain separate
work; the default three-attempt policy is unchanged.

### Child Action and Processor routes

Fixed child admission/result routes require a current parent with ctx authority
and select only the registered child input/projection operations. Parentless and
settlement-only callers cannot use them. Restricted completion recognizes only
Action/logical and Processor/incarnation kind/domain pairs. Independent
connection coverage is 43 passing cases. Actual child/Processor policy,
execution and facade composition remain separate acceptance slices.

### Current parent proof for ordinary child calls

The private child-Action composition requires both asynchronous `resolveParent`
(current execution/Processor grants and input policy) and synchronous
`isCurrentParent` (the exact owner/Started caller lifetime). Neither substitutes
for the other. The host obtains the latter from the authenticated dispatch
bridge; copying a caller tuple does not create a Started witness.

After awaited child policy, and around admission/result work, the owner rechecks
its original parent coordinates, operation cancellation, open Action, absence of
parent terminal history, retry limit and exact PostgreSQL lease instant. It
compares the initially verified source/invoked bodies, including their contents
and digests, rather than assuming `event_bodies` is immutable. At most two
bodies are retained under the child JSON limits. The private proof follows an
internally returned parent clone; policy argument copies receive no proof.

Ordinary admission/result commands also opt into the transaction boundary's
final synchronous authorization fence through a captured, validated
`currentAuthorizationKinds` allowlist. Other host commands retain their existing
acknowledgement behavior; returning `true` from a globally installed fence would
not be equivalent to leaving those commands unfenced. This closes
receipt-reader, handler, savepoint and caller-visible completion windows after
the last awaited check. Lost authority rolls back pre-commit work; post-commit
loss suppresses the reply without pretending that durable work did not commit.
Prepared admission is not silently opted into the ordinary command proof.
Private fresh local parents use the same ordinary proof as described below;
local named preparation remains unavailable.

Ordinary child input and result traversal refuses all four reserved protected
schema families, including bare, future-version, malformed-suffix and
array-wrapped markers. This adds no protected-format reader or decryption path.
The shared scalar family predicate does not impose the preparation/startup
guard's broader reserved-key policy: ordinary application fields such as
`assetId`, `location` and secret-looking labels remain valid unless they form an
existing ContentRef or carry a reserved protected schema marker.

### Private local parents and mixed child placement

The private fresh owner host now composes ordinary child calls for both local
Actions and local Processors. Local parents can call worker or local children;
worker parents can call selected local Actions. The public placement selector,
retained local history and cross-owner recovery are not activated by this step.

Worker parent wire coordinates remain `deliveryId` / `dispatchAttemptId`. Local
coordinates are explicitly `placement: "owner-local"`, `deliveryId` /
`attemptId`; mixed, inherited, accessor and own-undefined fields are refused.
These selectors never grant authority. The owner resolves the actual private
handle, current business grants, durable reservation, epoch/holder, exact
NULL-lease representation and, for Processors, the exact attempt ordinal. The
logical child key/digest excludes placement and physical attempt, so a new local
Processor attempt can reuse its one previously completed child.

One shared local adapter wraps the existing child waiter. Each actual input
admission and result projection is charged through the parent's raw-call
tracker, below cancellation/timeout races. The parent remains charged while it
waits; unresolved raw work delays shutdown. Unknown admission cannot become a
retry or terminal receipt, and revocation cannot expose a late result. Local
EventStore mutations derive their `ownerAttempt` from the verified binding.

The existing aggregate capacity guard remains in force: fresh child admission at
full capacity refuses before creating a child event or receipt. It does not park
the parent or silently release its slot. Compatible receipt reuse remains
possible at capacity. A parent slot releases only after a known terminal commit
and actual drain. The private captured `childWaitMs` budget defaults to
30,000ms, accepts integers from 1 through 60,000, and does not cancel durable
child work. Timing out before an admission reply remains an unknown outcome,
distinct from a known capacity refusal.

Local named preparation is rejected both at the bound capability and the owner
entry. Private local Action effects now reuse the shared owner protocol and
policy, with the same exact-attempt and raw-call drain checks; local effect
activation does not enable Processor effects or retained local history. Ordinary
children retain the shared ContentRef/protected-format refusal without adopting
a broader reserved-key policy. This is private same-owner capability parity, not
a public configuration or restart migration.

### Fresh ordinary Action owner host

A private fresh-schema host composes the real fenced boundary, current ingress
policy, durable assignment bridge, registered worker, Collection/effect
commands, Action lifecycle and catalog settlement. Five independently repeated
actual-table cases use both sibling in-process and WebSocket transports. Simple
Action keys include trusted principal and registered target identity; current
policy and original metadata constraints are checked on replay/results. The host
refuses nonfresh activation instead of claiming restart recovery.
Processor/child host composition, actual dropped-Start negative proof,
owner-local execution, public factory, protected/content/stream support and
default Views remain open. Transport fixtures still require the explicit
unpublished sibling mapping.

### Common ordinary Action caller

The internal typed ActionCaller component shares output semantics across owner
placements. It preserves trimmed/blank operation-key behavior, admits once and
polls only current-authorized ordinary terminal results. Duration and concurrent
waits are bounded; noncooperative requests retain reservations. Interrupted or
malformed admission replies remain indeterminate with the requested identity;
interruption after a known admission retains a safe reference and does not imply
durable cancellation. Unsupported options and prepare refuse before admission.
Eight independent typed cases and the five actual host cases using this facade
pass. This is the common Action component, not the complete public constructor
or Collection/content/protected facade.

### Exhausted and abandoned effect recovery

The existing fenced delivery failure/cancellation path now retains begun effect
receipts while recording a safe effect-indeterminate Action failure when needed.
Exhaustion remains DeliveryLeaseExpired; no extra mutation attempts or invented
recovery delivery are added. Ordinary failure consumers and settlement alarms
commit atomically, and a bounded wake batch avoids callback-cap starvation.
Abandoned nested obligations use the same effect inventory. Independent ten-case
recovery review, local20 recovery/compatibility and32 execution/architecture
cases pass. Startup/takeover composition and declared awaitOperation
continuations are still open; ordinary failure-consumer delivery is not a
substitute for resume.

### Collection-created detached operations

Private owner Collection composition can attach the existing operation catalog
hooks, with schema equality checked up front. Real Collection events now admit
and index detached Processor scopes in the same outer transaction. The retained
regression proves the actual parent event/catalog relationship and complete
rollback; no operation row is fabricated by the fixture. Four independently
reviewed Collection cases pass. Host Processor routing remains a separate step.

### Named child Action admission and result capability

Child commands reconstruct current durable Action/Processor parent authority,
retain inherited/detached scope and target-scoped logical identity, and
authorize before replay or result hydration. Stable parent identity excludes
transient attempt coordinates. The pure port admits once, bounds waits/capacity
and retains unresolved reservations; interrupted admission is unknown, while a
known admitted wait retains safe recovery references. Independent21
owner/port/reproducer cases and final10 strict-codec/abort cases pass. Actual
general-plugin host dispatch and Action nested-call wrappers remain separate
integration work.

### Registered Processor owner execution

Current-table Processor claim, projection, renewal and settlement now share the
owner fence and command timestamp. Current event policy is rechecked before
Collection/child replay; restricted settlement remains possible after ctx
revocation. The database-free worker preserves onError acknowledgment, existing
retry/backoff and detached scope semantics, latches unsupported capabilities and
uses exact literal completion codes. Independent64 cases plus16 final
owner-policy cases pass. Assignment/bridge unions and the connected workload are
included in this same coherent checkpoint because the child capability and
Processor graph depend on one another. Full general-plugin host transport
remains the next proof; owner-local mode is still separate from this leased
worker path.

### Digest-bound ordinary Action completion

Action completion uses the registered normalized-input boundary. A versioned
canonical digest binds namespace, stable run identity and every terminal fact;
ordinary output is retained in the existing lifecycle body rather than command
receipt intent. Current assignment, immutable registered target and output
policy are checked before receipt lookup. Plain command execution cannot bypass
this normalizer. Settled attempts retain the existing restricted safe-receipt
recovery rules, without regaining execution or input authority. Processor
completion keeps its fixed safe envelope. The migration passed 105 typed
compatibility cases, focused canonical-order/changed-fact/identity/bypass checks
and all 14 actual in-process/WebSocket sibling transport cases.
Protected/content output and the published dependency integration remain
separate requirements.

### Current captured-input authorization before mutations

Action Collection/child/effect-begin authority now rechecks the current input
policy against detached copies of the original captured input and assignment.
Revocation refuses both new commands and compatible mutation replay, while the
separate restricted settlement route can record already-started effects and safe
failure completion. Completion success also checks cancellation/effect recovery
before output validation and before receipt lookup, preserving the existing
fixed uncertainty classification. The revoked-input failure was reproduced
before fixing; final serial execution29 and recovery11 pass, independently41
including the original reproduction. An earlier concurrent rerun was killed with
exit137 and is not counted as completed evidence.

### Fresh general-plugin host composition

The fresh owner now dispatches registered Actions and Processors, including
Action-to-child and Collection-to-Processor-to-child mutation flows. Current
parent/event policies are checked before writes and replay. Inherited/detached
catalog scopes, three-attempt retry timing and renewed lease alarm deadlines
remain durable. Capacity-one and concurrent-root saturation refuse or time out
boundedly without stopping the owner; an already admitted child remains durable
and can finish when a slot becomes free. Independent actual-table sibling
in-process/WebSocket acceptance passed11/11. This still excludes
restart/takeover, owner-local epoch-only execution,
protected/content/deferred/custom frames and full output/continuation recovery.
Ordinary Action terminal results remain distinct from operation settlement.

### Owner-local delivery authority prerequisite

An internal EventStore command can bind one exact local delivery/attempt under
its current owner epoch/holder fence. Such a claim has no wall-clock deadline;
settlement checks the exact token and NULL deadline, and local heartbeat,
claimNext and generic recovery remain refused. Worker deadlines and heartbeat
semantics are unchanged; a worker row with NULL expiry grants no authority. The
supplied tuple is privately copied. Five new cases plus existing delivery and
event-store compatibility passed36 tests with one existing PostgreSQL skip;
independent local/owner delivery acceptance passed11. This does not enable an
owner-local host yet: Action writer fencing, durable placement and takeover
classification remain separate prerequisites.

The local Action lifecycle writer now independently locks the same epoch/holder
and exact delivery/token before lifecycle insertion. It validates the schema,
transaction and private authority snapshot before preparation, including
captured coordinator/protected-storage callbacks. This is still a low-level
prerequisite.

Local event mutations additionally require that exact delivery tuple before body
encoding, mutation callbacks or duplicate recovery. The row must remain leased
with a NULL deadline under the locking owner fence; the event statement repeats
the exact attempt gate. The lifecycle appender supplies the matching tuple when
absent and refuses an explicitly different tuple before preparation. Event-only
writes do not require a publication callback; ordinary delivery transitions keep
their existing callback requirement. Worker deadline checks and owner-control
writes without local attempt authority are unchanged. Durable placement,
owner-created local execution and old-epoch loss recovery remain unfinished.

### Explicit principals and original-attempt recovery evidence

The internal owner caller now distinguishes authenticated workers, current
owner-control commands and exact owner-local attempts. Owner principals bind the
owner ID, epoch and holder; local principals additionally bind delivery and
attempt. The boundary checks these coordinates before command authorization.
Transport routes construct worker principals from authenticated transport facts;
request payloads cannot select control or local authority. Assignment liveness
and current policy remain separate checks. These tags do not by themselves
enable a local executor.

Logical receipt identity remains owner/domain/key, independent of worker or
attempt. Fresh private schemas store canonical tagged principal identities for
provenance and reader associations. The ordinary recovery endpoint remains
worker-only and requires the authenticated associated worker; control/local
callers cannot use it as a general cross-epoch read capability. The previous
private worker-only schema is refused rather than silently migrated. There is no
production-data migration in this increment.

Automatic retry eligibility must have evidence from the original admitted
attempt. A prospective versioned execution-contract witness binds that attempt's
registered Action, source/run/delivery and exact worker assignment. It is
recorded only on a fresh first claim that the trusted host explicitly authorizes
under the converted effect protocol. A later deployment or policy change cannot
upgrade an old receipt or add missing historical evidence. Replacement execution
still requires current exact-assignment approval, captured-input authorization
and the effect-recovery barrier. The witness does not authorize dispatch, prove
that an external effect did not start, or complete restart readiness. Logical
operation identities do not incorporate deployment hashes.

### Placement-neutral invocation kernels

Action and Processor invocation/context assembly is shared independently of the
leased worker drivers. The drivers still own claim, projection, heartbeat,
completion, assignment replay and lifetime accounting. The pure kernels receive
prebound capabilities and ordinary logical coordinates; Collection planning
needs only owner and invocation identity. Worker replacement remains an
authorization concern and does not change generated record IDs. Pending calls,
effect recovery, Processor error acknowledgement and unknown completion retain
their existing semantics. Authored reconciliation callbacks cannot receive the
private effect controller as their JavaScript receiver. The production role
graph includes only the two executable kernels; the shared type module is
erased. This extraction does not itself provide the owner-local attempt driver
or restart readiness.

### Explicit placement reservation storage

The fresh private assignment schema uses one tagged assignment key and one live
reservation per owner/delivery across worker and owner-local placements. Worker
bindings retain their exact authenticated transport coordinates. Local bindings
instead retain owner/epoch/holder, delivery/attempt, immutable source and a
closed Action or Processor target. Neither binding representation grants
execution by itself. Worker resolution still requires current transport Started
evidence; local resolution requires the host's exact private handle plus the
current owner fence. Both validate the durable source owner, namespace and
registered target.

History lookup is capped, checks complete stored bindings and refuses incomplete
or malformed evidence. Its unfiltered delivery-leading index also supports the
reconciliation anomaly scan without hiding foreign-owner rows. Prior retirement
matches the exact original binding and prior epoch under the successor fence.
The previous private transport-column schema is refused; this is not a data
migration. The existing conservative classifier validates local identities but
leaves them blocked pending a genuine local start/execution and loss-recovery
path. Resolving a pending local reservation does not prove a committed claim or
permit invoking plugin code.

### Atomic fresh owner-local Action prerequisite

A private control-authorized start now joins local reservation, exact
NULL-deadline claim and invoked-input capture in one fenced command transaction.
The host must explicitly authorize the current private start handle before
replay lookup and again after awaited input/preparation policy. A duplicate
start receipt does not permit another execution, and an ambiguous start outcome
cannot be retried as a new invocation. This fresh-only path does not manufacture
a historical recovery contract.

Subsequent local input and mutation authority uses the exact local principal,
current private handle, owner epoch/holder and delivery/attempt tuple. It
rechecks local liveness after awaited input and prepared-source policy before
releasing input or admitting mutation. Local attempts have no wall-clock lease
or heartbeat. Shared cancellation, effect-recovery and successful-completion
rules remain in force; terminal settlement retires the reservation atomically
and retains the same logical completion digest as worker placement. Publication
and returned values remain behind the outer commit.

At the original command-only checkpoint this seam was dormant and the host was
worker-only. Subsequent private host, Processor and ordinary child wiring is
described above. Public local placement and exact old-epoch local loss handling
remain separate integration and acceptance gates; in-process worker transport
must still not be confused with owner-local execution.

### Child result physical lineage prerequisite

Before exposing a pending, failed or completed child result, the shared child
reader now checks both the stored `parentDeliveryId` against the actual parent's
delivery and the child's source-event `causationId` against the actual parent's
source event. These supplement the existing logical run, correlation and scope
checks; they do not change child admission keys or receipt digests.

Six actual-history regressions independently corrupt either field after genuine
admission/completion and require refusal in all three result states. The fixture
only disables its immutable-event trigger inside its disposable corruption
transaction and restores it before commit. Refusal leaves every public base
table, receipt-read count and scheduled-publication list unchanged. This narrow
correction does not activate local parents, change ordinary-value policy, or
stand in for the separate final current-parent rechecks.

The corrected full child fixture passes 18 ordinary-checked cases on PGlite and
independent PostgreSQL, with no failures/skips. The independent run created and
dropped 19 fixture databases and stopped PostgreSQL; source/config/sibling
hashes and lint/format were verified. The six missing-rejection failures from
the committed pre-fix source are retained separately from an initial
failure-code setup correction.

### Optional final private-authorization fence

The owner boundary now accepts an optional, captured
`isCurrentAuthorization(tx, caller, command, time)` callback. It is a
synchronous private-lifetime witness, separate from the existing SQL/policy
`authorize` operation. Only literal `true` admits. Caller and command values are
detached; callback mutation cannot change persisted identity. The scoped
transaction is an identity token for this callback, not permission to run SQL
after its lifetime. An omitted callback preserves existing behavior and adds no
command JSON copy.

The fence runs after receipt lookup, after the handler/projection, before and
after reader association, and again for every successful command before the
outer transaction callback returns. This last check covers savepoint release and
revocation by a later command in the same group. Such pre-COMMIT loss uses
`owner_authorization_lost`, rolls back the relevant transaction, and follows the
existing definitive individual-retry rules without treating private caller loss
as owner-epoch loss.

It also runs before returning a scoped committed outcome. A loss during COMMIT
acknowledgement hides that outcome but does not retry or undo the committed
mutation, receipt or reader association. Every committed publication remains
eligible exactly once. Callback-induced owner stop or cancellation cannot be
masked by returning true. Async results are rejected and native Promise
continuations absorb rejection without invoking overridden callback methods.

The complete boundary fixture passes 38 ordinary-checked PGlite cases, including
fresh-handler rollback, duplicate lookup, reader insert, savepoint release,
later-command group revocation and post-COMMIT publication. This prerequisite is
opt-in; its original tests preceded the child consumer's exact proof and
current-parent witness. The later ordinary child wiring above installs those
proofs with explicit command-kind scope.

Independent ordinary-checked PostgreSQL validation also passes all 38 boundary
cases and the five unchanged explicit-URL PostgreSQL cases (including four
native child-process/proxy crash cases), with zero failures/skips. The two
frozen source hashes, 1,597-file archive, configs and sibling sources were
unchanged; lint/format passed. All 45 fixture databases were dropped and both
PostgreSQL runs stopped. The intentionally failing, not-yet-wired child
current-parent regressions were excluded from this isolated boundary
prerequisite.
