---
title: Copilotz v3 Runtime Capability Adapters
description: Explicit factory boundaries for OpenAPI, MCP, filesystem, terminal, and other host-owned capabilities.
section: Internal Design
status: implementation
---

# Copilotz v3 Runtime Capability Adapters

Plugin resources describe logical capabilities. They do not grant a worker
access to a filesystem, subprocess, socket, package loader, or other host API.
The runtime hosting that worker grants those capabilities explicitly through
factory-created adapters.

For API and MCP tools, the portable text workflow uses a worker-local tool
catalog. Static tool resources need no adapter. If `apis` or `mcpServers`
resources exist without their corresponding generator, catalog resolution fails
with a bounded configuration error instead of importing a runtime module or
silently omitting tools.

```ts
import { createCopilotzApplication } from "@copilotz/copilotz/application";
import { createStdioServerWorkflowToolCatalog } from "@copilotz/copilotz/adapters/stdio";

const application = await createCopilotzApplication({
  session,
  namespace: "customer-a",
  core: {
    text: {
      toolCatalog: createStdioServerWorkflowToolCatalog(),
    },
  },
  plugins,
});
```

`createServerWorkflowToolCatalog()` on the generic adapters subpath grants
Web-fetch OpenAPI generation and accepts an explicitly injected MCP connector.
`createStdioServerWorkflowToolCatalog()` lives on the host-only `adapters/stdio`
subpath and additionally grants the first-party subprocess transport. Browser or
Cloudflare workers use the generic factory with only adapters supported by that
host. A shared or remote Oxian worker constructs its catalog locally; dispatch
payloads continue to contain delivery and resource identities, never generator
closures, MCP clients, or transports.

MCP integration is factory-first. `createMcpWorkflowToolGenerator({ connect })`
accepts a structural connection capability. Discovery owns one short-lived
connection, and every tool invocation owns another. All are closed by Copilotz,
which avoids hidden resident clients and gives cancellation a transport-level
boundary. The stdio implementation uses the official SDK internally but does not
expose an SDK class as a Copilotz API.

This same boundary applies to filesystem, terminal, package resolution, server,
and CLI capabilities: portable resources and execution semantics live in core;
host access lives in explicit first-party or application adapters. Unsupported
resources fail during logical resolution rather than making core imports
runtime-specific.

The interactive CLI follows that split directly. `createInteractiveCli()` is a
plain state machine over an `InteractiveCliIo` capability and has no terminal
imports. `createNodeInteractiveCliIo()` and `startNodeInteractiveCli()` live on
`@copilotz/copilotz/adapters/node`, where readline, stdin, and stdout are an
explicit host choice. Deno and Bun can use that compatibility adapter; browser
and worker deployments omit it.

Bundled skills illustrate the capability-free side of that split. Their
generated data modules are parsed into immutable `skills` resources by
`createBundledSkillsPlugin()` with no filesystem or network access. The portable
`list_skills` and `load_skill` tools consume those resources directly. Only
`read_skill_resource` requires an injected reader, because references may live
in a host-owned directory or remote store.

The separate `createWebToolsPlugin()` contributes `http_request`, `fetch_text`,
and `web_search`. Those tools depend only on Web APIs and therefore work in
Deno, current Node/Bun, browsers, and Cloudflare workers subject to the host's
network policy. They remain a distinct plugin so an embedding application can
disable or override network access by stable tool ID.

`createFinanceToolsPlugin()` follows the same network-capability boundary. Its
provider registry is closure-backed and worker-local, and the Yahoo provider is
a plain factory product. Applications can inject another provider resolver
without changing the logical `finance` tool ID.

Deno-specific filesystem and general subprocess behavior lives on the separate
`@copilotz/copilotz/adapters/deno` subpath. It provides factory plugins for the
bounded workspace tools and `run_command`, plus a reference reader that can be
injected into the core skill tools. The generic root and `copilotz/adapters`
entrypoints do not import that subpath. MCP stdio is similarly isolated on
`@copilotz/copilotz/adapters/stdio`; it is never imported by the generic adapter
entry point. Node/Bun hosts can provide equivalent plugins with the same stable
tool IDs; browsers and Cloudflare workers simply omit them.

Persistent terminals use a two-part boundary. The runtime-neutral
`createPersistentTerminalToolsPlugin()` receives a `PersistentTerminalService`;
`createDenoPersistentTerminalService()` owns Deno child processes and session
state. The application—not the plugin registry—owns and shuts down that service.
Asset transfers cross the boundary through canonical content callbacks, so the
adapter never reaches into SQL or a legacy asset store. The Deno service is
worker-local: an embedded engine already targets one attached worker, while a
shared hypervisor must configure a stable worker target (or inject an external
terminal service) when shell state must survive deliveries.

The first-party server facade terminates at the Web Fetch contract.
`createEventNativeFetchHandler()` maps `Request` values into the
transport-neutral application, preserves raw channel bytes, and passes native
streaming `Response` values through. Request-bound attachment output is exposed
as a framework-neutral `EventNativeOutputStream`; the Fetch adapter serializes
semantic output incrementally as SSE, honors pull backpressure, omits raw media
streams from JSON frames, and propagates response cancellation to the channel
execution. A versioned `projectSseOutput` hook owns any legacy wire vocabulary
outside the event-native core. `createV1SseProjector()` is the first-party v1
edge: it maps canonical deltas and public messages to uppercase compatibility
frames while preserving media and oversized content as configurable asset links.
`createV1RouteAdapter()` keeps the transitional `providers` → `channels` and
`admin` → `features/admin` aliases at that same boundary, while
`createV1FetchHandler()` composes the aliases, `/v1` base path, and SSE
projection in one factory. The same handler can therefore be mounted by Deno,
Node, Bun, browser service workers, or Cloudflare workers without bringing a
framework or runtime API into the core.

Plugin package loading is also injected. `createModulePluginResolver()` requires
a runtime-owned `importModule` capability, resolves relative sources only
against an explicit base URL, and accepts a specifier-policy hook. The registry
and published package never perform an unanalyzable dynamic import, read a
directory, or guess how JSR, npm, authenticated URLs, or import maps work in the
embedding host.
