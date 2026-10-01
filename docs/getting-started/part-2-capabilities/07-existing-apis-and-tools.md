---
title: "Ch 7: Existing APIs and Tools"
description: "Connect a model to existing application functions, OpenAPI operations, or MCP servers through explicit tool grants."
section: Getting Started
order: 70
status: stable
---

# Chapter 7: Existing APIs and Tools

## The pain

When an assistant needs a customer record, a status check, or a write to another
system, a second implementation is tempting. That creates two sets of business
rules to update and two places to audit. The Notes Action from the earlier
chapters already shows the better boundary: keep execution in an Action, then
give an Agent a Tool Resource that names that Action.

## The solution

Copilotz turns a native Tool, an OpenAPI operation, or a discovered MCP Tool
into the same composed Action and data-only Tool Resource. Each Agent still gets
an explicit alias grant. An installed integration is available for composition;
it is not automatically available to every Agent.

### Start with a read-only API operation

This complete `posts-tools.ts` file compiles one public JSONPlaceholder GET
operation into a reusable plugin. Importing it does not send a request; the
generated Action calls the API only when an authorized Agent selects the Tool.
The JSONPlaceholder guide documents `/posts/1` with `userId`, `id`, `title`, and
`body`; it is a public test API for prototypes, not a durable source of business
data ([official guide](https://jsonplaceholder.typicode.com/)).

```ts
// Import the generic plugin composer from the root runtime entrypoint.
import { definePlugin } from "@copilotz/copilotz";
// Import the API declaration and compiler from their OpenAPI-owned entrypoint.
import {
  compileOpenApiTools,
  defineApi,
  openApiToolsPlugin,
} from "@copilotz/copilotz/tools/openapi";

// Describe one public, read-only HTTP API without embedding an API key.
const postsApi = defineApi({
  // Give this upstream connection a stable integration identifier.
  id: "jsonplaceholder",
  // Use a human-readable label in generated Tool presentation.
  name: "JSONPlaceholder",
  // Point generated requests at the public API host.
  baseUrl: "https://jsonplaceholder.typicode.com",
  // Supply the OpenAPI operations that may become Copilotz Actions.
  openApiSchema: {
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

// Declare this integration as an ordinary plugin with generated Action and Tool maps.
export const postsToolsPlugin = definePlugin({
  // Keep the plugin ID stable after publishing it to other applications.
  id: "@example/jsonplaceholder-tools",
  // Track this plugin's independent release version.
  version: "1.0.0",
  // The generated Tools use the OpenAPI integration's runtime Action support.
  plugins: [openApiToolsPlugin],
  // Compile operations before runtime composition; no runtime discovery occurs.
  resources: {
    tools: compileOpenApiTools({ apis: [postsApi] }),
  },
});
```

Add `postsToolsPlugin` to the existing `assistant.ts` `plugins` array and add
`"get_post"` beside `"saveNote"` in that Agent's `capabilities.tools` array.
Those are exact locations in the earlier file; keep the Agent's other properties
as they are. The operation is a safe first example because it reads a public
record. Before granting a write operation, verify the upstream authorization,
validation, and retry behavior that own that change.

### Discover an existing MCP server before composition

MCP discovery is a build/startup step. Prepare Tools before calling
`createCopilotz()`, then provide the same connector under
`adapters.mcp.<serverId>` so each Action can reconnect when it runs. The stdio
connector is a host capability; use it only when your server command is already
installed in the process environment.

This complete `notes-mcp-tools.ts` file wires an existing local stdio server. It
expects `./notes-mcp-server.js` to already exist. Running or importing this
module invokes `prepareMcpTools` at top level, which starts that process and
connects to list its Tools; type-checking the file does not execute discovery.
Replace the command and arguments with an MCP server you already operate, and
run this startup step only in a host that permits the subprocess.

```ts
// Import the plugin composer and the discovery contracts from their owners.
import { definePlugin } from "@copilotz/copilotz";
import {
  type MCPServer,
  mcpToolsPlugin,
  prepareMcpTools,
} from "@copilotz/copilotz/tools/mcp";
// Import the host-specific stdio connector only in a host that permits subprocesses.
import { connectMcp } from "@copilotz/copilotz/tools/mcp/stdio";

// Describe the MCP process that supplies Tool definitions and implementations.
export const notesMcpServer: MCPServer = {
  // Use this stable ID in the generated Tool aliases and Adapter map.
  id: "notes",
  // Show this name in generated Tool labels and diagnostics.
  name: "Notes MCP server",
  // Select the stdio transport and the already-installed local server program.
  transport: {
    // Use standard input and output to communicate with the process.
    type: "stdio",
    // Start the server executable already installed in this host.
    command: "node",
    // Point Node at the local MCP server entrypoint.
    args: ["./notes-mcp-server.js"],
  },
};

// Discover the server's Tool schemas before composing the application.
const discoveredTools = await prepareMcpTools({
  // Restrict discovery to the server described above.
  servers: [notesMcpServer],
  // Use the same connector again at execution time through adapters.mcp.notes.
  connect: connectMcp,
});

// Package generated Action and Tool definitions for reuse by an application.
export const notesMcpToolsPlugin = definePlugin({
  // Give this generated integration a stable plugin identity.
  id: "@example/notes-mcp-tools",
  // Version the generated Action and Tool declarations with the package.
  version: "1.0.0",
  // Depend on the MCP plugin that owns generated MCP Tool semantics.
  plugins: [mcpToolsPlugin],
  // Register every discovered Tool under its generated alias.
  resources: { tools: discoveredTools },
});

// Export the execution Adapter declaration for the application's matching server ID.
export const notesMcpAdapter = {
  // Connect each Tool invocation with the host-owned stdio connector.
  connect: connectMcp,
  // Preserve server metadata needed to reconnect to this exact process.
  server: notesMcpServer,
} as const;
```

In `assistant.ts`, add `notesMcpToolsPlugin` to `plugins`, and add
`adapters: { mcp: { notes: notesMcpAdapter } }` to the application options.
Grant only the generated MCP aliases the Agent needs. Discovery opens the server
to list Tools; runtime calls reconnect and close through the configured Adapter.
`connectMcp` uses Node subprocess support, so this entrypoint is appropriate for
a Node/Deno host, not a browser bundle.

### Keep native Tools close to application rules

For a local function, use Core's `defineTool` over an Action, as in
[`notes-plugin.ts`](../part-1-foundations/03-application-data-and-actions.md).
For an API already described by OpenAPI, use `/tools/openapi`. For a protocol
server, use `/tools/mcp` and a host connector. All three produce Actions with
durable lifecycle Events, and each Agent still names its exact allowed aliases.

## What this unlocks

Your Agent can use existing application behavior without making the model the
owner of business rules. The same Action can be called by the Agent or exposed
through the HTTP Server API. Generated integrations remain inspectable and
composable with your own Collections, Actions, and Processors.

## What's next

As tool catalogs grow, adding every procedure to every prompt makes selection
harder. [Chapter 8: Skills](08-skills.md) adds reusable instructions that agents
can load when a task needs them.
