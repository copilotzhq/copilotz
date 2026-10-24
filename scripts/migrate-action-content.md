# Remove execution content ownership

`migrate-action-content.ts` is an offline migration for existing databases. It
removes `@copilotz/action-content` nodes and every edge incident to those nodes.
It preserves assets, body bytes, events, receipts and existing domain ownership.
The runtime no longer creates these synthetic owners.

Stop intake and producers and drain all execution and streams before applying.
Take a database backup. Run the default dry run first and review its JSON
report:

```sh
deno run --allow-env --allow-net --allow-read scripts/migrate-action-content.ts --schema=SCHEMA
```

Set `COPILOTZ_MIGRATION_DATABASE_URL` to the offline database connection. The
script requires an explicit schema and does not provision or upgrade the
database.

The report lists each referenced asset, its origin, consuming Actions, candidate
domain producers, and classification. It groups counts by producer record type.
Existing domain `has_asset` edges establish ownership. Without those edges,
provenance matching an existing domain record or a reference in domain data
identifies a candidate producer. Multiple candidates require an explicit
reviewed `ownerIds` decision. Missing assets still require repair before
applying; no decision can bypass that refusal. An asset hidden inside another
asset's body needs an explicit decision because the report scans domain records,
not body storage.

Supply a reviewed JSON decision file:

```json
[
  { "namespace": "example", "assetId": "asset-a", "ownerId": "record-a" },
  { "namespace": "example", "assetId": "asset-b", "ownerId": null },
  {
    "namespace": "example",
    "assetId": "asset-c",
    "ownerIds": ["record-a", "record-b"]
  }
]
```

A non-null owner must be an existing domain record in the asset's namespace.
`null` explicitly permits the asset to become collectable after the synthetic
owners are removed. It does not delete the asset or its bytes. Decisions may not
replace an already identified domain owner.

`ownerIds` and `ownerId` are mutually exclusive. A shared-owner list must be
nonempty, contain no duplicates, and contain only the asset's reported candidate
producers, each still an existing domain record in its namespace. Selecting a
subset is allowed. Apply adds one `has_asset` edge for each selected owner that
does not already have one; existing domain edges are preserved. An ambiguous
asset without a shared-owner decision remains refused. The legacy `ownerId`
format, including `null` for unowned assets, keeps its existing behavior.

Generate suggestions from a retained upgrade plan without opening a database:

```sh
deno run --allow-read scripts/upgrade-retained-data.ts content-decisions --plan=review.json > decisions.json
```

The deterministic template includes all candidates for each ambiguous asset and
`ownerId: null` for each unowned asset. Other classifications are omitted.
Review and edit the file before explicitly passing it to apply; generation never
applies decisions. `contentDecisionTemplate({ ownership })` in
`runtime/actions/content-migration.ts` exposes the same helper. Shared-owner
arrays are sorted for fingerprinting; legacy decisions retain byte-identical
canonical forms and fingerprints.

```sh
deno run --allow-env --allow-net --allow-read scripts/migrate-action-content.ts --schema=SCHEMA --apply --decisions=decisions.json
```

Apply locks the domain tables, checks for active deliveries and Action
obligations, reclassifies in that transaction, adds producer ownership edges and
removes the synthetic nodes and edges. Any unresolved asset aborts the entire
transaction. A repeated apply without a decision file is a no-op. Keep the
reviewed dry-run report and the apply report with the database backup.

Tests call the migration only on isolated fixtures. They verify producer
classification, dry-run immutability, namespace checks, refusal of ambiguous or
broken references, atomic rollback, preservation of history, removal and repeat
application. No migration has been run against application data as part of this
change.
