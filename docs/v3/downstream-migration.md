---
title: Copilotz v3 Downstream Migration Matrix
description: Explicit migration status and acceptance gates for first-party applications and packages.
section: Internal Design
status: implementation
---

# Copilotz v3 Downstream Migration Matrix

Copilotz v3 is intentionally source-breaking. The 0.59.0 persistence and
multi-schema foundation is the current downstream migration target. Existing
clients pin exact 0.x versions, so publishing it cannot silently upgrade them.
That protects production rollout, but it does not count as v3 compatibility:
each application needs a deliberate migration and its own acceptance run.

The library contract `contracts/v3/downstream-embedding.contract.test.ts` is the
reference embedded shape. It proves that an application can own the Ominipg
database and Oxian host, compose an agent/provider/processor plugin, run a
causal turn, and shut Copilotz down without closing injected infrastructure. The
external-dispatcher contract is covered separately by the execution suite,
including ID-only dispatch payloads and app-owned worker lifetime.

## Migration Mapping

| v0.x integration                                                                     | v3 destination                                                                                             |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `createCopilotz({...legacy config})`                                                 | `createCopilotz()` for embedded use or `createCopilotz({ role: "gateway" })` / `createCopilotz({ role: "worker" })` |
| `Copilotz` service type                                                              | inferred `CopilotzApplication` factory product                                                             |
| resource directories and `loadResources()`                                           | `definePlugin({ manifest, resources })`, with an injected module resolver for package/path sources         |
| `ProcessorDeps`, priority, `shouldProcess`, replacement events, and `producedEvents` | independent `defineProcessor()` subscriptions using typed context and collection/domain mutations          |
| uppercase queue/live events                                                          | semantic durable events and ephemeral lowercase deltas                                                     |
| `withSchema()` ambient context                                                       | explicit namespace/schema on application or operation scope                                                |
| direct database operations and `CopilotzDb`                                          | typed conversation, collection, event, content, workflow, and admin capabilities                           |
| `withApp()`                                                                          | `createCopilotz({ role: "gateway" }).fetch`                                                             |
| legacy asset store and `resolveAsset` plumbing                                       | canonical content preparer/resolver and asset references                                                   |
| `start().closed`                                                                     | embedding application owns its server lifecycle; Copilotz exposes idempotent `close()`                     |

## First-Party Status

| Consumer                           | Current pin/direct dependency                                                  | v3 status                                                       | Required acceptance before changing its pin                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compass                            | `0.59.20`                                                                      | Event-native runtime migrated; canonical history rollout active | Keep tenant provisioning in explicit onboarding/migration control flow; validate auth, history, sandbox, channel, and admin suites before each exact version update.                                                          |
| Copilotz Starter                   | `0.36.0`                                                                       | Explicit migration required; highest-value reference app        | Replace filesystem resource loading and `withApp`; add a v3 compile/smoke suite; use it as the public embedded/server example.                                                                                                |
| Gilpinna                           | `0.48.0`                                                                       | Explicit migration required                                     | Port S3/canonical assets, Collections, Actions, provider streaming, and server assembly; run its integration suite plus asset-backed image/tool coverage.                                                                     |
| Mobizap                            | `0.55.6`                                                                       | Explicit migration required; strongest processor gate           | Rewrite every custom processor as a named durable/live subscription; replace direct database/schema operations and channel actions; preserve application idempotency; run all processor, runtime, WhatsApp, and server tests. |
| `@copilotz/chat-adapter` / chat UI | HTTP/SSE consumer rather than core import                                      | Canonical events and compound history migrated                  | Keep strict canonical parser/projection tests for messages, assets, LLM attempts, reasoning, tool calls, progressive output, tool settlement, and pagination.                                                                 |
| `@copilotz/admin`                  | HTTP consumer rather than core import                                          | Event-native admin handlers exist; integration pending          | Add package-level route/shape tests against the v3 server and preserve required admin modules during migration.                                                                                                               |
| `@copilotz/sandbox`                | Copilotz 0.57 domain/events plus Oxian 0.21 and Ominipg 0.9 release candidates | Migrated to the explicit transport/lifecycle contracts          | Keep its dependency-graph, Oxian, persistence, worker-gateway, and process-boundary suites as ecosystem gates; retain only reviewed Copilotz subpath imports.                                                                 |
| `@copilotz/browser`                | No direct core import found                                                    | No core source migration                                        | Keep its independent service contract; integrate only through tools/plugins where an application needs it.                                                                                                                    |

## Rollout Rule

Do not bulk-edit these consumers in the library release branch. Migrate them in
small, reviewable downstream changes, starting with Copilotz Starter, then the
chat/admin packages, Gilpinna, Compass, and Mobizap. A consumer moves its
version pin only after its compile, runtime, persistence, and server contracts
are green. Until then, its existing exact pin remains supported by the
corresponding 0.x release line rather than by compatibility code inside v3.
