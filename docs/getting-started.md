---
title: "Getting Started Guide"
description: "Build one Notes application on the Copilotz runtime, verify and persist it, then add the optional agent harness and the delivery and operations capabilities your product needs."
section: Getting Started
order: 0
status: stable
---

# Getting Started with Copilotz

Copilotz is a generic application runtime built from five primitives:

- **Collections** hold application state.
- **Actions** are named operations with a tracked lifecycle.
- **Processors** react to Events.
- **Resources** are declarative configuration that plugins read.
- **Adapters** supply host or provider implementations.

Plugins compose these primitives, and Events connect them. The runtime records
Events and Action lifecycles and coordinates the work they trigger, so you can
test, persist, recover and serve your application. Ordinary application code and
process-local policy hooks run as normal code; the runtime does not record each
of their steps.

**Core** is an optional agent harness built on the same runtime. It contributes
conversations, agents, model connections and tools as plugins and Resources of
its own, but it does not own your product. Your application's behaviour, data
and policy stay in your own plugins, whether a person, an HTTP client, a
schedule or an agent calls them.

This guide builds one small Notes application across 22 chapters in six parts.
It targets **Copilotz 0.85.0**.

## Choose a route

Every chapter belongs to one track:

- **R (runtime):** never imports `@copilotz/copilotz/core` and needs no model
  credential.
- **H (agent harness):** adds Core on top of the runtime. Harness chapters that
  call a model need a model credential.

```text
Runtime track (R): no model credential
  setup → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 15 → 16 → 18 → 19 → 21 → 22

Agent harness track (H): optional, on the same runtime
  setup → 8                 fastest route to a model reply
  5 + 8 → 9                 present Notes Actions to the agent as tools
  6 + 9 → 14                test agents without a provider (recommended)
  9 → 10 · 8 → 11 · 8 → 12 · 8 → 13      optional branches, in any order
  8 + 16 → 17 → 20          chat over HTTP, then usage (20 is optional)
```

The optional chapters are independent branches, not a checklist. Each chapter's
**Requires** line names the chapters that bring your project to that chapter's
starting point. You install only the plugins your product needs; nothing
requires every plugin.

## How each chapter works

Tutorial chapters use the same six headings, in this order:

1. **The pain:** something concrete your application gets wrong or cannot do
   yet.
2. **The problem:** the underlying constraint, such as durability, ownership,
   isolation or trust.
3. **The solution:** one main new idea, in steps titled `` Create `file` `` or
   `` Edit `file` ``.
4. **Check it works:** the command to run, and the event facts, operation status
   or predicate you should see. Model replies are checked by what happened, not
   by their exact wording.
5. **What this unlocks:** what you can now build or inspect.
6. **Next steps:** the next chapter, then optional branches and reference pages.

Code follows a few conventions:

- A **Create** step shows the complete file, with every import. It can run as
  shown.
- An **Edit** step names the file and the declaration, and says whether the code
  is inserted or replaces something. If a step makes three or more changes to
  one file, it normally shows the complete updated file. Shared capability files
  use exact additive edits when a replacement would erase optional branches;
  those steps explain what to keep and show the resulting baseline.
- Adding a capability appends to existing plugin lists, resource maps and
  grants, so earlier work is kept.
- Comments explain why a declaration, property or operation exists, not what the
  syntax does.
- Packages, credentials, host capabilities and sample servers are listed before
  the code that needs them.
- Entrypoints read their varying input from command-line arguments, close the
  application when they finish, and report failures.

### Module roles

Each sample file has one of three roles. The chapter that creates it says which.

- **Definition modules**, such as the Notes plugin, the assistant definition and
  the HTTP server factory, only declare behaviour. They do no I/O at import time
  and read no environment variables.
- **Host composition modules** choose the database, credentials and live
  integrations, such as a model connection or MCP discovery.
- **Entrypoints** run things: they send events, start chats or servers, and
  print results.

This split keeps tests deterministic. Tests import only definitions, compose an
in-memory application for each case, and never load host composition. As a
result, they need no credential, network or persistent path.

## Before you start

Use **Deno 2.9+** or **Node 24+**. Create an empty project directory, then
follow one of the setup paths below. Every file path in the guide is relative to
that project's root. Most files sit at the root, and a few, such as Skill and
plugin directories, are nested.

The runtime chapters need no model credential. Chapter 8 introduces the first
one, `OPENAI_API_KEY`, and every chapter that calls a model lists it in its
**Needs** line. A chapter that needs another package, such as a Node HTTP
adapter or the MCP SDK, lists the install command before the code.

### Deno

```sh
# Create a project directory for the guide's files and enter it.
mkdir copilotz-notes
cd copilotz-notes
```

By default, Deno 2.9 holds back dependency versions published in the last 24
hours. This guide uses a recent Copilotz release, so before adding the package,
create `deno.jsonc` with an exception for Copilotz only. Every other dependency
keeps the normal delay. See the
[Deno configuration reference](https://docs.deno.com/runtime/reference/deno_json/#minimum-dependency-age).

```jsonc
{
  // Controls how old a dependency version must be before Deno installs it.
  "minimumDependencyAge": {
    // Keep the normal 24-hour delay for every other dependency.
    "age": "P1D",
    // Let the chosen Copilotz release install as soon as it is published.
    "exclude": ["jsr:@copilotz/copilotz"]
  }
}
```

```sh
# Add Copilotz to deno.jsonc, with import mappings for its plugin subpaths.
deno add jsr:@copilotz/copilotz@^0.86.1
```

### Node

```sh
# Create a project directory for the guide's files and enter it.
mkdir copilotz-notes
cd copilotz-notes
# Create package.json so npm can record dependencies.
npm init -y
# Treat .ts files as ES modules so Node 24+ runs the examples directly.
npm pkg set type=module
# Install Copilotz from JSR and record it in package.json.
npx jsr add @copilotz/copilotz@^0.86.1
# Install PGlite, the database the runtime opens for in-memory and local data.
npm i @electric-sql/pglite
```

Node runs the guide's `.ts` files directly by stripping their type annotations,
so the examples use only TypeScript syntax that Node can strip.

### Where your code runs

The guide's commands run on a local machine, where the host can read files,
start subprocesses and keep a local database directory. Not every runtime can.
Edge and worker platforms may have no local filesystem and no subprocesses.
Chapters that rely on a host capability say so in their **Needs** line. Chapter
21 covers how deployment differs between hosts and between Gateway and Worker
roles.

The runtime chapters start with an in-memory database. Chapter 7 switches to a
local directory. Examples never delete data: to start over, point the database
at a new local directory and treat the old one as disposable.

## The path

Each entry gives the chapter's track and what it **Requires**, then the pain it
resolves and what you have afterwards.

### Part 1 — Design and Build

- [Chapter 1: Send Your First Event](getting-started/part-1-design-and-build/01-send-your-first-event.md)
  · R · Requires: setup. A plain function call leaves no record of what was
  asked or what happened. Send a named event, then read its outputs and
  operation status. Input validation arrives with Actions in Chapter 4.
- [Chapter 2: React With a Processor](getting-started/part-1-design-and-build/02-react-with-a-processor.md)
  · R · Requires: 01. Inline handling ties the sender to every step. Register a
  Processor that reacts to the event's data.
- [Chapter 3: Keep State in a Collection](getting-started/part-1-design-and-build/03-keep-state-in-a-collection.md)
  · R · Requires: 02. Notes vanish when the handler returns. Declare a
  schema-checked Collection whose changes are recorded as facts.
- [Chapter 4: Share Operations as Actions](getting-started/part-1-design-and-build/04-share-operations-as-actions.md)
  · R · Requires: 03. Copied save logic drifts between callers. Define one
  Action with a stable ID and a tracked lifecycle that every caller uses.
- [Chapter 5: Package a Plugin](getting-started/part-1-design-and-build/05-package-a-plugin.md)
  · R · Requires: 04. Behaviour that lives in an entry file cannot be reused.
  Move it into a versioned plugin, and let the application choose its namespace
  and database.

### Part 2 — Verify and Recover

- [Chapter 6: Test and Inspect](getting-started/part-2-verify-and-recover/06-test-and-inspect.md)
  · R · Requires: 05. Manual runs prove nothing about the next change. Compose
  the plugin in memory and assert its recorded outputs under Deno and Node.
- [Chapter 7: Persist and Recover](getting-started/part-2-verify-and-recover/07-persist-and-recover.md)
  · R · Requires: 05 (06 recommended). A restart loses every note. Keep state in
  a local database and learn what the runtime recovers.

### Part 3 — Add Agent Behavior

- [Chapter 8: Hello Agent](getting-started/part-3-add-agent-behavior/08-hello-agent.md)
  · H · Requires: setup only. Fixed code cannot answer open-ended requests
  written in natural language. Compose Core with one model connection and one
  agent, so those requests get model-backed replies.
- [Chapter 9: Grant Tools](getting-started/part-3-add-agent-behavior/09-grant-tools.md)
  · H · Requires: 05, 08. The assistant can talk but cannot act. Present the
  existing Notes Action as a tool and grant it explicitly.
- [Chapter 10: Connect Existing APIs and MCP Servers](getting-started/part-3-add-agent-behavior/10-connect-apis-and-mcp.md)
  · H, optional · Requires: 09. Rewriting existing services as tools duplicates
  work. Declare an HTTP API and an MCP server as granted tools.
- [Chapter 11: Package Instructions as Skills](getting-started/part-3-add-agent-behavior/11-package-skills.md)
  · H, optional · Requires: 08. Long procedures crowd every prompt. Package them
  as a Skill that only granted agents can load.
- [Chapter 12: Collaborate With Specialists](getting-started/part-3-add-agent-behavior/12-collaborate-with-specialists.md)
  · H, optional · Requires: 08. One agent is asked to be good at everything. Add
  a reviewer agent and grant which agents may ask it.
- [Chapter 13: Remember Across Conversations](getting-started/part-3-add-agent-behavior/13-remember-across-conversations.md)
  · H, optional · Requires: 08 (07 recommended). Long conversations exceed a
  bounded history window. Preserve certified facts through consolidation and
  grant explicit memory search. Ready checkpoints feed the same agent's later
  turns in that thread; cross-thread retrieval requires explicit search and
  access.
- [Chapter 14: Test Agents Without a Provider](getting-started/part-3-add-agent-behavior/14-test-agents-without-a-provider.md)
  · H, recommended · Requires: 06, 09. Live model calls make tests slow, costly
  and unpredictable. Script the model's tool calls and assert the Action
  lifecycle instead.

### Part 4 — Release to Users

- [Chapter 15: Expose an HTTP API](getting-started/part-4-release-to-users/15-expose-an-http-api.md)
  · R · Requires: 05. Only local scripts can reach the application. Serve one
  explicitly exposed Action over Fetch and call it from a client.
- [Chapter 16: Authenticate and Isolate Tenants](getting-started/part-4-release-to-users/16-authenticate-and-isolate-tenants.md)
  · R · Requires: 06, 15. Every caller still shares one default data scope.
  Authenticate each request, resolve its principal, and assign that principal a
  trusted tenant scope of its own.
- [Chapter 17: Connect Chat and Channels](getting-started/part-4-release-to-users/17-connect-chat-and-channels.md)
  · H · Requires: 08, 16 (09 recommended). The assistant is reachable only from
  a terminal. Serve conversations over HTTP under the same access policy.
- [Chapter 18: Handle Files and Large Content](getting-started/part-4-release-to-users/18-handle-files-and-large-content.md)
  · R · Requires: 05. Large bodies bloat records and events. Store them as
  content and keep records small.

### Part 5 — Operate and Scale

- [Chapter 19: Schedule Recurring Work](getting-started/part-5-operate-and-scale/19-schedule-recurring-work.md)
  · R · Requires: 07. A timer on its own fires, but it gives no durable identity
  to each occurrence and no record of the work that ran. Declare schedules, let
  the host clock supply ticks, and the runtime records due work as events.
- [Chapter 20: Measure Model and Tool Usage](getting-started/part-5-operate-and-scale/20-measure-usage.md)
  · H, optional · Requires: 17. You cannot tell what a conversation consumed.
  Record usage and query it from a client.
- [Chapter 21: Deploy and Scale](getting-started/part-5-operate-and-scale/21-deploy-and-scale.md)
  · R · Requires: 07 (15 for the Fetch section). One process does everything.
  Split Gateway and Worker roles over a shared database, and choose a topology
  for your host.

### Part 6 — Evolve and Reuse

- [Chapter 22: Organize, Share and Evolve Plugins](getting-started/part-6-evolve-and-reuse/22-organize-and-share-plugins.md)
  · R · Requires: 05. A growing plugin file is hard to share, and careless
  changes break the applications that use it. Generate the plugin from a
  directory, check it in CI, and keep its IDs stable.

## Imports

Runtime primitives come from the package root, `@copilotz/copilotz`. Each
plugin's definitions and helpers come from that plugin's own subpath, such as
`@copilotz/copilotz/core` for the agent harness. Every subpath comes from the
same package version. Host-specific adapters also have their own subpaths, and
the guide introduces each one when a chapter first needs that host capability.

## Start building

- **Runtime first:**
  [Chapter 1: Send Your First Event](getting-started/part-1-design-and-build/01-send-your-first-event.md)
- **First model reply:**
  [Chapter 8: Hello Agent](getting-started/part-3-add-agent-behavior/08-hello-agent.md)
- **Reference by subsystem:** the [documentation map](README.md)
