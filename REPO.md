---
name: copilotz
kind: lib
summary: Event-driven runtime for composing applications from plugin primitives.
depends_on:
  - ominipg
  - oxian-js
tags:
  - ai
  - agents
  - events
  - streaming
  - database
entrypoints:
  - index.ts
  - create-copilotz.ts
  - runtime/application/public.ts
  - runtime/persistence/index.ts
  - runtime/actions/index.ts
  - runtime/collections/index.ts
  - runtime/plugins/index.ts
  - runtime/events/index.ts
  - plugins/core/index.ts
  - plugins/llm/index.ts
  - plugins/usage/index.ts
  - server/index.ts
status: active
---

## Purpose

Copilotz is a generic event-driven runtime. Plugins compose Collections,
Actions, Processors, Resources, and Adapters into applications, including AI
harnesses. Ominipg supplies graph-native persistence, which is the durable
authority for recovery. Oxian supplies execution placement and transport;
neither defines plugin business semantics.

## Read First

- [ARCHITECTURE.md](ARCHITECTURE.md) — the contributor architecture contract;
  read before an implementation, refactor or API decision.
- [DOCUMENTATION.md](DOCUMENTATION.md) — the writing and review contract,
  including complete examples, module roles and verification.

[README.md](README.md) introduces the public package. The
[documentation map](docs/README.md) is the single broad guide and reference map.
Historical design plans are intentionally not shipped.

[Contributing to Built-In Plugins](docs/plugin-layout.md) defines repository
source ownership and checks.
[Filesystem Plugin Authoring](docs/convention-authoring.md) explains the
corresponding build convention for applications. Keep those reader roles
separate.

## Current Code Map

This map describes the current implementation.

- Public application composition: `create-copilotz.ts`; generic application
  contracts: `runtime/application/public.ts`; trusted host `app.actions` and
  `app.collections` bindings: `runtime/application/host.ts` (host Actions and
  mutations admit operations with `idempotencyKey`; matching `context` calls use
  `operationKey` within the current delivery and operation); shared host/HTTP
  durable ingress: `runtime/application/ingress/`
- Action definition, lifecycle, and invocation: `runtime/actions/`
- Canonical graph Collections and mutation planning: `runtime/collections/`
- Canonical content/assets: `runtime/content/`
- Conversation Collections: `plugins/core/collections/`; mutation Actions:
  `plugins/core/actions/`; projections and contracts: `plugins/core/shared/`;
  Agent routing and prompt policy: `plugins/core/`
- Immutable events/deliveries: `runtime/events/`
- Oxian placement: `runtime/execution/`
- Plugin definition/composition: `runtime/plugins/`
- Semantic Resources: their owning primitive directory, such as
  `plugins/core/resources/`, `plugins/llm/resources/`, and
  `plugins/skills/resources/`
- Agent contract, prompt policy, and conversation loop: `plugins/core/`
- Provider-neutral LLM Action, connection/model selection and Adapter contracts,
  and providers: `plugins/llm/`
- Provider-aware token estimation: `plugins/llm/authoring/token-estimation/`
- Tool authoring contracts: `plugins/core/authoring/define-tool/`; concrete Tool
  plugins: `plugins/tool-*/`
- Declarative API and MCP resources: `plugins/tool-openapi/` and
  `plugins/tool-mcp/`; Skill root declarations:
  `plugins/skills/authoring/define-skill/`. Their composition contributions
  register ordinary dependencies, Actions and supporting resources.
- Text/ask processors: `plugins/core/`
- Generic progressive stream output: `runtime/streams/`
- Admin, knowledge, and skills: `plugins/admin/`, `plugins/knowledge/`,
  `plugins/skills/`
- Schedules: `plugins/schedules/` and `plugins/schedule-core/`; Usage ledger,
  aggregate analytics, HTTP adapter, and browser-safe client: `plugins/usage/`
- Goal Action: `plugins/core/actions/run-goal/`; default policy:
  `plugins/core/resources/goals/default/`
- Channel family barrel: `plugins/channels/`; concrete Channel plugins and
  transports: `plugins/channel-*/`
- Semantic memory plugin: `plugins/memory/`
- Physical persistence: `runtime/persistence/`; Deno host listeners and Body
  storage: `runtime/adapters/deno/`; portable/Node CLI: `plugins/core/adapters/`
- Semantic automatic HTTP facade: `plugins/server/`; portable Fetch, multipart
  output, and host integration: `server/`
- Package conformance tests and cross-runtime smoke programs: `contracts/`

## Invariants

- The runtime owns generic lifecycle, composition, persistence, and execution
  mechanics; it never owns plugin business meaning.
- Runtime production code never imports a concrete plugin.
- Plugins compose Collections, Actions, Processors, Resources, and Adapters.
- Resources and Adapters remain separate composition/context roots and use
  direct property access, not locators or runtime dependency declarations.
- Actions and Processors declare their expected context as ordinary TypeScript
  interfaces; the runtime passes the complete composed context without
  filtering.
- Plain typed Resource and Adapter objects are canonical. Semantic helper
  factories are optional conveniences, never required constructors.
- Durable mutations commit graph, event, and delivery obligations atomically.
- Action invocation and terminal outcomes are durable Events with their input
  and output or normalized error.
- Raw media/token frames are never persisted as events.
- Collection-declared content is assetized by the Collection kernel.
- Streams, Bodies, Assets, Event Bodies, and durable delivery are runtime
  mechanisms; messages, agents, tools, goals, and similar concepts are not.
- Injected sessions, shared persistence, Hypervisors and dispatchers remain
  host-owned.
- The runtime never scans application resource directories. The Deno build host
  generates static plugin registration; API, MCP and Skill declarations use the
  same ordinary contribution path in generated and hand-written plugins.

## Verification and Release

Use focused tests and checks for the boundary being changed. Updates to main run
`deno task check`, the complete retained test suite, cross-runtime smoke checks,
formatting and the JSR dry run. Tags publish only after those checks succeeded
for that exact main revision; they do not rerun the suite. Do not add parallel
PR or deployment copies of the same checks.

For documentation, follow [DOCUMENTATION.md](DOCUMENTATION.md): type-check
complete examples, execute meaningful deterministic fixtures, check links and
anchors, and keep the two TypeScript snippets in [README.md](README.md)
identical to [Quickstart](docs/quickstart.md). Live-provider examples require
credentials; verify their contracts with scripted adapters without claiming a
paid model run. Keep the navigation manifest aligned with page frontmatter and
the final guide paths.
