# Native directory Collection commands

## Current code

`runtime/authorization/directory-command.ts:130` joins the source owner command,
locks the attached destination epoch, checks source policy and the declaration's
independent destination authorization, and records atomic replay/audit receipts.
Its executor is SQL-only. `runtime/collections/kernel.ts:4400` already adopts a
real owner command, preserving Collection planning, reduction, validation,
indexes and events. `runtime/events/store.ts:1147` registers publication through
that command's after-commit gate. `runtime/engine/commands.ts:530` owns command
contexts and publication queues; a context cannot be fabricated by app code.

## Contract

Extend `defineDatabaseDirectoryCommand` with `collections`, a fixed map from
**destination composition alias** to allowed native methods. Methods are `get`,
`create`, and declared custom command names. Execute receives `collections` with
those exact methods. Custom commands retain their native
`commands.name({ id, ...input })` shape. No caller-selected schema, namespace,
Collection definition, write options, transaction boundary, credentials or
operation-start capability is exposed. Physical tenant provisioning stays
host-owned, before route activation.

Use native Collection commands rather than a membership-specific reducer. This
keeps schemas, indexes, command validation and domain invariants in the existing
Collection definitions without adding a second persistence model. SQL remains
available for trusted service tables and fresh joined source reads; it must not
write native storage.

The owner registers its existing Collection runtime and definitions privately.
The directory command resolves this registration from the live durable owner
identity, not a captured app handle. Unknown aliases, methods or missing
policies fail closed. The source policy must grant the directory command; its
independent destination authorize callback must allow the request; every native
operation also runs the destination Collection's registered policy. That policy
receives the unchanged source authority and invocation plus an owner-created
`directory` provenance input naming the fixed destination and command. Its
declared reads use the destination namespace. Source credential/flow validity is
checked at source admission and the final transaction gate; it is never
reinterpreted as a destination credential. Delegation exists only in an internal
live invocation, never as retained or worker-supplied evidence.

## Transaction and publication

Add a private owner join primitive: lock and verify the attached destination
holder/epoch in the existing SQL transaction, run a real destination owner
command on a revocable SQL facade, and retain its guards through the outer
commit gate. The same owner command machinery creates the context, refreshes
alarms and queues publication on the destination owner. No independent SQL
commit or owner acquisition is permitted. The destination lifetime remains
retained until the outer transaction finishes, including rollback.

Execute runs inside native destination Collection transaction planning. Its
repository exposes only declared methods and is revoked on callback return.
Planning drains submitted work, and a caught method failure poisons the command.
A later source/destination denial or exception rolls back records, events,
indexes, credentials and receipts together. Publication callbacks are released
only after confirmed outer commit; rollback or unknown commit publishes nothing.
Replay uses the existing directory receipt and does not rerun native commands or
publish duplicate events. Private receipts additionally retain native policy
intents (bounded to 1 MiB) and recheck them against fresh destination records
and policy before returning the retained result. Audits contain no record
payloads. Destination publication uses its own coordinator, epoch, alarm driver
and shutdown drain, never the source owner's routing.

## Tests and risks

Real PGlite and PostgreSQL fixtures create a source account/session and
destination login index/tenant route, including custom membership reduction.
Observe native destination subscriptions and processors; verify indexes, event
count and replay. Deny source policy, declaration authorization, and destination
Collection policy; throw after planning; attempt unrelated Collection access and
escaped repository use. Assert exact refusals, no
state/effects/events/publication, and atomic rollback. Exercise destination
epoch loss and lifetime/commit guards.

Cross-schema transactions can deadlock if concurrent commands acquire owners in
opposite order; database deadlock detection must abort the whole command safely.
This API requires both owners attached in the same process and physical
database. It does not provision schemas or support distributed transactions.
Keep changes to the engine limited to real owner transaction adoption and
registration.

## Implementation and validation notes

The destination owner creates an ordinary command context via its existing
command runner (`commands.ts`); SQL completion aliases share the source commit
and rollback gates. Joined work and publication reservations participate in the
destination shutdown drain. Source and destination guards are retained through
the outer result gate. The native bridge is private to owner composition and
exposes no host trust or caller-controlled command context.

Destination policy sees source identity plus explicit directory provenance; its
resource mapping selects its own policy revision, independently of the source
policy id. Destination events retain source caller provenance. Processor
publication is ordinary destination delivery and does not confer directory
mutation privileges or bypass flow bounds.

No public surface was removed. The SQL-only callback restriction is replaced by
this bounded native repository; the source API and SQL service path remain one
command/receipt implementation. Existing SQL-only replay intent shapes remain
unchanged. Native command declaration changes are included in receipt identity.

Regression coverage includes native first-login creation and custom membership
reduction, indexed reads, one destination subscription update and Processor
delivery, exact refusal codes, atomic rollback, receipt replay and revoked
handles. Multiple attached compositions matching the declared aliases refuse;
closing a composition unregisters it. The real transport identity/flow matrix
also performs native destination writes. Joined-owner tests cover destination
epoch loss and shutdown while the source transaction is still open. These
targeted regressions pass on PGlite and PostgreSQL. Full-suite results,
including load-sensitive baseline failures, are recorded separately in the lane
report.
