---
title: "Ch 7: Existing APIs and Tools"
description: "Connect a model to existing application functions, OpenAPI operations, or MCP servers through explicit tool grants."
section: Getting Started
order: 70
status: stable
---

# Chapter 7: Existing APIs and Tools

Resources declare integrations once. Copilotz contributes their native Actions,
Tool Resources, and default runtime bindings. Agents still need explicit tool
grants; installing an integration grants no agent access by itself.

## OpenAPI

```ts
import { createCopilotz } from "@copilotz/copilotz";
import { defineApi } from "@copilotz/copilotz/tools/openapi";
import schema from "./billing.openapi.json" with { type: "json" };

const app = await createCopilotz({
  resources: {
    apis: {
      billing: defineApi({
        id: "billing",
        name: "Billing",
        schema,
        operations: ["getCustomer"],
        auth: { type: "bearer", token: "application-owned-token" },
      }),
    },
  },
});
```

`defineApi` takes supplied OpenAPI schema data or text and performs no network
I/O. Omit `operations` to expose every generated operation; unknown selected
aliases fail. Tool aliases derive from operationId, with a deterministic
fallback when it is absent. There is no separate compilation or feature plugin
import.

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

## MCP

```ts
import { createCopilotz } from "@copilotz/copilotz";
import { defineMcp } from "@copilotz/copilotz/tools/mcp";
import { connectMcp } from "@copilotz/copilotz/tools/mcp/stdio";

const docs = await defineMcp({
  id: "docs",
  name: "Documentation",
  connection: {
    connect: connectMcp,
    transport: { type: "stdio", command: "docs-mcp-server" },
  },
  tools: ["search"],
});
const app = await createCopilotz({ resources: { mcp: { docs } } });
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
