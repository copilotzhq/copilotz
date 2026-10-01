---
title: "Ch 13: Content and Usage"
description: "Understand the Asset reference boundary and optionally record metered LLM and Tool work."
section: Getting Started
order: 130
status: stable
---

# Chapter 13: Content and Usage

## The pain

Short control values belong in ordinary records. Large text, files, images, and
other bodies have different storage and access needs. Separately, measuring
model work is not the same as knowing its price: usage may be missing provider
metrics, and negotiated pricing is application policy.

## The solution

Keep semantic records small by letting Copilotz represent body content with
canonical Asset references. If the application needs a durable metering ledger,
add the Usage plugin and optionally expose its analytics adapter. Neither step
changes the Notes Action's business rule.

### Follow a message body through Content

The `message()` calls in Chapters 1 and 9 already exercise the Content path.
Core accepts text and multimodal `ContentInput`, prepares bodies at ingress, and
stores ordered `ContentRef` values in the message record. A ref carries an Asset
ID and safe metadata; it does not embed the body bytes or reveal a storage
locator. The BodyStore owns the actual bytes.

For the Notes feature, you can turn the existing `text` field into a separate
large-body field. These are exact edits to `notes-plugin.ts` from Chapter 3.
First, add the content declaration to the existing `note` Collection beside its
`name` and `schema` properties:

```ts
// Tell the Collection kernel that the body field contains durable Asset refs.
content: { fields: ["body"] },
```

Inside that Collection's existing `schema.properties`, add:

```ts
// Accept the ordered ContentRef array written after prepared content is adopted.
body: { type: "array", items: { type: "object" } },
```

Replace the Collection schema's `required` property with:

```ts
// Require the display text and the large body on every saved note.
required: ["text", "body"],
```

Inside `saveNote.inputSchema.properties`, add the caller-facing body string:

```ts
// Accept the long body as text at the Action boundary.
body: { type: "string", minLength: 1 },
```

Replace the Action schema's `required` property with:

```ts
// Require both the short label and the long body from every caller.
required: ["text", "body"],
```

Replace `saveNote.execute` with this complete method. The collection field
declaration tells the runtime where it may adopt the prepared body:

```ts
// Prepare the potentially large body before the semantic Collection write.
async execute(
  // Type the Action input to match its JSON Schema fields.
  input: Readonly<{ text: string; body: string }>,
  // Receive the current application scope, including content preparation.
  context: ActionContext,
) {
  // Normalize the body and tie preparation identity to this Action operation.
  const preparedBody = await context.content.prepare(input.body, {
    // Keep content preparation stable if this Action operation retries.
    operationKey: "save-note-body",
  });
  // Adopt the body Asset and note record through one declared Collection write.
  return await context.collections.note.create(
    {
      // Keep a short inline summary available for ordinary list views.
      text: input.text,
      // Store the prepared content as canonical Asset references.
      body: preparedBody,
    },
    {
      // Recover the same note write when the Action operation is retried.
      operationKey: "save-note",
    },
  );
},
```

The method preserves the existing Action's `save-note` Collection operation key.
Send the body through the ordinary Action input; do not create an Asset outside
the Collection write and leave the record without its ownership edge. On reads,
request content resolution only for paths the caller needs. The exact
`PreparedContent`, `ContentRef`, read options, and storage configuration are
documented in the [Content and Assets reference](../../content-assets.md);
follow its complete examples when changing your Collection schema.

For production, choose a BodyStore that is reachable from the Gateway and every
Worker that must read the same body. Keep provider credentials in the host's
secret store. BodyStore selection, namespace isolation, size limits, and
retention are part of the content policy, not model prompt configuration.

### Add optional usage tracking

This is an exact addition to the Chapter 11 server composition. The browser-safe
Usage client has a dedicated `/usage/client` entrypoint; server-side tracking
and its HTTP adapter come from `/usage`. Keep the same authenticated Server
facade. The adapter path is chosen to match the client's default
`/api/admin/usage` base URL.

Add this server-side import beside the imports in `server.ts`:

```ts
// Import the Usage plugin and HTTP adapter on the server side.
import { createUsageHttpAdapter, usagePlugin } from "@copilotz/copilotz/usage";
```

In the existing `createCopilotz()` options, add the plugin to its `plugins`
array:

```ts
// Compose the metering ledger with the existing Notes and Server plugins.
plugins: [notesPlugin, serverPlugin, usagePlugin],
```

This list shows the Chapter 11 server by itself. If you also applied Chapter 10
or 12, keep `memoryPlugin`, `corePlugin`, and `coreHttpPlugin` in the array as
applicable; add `usagePlugin` without removing those existing plugins.

Beside the `resources` property in those options, add:

```ts
// Register the Usage analytics adapter under Server's HTTP adapter namespace.
adapters: {
  // Server compiles named HTTP adapters after final plugin composition.
  http: {
    // Match the Usage client's standard /api/admin/usage base path.
    usage: createUsageHttpAdapter({ basePath: "/admin/usage" }),
  },
},
```

Create `usage-report.ts` to query a week of LLM analytics from the mounted
facade:

```ts
// Read the endpoint and bearer token provided by the surrounding host.
import { env } from "node:process";
// Import the browser-safe Usage client from its dedicated entrypoint.
import { createUsageClient } from "@copilotz/copilotz/usage/client";

// Bind the client to the configured Usage route beneath the Server base path.
const usage = createUsageClient({
  // Match createUsageHttpAdapter's /admin/usage path beneath /api.
  baseUrl: env.COPILOTZ_USAGE_URL!,
  // Send host-issued credentials so Server authentication can verify access.
  getRequestHeaders: () => ({
    // Keep the access token in process configuration rather than source code.
    authorization: `Bearer ${env.COPILOTZ_ACCESS_TOKEN!}`,
  }),
});

// Calculate a bounded UTC reporting window without assuming a local timezone.
const to = new Date();
// Start the report seven days before the current instant.
const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

// Ask for daily LLM totals grouped by model within that window.
const report = await usage.analytics({
  // Restrict this query to the metered LLM family.
  filters: {
    // Select model calls rather than Tool lifecycle events.
    kind: "llm",
    // Provide the inclusive beginning of the report window in ISO form.
    from: from.toISOString(),
    // Provide the exclusive/current end of the report window in ISO form.
    to: to.toISOString(),
  },
  // Split each daily series and summary by the provider model identifier.
  groupBy: ["model"],
  // Request one aggregate bucket per UTC day.
  interval: "day",
});

// Pass the validated analytics result to the application's reporting layer.
console.log(report.summary);
```

The plugin records metered LLM and Tool lifecycle data when those events include
it. It can store a provider-reported cost, but it does not guess a price from
token counts. Add an application-owned `resolveCost` hook only when you have a
current pricing source and explicit rules for currency, model versions, cache
usage, and adjustments. A tool call need not contact an LLM, and a report may
contain null for metrics the provider did not report.

## Breaking it down

`ContentRef` is the durable semantic pointer; `BodyStore` holds body bytes. A
Collection declares which paths contain refs so the runtime can adopt, resolve,
authorize, and maintain those Assets with the right ownership rules. This also
lets event history and projections avoid copying large bodies into every row.

Usage is an opt-in ledger built from lifecycle events. Its analytics adapter
uses the same Server authentication boundary as other routes. The `UsageClient`
fetches a typed report; the application remains responsible for display and
pricing policy.

## What this unlocks

- Messages and application records can refer to large content without
  duplicating body bytes in semantic records.
- Callers can request resolved bodies only when a feature needs them.
- A durable usage ledger can report metered activity without treating missing
  metrics or unknown pricing as zero-cost work.

## What's next

Content and usage still need caller-specific scope.
[Chapter 14: Tenants and Access](14-tenants-and-access.md) explains which parts
come from trusted host identity and which require explicit authorization.
