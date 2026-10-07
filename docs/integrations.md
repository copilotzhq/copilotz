---
title: "APIs and MCP"
description: "Declare OpenAPI and MCP resources that become ordinary Actions and grantable Tools, and keep credentials and subprocesses in the host."
section: Agent Harness
order: 30
status: stable
---

# APIs and MCP

## The pain

An assistant becomes useful when it can reach services you did not write: a
billing API with an OpenAPI description, or a tool server that speaks the Model
Context Protocol (MCP). Wrapping each endpoint by hand means one Action, one
input schema, one URL builder and one Tool per operation, plus client sessions
for MCP. That glue drifts from the service, and credentials end up inside
modules that tests and shared plugins also import.

## The problem

Both kinds of service already describe themselves. What an application needs is
a contract that:

- turns a description into ordinary Actions (validated input, lifecycle Events)
  and Tools (granted by alias), with no second execution path;
- registers only the operations you select;
- keeps the shared description pure, while the host chooses base URLs,
  credentials, transports and subprocesses.

## The solution

Declare each service as a **resource**. Put the result of `defineApi` under
`resources.apis`, or the awaited result of `defineMcp` under `resources.mcp`.
Composition then registers one Action and one Tool per selected operation, plus
the default runtime binding those Actions call through. There is no plugin to
enable and no compile or preparation step: the resource is the integration.

| Resource | Import                             | Description read                   | Module kind      |
| -------- | ---------------------------------- | ---------------------------------- | ---------------- |
| API      | `@copilotz/copilotz/tools/openapi` | at declaration, no network request | pure definition  |
| MCP      | `@copilotz/copilotz/tools/mcp`     | once, when `defineMcp` is awaited  | host composition |

### Declare an OpenAPI resource

`defineApi` validates and snapshots its declaration. It reads no environment and
makes no request, so the module stays a pure definition that tests and shared
plugins may import. The examples assume Deno 2.9+ or Node 24+ and
`@copilotz/copilotz@^0.85.5`; the API resource needs no other package. This is
`posts-api.ts` from
[Chapter 10](./getting-started/part-3-add-agent-behavior/10-connect-apis-and-mcp.md#create-posts-apits):

```ts
// Declares an OpenAPI resource whose operations become Actions and Tools.
import { defineApi } from "@copilotz/copilotz/tools/openapi";

// The public posts API. `defineApi` validates and snapshots this declaration;
// it does not fetch anything.
export const postsApi = defineApi({
  // Stable API identity. Generated Action IDs are derived from it, so changing
  // it changes every generated Action ID.
  id: "posts",
  // Human-readable name shown with the generated tools.
  name: "Posts",
  // The OpenAPI document, inline. Only what the operation needs is described.
  schema: {
    openapi: "3.0.3",
    info: { title: "JSONPlaceholder posts", version: "1.0.0" },
    // Base URL that generated Actions send requests to.
    servers: [{ url: "https://jsonplaceholder.typicode.com" }],
    paths: {
      "/posts/{id}": {
        get: {
          // Becomes the Action alias and the tool name agents are granted.
          operationId: "get_post",
          // Tells the model what the tool returns.
          summary: "Fetch one blog post by its numeric ID.",
          parameters: [
            {
              // Substituted into the `{id}` segment of the path.
              name: "id",
              in: "path",
              required: true,
              description: "Post ID, from 1 to 100.",
              schema: { type: "integer", minimum: 1 },
            },
          ],
          responses: {
            "200": {
              description: "The post.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      userId: { type: "integer" },
                      title: { type: "string" },
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
  // Operations to expose, by alias. Anything not listed is not registered.
  operations: ["get_post"],
});
```

`schema` takes the OpenAPI document as an object or as serialized JSON/YAML
text. `defineApi` never downloads a document: if yours lives at a URL, the host
loads it and passes the content in.

Each selected operation gets two names:

- the **alias** (`get_post`), taken from `operationId`, which agents grant and
  the model sees;
- the **Action ID**, `copilotz.tools.openapi.posts.get_post`, with lifecycle
  Events such as `copilotz.tools.openapi.posts.get_post.completed`.

`aliases: { get_post: "read_post" }` renames only the grantable alias. The
Action ID keeps the native `get_post` segment, so recorded Event types and
anything that reads them stay stable when you rename a tool for the model.

Changing `id` changes every generated Action ID, so treat it like any other
stable primitive ID. Other declaration fields include `description`, `timeout`,
`headers`, `auth`, `toolPolicies` and `transformTool`. `defineApi` rejects
unknown fields rather than ignoring them.

### Bind credentials in the host

The resource also installs a default runtime binding at `adapters.openapi.<id>`
built from its own `baseUrl`, `headers`, `auth` and `prepareRequest`. A shared
description should not contain secrets. Leave them out and let a host module,
here `api-host.ts`, supply a complete adapter entry for that API:

```ts
// Host composition: chooses where and how the posts API is called.
import { createCopilotz } from "@copilotz/copilotz";
// Reads host settings the same way on Deno and Node.
import { env } from "node:process";
// Pure resource from the previous example.
import { postsApi } from "./posts-api.ts";

// Builds the application when called, so importing this module neither reads
// the environment nor leaves an open app behind.
export async function createPostsApp() {
  const token = env.POSTS_API_TOKEN;
  if (!token) throw new Error("POSTS_API_TOKEN is required");

  return await createCopilotz({
    namespace: "team-notes",
    // Registers the generated Action and Tool for `get_post`.
    resources: { apis: { posts: postsApi } },
    adapters: {
      openapi: {
        // Replaces the resource's default entry as a whole, so restate every
        // field you still need.
        posts: {
          // Application-owned endpoint instead of the document's server.
          baseUrl: "https://posts.internal.example",
          // Sent on every generated request.
          auth: { type: "bearer", token },
          headers: { "X-Client": "team-notes" },
        },
      },
    },
  });
}
```

The entrypoint awaits `createPostsApp()` and calls `app.close()` in a `finally`
block, like every other entrypoint in the guide. An entry may set `baseUrl`,
`headers`, `auth` (`apiKey`, `bearer`, `basic`, `custom` or `dynamic`),
`prepareRequest` and `fetch`; a focused test can compose the pure `postsApi`
itself with an entry whose `fetch` returns a canned `Response`, without a
credential or a network. Tests never import `api-host.ts`.

### Discover an MCP server

`defineMcp` is asynchronous: it opens one connection, lists the server's tools,
checks that every name in `tools` exists, closes that discovery connection and
returns the resource. Because it is awaited at module top level, the module that
calls it is **host composition**, not a pure definition.

The example below needs Deno or Node with permission to start subprocesses, plus
the server file and packages from Chapter 10: the MCP SDK and Zod from
[Install the MCP server's packages](./getting-started/part-3-add-agent-behavior/10-connect-apis-and-mcp.md#install-the-mcp-servers-packages),
and the stdio server from
[Create `notes-mcp-server.ts`](./getting-started/part-3-add-agent-behavior/10-connect-apis-and-mcp.md#create-notes-mcp-serverts),
saved next to this module. This is Chapter 10's `notes-mcp.ts`:

```ts
// Declares an MCP resource by discovering the server's tools.
import { defineMcp } from "@copilotz/copilotz/tools/mcp";
// Connector that runs a server as a child process over stdio.
import { connectMcp } from "@copilotz/copilotz/tools/mcp/stdio";
// Path of the running Deno or Node executable, reused for the child.
import { execPath } from "node:process";
// Turns this module's URL into a file path.
import { fileURLToPath } from "node:url";

// Resolved next to this module, so the working directory does not matter.
const serverPath = fileURLToPath(
  new URL("./notes-mcp-server.ts", import.meta.url),
);

// Deno needs `run` and permissions; Node runs a .ts file directly.
const args = "Deno" in globalThis ? ["run", "-A", serverPath] : [serverPath];

// Discovers the server once, when this module is evaluated, and returns a
// resource that registers one Action and one Tool per selected tool.
export const notesMcp = await defineMcp({
  // Stable server identity; generated aliases and Action IDs derive from it.
  id: "notes",
  // Human-readable name shown with the generated tools.
  name: "Notes reference",
  // Tools to register, by the server's own names. Discovery fails if one is
  // missing, rather than silently registering nothing.
  tools: ["search"],
  // One connection, used for discovery now and for every later call.
  connection: {
    connect: connectMcp,
    transport: { type: "stdio", command: execPath, args },
  },
});
```

The server tool `search` on server `notes` becomes the alias `notes_search` and
the Action `copilotz.tools.mcp.notes.search`.

Connection lifecycle:

- **Discovery** happens once, at evaluation. It times out after 30 seconds by
  default; `timeoutMs` and `signal` change that.
- **Execution** never rediscovers. Each generated Action call opens its own
  connection, calls the tool and closes the connection; cancelling the operation
  closes it too.
- The same `connection` is installed as the default binding at
  `adapters.mcp.<id>`. A host may replace that entry as a whole, using the
  server's native ID as the key, for example to point calls at a different
  transport.

The transport sets no `env`, so the SDK gives the child only a small default
environment rather than this process's variables. Host secrets such as
`OPENAI_API_KEY` are not passed to the server. If a server needs a setting, add
it explicitly under `transport.env`.

### Register and grant

Registration makes Tools available; grants decide which agent may call them.
Both edits are additive, so Skills, specialists, Memory or other tools you
composed earlier stay intact.

In `agent.ts`, import `postsApi` and `notesMcp`, then **add** these entries to
the `agentResources.apis` and `agentResources.mcp` maps, creating either map
when absent and keeping every existing entry:

```ts
// API descriptions whose selected operations become Actions and Tools.
apis: { posts: postsApi },
// Discovered MCP descriptions whose selected tools become Actions and Tools.
mcp: { notes: notesMcp },
```

In `assistant.ts`, **append** `"get_post"` and `"notes_search"` to the end of
`assistant.capabilities.tools`, keeping every grant already in that list.

An ungranted alias is registered but invisible to that agent. A grant names the
alias, never the Action ID.

## Reference

### Where each module runs

| Module                | Pure? | Imported by tests? | Host requirement                        |
| --------------------- | ----- | ------------------ | --------------------------------------- |
| `posts-api.ts`        | yes   | yes                | `fetch` at call time                    |
| `api-host.ts`         | no    | never              | `POSTS_API_TOKEN` when the factory runs |
| `notes-mcp.ts`        | no    | never              | Deno or Node with subprocess permission |
| `notes-mcp-server.ts` | —     | never              | MCP SDK and Zod deployed beside it      |

The `/tools/mcp` import is the same on every supported host, but the stdio
connector starts a child process, so browsers and Workers cannot use it. To test
agent behaviour around an MCP tool, grant a pure stand-in Tool and script the
model, as in
[Chapter 14](./getting-started/part-3-add-agent-behavior/14-test-agents-without-a-provider.md).

### Packaging

When you move to filesystem authoring and build a static plugin, an API resource
is an ordinary resource leaf. A live MCP leaf remains host I/O: keep it out of
reusable pure plugins, and copy the MCP server file and its packages explicitly,
because bundling changes what `import.meta.url` points to. See
[Chapter 22](./getting-started/part-6-evolve-and-reuse/22-organize-and-share-plugins.md).

## What this unlocks

- Any OpenAPI operation or MCP tool becomes a validated, recorded Action and a
  grantable Tool from its own description.
- External calls appear in the same lifecycle Events as your own Actions, so
  inspection, recovery and usage work unchanged.
- Shared definitions stay pure and testable while each host chooses endpoints,
  credentials and subprocesses.

## Next steps

- [Chapter 10: Connect Existing APIs and MCP Servers](./getting-started/part-3-add-agent-behavior/10-connect-apis-and-mcp.md)
  builds and runs both examples end to end.
- [Agent Capabilities](./agent-capabilities.md) explains how grants select
  tools, agents and Skills.
- [Actions](./actions.md) covers the lifecycle Events generated Actions record.
- [Testing and Inspection](./testing-and-inspection.md) shows how to replace
  adapters in focused tests.
