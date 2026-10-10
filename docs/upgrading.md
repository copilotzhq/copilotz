---
title: "Upgrading and Data Safety"
description: "Pin Copilotz versions, keep durable identities stable, evolve record schemas deliberately, and run explicit offline database upgrades without losing history."
section: Evolve
order: 20
status: stable
---

# Upgrading and Data Safety

## 0.87.0: Actions and Collections from the host

`createCopilotz` results gain `actions` and `collections`, matching the
`context.actions` and `context.collections` that Actions and Processors use.
Scripts, tests and seeds can now run an Action or write a record as its own
recorded operation, with an optional `idempotencyKey`, instead of sending an
Event to a Processor. The additions are additive: no data migration, and code
that annotates a result as `CopilotzApplication` keeps compiling, since its new
type parameters default to dynamic maps. HTTP ingress for Actions and Collection
mutations now shares its admission path with these host calls; routes,
identities and authorization are unchanged.

## 0.86.3: workflow origins and memory ownership

Memory maintenance no longer requires a human initiator. Core carries the
initiating participant and optional stable origin Message through continuations;
applications may use that reference instead of walking historical Tool plans.
Keep application permission checks against current resource state. Update
services that parse Core Tool metadata before producers emit `originMessageId`.
Existing checkpoints and snapshots need no migration.

## 0.86.2: preferred-model consolidation

Core now consolidates ordinary history when the first configured model exceeds
its input budget, even if a fallback fits. History capacity follows that
preferred model's prefix, input limit and output allowance. Provider failures
still use the configured fallback order; scoped maintenance turns retain their
own LLM admission behavior. Existing snapshots remain usable without a database
or memory migration.

## 0.86.1: native-state memory budgets

Memory consolidation now counts compatible native provider state using the same
wire protocol as LLM admission. A history with large encrypted reasoning blocks
triggers consolidation earlier and is reserved in smaller contiguous ranges. The
ordinary Agent prompt prefix, tool catalog, stored snapshots and native blocks
are preserved. This patch needs no database or memory migration.

## 0.86.0: lifecycle and plain memory notes

This release changes durable Action scheduling and the Memory plugin's public
contract. Deploy all workers together after stopping old writers and draining or
cancelling their in-flight work. Run `upgradeActionLifecycle` from
`@copilotz/copilotz/actions` for the existing indexed runtime schema. It refuses
an active database and preserves historical events. Read-only operation status
checks no longer perform recovery or settlement.

Actions may return `deferAction(work)` and implement
`resolve(input, context, resolution)`. The runtime schedules and fences their
work without interpreting plugin metadata. A pending Ask now stays open until
the asked turn, tools and nested Asks drain. Permanent delivery failures produce
ordinary Action failure terminals so tool pipelines can continue through their
normal error path.

Memory's tool input is now `{continuity, remember?, retire?}`. Remove
`resources.memory.kinds`, `defineMemoryKind`, graph/form/kind queries and grants
for `set_memory_status` or `invalidate_memory`. Search accepts
`{query?, limit?, includeRetired?}`; inspect accepts `{ids}`. Results return
`notes`, with `unavailableIds` on inspect. Use explicit note replacements and
retirements instead of domain status mutations.

There is **no memory data migration**. Keep existing `long_term_memory`
checkpoints and their continuity and history certificates unchanged. New writes
and reads use `memory_note`; historical `memory_record` rows stay in storage
without conversion or re-embedding. The context allowance now covers continuity
and both own and peer notes together. Check application settings against this
single budget.

Textual reasoning is no longer replayed in model input. Compatible native
provider reasoning state is retained intact, and provider-output reasoning
extraction remains available for display and diagnostics. Stored messages are
not rewritten.

## The pain

Your team-notes application has been running for weeks. Its database holds
Notes, completed operations and the Event history that browsers replay. A new
Copilotz release arrives, and someone also wants to rename `notes.capture` to
something clearer and add an optional `body` field to Note.

Each of those changes touches data that already exists. Suppose you bump the
package and restart without a plan. The new version can refuse to start because
its catalog check fails, or old workers can keep writing beside new ones.
Deliveries addressed to the old Processor ID stay outstanding with no consumer.
Browsers that resume from a stored cursor get `invalid_replay_cursor` instead of
history.

## The problem

Copilotz stores three independent things, and each one evolves differently:

1. **Physical schema.** The SQL tables for Events, Collections and Bodies are
   validated against Event schema v6. Startup provisions fresh Core tables and
   validates existing ones; incompatible Core schemas are rejected. Declared
   Collection indexes are provisioned separately as described below. Stored
   records are never reset or rewritten.
2. **Durable identities.** Plugin IDs, Collection names, Action IDs, Processor
   IDs, retry keys and call order are recorded in Events and deliveries. They
   behave like primary keys, not like labels.
3. **Your JSON records.** Collection schemas validate new writes. They do not
   backfill or rewrite records that are already stored, and there is no
   record-migration hook.

Installing a new library version changes none of these by itself. So you need an
explicit contract: what stays fixed, what you plan yourself, and which operator
steps a release requires.

## The solution

### Pin one release for every subpath

All public entrypoints (`/core`, `/events`, `/streams`, `/persistence`,
`/server` and the rest) belong to one package version and share one framework
identity. Choose one version range for the package, commit the lockfile that
records the exact resolved version, and upgrade every subpath together.

On Deno, edit the existing `imports` property in `deno.json`. Replace only the
`@copilotz/copilotz` entry and keep your other imports:

```json
{
  "imports": {
    "@copilotz/copilotz": "jsr:@copilotz/copilotz@^0.86.3"
  }
}
```

If Deno holds back a release published in the last 24 hours, see
[Before you start: Deno](./getting-started.md#deno).

On Node:

```sh
# Add the package from JSR and record the resolved version in the lockfile.
npx jsr add @copilotz/copilotz@^0.86.3
```

Generated or bundled plugins must keep framework imports external so that they
resolve to the same package. Before you upgrade, read every CHANGELOG entry
between your version and the target. An entry that names an operator step, such
as 0.85.0 below, needs that step before the new version serves traffic.

### Keep durable identities stable

- **Processor IDs.** Outstanding deliveries name their consumer as
  `processor:<id>`. If you rename a Processor, the new one does not inherit that
  work. Keep the ID and change the implementation, or drain the old deliveries
  before you remove it.
- **Collection names and Action IDs.** Records and recorded Action calls refer
  to them. Aliases such as `saveNote` can change in TypeScript; the ID
  `notes.save` cannot.
- **Retry keys and call order.** Keys such as
  `` `${context.operationKey}:save-note` `` and the Processor's `save-request`
  call key identify retried work. If you change them, or reorder Action calls
  inside one handler, an in-flight retry can repeat or skip work.
- **Plugin IDs.** Dependencies and generated plugins resolve by ID.

### Evolve record schemas deliberately

The optional `body` property added to Note works against existing text-only
Notes. Old records simply lack the field, and the change needs no SQL migration,
because the JSON schema lives in your definition rather than in the physical
tables. Do not generalize that to every schema edit. Making a field required,
changing a type, adding constraints old records violate, or splitting a record
all need an application-managed plan: read both shapes, update records through
your own Actions with stable keys, then tighten the schema. Copilotz backfills
nothing for you.

All namespaces in one physical schema share the same tables. A namespace
isolates data, not physical-schema changes; separate physical schemas are
upgraded separately.

Collection `indexes` are physical database declarations. Before serving this
release on an existing tenant schema or with validation-only startup, run
`provisionCollectionIndexes(session, schemaName, definitions)` with the complete
composed Collection definitions. Default database provisioning performs this
step automatically. It adds indexes and enforces declared uniqueness, but never
rewrites rows or drops old indexes. Resolve any duplicate-key violation through
an explicit data correction; provisioning does not choose which record to keep.
For populated PostgreSQL schemas, use the provisioning option
`{ concurrently: true }` from one standalone host operation to avoid blocking
normal writes. See [Collections](./collections.md#provision-declared-indexes).

### Test against disposable data only

Tests omit the database option and use the private in-memory default. If you
rehearse an upgrade, restore a backup into a fresh `file://` directory or a
scratch PostgreSQL database. Never point a test or rehearsal at existing data,
and never delete a data directory to "start over".

### Validate instead of provisioning at startup

By default an application provisions a fresh Event schema and operation catalog
at startup, and validates existing ones. If your database role should not create
them, set `engine: { provisionDefaultDatabaseSchema: false }` in the options you
pass to `createCopilotz`. Startup then validates the Event schema and the
operation catalog, and fails if either is missing or incompatible. An operator
must provision both beforehand, not just one index. The flag covers these two
layers; check each optional feature you enable for its own provisioning needs.

### Run the 0.85.0 catalog upgrade offline

Release 0.85.0 changed the operation catalog fingerprint to
`indexed-observation-ordinals-v1`. Event records stay at schema v5 and no Body
is rewritten. The upgrade assigns operation-local ordinals to committed history
and builds selection membership. It supports only the previous
`retained-terminal-streams` catalog or an already-current one. It is not a
migration path from arbitrary older releases.

The procedure:

1. Take a database backup and keep the previous build artifact.
2. Stop every old writer and worker for that physical schema.
3. Call the helper below once per physical schema.
4. Deploy matching server and client versions. Clients bootstrap fresh history:
   the `operation-selections-v1` cursor rejects older cursor generations with
   `invalid_replay_cursor`.

Never restart old binaries against an upgraded catalog. Rollback means restoring
the backup with the previous artifact, under operator control.

Create `upgrade-core-catalog.ts` as an offline host helper. It is a reusable
definition, not a standalone command. Your operator code owns the SQL session,
which must support real transactions, chooses the physical schema, and calls
`upgradeCoreCatalog` only while old writers are stopped.

```ts
// The host owns the connection and its transaction implementation.
import type { SqlSession } from "@copilotz/copilotz/events";
// Explicit catalog upgrade; no application traffic may run this helper.
import { upgradeOperationCatalog } from "@copilotz/copilotz/streams";
// Core resolves its legacy conversation associations.
import { resolveCoreObservationKeys } from "@copilotz/copilotz/core";

export async function upgradeCoreCatalog(
  session: SqlSession,
  physicalSchema: string,
) {
  return await upgradeOperationCatalog(session, physicalSchema, {
    // Translate Core associations into opaque selection keys.
    resolveObservationKeys: resolveCoreObservationKeys,
    // Legacy metadata fields read during this one offline backfill.
    backfillMetadataKeys: ["observationKeys", "core", "operationMetadata"],
  });
}
```

Core's resolver derives legacy Thread associations from Events and operations. A
runtime-only domain without Core supplies its own resolver; the generic default
reads only `metadata.observationKeys`. The optional Core history index is a
separate procedure, described in
[History performance](./history-performance.md).

## Reference

### Upgrade layers

| Layer              | Current state                                  | How it is applied                                             |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------- |
| Event schema       | v5, unchanged by the catalog upgrade           | Provisioned when fresh, validated when existing               |
| Operation catalog  | `indexed-observation-ordinals-v1` since 0.85.0 | Provision fresh; upgrade the supported legacy catalog offline |
| Core history index | Optional since 0.85.1                          | `provisionCoreHistoryIndexes`, once per physical Core schema  |

- `upgradeOperationCatalog` always takes exclusive catalog and Event locks, even
  when the catalog is already current. Use `validateOperationCatalog` for a
  read-only check.
- The backfill runs in transactions, and final validation runs after commit. A
  failed transaction rolls back, but an error thrown after commit does not mean
  nothing changed. Validate before you retry.
- A query-only driver adapter cannot supply atomicity; the session needs a real
  transaction.
- The history index is not part of the catalog upgrade. A concurrent build needs
  PostgreSQL outside a transaction, and the non-partial index adds write and
  storage cost. Operator scripts are your repository's code, not a package CLI.
- Replay retention keeps settled operations for a 24-hour grace period until
  `app.maintenance(...)` prunes them. `operationRetentionMs: null` disables
  pruning. This is independent of the five-minute HTTP observation renewal.

### Release history

These entries record past changes. They describe history, not the current API.

- **0.85.1 (2026-10-06).** Added optional `provisionCoreHistoryIndexes`.
  Existing schemas can build it concurrently; stored Messages and the v5 Event
  schema are unchanged. Installing the package alone does not create the index.
- **0.85.0 (2026-10-06).** Indexed observation selections and the
  `operation-selections-v1` cursor. Required the offline catalog upgrade above
  and fresh client history.
- **0.84.1–0.84.3 (2026-10-06).** Unknown or unadvertised Tool calls became
  correctable `ToolUnavailable` results. Memory consolidation budgets its input
  from the prepared prompt. Exhausted Ask preparation failures settle through
  the existing owned deferred Tool-plan cursor. Durable Processors gained an
  optional `onError` recovery hook.
- **0.84.0 (2026-10-06).** OpenAPI, MCP and Skills became resources declared
  with `defineApi`, awaited `defineMcp` and `defineSkill`. The empty plugins,
  public compilers and separate Skill constructors were removed with no
  compatibility layer: refactor applications and rebuild generated plugins.
- **0.80.0 (2026-09-22).** Text and JSON Asset refs began resolving recursively
  in Processor Events, outputs, observations and replay, while durable envelopes
  keep canonical refs and binary refs stay metadata-only. Native Channel, memory
  and schedule Processors consume the immutable `event.data` snapshot;
  `submitChannel` and `createChannelSession` were added.
- **0.76.0 (2026-09-17).** Core HTTP discovery moved behind generic
  operation-catalog reads, and the catalog stopped exposing its SQL session and
  table names. Schema v5 was kept, with no conversation-specific index at that
  time.

## What this unlocks

- Upgrade on a schedule you control, with a backup and a tested rollback.
- Refactor handlers freely while their IDs and keys carry in-flight work.
- Ship the known `body` addition without downtime, and plan stricter changes as
  ordinary application work.
- Run application roles that validate rather than provision the Event schema and
  catalog.

## Next steps

- [Events, deliveries and recovery](./events-deliveries-recovery.md): what
  durable identities mean during retries and recovery.
- [Observation performance](./observation-performance.md): the indexed
  observation design behind the 0.85.0 upgrade.
- [History performance](./history-performance.md): provisioning the Core history
  index.
- [Persist and recover](./getting-started/part-2-verify-and-recover/07-persist-and-recover.md):
  choosing the database URL your hosts share.
