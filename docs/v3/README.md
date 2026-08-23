---
title: Copilotz v3 Implementation Record
description: Design contracts, migration evidence, and release acceptance for v3.
section: Internal Design
status: implementation
---

# Copilotz v3 Implementation Record

This directory preserves the design, migration evidence, and implementation
contracts for v3. Current user documentation lives one level above and is listed
in `docs/manifest.json`.

The baseline is `origin/main` at commit `cb6016b` (`0.56.1`) on 2026-08-06. The
existing `v3` branch is an architectural spike and evidence source, not the
implementation baseline. In particular, it deleted most current capabilities,
documentation, and tests and introduced stateful service classes. Those choices
must not be carried forward implicitly.

## Review Artifacts

- [Feature and Test Parity Ledger](./feature-test-parity.md) defines what must
  remain observable, which architecture-coupled tests need replacement, which
  missing characterization tests must be added first, and which downstream apps
  form the compatibility gate.
- [Content and Asset Model](./content-assets.md) defines a shared representation
  for text, structured values, files, tool payloads, finalized realtime media,
  and future modalities while keeping routing metadata inline and raw stream
  frames ephemeral.
- [Events and Durable Deliveries](./events-and-deliveries.md) records the
  implemented immutable-event store, sparse delivery lifecycle, causal
  settlement, retention, and isolated v1 upgrade.
- [Plugins and Resources](./plugins-and-resources.md) defines the package
  boundary, deterministic resource composition, and independent durable/live
  processor subscriptions.
- [Oxian Execution](./oxian-execution.md) defines private/shared/remote delivery
  placement, ownership, lease claiming, and ID-only worker payloads.
- [Event-Native Collections](./event-native-collections.md) defines plugin
  collection composition, atomic typed mutations, before-hook migration, and
  delivery-scoped retry safety.
- [Event-Native Workflows](./event-native-workflows.md) defines graph-native
  LLM-attempt and tool-execution lifecycles, canonical content roles, provider
  fallback relationships, and retry-safe promotion into public messages.
- [Factory Engine Assembly](./engine-assembly.md) composes storage, plugins,
  Oxian, canonical content, graph domains, and tenant-scoped processor
  capabilities without exposing raw persistence to plugins.
- [Runtime Capability Adapters](./runtime-adapters.md) keeps OpenAPI, MCP,
  filesystem, terminal, server, and CLI access explicit at worker assembly.
- [Downstream Migration Matrix](./downstream-migration.md) records exact client
  pins, breaking-surface mappings, rollout order, and per-application gates.

## Non-Negotiable Constraints

1. The implementation starts from current `main`, not from the v3 spike.
2. Runtime modules use factories, closures, functions, and plain records.
   Stateful service classes are not part of the architecture. Narrow error
   subclasses may remain where JavaScript error identity is useful.
3. Product behavior is not removed merely because its current implementation is
   queue-specific, Deno-specific, or otherwise due for replacement.
4. Every removed test has a named parity replacement that passes first.
5. Direct downstream consumers are tested before a breaking API is accepted.
6. Durable semantic state and guaranteed work are database-backed. Oxian owns
   execution placement and transport, not Copilotz domain state.
7. Raw audio, token, and future video frames are stream data, not database
   events. Durable outcomes use the same content/asset model as text.

## Current Gate

The event-native implementation and aggressive cleanup are complete in the
working tree. Canonical content/assets, four-table persistence, immutable
events, durable deliveries, plugins, Oxian placement, graph-native domains,
LLM/tool and public `ask` workflows, attachments/realtime streams, channels,
admin, server, CLI, goals, and isolated v1 upgrades now share one
factory-created runtime.

Release validation is implemented in CI: package/subpath and removed-symbol
checks, Deno/Node/Bun/browser/Cloudflare smokes, PGlite/PostgreSQL matrices,
formatting, downstream embedding contracts, package-file filtering, and a JSR
dry run. The 0.58 local acceptance passes 488 tests with two PostgreSQL-service
tests intentionally deferred to CI, verifies 27 public exports and 245 reachable
production modules, passes Deno, Node, browser-isolate, Cloudflare-isolate, and
Wrangler 4.120.0 checks, and completes the JSR publish dry run without warnings.
Bun 1.3.14 and PostgreSQL run in CI. Existing downstream applications retain
exact 0.x pins and will move through explicit migrations rather than a
compatibility runtime inside v3.
