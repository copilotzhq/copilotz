# Migrating from Copilotz 0.56.x/0.57.x to 0.58.0 (v3 architecture)

The role-based v3 architecture ships as the intentionally breaking pre-1.0
version 0.58.0. It does not include a dual runtime. Migrate configuration,
plugins/processors, database state, and HTTP clients explicitly.

## Public API mapping

| Removed v0.x concept                                                   | v3 replacement                                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ResourceManifest` and filesystem resource loader                      | `PluginManifest`, `definePlugin()`, and an injected `PluginResolver`                    |
| `ProcessorDeps`, priority, `shouldProcess`, and `producedEvents`       | independent `defineProcessor({ id, on, delivery, filter, handle })` subscriptions       |
| `queueId`, queue TTL/ack settings, run generations, and queue recovery | causal `eventId`, `correlationId`, durable deliveries, `recover()`, and `maintenance()` |
| uppercase internal event vocabulary                                    | semantic lowercase durable events plus ephemeral deltas                                 |
| `unsafeGraph` and public raw graph writes                              | typed domain/collection mutations and relations                                         |
| ambient `withSchema()`                                                 | explicit namespace/schema on application or operation scope                             |
| `withApp()`                                                            | `createCopilotzGateway().fetch` or transitional `createV1FetchHandler()`                |
| public engine/application assembly and workload maps                   | `createCopilotz()`, `createCopilotzGateway()`, and `createCopilotzWorker()`             |
| hidden agent consultation/delegation                                   | public same-thread `ask` conversation                                                   |
| Web Worker/inline runtime switches                                     | private/shared/injected Oxian placement                                                 |
| separate large message/tool payloads                                   | canonical content assets and references                                                 |
| bundled development skills and generated `SKILL.ts` files              | standard Agent Skills source packed into an optional `createSkillsPlugin()`             |
| `allowedTools`, `allowedAgents`, and `allowedSkills`                   | explicit `agent.capabilities` selections; omission grants none                          |
| static CLI `agents`/`tools` display arrays                             | application capability introspection or a portable `inspect` callback                   |

## Recommended sequence

1. Pin the current 0.x release while preparing migration.
2. Convert reusable resource bundles to validated plugins. Pack any standard
   skill directories as optional plugins; generic core no longer installs skills
   or skill tools. Replace agent allow-list fields with `capabilities`; use
   `{ all: true }` only where ambient expansion is intentional.
3. Rewrite each processor as an independent durable or live subscription and
   move every mutation through typed context capabilities.
4. Replace ambient schema/database calls with explicit namespace/schema and
   domain repositories.
5. Move large text, JSON, media, and tool payloads to canonical content refs.
6. Mount `gateway.fetch` as the v3 server. Keep the v1 Fetch/SSE projection only
   for clients that still require it.
7. Drain all legacy pending/processing work and active thread leases.
8. Run the isolated database upgrade for every tenant schema.
9. Run application compile, runtime, persistence, channel, and HTTP acceptance
   suites before changing the version pin.

## Database upgrade

The migration module is not imported by normal runtime code.

```ts
import { upgradeV1Schemas } from "@copilotz/copilotz/migration/v1";

const results = await upgradeV1Schemas(session, {
  schemas: ["public", "tenant_acme"],
  resolveLegacyAsset: async (legacy) => ({
    body: await fetchLegacyBytes(legacy),
    mediaType: legacy.mediaType ?? "application/octet-stream",
  }),
});
```

The upgrade refuses to run while legacy queue rows are pending/processing or a
thread lease is active. It preserves node/edge IDs, merges thread fields into
thread nodes, unions participant edges, canonicalizes assets, translates settled
non-ephemeral events, discards transient queue state, verifies the new schema,
and drops staged legacy tables in one transaction per tenant.

Fresh databases use the four-table v3 baseline directly and never import the
upgrade module.

## First-party rollout

See [the downstream migration matrix](v3/downstream-migration.md) for exact
client pins, migration order, and acceptance gates.
