# Server Helpers

Framework-independent handler factories for building APIs on top of Copilotz.
Import from `copilotz/server`.

These helpers wrap `copilotz.ops` and `copilotz.collections` into
domain-specific objects that return plain data — no framework types, no
request/response objects. Wire them to any web framework (Oxian, Hono, Express,
Fastify, etc.).

## Setup

```typescript
import { createCopilotz } from "copilotz";
import { withApp } from "copilotz/server";

const copilotz = withApp(
  await createCopilotz({
    resources: { path: "./resources" },
    dbConfig: { url: Deno.env.get("DATABASE_URL") },
  }),
);

// All handlers are available via copilotz.app
copilotz.app.threads; // ThreadHandlers
copilotz.app.messages; // MessageHandlers
copilotz.app.events; // EventHandlers
copilotz.app.assets; // AssetHandlers
copilotz.app.collections; // CollectionHandlers
copilotz.app.graph; // GraphHandlers
copilotz.app.participants; // ParticipantHandlers
copilotz.app.agents; // AgentHandlers
copilotz.app.channels; // ChannelHandlers

// Access individual adapters by channel name
copilotz.app.channels.list(); // ChannelEntry[]
copilotz.app.channels.getIngress("whatsapp"); // IngressAdapter | undefined
copilotz.app.channels.getEgress("zendesk"); // EgressAdapter | undefined

// Or use the universal dispatcher
await copilotz.app.handle({
  resource: "threads",
  method: "GET",
  path: [],
  query: { participantId: "p-1" },
});
```

Channel transport routes are dispatched through the same `handle()` interface.
The ingress and egress sides are addressed independently, so you can mix
channels freely:

```typescript
// Same channel for both sides
await copilotz.app.handle({
  resource: "channels",
  method: "POST",
  path: ["web"],
  body: { content: "Hello", sender: { type: "user" } },
});

// Cross-channel: receive via WhatsApp, reply via Zendesk
await copilotz.app.handle({
  resource: "channels",
  method: "POST",
  path: ["whatsapp", "to", "zendesk"],
  body: { /* WhatsApp webhook payload */ },
});
```

## Handler Families

### Threads

Manage conversation threads.

```typescript
const threads = createThreadHandlers(copilotz);

// List threads for a participant
const list = await threads.list("user-123", {
  status: "active",
  limit: 20,
  offset: 0,
  order: "desc",
});

// Get a thread by ID or external ID
const thread = await threads.getById("thread-abc");
const thread2 = await threads.getByExternalId("ext-123");

// Find or create
const thread3 = await threads.findOrCreate(undefined, {
  externalId: "session-xyz",
  metadata: { source: "web" },
});

// Archive
await threads.archive("thread-abc", "Conversation resolved");
```

### Messages

Read message history for a thread.

```typescript
const messages = createMessageHandlers(copilotz);

// List messages
const msgs = await messages.listForThread("thread-abc", {
  limit: 50,
  order: "asc",
});

// Get formatted chat history
const history = await messages.getHistory("thread-abc", "user-123", 100);

// Get history from knowledge graph
const graphHistory = await messages.listFromGraph("thread-abc", 50);
```

### Events

Manage the event queue for a thread.

```typescript
const events = createEventHandlers(copilotz);

// Enqueue a new event
await events.enqueue("thread-abc", {
  type: "NEW_MESSAGE",
  payload: {
    content: "Hello!",
    sender: { type: "user", name: "Alex" },
  },
});

// Poll for processing/pending events
const processing = await events.getProcessing("thread-abc");
const pending = await events.getNextPending("thread-abc", "default");

// Update status
await events.updateStatus("event-id", "completed");
```

Queued and streamed event types now include explicit lifecycle/result pairs for
executors:

- `LLM_CALL` / `LLM_RESULT`
- `TOOL_CALL` / `TOOL_RESULT`

`NEW_MESSAGE` remains the persisted/history artifact event and `TOKEN` remains
ephemeral stream-only progress output.

### Assets

Retrieve stored assets.

```typescript
const assets = createAssetHandlers(copilotz);

// Get as base64
const { base64, mime } = await assets.getBase64("asset-id");

// Get as data URL (for embedding in HTML/LLM)
const { dataUrl, mime: mimeType } = await assets.getDataUrl(
  "asset://ns/asset-id",
);

// Parse an asset:// reference
const parsed = assets.parseRef("asset://namespace/id");
// → { id: "id", namespace: "namespace" }
```

### Collections

CRUD and search over application-defined collections.

```typescript
const collections = createCollectionHandlers(copilotz);

// List available collections
const names = collections.listCollections(); // ["customer", "ticket"]

// CRUD — via handler
const items = await collections.list("customer", {
  namespace: "tenant:acme",
  filter: { plan: "enterprise" },
  limit: 10,
  sort: [{ field: "name", direction: "asc" }],
});

// Via the API dispatcher (query params)
// GET /collections/customer?filter={"plan":"enterprise"}&sort=name:asc,createdAt:desc&limit=10
await copilotz.app.handle({
  resource: "collections",
  method: "GET",
  path: ["customer"],
  query: {
    filter: '{"plan":"enterprise"}',
    sort: "name:asc,createdAt:desc",
    limit: "10",
  },
});

const item = await collections.getById("customer", "cust-123");
const created = await collections.create("customer", {
  name: "Acme",
  plan: "enterprise",
});
const updated = await collections.update("customer", "cust-123", {
  plan: "pro",
});
await collections.delete("customer", "cust-123");

// Semantic search
const results = await collections.search("customer", "enterprise plan", {
  limit: 5,
});
```

### Admin (Feature)

Admin is shipped as a built-in **feature** (`resources/features/admin/`), so it
is accessible via the dispatcher at `/features/admin/<action>`:

```typescript
await copilotz.app.handle({
  resource: "features",
  method: "GET",
  path: ["admin", "overview"],
  query: { namespace: "tenant-acme" },
});
await copilotz.app.handle({
  resource: "features",
  method: "GET",
  path: ["admin", "activity"],
  query: { interval: "day" },
});
await copilotz.app.handle({
  resource: "features",
  method: "GET",
  path: ["admin", "agents"],
  query: { search: "support" },
});
```

Admin overview, activity buckets, and agent summaries include aggregated LLM
usage totals:

- token totals: input, output, reasoning, cache-read, cache-write, total
- cost totals: input, output, reasoning, cache-read, cache-write, total
- call totals: `totalCalls` on overview/activity, `llmCallCount` on agent
  summaries

These values are aggregated from persisted `llm_usage` nodes and only include
cost for calls where Copilotz had provider-native usage data.

## Response Contract

`copilotz.app.handle(request)` returns an `AppResponse`:

```typescript
interface AppResponse {
  status: number;
  data?: unknown; // primary payload
  pageInfo?: MessageHistoryPageInfo; // set only by paginated endpoints
}
```

HTTP adapters (see the examples below) must serialize this as a uniform envelope
so frontends always read the body the same way:

```json
{ "data": <payload>, "pageInfo"?: { ... } }
```

Currently only `GET /threads/:id/messages` populates `pageInfo` (with
`{ hasMoreBefore, oldestMessageId, newestMessageId }`). Every other route
returns just `{ "data": <payload> }`.

## Wiring to a Framework

### Oxian (file-based routing)

The `copilotz-starter` template uses a single catch-all route that delegates to
`copilotz.app.handle()`:

```typescript
// api/v1/[...path].ts — handles all /v1/* requests
import type { Dependencies } from "@/api/dependencies.ts";

const handler = async (
  data: { path?: string[] },
  context: { dependencies: Dependencies; request: Request },
) => {
  const { copilotz } = context.dependencies;
  const [resource, ...path] = data.path ?? [];
  const url = new URL(context.request.url);

  const result = await copilotz.app.handle({
    resource,
    method: context.request.method,
    path,
    query: Object.fromEntries(url.searchParams),
    body: await context.request.body,
  });

  if (result.status === 204) return { status: 204 };

  // Uniform HTTP envelope: `{ data, pageInfo? }`.
  // Paginated routes (e.g. `GET /threads/:id/messages`) set `pageInfo`; all
  // other routes only emit `data`.
  const body: Record<string, unknown> = { data: result.data };
  if (result.pageInfo !== undefined) body.pageInfo = result.pageInfo;
  context.response.send(body, { status: result.status });
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
```

### Deno.serve

```typescript
import { createCopilotz } from "copilotz";
import { withApp } from "copilotz/server";

const copilotz = withApp(await createCopilotz({/* ... */}));

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const [, resource, ...path] = url.pathname.split("/").filter(Boolean);

  try {
    const result = await copilotz.app.handle({
      resource,
      method: req.method,
      path,
      query: Object.fromEntries(url.searchParams),
      body: req.method !== "GET" ? await req.json() : undefined,
    });
    if (result.status === 204) return new Response(null, { status: 204 });
    // Uniform HTTP envelope: `{ data, pageInfo? }`.
    const body: Record<string, unknown> = { data: result.data };
    if (result.pageInfo !== undefined) body.pageInfo = result.pageInfo;
    return Response.json(body, { status: result.status });
  } catch (err) {
    return Response.json({ error: err.message }, { status: err.status ?? 500 });
  }
});
```

### Individual handler factories

For fine-grained control, individual factories are still exported:

```typescript
import {
  createCollectionHandlers,
  createThreadHandlers,
} from "copilotz/server";

const threads = createThreadHandlers(copilotz);
const collections = createCollectionHandlers(copilotz);
await threads.list(participantId, { status: "active" });
```

## Next Steps

- [API Reference](./api-reference.md) — Full handler signatures and types
- [Configuration](./configuration.md) — `createCopilotz` options
- [Loaders](./loaders.md) — File-based resource loading
