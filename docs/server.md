# Server Helpers

Framework-independent handler factories for building APIs on top of Copilotz. Import from `copilotz/server`.

These helpers wrap `copilotz.ops` and `copilotz.collections` into domain-specific objects that return plain data — no framework types, no request/response objects. Wire them to any web framework (Oxian, Hono, Express, Fastify, etc.).

## Setup

```typescript
import { createCopilotz } from "copilotz";
import {
  createThreadHandlers,
  createMessageHandlers,
  createEventHandlers,
  createAssetHandlers,
  createCollectionHandlers,
  createRestHandlers,
} from "copilotz/server";

const copilotz = await createCopilotz({
  resources: { path: "./resources" },
  dbConfig: { url: Deno.env.get("DATABASE_URL") },
  stream: true,
});

// Create handler objects once
const threads = createThreadHandlers(copilotz);
const messages = createMessageHandlers(copilotz);
const events = createEventHandlers(copilotz);
const assets = createAssetHandlers(copilotz);
const collections = createCollectionHandlers(copilotz);
const rest = createRestHandlers(copilotz);
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

### Assets

Retrieve stored assets.

```typescript
const assets = createAssetHandlers(copilotz);

// Get as base64
const { base64, mime } = await assets.getBase64("asset-id");

// Get as data URL (for embedding in HTML/LLM)
const { dataUrl, mime: mimeType } = await assets.getDataUrl("asset://ns/asset-id");

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

// CRUD
const items = await collections.list("customer", {
  namespace: "tenant:acme",
  filter: { plan: "enterprise" },
  limit: 10,
  sort: [{ field: "name", direction: "asc" }],
});

const item = await collections.getById("customer", "cust-123");
const created = await collections.create("customer", { name: "Acme", plan: "enterprise" });
const updated = await collections.update("customer", "cust-123", { plan: "pro" });
await collections.delete("customer", "cust-123");

// Semantic search
const results = await collections.search("customer", "enterprise plan", { limit: 5 });
```

### REST (Generic CRUD)

Low-level access to internal database tables via `ops.crud`. For application data, prefer Collections.

```typescript
const rest = createRestHandlers(copilotz);

// Parse query params from a URL
const options = rest.parseQueryParams(new URL(request.url).searchParams);
// → { limit: 20, offset: 0, sort: [...], filters: { status: "active" } }

// CRUD on any internal resource
const items = await rest.list("threads", options);
const item = await rest.getById("threads", "thread-abc");
const created = await rest.create("messages", { content: "Hello", threadId: "thread-abc" });
const updated = await rest.update("threads", "thread-abc", { status: "archived" });
await rest.delete("threads", "thread-abc");
```

### Standalone Utilities

`parseQueryParams` and `parseSort` are also exported as standalone functions:

```typescript
import { parseQueryParams, parseSort } from "copilotz/server";

// Parse URL query params
const options = parseQueryParams(url.searchParams);

// Parse sort string: "name:asc,-createdAt" → [{ field: "name", direction: "asc" }, { field: "createdAt", direction: "desc" }]
const sort = parseSort("name:asc,-createdAt");
```

## Wiring to a Framework

### Oxian (file-based routing)

The `copilotz-starter` template demonstrates this pattern. Each route file imports `copilotz` from `dependencies.ts` and creates handlers inline:

```typescript
// api/v1/threads/index.ts
import type { Dependencies } from "@/api/dependencies.ts";
import { createThreadHandlers } from "copilotz/server";

export const GET = async (req: Request, deps: Dependencies) => {
  const threads = createThreadHandlers(deps.copilotz);
  const participantId = new URL(req.url).searchParams.get("participantId");
  if (!participantId) return new Response("participantId required", { status: 400 });
  return Response.json(await threads.list(participantId));
};

export const POST = async (req: Request, deps: Dependencies) => {
  const threads = createThreadHandlers(deps.copilotz);
  const body = await req.json();
  const thread = await threads.findOrCreate(body.threadId, body);
  return Response.json(thread, { status: 201 });
};
```

### Hono

```typescript
import { Hono } from "hono";
import { createThreadHandlers } from "copilotz/server";

const app = new Hono();

app.get("/v1/threads", async (c) => {
  const threads = createThreadHandlers(copilotz);
  const participantId = c.req.query("participantId");
  return c.json(await threads.list(participantId));
});

app.post("/v1/threads", async (c) => {
  const threads = createThreadHandlers(copilotz);
  const body = await c.req.json();
  return c.json(await threads.findOrCreate(body.threadId, body), 201);
});
```

### Express

```typescript
import express from "express";
import { createThreadHandlers } from "copilotz/server";

const app = express();

app.get("/v1/threads", async (req, res) => {
  const threads = createThreadHandlers(copilotz);
  const list = await threads.list(req.query.participantId);
  res.json(list);
});
```

## Next Steps

- [API Reference](./api-reference.md) — Full handler signatures and types
- [Configuration](./configuration.md) — `createCopilotz` options
- [Loaders](./loaders.md) — File-based resource loading
