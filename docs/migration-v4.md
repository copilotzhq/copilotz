# Migrate a 0.47/0.48 Legacy Graph to v4

`@copilotz/copilotz/migration/v4` is the sole database-migration entrypoint in
0.62. It accepts only the exact `legacy-graph-v1` physical profile deployed by
Copilotz 0.47/0.48.

It is intentionally not a general upgrader for 0.55 or 0.60 databases. Mobizap
and Compass should start with fresh v4 schemas. Gilpinna is the supported
in-place migration target.

## Safety contract

Before any write, migration:

- classifies the exact tables and ordered columns;
- rejects partial, unknown, final, or incompatible profiles;
- rejects every nonterminal legacy delivery/event status;
- pages and digests threads, events, nodes, edges, and Asset references;
- resolves and hashes every referenced legacy Asset byte stream;
- validates that retained node types have final Collection definitions.

The archive cut locks and rechecks all four legacy tables, then moves their
exact rows into one immutable archive schema in a transaction. Legacy Events are
never copied into the live v4 Event log.

## Run

```ts
import { migrateToV4 } from "@copilotz/copilotz/migration/v4";

const result = await migrateToV4({
  session,
  schema: "public",
  plugins: finalPlugins,
  async resolveLegacyAsset(reference) {
    const bytes = await legacyAssetStore.read(reference.ref);
    return { bytes };
  },
  config: {
    client: "gilpinna",
    fixture: "validated-production-profile",
  },
});

console.log(result.stage); // "complete"
console.log(result.archiveSchema);
console.log(result.counts);
```

Required inputs:

- `session`: the SQL session owning the target physical schema;
- `plugins`: the exact final composition whose Collection definitions rebuild
  retained records;
- `resolveLegacyAsset`: a byte resolver for every legacy `asset://` reference,
  available for the entire run and verification reruns.

`config` is optional strict JSON. Its canonical fingerprint prevents a resumed
run from silently changing migration policy. `pageSize` is bounded from 1 to
1,000.

## What is produced

The migration creates ordinary final facts:

1. Asset source Events and database-backed Bodies;
2. retained Collection create/update Events in dependency order;
3. relation delete/upsert Events needed to reproduce the exact graph;
4. a namespace-wide replay and two logical projection verifications;
5. the v4 readiness marker in the final verification transaction.

Retired `tool_execution`, `llm_attempt`, and `llm_usage` records remain only in
the immutable archive. Their final operational replacement is authenticated
Action lifecycle Events; the migrator does not invent those from incomplete
legacy rows.

## Restart behavior

Migration state records an immutable baseline/config/plugin fingerprint and
bounded cursors. Every source batch writes its Event Body and Event atomically.
Rerunning after interruption resumes from committed cursors; deterministic IDs
and equality checks reject conflicting partial state.

The v4 marker is absent until archive, sources, replay, byte verification, and
graph verification all succeed. Normal `createCopilotz()` provisioning rejects a
legacy or in-progress schema instead of applying partial DDL.

After completion, rerunning `migrateToV4` performs verification and returns the
same result. Keep the archive schema until the client has completed its own
retention review; normal runtime never reads it.
