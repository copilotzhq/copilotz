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
  - runtime/application/index.ts
  - runtime/capabilities/index.ts
  - runtime/plugins/index.ts
  - runtime/events/index.ts
  - runtime/attachments/index.ts
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
- `IMPLEMENTATION_PLAN.md` — current audit, target APIs, ownership, deletion
  rules, and implementation order; subordinate to `ARCHITECTURE.md`

Other README and `docs/` files describe the code at different historical
checkpoints. They are not architecture authorities and must be reconciled or
deleted during the refactor.

## Current Code Map

This map describes the transitional worktree, not target ownership. Use
`IMPLEMENTATION_PLAN.md` for the destination and move order.

- Public application assembly: `runtime/application/`
- Agent authority and capability introspection: `runtime/capabilities/`
- Canonical content/assets: `runtime/content/`
- Graph-native domains and collections: `runtime/domain/`
- Immutable events/deliveries: `runtime/events/`
- Oxian placement: `runtime/execution/`
- Plugins/resources: `runtime/plugins/`, `runtime/resources/`
- Agents, prompt, and transcript: `runtime/agents/`
- LLM providers and attempt lifecycle: `runtime/llm/`
- Tool catalog, executor, and jq pipelines: `runtime/tools/`
- Concrete Tool plugins and host/protocol integrations: `plugins/tools/`
- Text/ask processors: `plugins/core/`
- Persistent text/realtime attachments: `runtime/attachments/`
- Memory, knowledge, schedules, usage, goals: corresponding `runtime/` modules
- Channels/admin: corresponding `runtime/` modules
- Host capabilities: `runtime/adapters/`
- Web Fetch boundary: `server/`
- Isolated legacy upgrade: `migration/v1/`

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
