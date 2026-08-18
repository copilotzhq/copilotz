---
name: copilotz
kind: lib
summary: Factory-first, event-native multi-agent framework with durable work and realtime Web Streams.
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

Copilotz composes agent, tool, processor, provider, channel, collection, skill,
memory, and feature plugins over graph-native Ominipg persistence and Oxian work
placement.

## Read First

- `README.md`
- `docs/architecture.md`
- `docs/api.md`
- `docs/v3/feature-test-parity.md`

## Code Map

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
- Text/ask processors: `plugins/core/`
- Persistent text/realtime attachments: `runtime/attachments/`
- Memory, knowledge, schedules, usage, goals: corresponding `runtime/` modules
- Channels/features/admin: corresponding `runtime/` modules
- Host capabilities: `runtime/adapters/`
- Web Fetch boundary: `server/`
- Isolated legacy upgrade: `migration/v1/`

## Invariants

- Keep the public architecture factory/closure based.
- Agent tools, peers, and skills require explicit capability grants.
- Durable mutations commit graph, event, and delivery obligations atomically.
- Raw media/token frames are never persisted as events.
- Plugins mutate through typed domain or collection capabilities.
- Core and generic adapters must not import host-specific APIs.
- Injected sessions, Hypervisors, and dispatchers remain application-owned.
- Run `deno task check` and `deno task test` before release work.
