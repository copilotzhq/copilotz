# Runtime Capability Adapters

Plugin resources describe logical behavior; they do not grant filesystem,
subprocess, package-loader, or server access. The embedding worker grants those
capabilities explicitly.

| Subpath                           | Capability                                             |
| --------------------------------- | ------------------------------------------------------ |
| `/adapters`                       | Ominipg adaptation and the portable CLI state machine  |
| `/adapters/deno`                  | Deno listener and filesystem BodyStore                 |
| `/skills/deno`                    | Deno build-time Open Skill packer                      |
| `/adapters/node`                  | Node terminal I/O for the interactive CLI              |
| `/tools/openapi`                  | Web-fetch OpenAPI Action/Tool plugin factory           |
| `/tools/mcp`                      | MCP Action/Tool plugin factory with injected transport |
| `/tools/mcp/stdio`                | Official MCP SDK subprocess connector                  |
| `/tools/deno`                     | Deno workspace and process Tool plugins                |
| `/tools/persistent-terminal/deno` | Deno persistent-terminal service                       |

Generated integrations are composed before the registry is built:

```ts
import { createMcpToolsPlugin } from "@copilotz/copilotz/tools/mcp";
import { createOpenApiToolsPlugin } from "@copilotz/copilotz/tools/openapi";

const openApiTools = createOpenApiToolsPlugin({ apis: [sandboxApi] });
const mcpTools = await createMcpToolsPlugin({
  servers: mcpServers,
  connect: connectOverApplicationTransport,
});

const plugins = [openApiTools, mcpTools];
```

Each factory contributes native Actions and a matching data-only Tool Resource
map. Discovery and alias validation finish before composition; duplicate aliases
or Action IDs fail deterministically.

OpenAPI NDJSON streaming is append-only per channel. A channel's media type is
fixed by its first record, and all channel streams materialize in one content
transaction after every writer closes.

MCP results cross the Action boundary as lossless plain JSON. Standard image,
audio, and embedded-resource bodies are prepared together, materialized in one
atomic content call, and replaced with `ContentRef`s; runtime objects and
unencoded binary values are rejected. Discovered input schemas are cloned and
deeply frozen before composition.

An OpenAPI resource can promote an API response into a canonical tool attachment
without embedding transport-specific code in the tool:

```ts
const sandboxApi = {
  id: "sandbox",
  name: "Sandbox",
  openApiSchema,
  baseUrl: "https://sandbox.example.test",
  responseAssets: {
    asset_export: {
      dataBase64Field: "dataBase64",
      mediaTypeField: "mimeType",
      nameField: "path",
    },
  },
};
```

For `asset_export`, the generated Action publishes the declared field as
canonical content, replaces the base64 field with a `ContentRef`, and retains
the remaining response as ordinary structured output. The mapping is explicit
per operation so Copilotz does not guess which API responses represent files.

Explicit server-side stdio:

```ts
import { createMcpToolsPlugin } from "@copilotz/copilotz/tools/mcp";
import { connectMcp } from "@copilotz/copilotz/tools/mcp/stdio";

const mcpTools = await createMcpToolsPlugin({
  servers: mcpServers,
  connect: connectMcp,
});
```

Owner subpaths identify placement; their symbols remain capability-oriented. For
example, `/adapters/node` exports `startInteractiveCli()`, while `/tools/deno`
exports `createWorkspaceToolsPlugin()` without making the generic runtime own
that Tool integration.

The same naming rule applies to serving a Gateway. Deno applications call
`listen(gateway, options)` from `/adapters/deno`; other hosts mount the
runtime-neutral `gateway.fetch` function in their own server, service worker, or
Cloudflare entry point.

The interactive CLI receives host I/O plus portable `performRun`, `scope`, and
`inspect` callbacks. An application can implement `inspect` with Core's resolver
over its composed plugin registry:

```ts
startInteractiveCli({ performRun, scope, inspect });
```

The terminal adapter does not own a Tool catalog or execute Tools itself.

Importing the root, generic adapters, or generic OpenAPI/MCP factory never
imports the stdio SDK. Browser and Cloudflare hosts omit unsupported plugins or
inject a transport they own. Discovery and composition fail explicitly instead
of silently dropping tools.

Package/path plugin resolution belongs to the embedding host's normal module
system. Import plugin values directly and pass those concrete plugins to
`createCopilotz({ plugins: [...] })`; the registry does not accept string
sources, presets, imports, or a module resolver.

Detailed contract: [runtime adapters](v3/runtime-adapters.md).
