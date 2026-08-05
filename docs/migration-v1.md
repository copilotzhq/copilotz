# Migrating a v1 database

The v2 upgrade is explicit, one-way, and isolated from the normal runtime.

```ts
import { upgradeV1Database } from "@copilotz/copilotz/migration/v1";

const results = await upgradeV1Database({
  database: { url: "postgresql://..." },
  // Omit to discover every schema with a v1 event table.
  schemas: ["tenant_a", "tenant_b"],
});
```

Back up the database and stop v1 writers first. The upgrader refuses a schema
while legacy events are pending/processing or a thread lease is active.

For each schema it performs one transaction:

1. stage the legacy graph, thread, and event tables;
2. create a clean four-table v2 baseline;
3. copy native/custom nodes and edges while preserving IDs;
4. merge thread-table fields into thread nodes;
5. union participant-array identities into graph relationships;
6. translate settled non-frame events into positioned immutable events with no
   deliveries;
7. discard legacy transient work state;
8. verify the copy by transaction success and drop staged/legacy tables.

Legacy uppercase event names are translated to lower-case semantic names.
Token/audio/tool-call frame events are omitted. The physical thread table, queue
status columns, leases, generations, and queue-only indexes do not survive.

Fresh databases never import upgrade code and start directly from the v2
baseline. If an unupgraded schema is opened by the normal engine, Copilotz
throws `LegacyDatabaseError` instead of attempting an implicit conversion.

After migration, run application-level record counts and representative
thread-history checks before reopening writes. Dead or in-flight legacy work
must be resolved under v1 before migration; v2 cannot infer its intended
recipient or idempotency state.
