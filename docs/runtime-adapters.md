# Runtime Capability Adapters

Plugin resources describe logical behavior; they do not grant filesystem,
subprocess, package-loader, or server access. The embedding worker grants those
capabilities explicitly.

| Subpath           | Capability                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `/adapters`       | Ominipg sessions, module plugin resolution, Web-fetch OpenAPI generation, and injected MCP transport |
| `/adapters/stdio` | Official MCP SDK subprocess transport                                                                |
| `/adapters/deno`  | Deno workspace/process tools, Open Skill build packer, and persistent terminal service               |
| `/adapters/node`  | Node terminal I/O for the interactive CLI                                                            |

Generic OpenAPI with an application-owned MCP transport:

```ts
import { createServerWorkflowToolCatalog } from "@copilotz/copilotz/adapters";

const catalog = createServerWorkflowToolCatalog({
  connectMcp: connectOverApplicationTransport,
});
```

Explicit server-side stdio:

```ts
import { createServerWorkflowToolCatalog } from "@copilotz/copilotz/adapters/stdio";

const catalog = createServerWorkflowToolCatalog();
```

Adapter subpaths identify placement; their symbols remain capability-oriented.
For example, `/adapters/node` exports `startInteractiveCli()` and
`/adapters/deno` exports `createWorkspaceToolsPlugin()` without repeating the
runtime in each API name.

The normal interactive CLI receives the application and stable agent ID, then
uses canonical capability introspection for `/agents`, `/tools`, and `/skills`:

```ts
startInteractiveCli({ application, agent: "support", scope });
```

Remote/custom clients can use the portable state machine with injected
`performRun` and `inspect` callbacks instead.

Importing the root or generic adapters never imports the stdio SDK. Browser and
Cloudflare hosts omit unsupported resources or inject a transport they own.
Missing capabilities fail during resource resolution instead of silently
dropping tools.

Package/path plugin resolution is explicit too:

```ts
import { createModulePluginResolver } from "@copilotz/copilotz/adapters";

const pluginResolver = createModulePluginResolver({
  baseUrl: import.meta.url,
  importModule: (specifier) => import(specifier),
});
```

The importer runs in the embedding host, so its package map, authentication, and
supported URL schemes remain host-owned.

Detailed contract: [runtime adapters](v3/runtime-adapters.md).
