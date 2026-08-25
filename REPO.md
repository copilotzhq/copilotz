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
  - server/index.ts
status: active
---

## Purpose

Copilotz is a generic event-driven runtime. Plugins compose Collections,
Actions, Processors, Resources, and Adapters into applications, including AI
harnesses. Ominipg supplies graph-native persistence and Oxian supplies durable
work placement; neither defines plugin business semantics.

## Read First

- `ARCHITECTURE.md` — canonical first-principles architecture; read before any
  implementation, refactor, or API decision

`README.md` and the curated `docs/` guides describe the executable public
surface. Historical design plans are intentionally not shipped.

Plugin source ownership and the canonical directory template are defined in
`docs/plugin-layout.md`.

## Current Code Map

This map describes the current implementation.

- Public application composition: `create-copilotz.ts`; generic application
  contracts: `runtime/application/public.ts`
- Action definition, lifecycle, and invocation: `runtime/actions/`
- Canonical graph Collections and mutation planning: `runtime/collections/`
- Canonical content/assets: `runtime/content/`
- Conversation Collections, mutation Actions, and projections:
  `plugins/core-collections/`; Agent routing and prompt policy: `plugins/core/`
- Immutable events/deliveries: `runtime/events/`
- Oxian placement: `runtime/execution/`
- Plugin definition/composition: `runtime/plugins/`
- Semantic Resources: their owning primitive directory, such as
  `plugins/core/resources/`, `plugins/llm/resources/`, and
  `plugins/skills/resources/`
- Agent contract, prompt policy, and conversation loop: `plugins/core/`
- Provider-neutral LLM Action, Model/Adapter contracts, and providers:
  `plugins/llm/`
- Provider-aware token estimation: `plugins/llm/authoring/token-estimation/`
- Tool authoring contracts: `plugins/tools/`; concrete Tool plugins:
  `plugins/tool-*/`
- Text/ask processors: `plugins/core/`
- Generic progressive stream output: `runtime/streams/`
- Admin, knowledge, and skills: `plugins/admin/`, `plugins/knowledge/`,
  `plugins/skills/`
- Schedules and usage: corresponding `plugins/` modules
- Minimal Goal authoring loop: `plugins/core/authoring/goals/`
- Channel family barrel: `plugins/channels/`; concrete Channel plugins and
  transports: `plugins/channel-*/`
- Semantic memory plugin: `plugins/memory/`
- Physical persistence: `runtime/persistence/`; Deno host listeners and Body
  storage: `runtime/adapters/deno/`; portable/Node CLI: `plugins/core/adapters/`
- Web Fetch boundary: `server/`
- Isolated legacy-graph-v1 (0.47/0.48) upgrade: `migration/v4/`
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
- Injected sessions, Hypervisors, and dispatchers remain application-owned.
- Run `deno task check` and `deno task test` before release work.
