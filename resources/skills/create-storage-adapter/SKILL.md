---
name: create-storage-adapter
description: Extend canonical asset-body storage without bypassing content invariants.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, storage, assets, architecture]
---

# Create Storage Adapter

Copilotz v3's supported baseline stores canonical asset metadata and bodies in
the graph/database repository. The initial 3.0 public engine does not yet expose
an object-storage repository injection option. Do not add an inert `storage`
resource and assume the content runtime will consume it.

## If the database baseline is sufficient

Configure `engine.maxDatabaseBytes` and use the canonical content API:

```ts
const app = await createCopilotz({
  engine: { maxDatabaseBytes: 64 * 1024 },
});

const prepared = await app.content.preparer.prepare({
  type: "file",
  bytes,
  mediaType: "application/pdf",
  name: "report.pdf",
}, { namespace: "acme", idempotencyKey: "report:42" });
```

The prepared content must be materialized by an owning domain mutation; do not
persist references to bodies that were never committed.

## Adding object storage to Copilotz itself

Treat this as a content-runtime contribution, not an application plugin recipe.
The adapter must preserve:

- immutable digest-addressed bodies and namespace authorization;
- stable idempotency on publish/materialize;
- atomic database metadata, owner links, and semantic events;
- staged upload recovery when object storage cannot join the SQL transaction;
- verified byte length/digest on read and Web Stream backpressure on open;
- deletion/retention semantics that cannot orphan live owner references;
- runtime-neutral interfaces, with SDK-specific code in host adapters.

Add a public factory/injection seam, PGlite and PostgreSQL crash tests, and
object-store conformance tests before documenting the backend as supported.
