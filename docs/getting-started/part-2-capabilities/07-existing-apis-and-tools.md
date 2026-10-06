---
title: "Ch 7: Existing APIs and Tools"
description: "Connect a model to existing application functions, OpenAPI operations, or MCP servers through explicit tool grants."
section: Getting Started
order: 70
status: stable
---

# Chapter 7: Existing APIs and Tools

## The pain

The Notes assistant can save a note through a local Action. When it needs data
from an existing HTTP API or MCP server, rewriting that service's operations as
local tools adds another schema and execution path to maintain.

## The solution

Declare the integration under `resources.apis` or `resources.mcp`. Copilotz
installs its native Actions, Tool Resources, and default runtime bindings from
that declaration. The assistant still needs an explicit grant for each tool it
may call.

Choose the integration your application needs. The following sections are exact
additions to the existing `assistant.ts`; keep its Core and Notes plugins, LLM
connection, Agent properties, message handling, and cleanup.

### Start with a read-only OpenAPI operation

Create `posts-api.ts` beside `assistant.ts`. This complete file describes one
public JSONPlaceholder GET operation. Importing it performs no HTTP request; the
generated Action calls the API only when invoked. JSONPlaceholder is a public
test API for prototypes, with `/posts/1` returning `userId`, `id`, `title` and
`body` ([official guide](https://jsonplaceholder.typicode.com/)).

```ts
// Import the declaration helper from its OpenAPI-owned public entrypoint.
import { defineApi } from "@copilotz/copilotz/tools/openapi";

// Describe one public, read-only HTTP API without embedding an API key.
export const postsApi = defineApi({
  // Give this upstream connection a stable integration identifier.
  id: "jsonplaceholder",
  // Use a human-readable label in generated Tool presentation.
  name: "JSONPlaceholder",
  // Point generated requests at the public API host.
  baseUrl: "https://jsonplaceholder.typicode.com",
  // Select the original operation alias this assistant should be able to call.
  operations: ["get_post"],
  // Supply the OpenAPI schema once; composition installs its Action and Tool.
  schema: {
    // Declare the OpenAPI dialect used by this document.
    openapi: "3.1.0",
    // Name this compact API description for OpenAPI consumers.
    info: {
      // Label the API definition that owns the operation.
      title: "JSONPlaceholder Posts",
      // Version this local OpenAPI description independently from the service.
      version: "1.0.0",
    },
    // Describe only the operation this Agent needs.
    paths: {
      // Bind the post read operation to its upstream resource path.
      "/posts/{id}": {
        // The GET operation reads one public post and makes no remote change.
        get: {
          // This stable operation ID becomes the Tool alias granted below.
          operationId: "get_post",
          // Explain the operation to the model in its Tool catalog.
          summary: "Read a public post by its numeric ID",
          // Declare the required path value used to build the request URL.
          parameters: [{
            // Bind this value to the `{id}` path segment above.
            name: "id",
            // Tell the compiler to substitute this value into the URL path.
            in: "path",
            // Reject a request that omits the record ID.
            required: true,
            // Require a positive integer for the public record identifier.
            schema: {
              // Parse this route value as an integer.
              type: "integer",
              // Disallow zero and negative post IDs in this declaration.
              minimum: 1,
            },
          }],
          // Declare the successful response shape for generated contracts.
          responses: {
            "200": {
              // Explain the successful result expected from this operation.
              description: "A public post",
              // Describe the media type returned for the successful response.
              content: {
                // Match the JSON response format documented by this API.
                "application/json": {
                  schema: {
                    // Return one JSON object rather than a collection page.
                    type: "object",
                    properties: {
                      // Identify the public author of this record.
                      userId: { type: "integer" },
                      // Identify the returned post.
                      id: { type: "integer" },
                      // Include its human-readable title.
                      title: { type: "string" },
                      // Include its full text body.
                      body: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});
```

Add this import to `assistant.ts`:

```ts
// Reuse the declaration instead of compiling a second tools map.
import { postsApi } from "./posts-api.ts";
```

Inside the existing `resources` object, add this sibling property beside
`agents` and `llmConnections`:

```ts
// Declare the API under its resource family; composition installs its support.
apis: {
  // Register the resource without a separate support-plugin import.
  posts: postsApi,
},
```

Inside `resources.agents.assistant`, replace the capability grant with this
version. Keep any other tool grants you have already added:

```ts
// Give this Agent access to the existing Notes Action and one read-only API tool.
capabilities: {
  // The API operationId supplies the generated get_post alias.
  tools: ["saveNote", "get_post"],
},
```

In the existing `message()` call, replace `content`:

```ts
// Ask for a public record through the newly granted API operation.
content: "Read public post 1 and tell me its title.",
```

Run the assistant with either host configured at the start of the guide. This
makes a model request through the existing connection and, when selected, a
read-only request to the public API:

```sh
# Run the existing message and output loop with Deno's host permissions.
deno run -A assistant.ts
# Or run the same ESM project with Node 24+.
node assistant.ts
```

### Connect an existing MCP server

This optional example assumes your host already has `notes-mcp-server.js`, an
MCP stdio server exposing a tool named `search`. Use a server you operate and
adjust the command, arguments, and selected tool names to match it.

Create `notes-mcp.ts` beside `assistant.ts`. Importing this complete module
starts the server to discover its tool schemas; type-checking it does not run
discovery:

```ts
// Import the single awaited MCP resource constructor.
import { defineMcp } from "@copilotz/copilotz/tools/mcp";
// Import stdio only on a host that permits subprocesses.
import { connectMcp } from "@copilotz/copilotz/tools/mcp/stdio";

// Discover this integration before application composition.
export const notesMcp = await defineMcp({
  // Use the server ID as the prefix of generated tool aliases.
  id: "notes",
  // Give the integration a readable name for presentation and diagnostics.
  name: "Notes MCP server",
  // Supply one connection configuration for discovery and runtime calls.
  connection: {
    // Let the stdio connector manage each MCP session.
    connect: connectMcp,
    // Describe the already-installed server process.
    transport: {
      // Exchange protocol messages through standard input and output.
      type: "stdio",
      // Start the Node executable available in the host environment.
      command: "node",
      // Resolve the server file from the project's working directory.
      args: ["./notes-mcp-server.js"],
    },
  },
  // Select the advertised server tool this assistant needs.
  tools: ["search"],
});
```

Add this import to `assistant.ts`:

```ts
// Reuse the discovered resource and its default connection binding.
import { notesMcp } from "./notes-mcp.ts";
```

Inside the existing `resources` object, add:

```ts
// Composition installs the discovered MCP Actions and Tool Resources.
mcp: {
  // Register the server once without another preparation or adapter step.
  notes: notesMcp,
},
```

Append `notes_search` to `resources.agents.assistant.capabilities.tools`. If you
also enabled the OpenAPI example above, the grant becomes:

```ts
// Preserve the previously granted tools and add the selected MCP operation.
capabilities: {
  // MCP aliases combine the server ID and its original tool name.
  tools: ["saveNote", "get_post", "notes_search"],
},
```

Run `assistant.ts` as above with a request your server's search tool can answer.
Importing `notes-mcp.ts` discovers the tool once and closes that session. Each
subsequent tool invocation connects, calls the server, and closes its own
session using the same configuration.

## Breaking it down

Registration and authorization are separate. `resources.apis.posts` contributes
`get_post`; `resources.mcp.notes` contributes `notes_search`. Neither
declaration grants those tools to the assistant. The Agent's
`capabilities.tools` selects which installed tools it may use, just as it does
for the native `saveNote` Action from Chapter 3.

`defineApi` accepts OpenAPI schema data or text and performs no network I/O.
`operations` selects original operation aliases; omit it to install every
operation. Unknown selections fail during declaration. Aliases normally derive
from `operationId`, with a deterministic fallback when it is absent. An
`aliases` map can rename an agent-facing tool while selection and request hooks
retain the original operation identity.

`await defineMcp` performs discovery and validates selected server tools before
composition. Omit `tools` to install the discovered catalog. Discovery accepts
`signal` and `timeoutMs`, defaults to 30 seconds, and closes sessions on
failure. There is no second preparation constructor or catalog polling during
tool calls. A changed server schema requires a new declaration and coordinated
application restarts.

Credentials, base URLs, request preparation, and execution connectors are owned
by the application. API declarations supply their default `adapters.openapi[id]`
binding; MCP's `connection` supplies its default `adapters.mcp[id]` binding. A
root adapter override replaces the whole binding, so include every required
field. A different schema or server requires a new resource declaration rather
than replacing only a composed descriptor. `transformTool(tool, alias)` can wrap
an API's generated Action or customize its presentation during declaration
without registering a duplicate tool. See [APIs and tools](../../api.md).

Stdio requires subprocess support. On browsers or Workers, use an appropriate
network connector through `connection.connect`. Workers also require an allowed
I/O initialization context for the awaited MCP constructor. Keep host-specific
connectors out of browser bundles.

For filesystem convention authoring, default-export these same declarations from
`resources/apis/posts/index.ts` or `resources/mcp/notes/index.ts` in your
plugin. The generated plugin includes the resources and composition installs
their support. It needs no additional Tool leaves or support-plugin imports. An
awaited MCP leaf performs discovery when evaluated on the build host as well as
at application startup. See
[Convention-first authoring](../../convention-authoring.md).

## What this unlocks

The assistant can use existing service contracts through the same native Action
execution path as `saveNote`. Tool grants remain explicit, while the application
keeps credentials and execution policy in one integration declaration.

## What's next

An integration gives the assistant a capability. In
[Chapter 8: Skills](./08-skills.md), add instructions and supporting files it
can load only when a task needs them.
