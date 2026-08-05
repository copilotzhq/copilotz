---
name: copilotz
kind: lib
summary: Event-native multi-agent framework for durable workflows and realtime media streams.
depends_on:
  - ominipg
  - oxian-js
tags:
  - ai
  - multi-agent
  - events
  - streaming
  - plugins
  - database
entrypoints:
  - index.ts
  - engine.ts
  - plugins/registry.ts
  - attachments/manager.ts
  - database/database.ts
  - execution/coordinator.ts
status: active
---

## Purpose

Copilotz provides thread-based multi-agent execution, plugin resources,
durable event deliveries, graph persistence, and realtime media attachments.
Oxian hosts logical workloads; Ominipg persists domain state and recovery work.

## Read These First

- `README.md`
- `docs/architecture.md`
- `index.ts`
- `engine.ts`

## Common Task Locations

- Public engine and contracts: `engine.ts`, `types/`, `events/`
- Plugin composition and core resources: `plugins/`, `core/`, `resources/`
- Persistent graph, events, and deliveries: `database/`
- Oxian workloads and dispatch: `execution/`
- Realtime and text attachment flow: `attachments/`
- Runtime-specific integration: `runtime/adapters/`, `server/`
- Legacy database upgrade only: `migration/v1/`

## Warnings

- Applications usually consume the published JSR package, not this workspace
  checkout.
- Durable delivery is at-least-once; mutations and external effects must honor
  the supplied idempotency key.
- Core modules must remain portable and cannot unconditionally import
  Deno-, Node-, Bun-, browser-, or Cloudflare-specific APIs.
- Namespace and schema isolation are part of the persistence contract.
