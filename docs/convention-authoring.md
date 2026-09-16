# Convention-first authoring

Copilotz plugins are static declarations. Configuration belongs to the final
application context. The library uses the same authoring format as application
plugins; there are no `createXPlugin(options)` compatibility wrappers.

## File structure

```text
my-plugin/
  copilotz.json
  collections/ticket/index.ts
  actions/close-ticket/index.ts
  processors/notify-owner/index.ts
  resources/tools/search-tickets/index.ts
  resources/support/config/index.ts
  adapters/ticketStore/default/index.ts
  shared/queries.ts
  plugin.generated.ts
```

Each discovered `index.ts` has a default export. Collections, Actions, and
Processors have one alias segment; Resources and Adapters have a namespace and
an alias. A helper used by one primitive stays inside that primitive module. Use
`shared/` only for code reused across different primitives; public authoring
APIs live in `authoring/`. Tests and README files are not discovered. Symlink
directories are not traversed.

Directory names become camelCase aliases: `close-ticket` becomes `closeTicket`.
Aliases are local registration names; stable Action IDs and Collection names
remain explicit inside their declarations. Explicit aliases are useful for
model-facing names such as `search_tickets`:

```json
{
  "id": "acme.support",
  "version": "1.0.0",
  "plugins": [{ "from": "@copilotz/copilotz/core", "export": "corePlugin" }],
  "aliases": {
    "resources/tools/search-tickets/index.ts": "search_tickets"
  }
}
```

An optional `include` array lists exact entry paths. Omit it to discover every
conventional entry. Use it to deliberately select capabilities; nothing scans
arbitrary exports or infers dependencies from imports. Dependencies are explicit
manifest `plugins` imports. Each entry has a `from` module specifier and an
`export` name (use `default` for default exports). There are no dependency
forwarding modules. `shared/` is excluded from discovery.

## Build on the development or CI host

Install the CLI using the package version selected by your project:

```sh
deno install -g -A -n copilotz jsr:@copilotz/copilotz/build
copilotz build ./my-plugin
# Multiple explicit roots are generated before their dependency graphs are checked:
copilotz build ./shared-plugin ./application-plugin
```

The compiler requires Deno 2.9 or later on the build host. It has no Browser or
Cloudflare compiler entry point. The default output is portable ESM at
`dist/plugin.js`. Use `--platform=deno` only for plugins that explicitly import
native capabilities. The platform flag describes the output target, not where
compilation runs.

- `--source-only`: write the static TypeScript composition entry, without
  bundling.
- `--check`: fail when `plugin.generated.ts` differs from the current
  declarations.
- `--output=path`: choose the ESM output file.

Discovery parses source syntax without executing it, sorts paths
deterministically, and reports missing default exports, invalid aliases, and
alias collisions with source paths. Build then type-checks and imports the
generated declaration in a read-only validation process, validates the
dependency graph and native identities, and bundles ESM. Validation does not
start an application. The existing bundle is replaced only after successful
bundling.

Generated modules contain ordinary static imports and `definePlugin`. They do
not contain filesystem discovery or the TypeScript compiler. Keep compilation
and native adapter imports out of deployment runtime entry points. In this
repository, `deno task build:plugins` regenerates all 23 concrete roots and
`deno task check:generated` verifies them.

## Define a tool once

```ts
// resources/tools/search-tickets/index.ts
import { defineTool } from "@copilotz/copilotz/core";

export default defineTool({
  id: "acme.support.search",
  name: "Search tickets",
  description: "Find tickets matching a query.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  execute(input: { query: string }, context) {
    const store = context.adapters.ticketStore.default as {
      search(query: string): Promise<unknown>;
    };
    return store.search(input.query);
  },
});
```

Object-form `defineTool` is a synchronous Composition Contribution. Registering
it in `resources.tools.search` contributes the native `actions.search` and a
data-only Tool Resource whose `action` is `search`. No tool-plugin wrapper is
needed. You can select individual library tools by importing their declarations
and placing only those declarations in `resources.tools`.

A custom compound authoring helper can implement the exported `contribution`
symbol. It returns a native `value` plus optional Actions, Collections,
Processors, Resources, or Adapters. Expansion rejects promises, conflicting
aliases, nested contributions, and unsafe namespace keys. It copies registration
containers so a declaration can be reused by different applications. The runtime
knows this generic protocol; it has no special cases for Tools, Memory, or
providers.

## Compose configuration last

```ts
import { createCopilotz } from "@copilotz/copilotz";
import { corePlugin } from "@copilotz/copilotz/core";
import { memoryPlugin } from "@copilotz/copilotz/memory";
import { getCurrentTimeToolResource } from "@copilotz/copilotz/tools/builtin";
import supportPlugin from "./my-plugin/plugin.generated.ts";

const application = await createCopilotz({
  plugins: [corePlugin, memoryPlugin, supportPlugin],
  resources: {
    memory: { config: { enabled: true, retrievalLimit: 12 } },
    tools: { clock: getCurrentTimeToolResource },
  },
  adapters: {
    ticketStore: { default: ticketStore },
    memoryEmbedding: { default: embedMemory },
  },
});
```

`createCopilotz` creates the final root declaration after its dependencies. It
accepts native `collections`, `actions`, `processors`, `resources`, and
`adapters`. Actions and Processors receive the composed context at invocation.
Root Resource and Adapter aliases override dependency values; duplicate native
Action IDs or aliases remain errors. The internal application root is not
exposed as a reusable dependency in `registry.plugins`.

## Library configuration locations

| Capability          | Final context configuration                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Memory              | `resources.memory.config`, `resources.memory.kinds`, `adapters.memoryEmbedding.default`                                                   |
| Knowledge           | `resources.knowledge.config` (`embedding`, `chunking`), `adapters.embedding`, `adapters.knowledge.loader`, `adapters.knowledge.extractor` |
| Usage               | `resources.usage.config.enabled`, `adapters.usage.hooks` (`resolveCost`, `onRecord`)                                                      |
| Channels            | `resources.channels[alias]`, `adapters.channels[alias]`, `adapters.channelProviders[alias]`                                               |
| Skills              | `resources.skills[name]`, `resources.skillConfig.default.maximumTextBytes`                                                                |
| Clock/wait          | `adapters.clock.default` (`now`, `sleep`)                                                                                                 |
| Finance             | `adapters.financeProviders[name]`                                                                                                         |
| Persistent terminal | `adapters.terminal.default` (application-owned service)                                                                                   |
| OpenAPI             | `adapters.openapi[apiId]` (`auth`, `headers`, `prepareRequest`, `baseUrl`, `fetch`, optional `tokenCache`)                                |
| MCP                 | `adapters.mcp[serverId]` (`connect`, optional runtime `server`)                                                                           |
| Server              | `resources.server.default`, constructed with `defineServerFacade`                                                                         |

Channel credentials and transports are transient capabilities scoped by channel
alias. Binding the same static adapter to two aliases does not share
configuration. Memory's static input schema accepts extensible kind names;
execution validates registration and semantic data against the final ontology
from context.

OpenAPI's `compileOpenApiTools({ apis })` returns tool declarations. MCP's
`await prepareMcpTools({ servers, connect })` performs explicit preparation and
returns declarations; the discovery connector is closed and is not retained for
execution. Place either result directly in `resources.tools`. Runtime MCP calls
use the final context connector and never call `listTools`.

Skill directory packing remains an explicit host operation through
`skills/deno`. Native filesystem, process, terminal, and stdio capabilities
remain on their explicit host subpaths. Portable plugin composition does not
require these adapters.

## Migration scope

This is a breaking library refactor. Replace plugin factories with static
imports, move configuration to the locations above, and explicitly select
optional tools. No legacy factory aliases remain. Compass, Mobizap, and Pricing
Agent migrations belong to their separate milestones.

## Runnable agent example

The
[support example](https://github.com/copilotzhq/copilotz/tree/main/contracts/authoring)
contains a Core dependency, Agent and LLM connection Resources, a deterministic
LLM Adapter, and a bootstrap Processor. It builds the plugin, imports its ESM
output into `createCopilotz`, creates a conversation, and verifies a streamed
agent reply. No provider credentials are required. Run it from this repository:

```sh
deno task smoke:authoring
```

For an empty application outside the checkout, copy that example's source files
and create `deno.json` with these package imports (use the released version):

```json
{
  "imports": {
    "@copilotz/copilotz": "jsr:@copilotz/copilotz@0.74.0",
    "@copilotz/copilotz/core": "jsr:@copilotz/copilotz@0.74.0/core",
    "@copilotz/copilotz/actions": "jsr:@copilotz/copilotz@0.74.0/actions",
    "@copilotz/copilotz/plugins": "jsr:@copilotz/copilotz@0.74.0/plugins",
    "@copilotz/copilotz/llm": "jsr:@copilotz/copilotz@0.74.0/llm"
  }
}
```

```sh
deno run -A jsr:@copilotz/copilotz@0.74.0/build build .
deno run -A run.ts
```

Expected output: `Hello from the generated support plugin.` Replace the demo LLM
Adapter with your chosen connection/provider configuration when integrating the
application. Keep credentials in the final application context.
