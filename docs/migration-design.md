# Retained-data migration and owner shutdown

## Baseline before implementation

- `scripts/owner-bundle.ts:97` exports a stopped owner under a repeatable-read
  snapshot; `:192` restores the archive and activates the key/marker in a final
  transaction. The implementation is excluded from publication.
- `runtime/actions/migrate-owner-keys.ts:48` converts v11 history, discovers
  protected bindings, verifies bodies and atomically rewrites references.
- `runtime/actions/owner-transfer-storage.ts:1` owns portable body inventory and
  installation, including legacy external storage readers.
- `runtime/engine/commands.ts:224` stops admission but resolves `stopped` before
  the current group finishes. `:238` starts untracked asynchronous publications.
- `runtime/engine/commands.ts:655` indexes owners by durable holder UUID, while
  `:715` associates SQL session objects with schema entries. Explicit
  attachments increment references; lazy repository acquisition can also own an
  attachment.
- `runtime/engine/engine.ts:1287` drains alarm callbacks and the executor before
  releasing attachments, but release does not await commands/publications.

## Target and public API

Publish `@copilotz/copilotz/migration` in both package maps. Move bundle
implementation into `runtime/migration`; retain the CLI as a thin caller. Expose
export/import, schema-preserving cross-database `relocateOwnerSchema`, owner-key
migration, verified transfer body inventory and external body readers. Schema
names are authenticated cryptographic coordinates: relocation preserves that
name. Splitting tenants or changing coordinates requires explicit app-owned row
classification, in one offline transaction.

Provide an offline restore operation to provision body storage and the owner key
together without acquiring an owner. Curate the protected-value and content
catalog factories for fixture creation and replay verification using normal
owner commands, outside arbitrary offline SQL transactions. Keep raw key
management private. Export AAD construction, protected reference
validation/coordinate types and event-body encoding only for custom historical
rewrites that cannot use whole-owner bundles. Do not expose owner ciphers, key
unwrap, physical body installation or table locks.

## Shutdown

Add an owner idle/drain barrier covering queue, current group and publication
callbacks. Graceful final release waits for admitted commands and descendant
publications while commands remain usable, then stops authority and drains alarm
work. Forced stop retains immediate invalidation; a separate completion barrier
waits for work already running. Publication failures remain observable at close.
Every engine attachment awaits release, including initialization failures. Audit
lazy acquisition/reference ownership and database identities with sequential
native runtime tests. Preserve shared-owner operation for surviving attachments.

## Deletions and guarantees

Delete the script implementation and obsolete script re-export shims; publish
runtime files through the existing runtime glob with an explicit surface guard.
Keep snapshot consistency, external body replay, integrity checks, original AAD,
key binding, drained-data checks and fail-closed restore activation. No sleeps,
per-command database queries, polling, or changes to admission policy.

## Tests and risks

Run existing migration/bundle tests through public migration imports; add a
public-specifier contract, relocation coverage, deterministic queue/publication
shutdown tests and two sequential native runtime lifecycles. Verify shared
attachments and timer removal. Run targeted tests, package checks, format, lint
against the captured baseline, the complete type guard and full PGlite/Postgres
suites (port 55433, databases named plat_*).

An offline API cannot stop external writers: operators must stop intake, owners
and physical producers. Bundle restore has atomic activation, not a transaction
spanning pg_restore and finalization; failed finalization leaves an inactive
schema for explicit operator cleanup. A hung user publication must keep close
pending rather than claim a successful drain. Shared attachments require careful
ownership: closing a borrowed database while another runtime uses it is invalid.
