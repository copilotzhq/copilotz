# API guide

## Engine

```ts
const copilotz = await createCopilotz({
  plugins,
  agents,
  tools,
  processors,
  collections,
  providers,
  database: { url: ":memory:", schema: "public" },
  maintenance: { periodic: true, retentionMs: 604_800_000 },
});
```

Resolution precedence is core, plugins in order, then top-level resources.
`llmOptions` remains shorthand for an agent's `runtimes.text` options; explicit
runtime provider/model fields win.

## Simple text run

```ts
const handle = await copilotz.run(message, {
  thread: "external-thread-id",
  namespace: "tenant-a",
  correlationId: "optional-caller-scope",
});

handle.eventId;
handle.threadId;
handle.correlationId;
handle.events; // ReadableStream<CopilotzEvent>
await handle.done;
await handle.cancel("reason");
```

`done` covers all durable delivery obligations in the correlation scope. It
rejects with `DeadLetterError` or `DeliveryCancelledError` when applicable.

## Collections

```ts
const note = defineCollection({
  name: "note",
  schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  } as const,
});

const copilotz = await createCopilotz({ collections: [note] });
const tenant = copilotz.collections.withNamespace("tenant-a");
await tenant.note.create({ text: "Remember this" });
```

Every create, update, delete, upsert, or aggregate operation emits a lower-case
`<collection>.<operation>` event. Public mutation APIs do not expose SQL or raw
graph primitives.

## Assets

```ts
const asset = await copilotz.assets.save(bytes, "audio/wav", {
  namespace: "tenant-a",
  threadId,
  by: "user:42",
});

asset.ref; // asset://...
await copilotz.assets.get(asset.ref);
```

Byte storage is delegated to the configured runtime-neutral `AssetStore`.
`assets.save()` writes only reference metadata through the native `asset`
collection, producing `asset.created` and any matching durable deliveries; raw
bytes never enter graph or event rows. Tools receive the same event-aware API as
`context.assets`, scoped to their delivery idempotency key.

Tool contexts also expose `context.createThread()` for explicitly separate
background workflows. The built-in `create_thread` tool delegates to this API;
it creates a child graph thread with a distinct correlation scope and returns
after the workflow is durably started.

## Events, deliveries, schemas

```ts
await copilotz.events.list({
  namespace: "tenant-a",
  threadId,
  correlationId,
  afterPosition: "100",
  limit: 100,
});

await copilotz.deliveries.list({ correlationId, status: "dead_letter" });
await copilotz.deliveries.retry(deliveryId);
await copilotz.deliveries.discard(deliveryId);

await copilotz.schema.provision("tenant_schema");
await copilotz.schema.exists("tenant_schema");
await copilotz.schema.list();
```

Delivery reads and mutations default to the engine namespace. Pass
`{ namespace: "tenant-a" }` to `get`, `retry`, or `discard`, or include the
namespace in `list`, when operating another namespace intentionally.

## Runtime-neutral HTTP adapter

`@copilotz/copilotz/server` exports Web `Request`/`Response` helpers and no
listener implementation.

```ts
import { createCopilotzFetchHandler } from "@copilotz/copilotz/server";

const fetch = createCopilotzFetchHandler(copilotz, {
  basePath: "/v2",
  authorize(request) {
    if (!authorized(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
  },
});
```

Mount `fetch` in Deno, Bun, Node adapters, Cloudflare Workers, browsers/service
workers, or another Web-compatible host.
