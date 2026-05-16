---
title: "Ch 19: Features — Custom Server Logic"
description: "Webhooks, admin APIs, and custom routes without a second server."
section: Getting Started
order: 190
status: stable
---

# Chapter 19: Features — Custom Server Logic

> **Part 7 — Production Patterns**

## The pain

Collections give you data. The server facade gives you channels. But your product needs more: a webhook endpoint to receive Stripe payment events, an admin endpoint to ingest documents or pull usage reports, a custom route to trigger an agent run programmatically.

The obvious answer is a second server — a separate Express or Hono app that handles these routes and calls Copilotz via its API. But now you're maintaining two servers. The Copilotz instance in the second server is a client, not the real thing. You lose direct access to collections, agents, and the database.

## The solution

Features are custom server-side action handlers that live inside Copilotz. Each feature is a directory under `resources/features/`. Each `.ts` file in that directory becomes an action, automatically routed by the server facade.

```
resources/features/
└── billing/
    ├── webhook.ts     → action "webhook"
    └── usage.ts       → action "usage"
```

These are served at `features/billing/webhook` and `features/billing/usage` by the server facade — no route declarations, no framework setup.

## The feature handler

A feature action is a default-exported async function. It receives a request object and the full Copilotz instance:

```typescript
// resources/features/billing/webhook.ts
import type { Copilotz } from "@copilotz/copilotz";

export default async function (
  request: {
    method: string;
    body: unknown;
    query: Record<string, unknown>;
    headers: Record<string, string>;
    rawBody?: Uint8Array;
    namespace?: string;
  },
  copilotz: Copilotz,
): Promise<{ status: number; data: unknown }> {

  const event = request.body as { type: string; data: { object: { customer: string } } };

  if (event.type === "invoice.paid") {
    const customerId = event.data.object.customer;

    // Trigger an agent run to notify the customer
    const result = await copilotz.run({
      content: `Customer ${customerId} just paid their invoice. Send them a welcome message.`,
      sender: { type: "system" },
    }, { namespace: request.namespace ?? "main" });

    await result.done;
    return { status: 200, data: { received: true } };
  }

  return { status: 200, data: { received: true } };
}
```

## Dispatching via the server facade

Feature actions are dispatched through `app.handle()` like any other resource:

```typescript
import { withApp } from "@copilotz/copilotz/server";

const { app } = withApp(copilotz);

// In your HTTP framework:
server.post("/api/features/billing/webhook", async (c) => {
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const response = await app.handle({
    resource: "features",
    method: "POST",
    path: ["billing", "webhook"],
    body: JSON.parse(new TextDecoder().decode(rawBody)),
    headers: Object.fromEntries(c.req.raw.headers),
    rawBody,
    context: { namespace: c.req.header("x-tenant-id") ?? "main" },
  });
  return c.json(response.data, response.status);
});
```

Or with the catch-all wildcard route from Chapter 15 — if you already route `/api/*` through `app.handle()`, feature endpoints work automatically without any extra registration.

## Common patterns

### Webhook receiver

```typescript
// resources/features/stripe/webhook.ts
import type { Copilotz } from "@copilotz/copilotz";

export default async function (request, copilotz: Copilotz) {
  // Verify HMAC signature before processing
  const sig = request.headers["stripe-signature"] ?? "";
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
  // ... verify sig against request.rawBody ...

  const event = request.body as { type: string; [key: string]: unknown };
  const db = copilotz.collections.withNamespace(request.namespace ?? "main");

  if (event.type === "customer.subscription.deleted") {
    const stripeCustomerId = (event.data as any).object.customer as string;
    await db.customer.update({ stripeId: stripeCustomerId }, { plan: "free" });
  }

  return { status: 200, data: { received: true } };
}
```

### Admin report

```typescript
// resources/features/admin/usage.ts
import type { Copilotz } from "@copilotz/copilotz";

export default async function (request, copilotz: Copilotz) {
  const { query = {} } = request;
  const namespace = query.namespace as string | undefined;
  const db = copilotz.collections.withNamespace(namespace ?? "main");

  const [openTickets, resolvedTickets] = await Promise.all([
    db.ticket.find({ status: "open" }),
    db.ticket.find({ status: "resolved" }),
  ]);

  return {
    status: 200,
    data: {
      open: openTickets.length,
      resolved: resolvedTickets.length,
      resolutionRate: resolvedTickets.length / (openTickets.length + resolvedTickets.length),
    },
  };
}
```

### Document ingestion endpoint

```typescript
// resources/features/knowledge/ingest.ts
import type { Copilotz } from "@copilotz/copilotz";

export default async function (request, copilotz: Copilotz) {
  const { url, title, namespace } = request.body as {
    url: string;
    title: string;
    namespace?: string;
  };

  // Trigger ingest via a system message with a toolCall
  const result = await copilotz.run({
    content: "",
    sender: { type: "system" },
    toolCalls: [{
      id: "ingest-1",
      tool: { id: "ingest_document" },
      args: { source: url, title },
    }],
  }, { namespace: namespace ?? request.namespace ?? "main" });

  await result.done;
  return { status: 202, data: { queued: true, url, title } };
}
```

## The built-in admin feature

Copilotz ships an `admin` feature preset that provides ready-made actions for monitoring your deployment:

| Action | What it returns |
|---|---|
| `admin/overview` | Thread, message, participant, queue, and LLM usage totals |
| `admin/threads` | Paginated thread list with message counts and last activity |
| `admin/participants` | Participant list with conversation history summary |
| `admin/agents` | Running agent configs |
| `admin/activity` | Recent LLM call activity and token usage |

Load it via preset:

```typescript
resources: {
  path: "./resources",
  preset: ["core", "admin"],
}
```

Then `GET /api/features/admin/overview?namespace=acme` gives you a live snapshot of that tenant's usage.

## Files that are not actions

Files starting with `_` are ignored by the loader — use them for shared helpers:

```
resources/features/
└── billing/
    ├── _helpers.ts    ← ignored (shared utilities)
    ├── webhook.ts     ← action
    └── usage.ts       ← action
```

`manifest.ts` is also reserved for the resource manifest and is not loaded as an action.

## What this unlocks

- Custom server logic co-located with your agent — no second server, no client/server split
- Full access to `copilotz.run()`, `copilotz.collections`, `copilotz.ops`, and env vars from every handler
- Webhook receivers, admin APIs, ingest endpoints, batch triggers — all in one place
- The built-in `admin` feature for live deployment monitoring
- Served automatically by `withApp()` — no route declarations needed

## What's next

You now have a complete production application: agents, tools, memory, channels, multi-tenancy, persistent application data, and custom server logic. The last layer is the client. How do you build a web frontend that consumes SSE token streams, manages conversation state, and uploads assets to chat?

→ **[Chapter 20: Multi-Agent Routing & Delegation](../part-8-multi-agent/20-multi-agent.md))**
