---
title: "Chapter 10: Connect Existing APIs and MCP Servers"
description: "Turn an OpenAPI description and an MCP server into ordinary Actions and Tools from declarative resources, and grant them to the assistant."
section: Getting Started
order: 100
status: stable
---

# Chapter 10: Connect Existing APIs and MCP Servers

> Part 3 — Add Agent Behavior · Track: H · Optional · Requires: Chapter 9 ·
> Needs: Deno 2.9+ or Node 24+, an `OPENAI_API_KEY` for the live example, and a
> host that may start subprocesses (for the MCP server)

## The pain

The assistant can save notes and read the clock, but useful facts often live in
services you did not write: an HTTP API with an OpenAPI description, or a tool
server that speaks the Model Context Protocol (MCP).

Wrapping each one by hand means writing a `defineAction` per endpoint, copying
its parameters into an input schema, building URLs, calling `fetch`, then
writing a `defineTool` for each Action. For MCP it also means opening a client
session, listing tools, translating their schemas and closing the session on
every path. That glue drifts from the service it describes, and every service
gets wrapped slightly differently.

## The problem

Both kinds of service already describe themselves. An OpenAPI document names
each operation and its parameters; an MCP server lists its tools and their input
schemas. What is missing is a way to turn that description into the same
primitives the assistant already uses — Actions that validate input and record
lifecycle Events, and Tools that agents are granted by alias — without a second
code path, a separate compile step or an extra plugin to enable.

## The solution

Declare each service as a **resource**. `defineApi` from
`@copilotz/copilotz/tools/openapi` takes an OpenAPI description; `defineMcp`
from `@copilotz/copilotz/tools/mcp` takes an MCP connection. When the host puts
the result under `resources.apis` or `resources.mcp`, composition registers one
ordinary Action and one Tool per selected operation, plus the runtime binding
those Actions call through. There is nothing else to install: the resource is
the integration.

The two kinds are siblings of one idea and differ only in where the description
comes from:

| Resource | Description comes from          | When it is read                         |
| -------- | ------------------------------- | --------------------------------------- |
| API      | an OpenAPI document you provide | at declaration, with no network request |
| MCP      | the server's own tool list      | once, when the host module is evaluated |

This chapter changes five files:

| File                  | Role             | Change                                    |
| --------------------- | ---------------- | ----------------------------------------- |
| `posts-api.ts`        | definition       | new: an OpenAPI resource for a public API |
| `notes-mcp-server.ts` | entrypoint       | new: a small local MCP server over stdio  |
| `notes-mcp.ts`        | host composition | new: discovers that server's tools        |
| `agent.ts`            | host composition | registers both resources                  |
| `assistant.ts`        | definition       | grants the two new tools                  |

`notes-plugin.ts`, `notes-tools.ts`, `composition.ts`, `app.ts` and the Chapter
6 tests do not change. `chat.ts` needs no change to run; one optional edit in
[Check it works](#check-it-works) prints the new tools' Events. The runtime path
never imports these modules.

### Install the MCP server's packages

The API resource needs no new package. The local MCP server in this chapter is
written with the official MCP TypeScript SDK and `zod`, at the versions Copilotz
itself is tested against:

```sh
# Deno: adds both packages to deno.json's import map.
deno add npm:@modelcontextprotocol/sdk@1.29.0 npm:zod@3.25.76
# Node 24+: adds both packages to package.json.
npm install @modelcontextprotocol/sdk@1.29.0 zod@3.25.76
```

`@copilotz/copilotz` stays at `^0.85.4` from earlier chapters. The client side
of MCP comes with Copilotz; these packages are only for the server you write.

### Create `posts-api.ts`

`posts-api.ts` is a **definition module**: it reads no environment and makes no
request. The OpenAPI document is inline and deliberately small. It describes one
read-only operation on JSONPlaceholder, a free public test API that needs no
credential.

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

Each selected operation produces two names:

- The **alias**, `get_post`, comes from `operationId`. It is what
  `capabilities.tools` grants and what the model sees.
- The **Action ID**, `copilotz.tools.openapi.posts.get_post`, combines the API
  `id` and the alias. Its completed Event is
  `copilotz.tools.openapi.posts.get_post.completed`.

This public sample carries no credential. For a private API, keep the shared
description pure and let the host replace the runtime binding: a whole entry
under the host's `adapters.openapi.posts`, with an application-owned base URL
and a credential read from the environment in the host module.
[Integrations](../../integrations.md) shows that pattern.

### Create `notes-mcp-server.ts`

`notes-mcp-server.ts` is a standalone **entrypoint**: a separate program that
Copilotz starts as a child process. It stands in for any MCP server you might
connect. It serves a small, fixed set of demo reference notes; it does not read
the application's `note` Collection, and it is not a second way to save notes.

```ts
// The SDK's high-level server, and the transport that speaks MCP over
// standard input and output.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// Describes the tool's input; the SDK publishes it as JSON Schema.
import { z } from "zod";

// Demo data only: fixed reference notes bundled with this server.
const referenceNotes = [
  "Release checklist: tag the commit, publish the package, announce in #team.",
  "On-call handbook: page the secondary after 15 minutes without a response.",
  "Style guide: write dates as YYYY-MM-DD in every note.",
];

// The server's identity, reported to clients when they connect.
const server = new McpServer({ name: "notes-reference", version: "1.0.0" });

// One read-only tool. Clients discover it, with its input schema, by listing
// tools.
server.registerTool(
  "search",
  {
    title: "Search reference notes",
    description:
      "Search the team's reference notes for a word or phrase. Returns matching notes.",
    // Required text to look for, matched without regard to case.
    inputSchema: { query: z.string().min(1) },
    // Tells clients this tool changes nothing.
    annotations: { readOnlyHint: true },
  },
  // The explicit type satisfies strict checking; `inputSchema` still
  // validates the value at run time.
  async ({ query }: { query: string }) => {
    const needle = query.toLowerCase();
    const matches = referenceNotes.filter((note) =>
      note.toLowerCase().includes(needle)
    );
    // MCP tool results are a list of content parts; one text part here.
    return {
      content: [{
        type: "text",
        text: matches.length > 0 ? matches.join("\n") : "No matching notes.",
      }],
    };
  },
);

// Standard output carries the protocol, so this program never writes to it
// with console.log. Diagnostics, if any, belong on standard error.
await server.connect(new StdioServerTransport());
```

### Create `notes-mcp.ts`

`notes-mcp.ts` is a **host composition module**, like `agent.ts`. It is not a
pure definition: evaluating it starts the server, lists its tools and closes
that discovery session, because `defineMcp` is awaited at the top level. That is
why only `agent.ts` imports it, and tests never do.

Static imports are evaluated before the importing module's own code. So when
`chat.ts` loads `agent.ts`, MCP discovery runs before `agent.ts` checks
`OPENAI_API_KEY`: a missing key still stops the run before the application is
composed, but only after the server has been started and discovered once.

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

The transport sets no `env`, so the SDK gives the child only a small default
environment rather than this process's variables. `OPENAI_API_KEY` is not passed
to the server. If a server needs a setting, add it explicitly under
`transport.env`.

The discovered tool `search` on server `notes` becomes:

- the alias `notes_search`, which agents grant;
- the Action `copilotz.tools.mcp.notes.search`, whose completed Event is
  `copilotz.tools.mcp.notes.search.completed`.

Discovery does not happen again at run time. Each generated Action call opens
its own connection, calls the tool and closes the connection, and cancelling the
operation closes it too. Discovery itself times out after 30 seconds by default;
`timeoutMs` and `signal` change that.

### Edit `agent.ts`

`agent.ts` stays the agent harness's host module. These three named additions
preserve any Skills, specialists or Memory already composed; a complete file
replacement would discard them.

**Insert** these imports after the existing `./notes-tools.ts` import:

```ts
// Pure OpenAPI resource; composition builds its Actions and Tools.
import { postsApi } from "./posts-api.ts";
// Host module: discovers the MCP tools before composition.
import { notesMcp } from "./notes-mcp.ts";
```

**Add** `posts: postsApi` to `agentResources.apis`, creating that map when
absent and keeping every existing entry. **Add** `notes: notesMcp` to
`agentResources.mcp` in the same way. The new entries, shown with only this
chapter's resources, are:

```ts
// API descriptions whose selected operations become Actions and Tools.
apis: { posts: postsApi },
// Discovered MCP descriptions whose selected tools become Actions and Tools.
mcp: { notes: notesMcp },
```

Keep the credential check, all `agentPlugins`, and the existing connections,
clock tool, agents, Skills and Memory configuration unchanged.

### Edit `assistant.ts`

In `assistant.ts`, **append** `get_post` and `notes_search` to
`assistant.capabilities.tools`, preserving every existing grant. With only
Chapter 9 before this chapter, the resulting list is:

```ts
// Existing Notes and clock grants, followed by the two new integration tools.
tools: ["saveNote", "get_current_time", "get_post", "notes_search"],
```

Keep the `agents` and `skills` lists unchanged. Optionally, append a sentence to
the existing `instructions`, such as "Use get_post to look up a post by ID, and
notes_search to search the team's reference notes." Registration makes the tools
available; the grants let this agent use them.

### What happens on a call

When the model calls `get_post` with `{ "id": 1 }`, Core invokes the generated
Action like any other: the runtime validates the input against the schema
derived from the OpenAPI parameter, records `…get_post.invoked`, sends
`GET https://jsonplaceholder.typicode.com/posts/1`, and records
`…get_post.completed` with the response. A call to `notes_search` follows the
same lifecycle, with the Action starting the server, calling `search` and
closing the session in between.

## Check it works

Optional edit to make the calls visible: in `chat.ts`, inside `printReply`,
**replace** the condition of the clock's `if` statement from Chapter 9 so it
matches the clock and both generated `.completed` Event types. Its body,
`console.log(`event ${output.type}`);`, stays as it is:

```ts
// Completed Events of the clock and the two generated tools. Only the
// type is printed; results appear in the reply.
if (
  [
    "copilotz.tools.builtin.get_current_time.completed",
    "copilotz.tools.openapi.posts.get_post.completed",
    "copilotz.tools.mcp.notes.search.completed",
  ].includes(output.type)
) {
```

Then run `chat.ts` once per service:

```sh
# Deno: -A also grants the subprocess and network access these tools need.
deno run -A chat.ts "Use get_post to fetch post 1 and tell me its title."
deno run -A chat.ts "Search the reference notes for release."
# Node 24+
node chat.ts "Use get_post to fetch post 1 and tell me its title."
node chat.ts "Search the reference notes for release."
```

The model's wording differs on every run, and so may its decision to call a
tool; a grant makes a call possible, not certain. Check facts, not prose:

- The first run prints `event copilotz.tools.openapi.posts.get_post.completed`,
  and the reply mentions post 1's title, which begins
  `sunt aut facere repellat`.
- The second run prints `event copilotz.tools.mcp.notes.search.completed`, and
  the reply mentions the release checklist.
- Each run ends with `settled operation <same ID>: completed`, exits with status
  0, and raises no model-call failure. A settled operation alone does not prove
  the model replied; `chat.ts` already checks `llm.call.failed` separately.

If no tool Event line appears, ask again naming the tool explicitly. To check
the Actions without a model or a network, see
[Chapter 14](./14-test-agents-without-a-provider.md) and
[Testing and Inspection](../../testing-and-inspection.md).

The runtime path is unaffected: `app.ts` and the Chapter 6 tests import none of
these modules and still run without a credential or a subprocess.

### Where this runs

The same `/tools/mcp` import works on every supported host, but the stdio
connector starts a child process, so it needs Deno or Node with subprocess
permission. Browsers and Workers cannot use it. `notes-mcp-server.ts` and its
packages must also be deployed next to `notes-mcp.ts`: bundling changes what
`import.meta.url` points to, so copy the server file explicitly.
[Chapter 22](../part-6-evolve-and-reuse/22-organize-and-share-plugins.md) covers
packaging runtime assets.

## What this unlocks

Existing services now reach the assistant as ordinary primitives. You can:

- turn an OpenAPI operation into a validated, recorded Action and a grantable
  Tool by declaring its description;
- connect any MCP server and register only the tools you select, discovered once
  at startup;
- trace an external call through the same lifecycle Events as `notes.save`;
- keep shared definitions pure while the host owns credentials, base URLs and
  subprocess choices.

## Next steps

- Next: [Chapter 11: Package Instructions as Skills](./11-package-skills.md)
  gives the assistant reusable instructions it loads on demand.
- Reference: [Integrations](../../integrations.md) covers API options,
  authentication, binding overrides and MCP transports.
- Reference: [Agent Capabilities](../../agent-capabilities.md) explains how
  grants select tools.
