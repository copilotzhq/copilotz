---
title: "Getting Started Guide"
description: "Build one assistant into reusable application behavior, then choose the capabilities your product needs."
section: Getting Started
order: 0
status: stable
---

# Getting Started with Copilotz

Start with one assistant. Give it a tool, add application data, and build a
reusable operation that people, integrations and agents can share. Then choose
the interfaces, context and deployment options your application needs.

This guide targets **Copilotz 0.83.1**. It rebuilds the earlier guide’s
progressive format around the current runtime and plugin APIs.

## How this guide works

Each chapter follows the same rhythm:

1. **The problem:** something the current application cannot yet do.
2. **The solution:** one useful change, with commented code.
3. **Breaking it down:** the contracts you need to understand that change.
4. **What this unlocks:** what you can now build or inspect.
5. **What comes next:** the next chapter or an optional branch.

Chapters 1–6 form the foundation. You can stop there with a small application
that has an assistant, a durable note-saving capability and an event-driven
workflow. Chapters 7–15 are optional: follow the ones that solve a problem you
have. Installing every plugin is not a requirement.

The runtime is useful without agents. Collections, Actions and Processors define
ordinary application behavior; Core supplies an agent harness on that same
foundation. The guide starts with Core because it gives us a small, visible
first result, then shows the application work behind it.

## Before you start

Use Deno 2.9+ or Node 24+. The model examples also need an `OPENAI_API_KEY` in
the host environment and access to the chosen model. The `gpt-5.4-mini` examples
use an OpenAI connection; select a model available to your account. Runtime-only
examples do not need an LLM credential.

Create an empty project directory and choose one setup path. All named files in
the chapters live in that project directory unless a chapter says otherwise. A
complete file includes its imports. A configuration excerpt states exactly which
earlier declaration to edit.

### Deno

```sh
# Create a separate project for the guide’s files.
mkdir copilotz-notes
cd copilotz-notes
```

Deno 2.9 delays dependency versions published in the last 24 hours by default.
For a recently published Copilotz release you have chosen to try immediately,
create `deno.jsonc` with this package-specific exception before adding it. Older
releases do not need the exception. See the
[Deno configuration reference](https://docs.deno.com/runtime/reference/deno_json/#minimum-dependency-age).

```jsonc
{
  // Configure the dependency age policy for this guide project.
  "minimumDependencyAge": {
    // Retain the normal 24-hour delay for other dependencies.
    "age": "P1D",
    // Allow the selected Copilotz release to install immediately.
    "exclude": ["jsr:@copilotz/copilotz"]
  }
}
```

```sh
# Add the package and mappings for its exported plugin subpaths.
deno add jsr:@copilotz/copilotz@^0.83.1
```

### Node

```sh
# Create a separate project and its package manifest.
mkdir copilotz-notes
cd copilotz-notes
npm init -y
# Install Copilotz and configure its package imports.
npx jsr add @copilotz/copilotz@^0.83.1
# Install the database implementation used by the default local runtime.
npm i @electric-sql/pglite
# Enable ESM so Node 24+ can execute the TypeScript examples.
npm pkg set type=module
```

## The path

### Part 1 — Foundations

- [Chapter 1: Hello Agent](getting-started/part-1-foundations/01-hello-agent.md)
  — Run one assistant, send a message and read its reply.
- [Chapter 2: Your First Tool](getting-started/part-1-foundations/02-your-first-tool.md)
  — Give the assistant one explicit, executable capability.
- [Chapter 3: Application Data and Actions](getting-started/part-1-foundations/03-application-data-and-actions.md)
  — Store notes and share one operation across agents and application callers.
- [Chapter 4: Processors and Lifecycles](getting-started/part-1-foundations/04-processors-and-lifecycles.md)
  — React to recorded changes and trace application execution.
- [Chapter 5: Reusable Plugins](getting-started/part-1-foundations/05-reusable-plugins.md)
  — Package behavior once and compose it across applications.
- [Chapter 6: Persistence and Recovery](getting-started/part-1-foundations/06-persistence-and-recovery.md)
  — Keep state across restarts and understand retry boundaries.

### Part 2 — Capabilities to add when needed

- [Chapter 7: Existing APIs and Tools](getting-started/part-2-capabilities/07-existing-apis-and-tools.md)
  — Choose native, OpenAPI or MCP integration when a task needs it.
- [Chapter 8: Skills](getting-started/part-2-capabilities/08-skills.md) —
  Package reusable instructions and grant access explicitly.
- [Chapter 9: Agent Collaboration](getting-started/part-2-capabilities/09-agent-collaboration.md)
  — Add a specialist, establish membership and enable public questions.
- [Chapter 10: Memory and Knowledge](getting-started/part-2-capabilities/10-memory-and-knowledge.md)
  — Distinguish conversation history, long-term memory and document retrieval.

### Part 3 — Interfaces and production choices

- [Chapter 11: HTTP and Client](getting-started/part-3-production/11-http-and-client.md)
  — Expose application Actions behind policy and call them from a Fetch client.
- [Chapter 12: Interfaces and Channels](getting-started/part-3-production/12-interfaces-and-channels.md)
  — Connect a chat interface or another conversation transport.
- [Chapter 13: Content and Usage](getting-started/part-3-production/13-content-and-usage.md)
  — Separate large bodies from records and account for model work.
- [Chapter 14: Tenants and Access](getting-started/part-3-production/14-tenants-and-access.md)
  — Choose data scope from authenticated identity and enforce access policy.
- [Chapter 15: Deployment and Next Steps](getting-started/part-3-production/15-deployment-and-next-steps.md)
  — Start embedded and choose Gateway/Worker placement when needed.

## A consistent import model

Import the public runtime API from `@copilotz/copilotz`. Import a plugin’s
definitions and helpers from its own entrypoint: Core uses `/core`, Skills uses
`/skills`, and so on. Host-specific adapters and build tools have explicit
entrypoints and are introduced when their host capability becomes necessary.

Every code block explains its purpose in comments, including the important
configuration properties. Comments tell you why a choice exists; the prose
explains how it fits with what you have already built.

→
**[Start with Chapter 1: Hello Agent](getting-started/part-1-foundations/01-hello-agent.md)**

For a reference rather than a learning path, use the
[documentation index](README.md) and [API reference](api.md).
