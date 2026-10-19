---
title: "Upgrading and Data Safety"
description: "Pin Copilotz versions, keep durable identities stable, evolve record schemas deliberately, and run explicit offline database upgrades without losing history."
section: Evolve
order: 20
status: stable
---

# Upgrading and Data Safety

## Current owner schema: v13

Each physical database schema has one fenced owner shared by its namespaces.
Fresh, absent-only provisioning installs **v13** and the operation catalog
fingerprint **`stream-taxonomy-content-v1`**. Startup validates the complete
current shape; it never upgrades an existing schema.

There is one offline chain: **v5–v10 → v11 → owner keys v12 → authority v13**.
Rehearse on a restored disposable backup. Stop admission, schedules, workers,
owners and every physical writer, and keep them stopped through v13. Existing
v11 or v12 schemas enter at their next step; never relabel a schema or skip a
step.

1. Run `inspectRetainedDataDrain(session, schema)` (or the CLI `drain`).
   Deliveries, obligations, operations, streams, begun effects and physical
   writers must have confirmed terminal states. Cancellation requests are
   insufficient; also drain application-owned external-work journals.
2. For v5–v10, call `prepareRetainedDataUpgrade(session, schema)` and retain its
   plan privately. Preparation records the source, **target v11**, and unique
   identity under reserved marker `0`. Review the exact fingerprint, physical
   copies and explicit ownership decisions. Repeat preparation to recover the
   same identity after interruption. External stores require explicit mappings.
3. Call
   `upgradeActionLifecycle(session, schema, { plan,
   reviewedFingerprint: plan.fingerprint, contentDecisions, ownerKeys })`.
   The retained-data transaction rechecks drain, bytes and accepted intent,
   installs v11, converts logical content and sequence, and preserves immutable
   history. The v11 → v12 transaction then reencrypts retained protected values
   under an owner data key wrapped by the application's master adapter.
   `ownerKeys` supplies `sourceAdapter`, `masterAdapter`, and, if needed,
   original protected `bindings` and `readExternalBody`. When starting at v11,
   omit the retained plan. The standalone `migrateOwnerKeys` API also performs
   exactly this step and stops at v12.
4. At v12, run `inspectAuthorityUpgrade(session, schema)` (CLI
   `authority-inventory`). Review the resulting invocations and ingress events
   against application policy. Build an explicit `AuthorityUpgradeManifest`
   containing policy revisions, exact invocation/event digests, authority
   bindings, and any required original Action schemas or ingress provenance.
   Inspect after key conversion because reencrypting captures can change their
   digests. Even an empty inventory requires an explicit empty manifest.
5. Call `upgradeActionLifecycle(session, schema, { authority })` to commit v12 →
   v13. This validates every binding, writes the accepted manifest receipt,
   invalidates old transport attachments, and fences the old owner epoch.
   Validate the schema and catalog, then start the application.

When all reviewed inputs are already available,
`upgradeActionLifecycle(session, schema, { plan, reviewedFingerprint,
contentDecisions, ownerKeys, authority })`
runs the entire chain in order. Missing inputs stop at the last committed
checkpoint with `UpgradeStepRequiredError`:
`copilotz_upgrade_owner_keys_required` at v11 or
`copilotz_upgrade_authority_required` at v12. Its `fromVersion` and `toVersion`
identify the next step. These checkpoints are not ready for this runtime.

Each step rechecks drain inside its exclusive transaction. Failed transactions
roll back that step. After a lost commit reply, inspect the marker or retry the
same inputs. Retained plan/decision fingerprints, the key-migration receipt, and
the authority-manifest fingerprint make retries resumable and idempotent.
Changed reviewed plans, decisions or authority manifests are rejected on replay.
Historical sequence follows canonical position order and preserves cursors; new
owner writes follow commit order.

The repository's [offline guide](../scripts/upgrade-retained-data.md) gives the
exact CLI commands and adapter-module contract. No step runs at startup.

### Receipt authority limitations

Historical logical Collection receipts bound only to a physical `worker:`
principal do not prove the original Action/Processor authority. The current
conversion refuses them without advancing readiness. It cannot guess from
receipt keys, accept an operator override, or grant a replacement worker access.
Keep such data offline until a separately reviewed conversion can establish its
original durable invocation binding. Fixed-principal receipts and supported
pre-conversion histories without owner receipts remain eligible.

Owner schemas missing the required receipt-reader column are also refused by
current validation. Do not relabel them or add a runtime compatibility path. See
the offline guide for the exact supported inventory.

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
   validated against Event schema v13. Startup provisions fresh Core tables and
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
Provision populated schemas before admitting work: index creation now runs
inside the schema owner command and holds its queue until commit. See
[Collections](./collections.md#provision-declared-indexes).

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

## Reference

### Upgrade layers

| Layer              | Current state                 | How it is applied                                                                                          |
| ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Event/owner schema | v13, owner keys and authority | Provision an absent schema; use the reviewed offline retained-data path for supported existing inventories |
| Operation catalog  | `stream-taxonomy-content-v1`  | Installed by fresh provisioning or the same retained-data conversion                                       |
| Core history index | Optional since 0.85.1         | `provisionCoreHistoryIndexes`, once per physical Core schema                                               |

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
  pruning. This is independent of the 15-minute HTTP observation renewal.

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
