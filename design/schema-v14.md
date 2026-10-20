# Combined offline schema upgrade

## Current state

- `runtime/authorization/schema.ts:11` already provisions private credential
  effects, the accepted continuation operation, and run/operation indexes.
  `AUTHORIZATION_SCHEMA_COLUMNS` inventories the same columns.
- `runtime/events/schema.ts:11` selects the unreleased schema marker.
- `runtime/authorization/credentials-upgrade.ts:9` upgrades authority schemas
  with credential effects inside a drained transaction and advances owner
  epochs. A second transaction redundantly adds flow admission and advances
  epochs again.
- `runtime/actions/upgrade.ts:461` runs these transactions after the retained
  data, owner-key and authority checkpoints.
- `runtime/actions/upgrade.test.ts:620` checks session preservation and drain
  refusal; the following test covers the redundant flow-only conversion.

## Target and public API

Released authority schemas advance directly from v13 to v14. Fresh v14 and
upgraded v14 have the same tables, columns, constraints, sequences and indexes.
The existing `upgradeActionLifecycle` and offline CLI remain the entry points;
no options or runtime activation paths are added.

The final transaction checks drain, creates the complete credential-effect
schema including `accepted_operation`, advances owner epochs once, clears
holders, and commits marker v14. Existing sessions and authority remain intact.
Retrying v14 does not change data or advance epochs.

## Deletions

Remove the separate flow-admission migration, its call, its backfill and its
obsolete schema recognition in authority and owner-key replay. The effect table
does not exist in released v13, so there are no consumed flows to backfill.
Replace the flow-only migration test with combined-upgrade and replay coverage.
Update the upgrade guides, Action session design and current release notes.

## Guarantees and tests

- Compare catalog inventories before downgrade and after v13 upgrade, including
  types, defaults, nullability, constraints, sequences and index definitions.
- Verify both effect indexes and the accepted-operation validation requirement.
- Reject undrained work without schema, session or epoch changes.
- Inject failure at the final marker write; verify rollback of DDL and epoch.
- Preserve active/revoked sessions and retained authority through upgrade.
- Advance the owner epoch once; replay preserves completed flow bindings and
  credential effects without another epoch advance.
- Run upgrade, session and flow suites on PGlite and PostgreSQL port 55433.
- Run check, formatting, lint delta, the full test type guard and both full
  backend suites with the required timeout wrapper.
- Search runtime, scripts, docs and design for obsolete schema references.

## Risks

This intentionally removes support for the discarded unreleased shape. Existing
offline rules still require all producers and physical writers to stop before
conversion. Earlier released upgrade checkpoints retain their existing separate
transactions and replay receipts.
