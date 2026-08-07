# Changelog

## 0.57.0 — Unreleased

Copilotz v3 is an intentionally breaking pre-1.0 architecture release.

### Added

- Factory-created applications, engines, plugins, processors, resources, and
  runtime adapters.
- Canonical immutable content/assets shared by messages, tools, model attempts,
  knowledge, memory, and finalized media.
- Immutable positioned semantic events plus sparse, durable consumer deliveries
  with leases, retries, dead letters, causal settlement, recovery, and
  compaction.
- Oxian execution with private in-process, injected shared-host, and remote
  dispatcher placement.
- Graph-native participants, threads, messages, model attempts, tool executions,
  custom collections, relations, schedules, memory, usage, and knowledge.
- Public same-thread agent `ask`, persistent attachments, one-call Web Stream
  ingress, participant-labelled concurrent outputs, and realtime provider
  capabilities.
- Runtime-neutral core and explicit Deno, Node, MCP stdio, server, filesystem,
  terminal, and package-loader adapters.
- An isolated one-way v1 database upgrade and transitional v1 HTTP/SSE boundary.

### Changed

- Package composition now uses validated plugins and stable resource IDs.
- `run()` is a temporary attachment over one causal scope; `connect()` owns
  persistent text/control/media interaction.
- Collection post-write behavior is expressed as independent named processors.
- Ominipg is the durable state/recovery authority; Oxian owns work placement.
- The package advances from 0.56.x to 0.57.0 while adopting the v3 public API
  and architecture.

### Removed

- The queue worker/scheduler architecture, thread leases, run generations,
  supersession/coalescing, processor claiming/swallowing/priority phases, and
  legacy resource filesystem loader.
- Private agent delegation/consultation, post-write hooks, public raw graph
  mutation APIs, dual thread storage, compatibility aliases, and stateful
  service-class assembly.
- Unconditional host-runtime imports from the core.

See [the v3 migration guide](docs/migration-v3.md) and
[downstream migration matrix](docs/v3/downstream-migration.md).
