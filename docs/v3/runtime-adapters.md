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

API and MCP integrations are factory-created plugins. Each factory completes
discovery before registry composition and contributes native Actions plus
matching data-only Tool Resources. Duplicate generated aliases or Action IDs
fail composition instead of being silently replaced.

```ts
import { createMcpToolsPlugin } from "@copilotz/copilotz/tools/mcp";
import { createOpenApiToolsPlugin } from "@copilotz/copilotz/tools/openapi";
import { connectMcp } from "@copilotz/copilotz/tools/mcp/stdio";

const openApiTools = createOpenApiToolsPlugin({ apis });
const mcpTools = await createMcpToolsPlugin({
  servers: mcpServers,
  connect: connectMcp,
});

const plugins = [corePlugin, openApiTools, mcpTools];
```

`createOpenApiToolsPlugin()` uses portable Web APIs. `createMcpToolsPlugin()`
accepts a structural connection capability; discovery owns one short-lived
connection and every Action invocation owns another. Connections close on
success, failure, and cancellation. The first-party subprocess connector has one
home, `/tools/mcp/stdio`, and is passed to that factory like any other host
capability. Browser or Cloudflare workers omit it or inject a supported
transport. Dispatch payloads contain delivery and resource identities, never
factory closures, MCP clients, or transports.

OpenAPI NDJSON output is append-only. Channel names must map to distinct stream
IDs, each channel keeps the media type declared by its first record, and all
closed channel batches materialize through one atomic content call.

MCP call results are lowered before Action settlement. Lossless plain JSON is
preserved recursively; standard image, audio, and embedded-resource bodies are
prepared and materialized as one atomic batch, then replaced by canonical
`ContentRef`s. Typed arrays, Blobs, streams, cyclic values, and objects with
non-plain prototypes are rejected. Discovered schemas are cloned and deeply
frozen before registry composition.

This same boundary applies to filesystem, terminal, package resolution, server,
and CLI capabilities: portable resources and execution semantics live in core;
host access lives in explicit first-party or application adapters. Unsupported
resources fail during logical resolution rather than making core imports
runtime-specific.

The interactive CLI follows that split directly. `createInteractiveCli()` is a
plain state machine over an `InteractiveCliIo` capability and has no terminal
imports. `createInteractiveCliIo()` and `startInteractiveCli()` live on
`@copilotz/copilotz/adapters/node`, where readline, stdin, and stdout are an
explicit host choice. Deno and Bun can use that compatibility adapter; browser
and worker deployments omit it.

The portable state machine accepts `performRun` and an asynchronous `inspect`
callback instead of parallel static agent/tool arrays. An embedding application
can back `inspect` with Core's capability resolver over its composed plugin
registry, so adapter output cannot drift from runtime authorization without
adding an application-level capability facade.

Runtime placement belongs to the owning package subpath, not to every exported
symbol. Node runtime adapters and Deno/stdio Tool hosts therefore use the same
capability names an equivalent host implementation would expose.

Skills illustrate the source/runtime split. Canonical Agent Skills directories
are validated by a build-host adapter and emitted as a portable plugin catalog
with lazy skill chunks. `createSkillsPlugin()` owns `list_skills`, `load_skill`,
and—when supporting files exist—`read_skill_resource`; all three consume each
skill's runtime-neutral `read(path)` closure. Generic core imports no skill
catalog or filesystem reader.

The separate `createWebToolsPlugin()` contributes `http_request`, `fetch_text`,
and `web_search`. Those tools depend only on Web APIs and therefore work in
Deno, current Node/Bun, browsers, and Cloudflare workers subject to the host's
network policy. They remain a distinct plugin so an embedding application can
disable or override network access by stable tool ID.

`createFinanceToolsPlugin()` follows the same network-capability boundary. Its
provider registry is closure-backed and worker-local, and the Yahoo provider is
a plain factory product. Applications can inject another provider resolver
without changing the logical `finance` tool ID.

Deno-specific workspace and process Tools live on
`@copilotz/copilotz/tools/deno`; `@copilotz/copilotz/adapters/deno` retains only
generic Deno host mechanisms such as the listener and filesystem BodyStore. The
Skill-owned `@copilotz/copilotz/skills/deno` subpath exports
`buildOpenSkillsPlugin()`. Applications import the generated Skill plugin and
never inject a Deno skill source. MCP stdio is isolated on
`@copilotz/copilotz/tools/mcp/stdio`; it is not imported by the generic adapter
or Tool entrypoint. Node/Bun hosts can provide equivalent plugins with the same
stable tool IDs; browsers and Cloudflare workers simply omit them. The bundled
Deno implementations use the capability IDs `@copilotz/workspace-tools` and
`@copilotz/process-tools`, so another host can replace either implementation
without changing the logical plugin identity.

Persistent terminals use a two-part boundary. The runtime-neutral
`createPersistentTerminalToolsPlugin()` receives a `PersistentTerminalService`;
`createPersistentTerminalService()` from `/tools/persistent-terminal/deno` owns
Deno child processes and session state. The application—not the plugin
registry—owns and shuts down that service. Asset transfers cross the boundary
through canonical content callbacks, so the host never reaches into SQL or a
legacy asset store. The Deno service is worker-local: an embedded engine already
targets one attached worker, while a shared hypervisor must configure a stable
worker target (or inject an external terminal service) when shell state must
survive deliveries.

Service-created assets remain staged while `execute()` runs. The plugin first
validates the complete service result as lossless plain JSON, then materializes
all staged bodies once and remaps candidate IDs/refs in the returned value.
Failure or an unsafe result therefore commits no partial asset graph.

The first-party Gateway terminates at the Web Fetch contract. `gateway.fetch`
maps `Request` values into the transport-neutral application, preserves raw
channel bytes, and passes native streaming `Response` values through. The
internal adapter serializes semantic attachment output incrementally as SSE,
honors pull backpressure, omits raw media streams from JSON frames, and
propagates response cancellation to channel execution. The same Fetch handler
can be mounted by Deno, Node, Bun, browser service workers, or Cloudflare
workers without bringing a framework or transport API into the runtime core.

Plugin package loading is not a runtime adapter. The embedding application uses
its own module system to import plugin values, then passes concrete plugins to
composition. The registry and published package never perform an unanalyzable
dynamic import, read a directory, or guess how JSR, npm, authenticated URLs, or
import maps work in the embedding host.
