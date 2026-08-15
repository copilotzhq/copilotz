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
  semanticConcurrency: 8,
  semanticIndexMode: "concurrent", // PostgreSQL; avoids blocking live writes
  batchSize: 250,
  uploadConcurrency: 16,
  bodyBatchMaxBytes: 64 * 1024 * 1024,
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
mutation commits. With the default `semanticConcurrency: 1`, it repairs legacy
messages in resumable transactions of `semanticBatchSize` records. PostgreSQL
migrations may increase `semanticConcurrency` up to the available connection
pool. Apply creates migration-scoped partial indexes over the remaining legacy
tool messages and the execution, participant, and migrated-event identities
needed to repair them. Ordered claims and per-message identity resolution then
avoid repeatedly scanning, sorting, or spilling the whole history. Concurrent
workers own stable logical-execution partitions and claim bounded batches of up
to 100 messages with `FOR UPDATE SKIP LOCKED`; an advisory lock keeps repeated
`thread + tool-call + tool` identities ordered. Independent tool calls inside
one large thread can therefore use separate workers. Prepared asset nodes and
ownership edges are written in bounded sets. This avoids duplicate work without
concentrating an entire large thread on one worker, while amortizing transaction
and connection round trips. A failed batch rolls back atomically and is claimed
again on a resumable run. The indexes are removed after successful semantic
repair and retained after an interruption for the next resumable run.

Use `semanticIndexMode: "concurrent"` on live PostgreSQL databases so the
one-time index build does not block ordinary writes. The runtime-neutral default
is `"blocking"`, which also works with PGlite. In concurrent mode,
`semanticBatchSize` remains the planner page size and progress-reporting
cadence. Asset relocation remains independently resumable and uses `batchSize`
for metadata-only keyset pages. It creates a migration-scoped partial index for
remaining database assets, then fetches only one upload-sized body slice at a
time. Resident body memory is therefore bounded by `uploadConcurrency`, not by
page size. Each upload-sized body slice is fetched in one SQL query, so
small-asset migrations do not pay one database round trip per object.
`bodyBatchMaxBytes` bounds each slice by total unencoded body bytes even when
`uploadConcurrency` is raised for small-object latency. The index is removed
after success and retained after interruption for reuse. `uploadConcurrency`
controls object-store parallelism independently. `onProgress` reports planning,
semantic, asset, and completion stages without coupling the migration to a
logger.

S3-compatible writes use the conditional PUT itself as the existence probe and
verify the stored metadata with HEAD after success. Existing/racing keys are
read and checksum-verified before reuse. This keeps immutable idempotency while
removing one network request from every newly uploaded object.

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
