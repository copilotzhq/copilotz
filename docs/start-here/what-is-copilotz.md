# What Is Copilotz?

Copilotz is a framework for building AI applications around a shared runtime
instead of around isolated LLM calls. It combines resource loading, persistent
state, event-driven execution, assets, tools, and server helpers into one
application model.

The key idea is simple: you declare resources, and Copilotz wires them into the
runtime for you.

## What Copilotz Gives You

- agent execution with persistent state
- graph-backed application data through collections
- tool calling and event-driven processors
- feature endpoints served through the app dispatcher
- assets and media handling
- namespace-aware multi-tenant execution
- server helpers that work with Oxian or any HTTP layer

## Recommended Use Case

Use Copilotz when your application needs more than one-off chat completion
calls. It works best when you need persistent profile data, agent tools,
background work, reusable resources, and a clean separation between framework
runtime and transport layer.

## Common Mistaken Alternative

Do not think of Copilotz as only an LLM wrapper or only a chat framework. If
you treat it as "just a model client plus some helpers," you will miss the core
benefit: resources and runtime composition.

## Public Example

The primary public example app is `copilotz-starter`. It uses:

- `createCopilotz({ resources: { path: [...] } })` in `api/dependencies.ts`
- `withApp(copilotz)` to expose dispatcher-backed endpoints
- a React UI that consumes participant and thread data over app routes

## Related Pages

- [Architecture Overview](./architecture-overview.md)
- [Resources Are the Foundation](./resources-are-the-foundation.md)
- [Build Backend Endpoints with Features](../playbooks/build-backend-endpoints-with-features.md)
