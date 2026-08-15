# Content-v2 Migration

`@copilotz/copilotz/migration/content-v2` repairs databases that were already
upgraded from the legacy queue runtime and can relocate every ready database
asset to an S3-compatible backend.

```ts
import {
  migrateContentV2Schemas,
} from "@copilotz/copilotz/migration/content-v2";

const reports = await migrateContentV2Schemas(session, {
  mode: "dry-run", // change to "apply" after inspecting the report
  schemas: ["tenant_copilotz_com"],
  semanticBatchSize: 250,
  batchSize: 250,
  uploadConcurrency: 16,
  onProgress(progress) {
    console.log(progress);
  },
  assets: {
    storage: {
      type: "s3",
      config: {
        backendId: "gcs:compass-assets",
        endpoint: "https://storage.googleapis.com",
        region: "auto",
        bucket: "compass-assets",
        accessKeyId,
        secretAccessKey,
        pathStyle: true,
        prefix: "copilotz",
      },
    },
  },
});
```

The semantic phase requires exactly one structured tool call per legacy
tool-authored message. A unique matching execution is merged; otherwise one is
synthesized with a deterministic migration ID. Ambiguous matches abort the
schema transaction. Repaired messages and their duplicate migrated events are
removed; ordinary human and agent messages are unchanged.

Dry-run is a read-only bulk planner. It keyset-pages legacy messages by
`semanticBatchSize`, loads only each page's matching executions, participants,
asset references, and ownership counts, then releases those payloads before the
next page. It simulates semantic repair without issuing writes or opening a
rollback-only transaction. Existing canonical tool output and projected-output
JSON are inspected too, even when no duplicate legacy message remains.

Apply runs the same planner first, so ambiguous history is rejected before any
mutation commits. It then repairs legacy messages in resumable transactions of
`semanticBatchSize` records. Asset relocation remains independently resumable
and uses `batchSize` plus `uploadConcurrency` for bounded memory and
object-store parallelism. `onProgress` reports planning, semantic, asset, and
completion stages without coupling the migration to a logger.

The object phase uploads and verifies one deterministic immutable key before it
conditionally changes the graph location and deletes the database body. A crash
after upload leaves the database authoritative, and a rerun verifies and reuses
the object. Failed, abandoned, deleted, and already object-backed assets are
unchanged.

Back up PostgreSQL before apply. After copy-and-delete, rollback requires
restoring bodies from the object store or database backup. All services that
read the same schemas must run an object-aware Copilotz release before object
relocation begins. Buckets should be private, block public access, and expose
asset bytes only through authorized Copilotz endpoints.
