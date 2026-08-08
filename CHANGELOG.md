# Changelog

## 0.57.0 — 2026-08-08

Copilotz v3 is an intentionally breaking pre-1.0 architecture release.

### Added

- Factory-created applications, engines, plugins, processors, resources, and
  runtime adapters.
- Canonical immutable content/assets shared by messages, tools, model attempts,
  knowledge, memory, and finalized media.
- Immutable positioned semantic events plus sparse, durable consumer deliveries
  with leases, retries, dead letters, causal settlement, recovery, and
  compaction.
- Oxian execution with private in-process, injected shared-hypervisor, and
  remote dispatcher placement.
- Graph-native participants, threads, messages, model attempts, tool executions,
  custom collections, relations, schedules, memory, usage, and knowledge.
- Public same-thread agent `ask`, persistent attachments, one-call Web Stream
  ingress, participant-labelled concurrent outputs, and realtime provider
  capabilities.
- Runtime-neutral core and explicit Deno, Node, MCP stdio, server, filesystem,
  terminal, and package-loader adapters.
- Agent Skills-compatible manifests, portable lazy skill resources, optional
  plugin-owned disclosure tools, and a Deno build-time directory packer.
- Explicit least-authority agent capabilities, derived ask/skill mechanisms, and
  canonical application introspection with plugin origins.
- Worker-local Oxian workload maps for embedded or outbound registration.
- An isolated one-way v1 database upgrade and transitional v1 HTTP/SSE boundary.

### Changed

- Package composition now uses validated plugins and stable resource IDs.
- `run()` is a temporary attachment over one causal scope; `connect()` owns
  persistent text/control/media interaction.
- Collection post-write behavior is expressed as independent named processors.
- Ominipg is the durable state/recovery authority; Oxian owns work placement.
- Copilotz now targets Oxian `0.20.0-rc.7`'s declarative
  Hypervisor/Worker/transport topology and Ominipg `0.9.0-rc.3`.
- Standard Agent Skills directories are canonical source while generated plugin
  modules are runtime artifacts; generic applications install no skills by
  default.
- Runtime-specific adapter subpaths expose capability-oriented factory names;
  host names no longer repeat in their public symbols.
- Workspace and process adapter plugins use runtime-independent logical IDs,
  allowing equivalent host implementations to replace them by capability.
- The interactive CLI coalesces one streamed tool-call draft into one labelled
  tool line while preserving argument deltas for other event consumers.
- Provider and text workflows are the only default core plugins; tools, web,
  finance, memory, usage, ask, schedules, knowledge, and skills are opt-ins.
- The interactive CLI reads agents, tools, and skills from application
  introspection instead of accepting disconnected display arrays.
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
- The statically imported Copilotz development-skill catalog, generated
  per-skill data modules, core skill tools, and injected filesystem reader.
- Agent `allowed*` fields, implicit all-resource inheritance, and static CLI
  agent/tool metadata.

See [the v3 migration guide](docs/migration-v3.md) and
[downstream migration matrix](docs/v3/downstream-migration.md).
