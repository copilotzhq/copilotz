---
title: "Ch 7: Existing APIs and Tools"
description: "Connect a model to existing application functions, OpenAPI operations, or MCP servers through explicit tool grants."
section: Getting Started
order: 70
status: stable
---

# Chapter 7: Existing APIs and Tools

> **Part 2 — Capabilities to add when needed**

## The pain

The Notes assistant can call a local Action. An existing HTTP API or MCP server
already has its own schema and execution contract; writing every operation again
as a tool adds another definition to keep in sync.

## The smallest useful change

Resources declare integrations once. Copilotz contributes their native Actions,
Tool Resources, and default runtime bindings. Agents still need explicit tool
grants; installing an integration grants no agent access by itself.

Choose the integration your application needs. Both examples below are edits to
the existing `assistant.ts`; keep its Core and Notes plugins, LLM connection,
Agent, message handling, and cleanup.

### OpenAPI

Save your service's OpenAPI schema as `billing.openapi.json` beside
`assistant.ts`. This example expects an operation with
`operationId: getCustomer` and a server URL in the schema. Set
`BILLING_API_TOKEN` in the host environment for its bearer credential.

Create `billing-api.ts`:

```ts
// Keep service credentials in the host environment.
import { env } from "node:process";
// Import the declaration helper from the owning public entrypoint.
import { defineApi } from "@copilotz/copilotz/tools/openapi";
// Use the service's existing schema instead of rewriting its operation inputs.
import schema from "./billing.openapi.json" with { type: "json" };

// Declare the HTTP integration once, including the operation selection and binding.
export const billingApi = defineApi({
  id: "billing",
  name: "Billing",
  schema,
  // Select the original operation alias from the supplied schema.
  operations: ["getCustomer"],
  // Give the agent-facing tool a stable, application-owned name.
  aliases: { getCustomer: "billing_get_customer" },
  // Authentication is supplied by the application, never by model-visible inputs.
  auth: { type: "bearer", token: env.BILLING_API_TOKEN! },
});
```

Add this import to `assistant.ts`:

```ts
// Reuse the API declaration rather than compiling a separate tools map.
import { billingApi } from "./billing-api.ts";
```

Inside the existing `resources` object, add this sibling property:

```ts
// Composition installs the selected HTTP Action and its Tool Resource.
apis: { billing: billingApi },
```

Inside `resources.agents.assistant`, extend the existing capability grant:

```ts
// Keep the Notes tool and grant the renamed API operation explicitly.
capabilities: { tools: ["saveNote", "billing_get_customer"] },
```

Keep any other tool grants you have added. Run `assistant.ts` with a request
appropriate to your service, such as asking for a customer's billing details.
The HTTP request happens only when the granted operation is invoked.

## Breaking it down

`defineApi` takes supplied OpenAPI schema data or text and performs no network
I/O. Omit `operations` to expose every generated operation; unknown selected
aliases fail. Tool aliases derive from operationId, with a deterministic
fallback when it is absent. `aliases` renames the generated tools; operation
selection and request hooks still use the original operation identity. There is
no separate compilation or feature plugin import.

Runtime auth, headers, base URL, and request hooks can be supplied in the
resource declaration. A final `adapters.openapi[id]` entry replaces the entire
default binding; include every required binding field in the replacement.
Changing schema requires declaring and composing a new resource. Replacing only
a resource descriptor at the application root does not regenerate Actions.

For application-specific execution or presentation, `transformTool(tool, alias)`
returns the desired ToolDefinition during declaration. It can wrap the generated
Action while retaining its schema, history policy, and attachment handling. This
is useful for adding application result transformations and bookkeeping without
registering a second copy of the same tools.

### MCP

For an MCP integration, create `docs-mcp.ts`. The example assumes
`docs-mcp-server` is installed on your host and advertises a `search` tool:

```ts
// Use the same resource declaration model for an MCP server.
import { defineMcp } from "@copilotz/copilotz/tools/mcp";
// This connector owns the host subprocess and its MCP session.
import { connectMcp } from "@copilotz/copilotz/tools/mcp/stdio";

// Discover the selected server tools once before composing the application.
export const docs = await defineMcp({
  id: "docs",
  name: "Documentation",
  connection: {
    connect: connectMcp,
    transport: { type: "stdio", command: "docs-mcp-server" },
  },
  // Limit the generated catalog to the capability this assistant needs.
  tools: ["search"],
});
```

Add this import to `assistant.ts`:

```ts
// Reuse the resource that already contains its discovered schema and connector.
import { docs } from "./docs-mcp.ts";
```

Inside the existing `resources` object, add:

```ts
// Composition installs the discovered search Action and Tool Resource.
mcp: { docs },
```

Append `docs_search` to the assistant's existing `capabilities.tools`. If you
enabled both integrations above, that grant becomes:

```ts
// Keep existing capabilities and grant only the discovered MCP tool needed here.
capabilities: { tools: ["saveNote", "billing_get_customer", "docs_search"] },
```

`await defineMcp` connects, discovers and validates selected tools, closes the
discovery connection, and returns an ordinary composable resource. The same
connection configuration supplies runtime calls. No second preparation primitive
or marker plugin is required. Tool aliases combine the server ID and tool name;
the example exposes `docs_search`.

Omit `tools` to expose the catalog. Unknown names fail initialization. Discovery
has a 30-second default timeout, accepts `timeoutMs` and `signal`, and closes
connections on failure. It never polls or rediscovers during a tool call. Each
runtime invocation uses the final connector to connect, call, and close. Root
binding overrides should address the same discovered server; a different server
requires a new declaration. Separate processes discover independently, so server
schema changes require coordinated application restarts.

Stdio requires a host that supports subprocesses. For browsers and Workers,
provide an appropriate network connector through `connection.connect`. On
Workers, call the awaited constructor inside an allowed I/O initialization
context, rather than at module scope. Conventional plugin leaves can use a
default awaited export on filesystem build hosts; network discovery then happens
when the generated module is evaluated, including during build validation.

## Native tools

Application functions can still be declared with `defineTool` from
`@copilotz/copilotz/core` under `resources.tools`. The generated integrations
use this same native execution path, cancellation, history policies, content
materialization, and explicit grant checks.

With the filesystem convention loader, default-export the same declarations from
`resources/apis/billing/index.ts` and `resources/mcp/docs/index.ts` inside your
plugin. The generated plugin registers the resources; no extra Tool files or
support-plugin imports are needed. See
[Convention-first authoring](../../convention-authoring.md).

## What this unlocks

- Existing schemas supply executable tools without a second registration step.
- Operation selection and agent grants bound what the model may call.
- Application-owned bindings and wrappers keep credentials and bookkeeping at
  the execution boundary.

## What's next

An integration gives the assistant a capability. In
[Chapter 8: Skills](./08-skills.md), add instructions and supporting files the
assistant can load only when a task needs them.
