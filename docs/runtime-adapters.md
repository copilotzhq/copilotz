# Host Capability Adapters

The package root is runtime-neutral. Host filesystem, terminal, subprocess, and
server capabilities live on explicit subpaths.

| Subpath                           | Capability                                               |
| --------------------------------- | -------------------------------------------------------- |
| `/adapters/deno`                  | Deno HTTP listener and filesystem BodyStore              |
| `/core/cli`                       | Portable interactive CLI state machine over injected I/O |
| `/core/cli/node`                  | Node-compatible readline/stdin/stdout implementation     |
| `/skills/deno`                    | Build-time Open Skill directory packer                   |
| `/tools/deno`                     | Deno workspace and process Actions/Tool Resources        |
| `/tools/mcp/stdio`                | Official MCP SDK subprocess connector                    |
| `/tools/persistent-terminal/deno` | Deno persistent-terminal service                         |

There are no generic `/adapters` or `/adapters/node` entrypoints.

## Deno Gateway host

```ts
import { listen } from "@copilotz/copilotz/adapters/deno";

const listener = listen(gateway, { hostname: "0.0.0.0", port: 8080 });
```

Other hosts mount the runtime-neutral `gateway.fetch` method directly.

## Interactive CLI

The portable CLI receives application ingress, an existing Core scope, optional
inspection, and injected I/O. The Node entrypoint supplies only terminal I/O:

```ts
import { startInteractiveCli } from "@copilotz/copilotz/core/cli/node";

const cli = startInteractiveCli({
  application: { send: app.send, namespace: "acme" },
  scope: {
    thread: "thread-1",
    participant: "user-1",
    recipientIds: ["agent-support"],
  },
  inspect: async () => ({
    agents: [],
    tools: [],
    skills: [],
  }),
});

await cli.closed;
```

The CLI does not own a Tool catalog, invoke Tools directly, or receive runtime
storage authority. Core adds an opaque Agent display hint to each LLM stream, so
multi-agent output is attributed per response rather than inferred from the
original recipient. The renderer keeps reasoning separate (`Agent thinking>`),
labels visible output with the responding Agent (`Agent>`), and presents an
incremental Ask draft as `Asking Agent → @Target> question` without exposing the
provider's Tool-call JSON.

## Generated Tool integrations

`/tools/openapi` and `/tools/mcp` build ordinary plugins before application
composition. Each generated operation contributes one native Action and a
matching data-only Tool Resource. Duplicate aliases or Action IDs fail during
composition.

For small native tools, author the Action and its presentation together, then
compose the result explicitly. The executable remains only in the Action; the
registered Tool Resource is data-only. This is an intentional compiler boundary:
tool execution has a durable lifecycle, retries, and possible external effects,
so it is never a Resource policy hook.

```ts
import { defineTool } from "@copilotz/copilotz/tools";

import { definePlugin } from "@copilotz/copilotz/plugins";
const tools = definePlugin({
  id: "example.tools",
  version: "1",
  resources: {
    tools: {
      echo: defineTool({
        id: "example.echo",
        name: "Echo",
        description: "Returns the supplied message.",
        execute: ({ message }: { message: string }) => ({ message }),
      }),
    },
  },
});
```

`compileOpenApiTools` accepts either `apis: [defineApi(...)]` or an API
declaration map such as `apis: { booking: defineApi(...) }`. Both forms generate
every schema operation using its operation ID-derived Tool alias.

`defineApi` names a source declaration. Explicit compilation returns Tool
contributions for `resources.tools`. Runtime auth, headers, request hooks,
transport, and optional cache are supplied through `adapters.openapi[apiId]`.
The compiler does not need runtime credentials.

OpenAPI live NDJSON channels are append-only, media-stable, and materialized in
one combined content commit. MCP result lowering accepts lossless JSON and
promotes standard image/audio/resource bodies through one staged
materialization; runtime objects, typed arrays, cycles, and credential-bearing
schemas reject.

Pass built-in provider configuration directly in LLM connections. Import and
register an Adapter only for a custom provider or host capability. The registry
does not load string presets, package paths, or modules at runtime.
