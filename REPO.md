---
name: copilotz
kind: lib
summary: Agentic AI framework with runtime orchestration, persistent memory, tools, assets, and multi-tenant database support.
depends_on:
  - ominipg
tags:
  - ai
  - runtime
  - database
  - tools
  - assets
entrypoints:
  - index.ts
  - runtime/index.ts
  - utils/loaders/resources.ts
  - database/index.ts
  - server/index.ts
  - server/channels/index.ts
  - create/mod.ts
status: active
---

## Purpose

Shared framework repo used by clients for agent execution, event processing, memory, RAG, assets, and database operations.

## Read These First

- `index.ts`
- `runtime/index.ts`
- `utils/loaders/resources.ts`
- `database/index.ts`

## Common Task Locations

- Runtime and run flow: `runtime/`
- Event processors and native tools: `event-processors/`
- Database schema, migrations, collections: `database/`
- Connectors for LLM, embeddings, storage, HTTP: `connectors/`
- Server helpers (framework-independent): `server/` (exported as `./server`)
- Channel handlers (web, WhatsApp, Zendesk): `server/channels/` (exported as `./server/channels`, `./server/channels/web`, `./server/channels/whatsapp`, `./server/channels/zendesk`)
- Project scaffolding CLI: `create/` (exported as `./create`, used by `deno run -Ar jsr:@copilotz/copilotz/create`)

## Warnings

- Clients usually reference published JSR versions, not the local workspace copy.
- Namespace and schema isolation are core behavior; changes here can affect multi-tenant data semantics.
