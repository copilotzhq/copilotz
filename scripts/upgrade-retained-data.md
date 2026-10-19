# Upgrade retained data offline

This is the single versioned conversion for an existing schema. It is never an
activation fallback and does not keep the old runtime running beside the owner.
Use a snapshot or backup and rehearse on a disposable copy first. Stop intake,
schedules, workers and every other old writer before starting. There is no
production migration command implicit in application startup.

1. Run `scripts/upgrade-retained-data.ts drain --schema=SCHEMA`. The read-only
   report is green only when deliveries, Action obligations, operations,
   streams, begun external effects and physical writers have confirmed terminal
   states. A cancellation request is insufficient. Unconverted Action invocation
   history without its terminal is rejected before conversion, even if its
   obligation or effect row is absent. Application-owned sagas must also be
   drained by the deploying application's own manifest.
2. Run `prepare --schema=SCHEMA --plan=review.json`. This commits the drained
   physical schema conversion and stream taxonomy mapping, preserving the bytes,
   event IDs, references, positions and observation ordinals. It records a
   unique upgrade identity, source version and target version and sets the core
   schema marker to reserved version `0`. Both old and new runtimes reject this
   marker. Keep all writers stopped until finalization succeeds.
3. Review the file, including every physical copy and execution-owned Asset.
   Resolve ambiguous or missing producer references. Supply explicit owner or
   collection decisions for ownerless Assets using the existing
   [content migration decision format](migrate-action-content.md). The CLI
   supports the database BodyStore. Other backends use the same TypeScript API
   with explicit `storeFor`, `streamBackend` and, where required,
   `copyMappings`; perform their physical import before inspecting the logical
   inventory.
4. Run `apply --schema=SCHEMA --plan=review.json --reviewed=FINGERPRINT`,
   optionally adding `--decisions=decisions.json`. Finalization locks and
   rechecks the exact source identity, drain, original event-body integrity,
   physical versions, bytes and ownership inventory. One transaction installs
   the final schema, removes execution retention pins, migrates logical-body
   locations, backfills owner sequence and restores event immutability. Only
   successful final validation writes the ready version. Then activate the
   normal application.

Every command uses `COPILOTZ_MIGRATION_DATABASE_URL` and runs with
`deno run -A`. The plan contains retained data and must be stored privately with
the backup. The CLI refuses to overwrite an existing plan file. To resume
preparation after an interrupted response or inventory failure, use a new output
path; it returns the existing durable identity and physical versions, not a
second migration.

## Failure and retry

A failed preparation transaction rolls back. Once preparation commits, failures
leave version `0`, preventing either runtime from restarting. Repeating prepare
revalidates that state and produces the actual inventory. A failed final
transaction leaves the prepared source intact. Repeat finalization with the same
reviewed plan. A lost commit acknowledgement is an unknown result: inspect the
marker or rerun the same command. Completed finalization is recognized by its
persisted exact upgrade identity and does not replay its mutations. Finalization
also commits the accepted reviewed-plan fingerprint and a canonical ownership-
decision fingerprint beside the ready marker. A completed retry must present the
same accepted plan and decisions; changing either is rejected even after a lost
commit acknowledgement. Omitted decisions and an empty decision list are the
same intent, and decision ordering does not change that intent.

A changed physical copy, mixed-schema plan, different release or mismatched
fingerprint is rejected. Never repair this by setting the ready marker manually.
Restore the backup or resolve the reported source problem and inspect again.

## History and cursors

Historical `seq` follows the old canonical `position` order, across namespaces,
with allocation gaps removed. The old schema did not retain a global transaction
commit timestamp, so concurrent historical commit chronology cannot be
reconstructed. New owner writes are commit ordered and gap free. Positions,
event IDs, operation event ordinals, stream replay keys and byte offsets remain
unchanged, so historical observation cursors stay valid. No history compaction
or blanket cursor reset occurs during this upgrade.

The [real old-code fixture](fixtures/retained-upgrade/README.md) and
`runtime/actions/retained-upgrade.test.ts` exercise preparation, interruption,
replay, finalization and normal owner activation on PGlite and PostgreSQL.
