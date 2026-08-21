# Runtime Capability Adapters

Plugin resources describe logical behavior; they do not grant filesystem,
subprocess, package-loader, or server access. The embedding worker grants those
capabilities explicitly.

| Subpath           | Capability                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `/adapters`       | Ominipg database adaptation, Web-fetch OpenAPI generation, and injected MCP transport            |
| `/adapters/stdio` | Official MCP SDK subprocess transport                                                            |
| `/adapters/deno`  | Deno listener, workspace/process tools, Open Skill build packer, and persistent terminal service |
| `/adapters/node`  | Node terminal I/O for the interactive CLI                                                        |

Generic OpenAPI with an application-owned MCP transport:

```ts
import { createServerWorkflowToolCatalog } from "@copilotz/copilotz/adapters";

const catalog = createServerWorkflowToolCatalog({
  connectMcp: connectOverApplicationTransport,
});
```

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

For `asset_export`, the adapter decodes the declared field into a durable
attachment, removes that base64 field from the bounded tool output, and retains
the remaining response as ordinary structured output. The mapping is explicit
per operation so Copilotz does not guess which API responses represent files.

Explicit server-side stdio:

```ts
import { createServerWorkflowToolCatalog } from "@copilotz/copilotz/adapters/stdio";

const catalog = createServerWorkflowToolCatalog();
```

Adapter subpaths identify placement; their symbols remain capability-oriented.
For example, `/adapters/node` exports `startInteractiveCli()` and
`/adapters/deno` exports `createWorkspaceToolsPlugin()` without repeating the
runtime in each API name.

The same naming rule applies to serving a Gateway. Deno applications call
`listen(gateway, options)` from `/adapters/deno`; other hosts mount the
runtime-neutral `gateway.fetch` function in their own server, service worker, or
Cloudflare entry point.

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

Package/path plugin resolution belongs to the embedding host's normal module
system. Import plugin values directly and pass those concrete plugins to
`createCopilotz({ plugins: [...] })`; the registry does not accept string
sources, presets, imports, or a module resolver.

Detailed contract: [runtime adapters](v3/runtime-adapters.md).
