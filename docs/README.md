# Copilotz Documentation

Copilotz is a generic event runtime: you can design Events, Processors,
Collections, Actions and Plugins on their own. An agent harness built from the
same plugins is optional. Add it when your application needs model-backed
participants. The same public imports work on Deno and Node. Browsers and
Workers can run the parts of an application whose host capabilities they
provide.

The public entrypoints are defined by the `exports` field in
[`deno.json`](https://github.com/copilotzhq/copilotz/blob/main/deno.json). The
[API reference](api.md) describes them.

## Choose where to begin

Most guide chapters build on a small Notes application. Choose one of two
tracks:

- **Runtime track (no model needed):** work through chapters 1–7 (Events to
  persistence), then 15 (HTTP), 16 (authentication), 18 (files), 19 (schedules),
  21 (deployment) and 22 (sharing plugins). This track never imports the agent
  harness.
- **Agent track (fastest model reply):** do the
  [setup in Before you start](getting-started.md#before-you-start), then go
  straight to
  [chapter 8, Hello agent](getting-started/part-3-add-agent-behavior/08-hello-agent.md).
  After that, add the optional chapters you need. Some of them build on runtime
  chapters, and each chapter lists its prerequisites.

Setup instructions for each host are under [Deno](getting-started.md#deno) and
[Node](getting-started.md#node). The [quickstart](quickstart.md) contains one
complete program for each track. The [overview](overview.md) explains how the
runtime and the harness fit together.

## The guide in six parts

| Part                 | Start here                                                                                             | Related references                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 1 Design and Build   | [Send your first Event](getting-started/part-1-design-and-build/01-send-your-first-event.md)           | [Plugins and Processors](plugins-and-processors.md), [Collections](collections.md), [Actions](actions.md)             |
| 2 Verify and Recover | [Test and inspect](getting-started/part-2-verify-and-recover/06-test-and-inspect.md)                   | [Testing and inspection](testing-and-inspection.md), [Events, deliveries and recovery](events-deliveries-recovery.md) |
| 3 Add Agent Behavior | [Hello agent](getting-started/part-3-add-agent-behavior/08-hello-agent.md)                             | [Models](models.md), [Agent capabilities](agent-capabilities.md), [Integrations](integrations.md)                     |
| 4 Release to Users   | [Expose an HTTP API](getting-started/part-4-release-to-users/15-expose-an-http-api.md)                 | [Server and client](server.md), [Channels](channels.md), [Content and assets](content-assets.md)                      |
| 5 Operate and Scale  | [Schedule recurring work](getting-started/part-5-operate-and-scale/19-schedule-recurring-work.md)      | [Schedules](schedules.md), [Usage](usage.md), [Deployment Topologies](embedding-and-hypervisors.md)                   |
| 6 Evolve and Reuse   | [Organize and share plugins](getting-started/part-6-evolve-and-reuse/22-organize-and-share-plugins.md) | [Filesystem Plugin Authoring](convention-authoring.md), [Upgrading](upgrading.md)                                     |

The [guide introduction](getting-started.md) lists all 22 chapters and their
prerequisites.

## Library reference

Each page below is the main reference for its topic.

### Runtime

- [Plugins and Processors](plugins-and-processors.md): the five plugin
  primitives and orchestration that is safe to retry.
- [Collections](collections.md) and [Actions](actions.md): application state and
  the operations that share it.
- [Events, deliveries and recovery](events-deliveries-recovery.md): immutable
  facts, retries, settlement and reconnection.
- [Content and assets](content-assets.md) and [progressive streams](streams.md).

### Agent Harness

- [Models](models.md): connections, providers and LLM adapters.
- [Agent capabilities](agent-capabilities.md): grants for tools, agents and
  skills.
- [Integrations](integrations.md): native tools, OpenAPI and MCP.
- [Skills](skills.md), [Agents asking agents](multi-agent-ask.md) and
  [Semantic memory](memory.md).
- [Knowledge](knowledge.md), [Shared Spaces](spaces.md) and [Goals](goals.md):
  optional semantic features.

### Deliver

- [HTTP server and browser client](server.md): routes, policy and live
  observation.
- [Channels](channels.md): web, WhatsApp, Telegram, Discord and Zendesk.

### Operate

- [Runtimes and Host Capabilities](runtime-adapters.md): portable declarations,
  host requirements and the exact CI coverage.
- [Testing and inspection](testing-and-inspection.md).
- [Schedules](schedules.md) and [Usage](usage.md).
- [Deployment Topologies](embedding-and-hypervisors.md): running in one process
  or several.
- [Observation performance](observation-performance.md) and
  [History performance](history-performance.md): benchmarks, capacity limits and
  indexed access paths.

### Evolve

- [Filesystem Plugin Authoring](convention-authoring.md).
- [Upgrading](upgrading.md): explicit upgrades and release history.

### Reference

- [Architecture](architecture.md): plugin ownership, the durable lifecycle,
  content, streams and execution.
- [API and package reference](api.md).

### Contributors

- [Contributing to Built-In Plugins](plugin-layout.md): primitive ownership,
  generated composition and repository checks.
- [ARCHITECTURE.md](https://github.com/copilotzhq/copilotz/blob/main/ARCHITECTURE.md):
  the architecture contract, derived from first principles.
- [REPO.md](https://github.com/copilotzhq/copilotz/blob/main/REPO.md):
  repository layout and checks for contributors.
- [DOCUMENTATION.md](https://github.com/copilotzhq/copilotz/blob/main/DOCUMENTATION.md):
  documentation standards.
