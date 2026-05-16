---
title: "Ch 16: Channels & The Server Facade"
description: "Ship to WhatsApp, web, Discord, and more via withApp."
section: Getting Started
order: 160
status: stable
---

# Chapter 16: Channels & The Server Facade

> **Part 7 — Production Patterns**

## The pain

You've built a great agent. It's smart, efficient, and handles edge cases well. It runs beautifully in your terminal.

Nobody else can use it.

To ship it, you need an HTTP server. To handle WhatsApp, you need to understand their webhook format, verify HMAC signatures, parse their message schema, and send responses via their API. For Discord, it's a different format, different auth, different delivery mechanism. For a web chat, you need SSE streaming.

Each platform is a separate integration project. And the actual agent logic is the same for all of them.

## The solution

Copilotz channels are ingress/egress adapter pairs that normalize platform-specific message formats to and from Copilotz's internal message format. The same agent logic works for every channel — you just plug in different adapters.

The server facade — `withApp()` — wraps a Copilotz instance with a framework-agnostic request dispatcher. It handles routing for threads, messages, collections, graph nodes, assets, and channels out of the box. You wire it to any HTTP framework once and everything works.

## The server facade: `withApp()`

```typescript
import { createCopilotz } from "@copilotz/copilotz";
import { withApp } from "@copilotz/copilotz/server";
import { Hono } from "npm:hono";

const copilotz = await createCopilotz({
  agents: [
    {
      id: "assistant",
      name: "Assistant",
      role: "A helpful assistant.",
      llmOptions: { provider: "openai", model: "gpt-4o" },
    },
  ],
  resources: { preset: ["core"] },
  security: {
    resolveLLMRuntimeConfig: async () => ({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    }),
  },
  dbConfig: { url: "postgresql://user:pass@localhost/myapp" },
});

// Attach the app facade — extends copilotz with a .app property
const { app } = withApp(copilotz, {
  // Resolve the tenant namespace for each request (for multi-tenant deployments)
  resolveNamespace: (req) => req.context?.namespace as string | undefined,
});

const server = new Hono();

// Wire all Copilotz routes to a single handler
server.all("/api/*", async (c) => {
  const [resource, ...rest] = c.req.path.replace("/api/", "").split("/");

  const response = await app.handle({
    resource,
    method: c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: rest,
    query: Object.fromEntries(new URL(c.req.url).searchParams),
    body: ["POST", "PUT", "PATCH"].includes(c.req.method)
      ? await c.req.json().catch(() => undefined)
      : undefined,
    headers: Object.fromEntries(c.req.raw.headers),
    rawBody: ["POST", "PUT", "PATCH"].includes(c.req.method)
      ? new Uint8Array(await c.req.arrayBuffer())
      : undefined,
    context: { namespace: c.req.header("x-tenant-id") ?? "main" },
  });

  return c.json(response.data, response.status);
});

Deno.serve({ port: 3000 }, server.fetch);
```

### Built-in routes

`app.handle()` routes requests based on `resource` and `path`:

| Resource | Method | Path | What it does |
|---|---|---|---|
| `threads` | GET | `[]` | List threads for a participant |
| `threads` | POST | `[]` | Find or create a thread |
| `threads` | GET | `[":id"]` | Get thread by ID |
| `threads` | GET | `[":id", "messages"]` | Get paginated message history |
| `collections` | GET | `[":collection"]` | List records (supports `filter`, `populate`) |
| `collections` | POST | `[":collection"]` | Create a record |
| `collections` | GET | `[":collection", ":id"]` | Get a record by ID |
| `collections` | PUT | `[":collection", ":id"]` | Update a record |
| `graph` | POST | `["search"]` | Semantic search across the knowledge graph |
| `graph` | GET | `["nodes", ":id", "edges"]` | Get edges for a node |
| `assets` | GET | `[":id"]` | Get an asset as data URL or base64 |
| `channels` | * | `[":ingress"]` | Dispatch to a channel (ingress + egress same name) |
| `channels` | * | `[":ingress", "to", ":egress"]` | Route mixing — one ingress to another egress |

## Web SSE streaming

For web clients that need real-time token streaming, call `copilotz.run()` directly and return the event stream as SSE:

```typescript
server.post("/api/chat", async (c) => {
  const body = await c.req.json();

  const result = await copilotz.run(
    {
      content: body.message,
      sender: { type: "user", name: body.senderName, externalId: body.senderId },
    },
    {
      threadId: body.threadId,
      namespace: body.namespace ?? "main",
    }
  );

  return c.streamText(async (stream) => {
    for await (const event of result.events) {
      await stream.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    await stream.write("data: [DONE]\n\n");
  });
});
```

The client consumes the SSE stream:

```javascript
const response = await fetch("/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "Hello!", threadId: "thread-123" }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const text = decoder.decode(value);
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") break;

    const event = JSON.parse(data);
    if (event.type === "TOKEN") {
      appendTokenToUI(event.payload.token);
    }
  }
}
```

## Adding WhatsApp

Register the channel in your Copilotz config, then dispatch webhook requests via `app.handle()`:

```typescript
import {
  createWhatsAppIngressAdapter,
  createWhatsAppEgressAdapter,
} from "@copilotz/copilotz/server";

const copilotz = await createCopilotz({
  agents: [...],
  channels: [
    {
      name: "whatsapp",
      ingress: createWhatsAppIngressAdapter({
        phoneId: Deno.env.get("WHATSAPP_PHONE_ID"),
        accessToken: Deno.env.get("WHATSAPP_ACCESS_TOKEN"),
        appSecret: Deno.env.get("WHATSAPP_APP_SECRET"),
        webhookVerifyToken: Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN"),
      }),
      egress: createWhatsAppEgressAdapter(),
    },
  ],
  // ...
});

const { app } = withApp(copilotz);

// GET: Meta's webhook verification handshake
// POST: incoming WhatsApp messages
server.all("/webhooks/whatsapp", async (c) => {
  const rawBody = new Uint8Array(await c.req.arrayBuffer());

  const response = await app.handle({
    resource: "channels",
    method: c.req.method as "GET" | "POST",
    path: ["whatsapp"],
    query: Object.fromEntries(new URL(c.req.url).searchParams),
    body: c.req.method === "POST" ? JSON.parse(new TextDecoder().decode(rawBody)) : undefined,
    headers: Object.fromEntries(c.req.raw.headers),
    rawBody,
  });

  return c.json(response.data ?? {}, response.status);
});
```

WhatsApp messages are now routed to the agent. Responses are sent back via the WhatsApp Cloud API automatically.

## Available channel adapters

```typescript
import {
  createWhatsAppIngressAdapter, createWhatsAppEgressAdapter,   // WhatsApp Cloud API
  createDiscordIngressAdapter, createDiscordEgressAdapter,     // Discord Interactions
  createTelegramIngressAdapter, createTelegramEgressAdapter,   // Telegram Bot API
  createZendeskIngressAdapter, createZendeskEgressAdapter,     // Zendesk Sunshine
} from "@copilotz/copilotz/server";
```

## Route mixing

Route from one ingress to a different egress. Receive via WhatsApp, respond via Zendesk — the path segment `to` separates them:

```typescript
server.all("/webhooks/whatsapp-to-zendesk", async (c) => {
  const rawBody = new Uint8Array(await c.req.arrayBuffer());

  const response = await app.handle({
    resource: "channels",
    method: c.req.method as "GET" | "POST",
    path: ["whatsapp", "to", "zendesk"],  // ingress → egress
    query: Object.fromEntries(new URL(c.req.url).searchParams),
    body: c.req.method === "POST" ? JSON.parse(new TextDecoder().decode(rawBody)) : undefined,
    headers: Object.fromEntries(c.req.raw.headers),
    rawBody,
  });

  return c.json(response.data ?? {}, response.status);
});
```

## Custom channels

Build a custom channel by implementing the ingress/egress interfaces and placing the files in `resources/channels/`:

```typescript
// resources/channels/sms/ingress.ts
export default {
  detachedResponseStatus: 200,

  async handle(request) {
    const body = request.body as { From: string; Body: string };

    return {
      messages: [{
        message: {
          content: body.Body,
          sender: { type: "user", externalId: body.From, name: body.From },
        },
      }],
    };
  },
};
```

```typescript
// resources/channels/sms/egress.ts
export default {
  async deliver({ message }) {
    await fetch("https://api.twilio.com/Messages.json", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${Deno.env.get("TWILIO_SID")}:${Deno.env.get("TWILIO_TOKEN")}`)}`,
      },
      body: new URLSearchParams({
        To: message.sender?.externalId ?? "",
        From: Deno.env.get("TWILIO_NUMBER") ?? "",
        Body: typeof message.content === "string" ? message.content : "",
      }),
    });
  },
};
```

## Framework compatibility

`app.handle()` is framework-agnostic — map your framework's request shape to `AppRequest` once and all routes work:

```typescript
// Oak
router.all("/api/(.*)", async (ctx) => { /* map to app.handle() */ });

// Express (via Node adapter)
app.all("/api/*", async (req, res) => { /* map to app.handle() */ });

// Deno's built-in serve
Deno.serve(async (req) => { /* map to app.handle() */ });
```

## What this unlocks

- `withApp()` provides a complete, routable API surface in one call — threads, messages, collections, graph, assets, channels
- The same agent, accessible from any channel
- WhatsApp, Discord, Telegram, Zendesk — production-ready adapters included
- Real-time SSE streaming for web clients
- Custom channels via the ingress/egress interface
- Route mixing — pipe any ingress to any egress via the `[":ingress", "to", ":egress"]` path pattern

## What's next

Users are now talking to your agent. Multiple users. From different companies. Their data cannot mix. You need tenant isolation baked into the system — not hacked on at the application layer.

→ **[Chapter 17: Multi-Tenancy](./17-multi-tenancy.md))**
