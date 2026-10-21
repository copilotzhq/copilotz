---
title: "Moving Retained Tenant Data"
description: "Relocate owner schemas, migrate owner keys and read transfer bodies offline with the public migration API."
section: Evolve
order: 30
status: stable
---

# Moving retained tenant data

Use `@copilotz/copilotz/migration` for offline retained-owner operations. The
entrypoint is published by both JSR and npm. It uses the same body formats,
authenticated coordinates and key wrapping as the serving runtime. The bundle
operations require Deno, PostgreSQL, and compatible `pg_dump` / `pg_restore`
executables on PATH. The SQL migration operations also support PGlite.

Stop intake, every owner attachment, maintenance and physical body producers
before exporting or rewriting data. Await each runtime's `close()` before
closing its database. SQL locks and durable drain checks cannot stop external
producers. Keep a verified backup and hold the write freeze through routing
cutover.

## Moving a complete tenant schema

```ts
import {
  type OwnerTransferConfig,
  relocateOwnerSchema,
} from "@copilotz/copilotz/migration";

// Obtain these adapters from the app's deployment secret provider.
declare const config: OwnerTransferConfig;
await relocateOwnerSchema({
  sourceUrl: "postgres://operator@source/app",
  destinationUrl: "postgres://operator@destination/app",
  schema: "tenant_a",
  directory: "/secure/backups/tenant-a-transfer",
  config,
});
```

The destination schema must be empty, and the bundle directory must not exist.
Relocation preserves the schema name: schema, namespace, record owner and slot
are authenticated coordinates. It retains the source and the bundle. Verify the
restored runtime's historical event replay, protected values and body reads,
then move the app's tenant routing and resume intake. Source retirement and old
object cleanup remain explicit operator actions after cutover verification.

For a staged transfer, call
`exportOwnerBundle({ url, schema, directory, config })` and later
`importOwnerBundle({ url, directory, adapter })`. Import uses the
**destination** adapter. Export needs both adapters to rewrap the owner data
key; raw key material is never included in the archive. Rewrapping preserves
body ciphertexts, commitments and references.

Configure `readExternalBody` with
`bodyStoreReader((backendId, namespace) => store)` when retained bodies reside
outside the source database. Route backend IDs explicitly.
`oldS3BodyReader(config)` is only for the legacy hashed S3 layout.
`readTransferBodies(transaction, schema, reader?)` verifies and returns retained
body prefixes, including failed and cancelled terminal bodies. Inventory and
bundles currently hold body bytes in memory.

Export locks source tables and uses one repeatable-read PostgreSQL snapshot for
both the archive and body inventory. Import checks archive/body digests and key
access before restoring. It restores DDL/data in one transaction and then
installs body copies, the wrapped key and schema readiness marker together in a
second transaction. Activation is atomic: a finalization failure leaves an
**inactive** schema, which must be discarded before retrying. This is not an
all-or-nothing transaction spanning both PostgreSQL command-line tools and
finalization.

Import also advances the owner epoch and replaces its holder UUID. A restored
owner cannot attach to a source incarnation in the same process. Logical body
IDs and receipts survive; physical body copies move into destination database
storage. Only import trusted PostgreSQL archives: their DDL is executable, and
checksums detect corruption rather than authenticate an archive author.

## Legacy owner-key conversion

```ts
import { migrateOwnerKeys } from "@copilotz/copilotz/migration";
import type { SqlSession } from "@copilotz/copilotz/events";
import type { SecretAdapter } from "@copilotz/copilotz/actions";

declare const session: SqlSession;
declare const oldAdapter: SecretAdapter;
declare const destinationAdapter: SecretAdapter;
await migrateOwnerKeys({
  session,
  schema: "tenant_a",
  sourceAdapter: oldAdapter,
  masterAdapter: destinationAdapter,
});
```

This operation upgrades v11 to v12, not to the current serving schema version.
Use the supported retained-schema upgrade chain afterward. Standard protected
Event and Action lifecycle references are classified automatically. Supply
`ProtectedBinding[]` for custom captures, using their original namespace, owner
ID and slot. Missing bodies, ambiguous bindings or an undrained owner abort the
transaction. Retrying a completed migration uses its retained receipt.

The conversion reencrypts each protected value once, updates every classified
JSON reference and event-body digest, and commits bodies, keys, receipts and the
version marker together. A failure rolls back all those changes. External source
objects remain intact because SQL rollback cannot undo object deletion.

## Splitting tenants or changing authenticated coordinates

Whole-schema relocation does not infer app-specific row ownership or rename
schemas. An app that splits retained data must classify every row, retained
reference and protected capture, including historical receipts. The app owns its
manifest, reference rewrites, destination validation and atomic outer SQL
transaction. Do not downgrade a serving schema merely to force a migration.

The public entrypoint supplies the following narrow building blocks:

| Previous private helper                               | Supported replacement                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Bundle and key migration scripts                      | `exportOwnerBundle`, `importOwnerBundle`, `relocateOwnerSchema`, `migrateOwnerKeys`                 |
| Transfer-body reader                                  | `readTransferBodies`, `bodyStoreReader`, `oldS3BodyReader`                                          |
| Separate body-store DDL and owner-key setup           | `prepareRetainedDataRestore({ session, schema, adapter })`                                          |
| Event-body hashing                                    | `encodeEventBody`                                                                                   |
| Protected coordinates and reference decoding          | `ProtectedValueCoordinates`, `ProtectedBinding`, `protectedValueRef`, `additionalAuthenticatedData` |
| Content/protected-value fixture and replay operations | `createContentCatalog`, `createProtectedValueRuntime`                                               |

`prepareRetainedDataRestore` requires an existing core schema and provisions
body storage and owner-key binding in one transaction without acquiring a
runtime owner. Inside an app's outer transaction, pass a session facade whose
query and transaction callback both use that same executor; throw on any failure
so the outer transaction rolls back.

AAD construction is exposed because an app-specific historical rewrite must
validate the original coordinates and explicitly bind the destination. Never
copy cryptographic format strings or substitute destination coordinates while
opening source ciphertext. Use the source format's adapter for old direct-value
ciphertexts; current owner-key ciphertexts require the owner-managed protected
value runtime. Raw key unwrap/cipher operations remain private.

The content catalog and protected-value factories use normal owner commands. Use
them to construct migration fixtures and verify replay on a restored runtime,
not to bypass owner admission inside an arbitrary offline SQL transaction. Their
repositories retain their original owner; discard them when that owner closes.

## Shutdown contract

The final runtime attachment pauses alarms, drains admitted alarm callbacks,
stops new delivery placement while preserving retained obligations for recovery,
cancels and drains deliveries and live transient callbacks, then awaits queued
SQL groups and asynchronous publications, including stream-terminal
reconciliation and publication-generated commands. Only then does it revoke
owner authority and finish `close()`. Close reports publication failures after
completing cleanup. Forced owner stop revokes authority immediately, while its
completion promise still waits for in-flight work. A callback that never
finishes keeps close pending.

With multiple runtime attachments, closing one preserves the others. Keep a
borrowed database open until every runtime using its owner has closed. Owner
lookup is scoped to the database object and schema. Supported SQL adapters and
transaction facades retain that database identity; a different connection object
acquires a new holder even when it sees the same durable epoch. Repository
helpers borrow the existing binding without adding runtime attachments; helper
bootstrap starts with zero runtime attachments. Closing the final attachment
drains and removes its owner binding; captured old repositories remain revoked
and never retarget the successor.

Create additional SQL adapters with `createSqlSession(database)` from
`@copilotz/copilotz/events`. Instrument that adapter when recording queries or
transactions. Hand-built wrapper objects have distinct identities. Owner-bound
observations use adapters of the same database object as their writer.

## Next steps

- [Upgrading](./upgrading.md#current-owner-schema-v14): the offline schema chain
  to v14, run in place with `upgradeActionLifecycle`.
- The repository's [offline guide](../scripts/upgrade-retained-data.md): the CLI
  commands that call these operations.
