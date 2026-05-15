---
title: Resources
description: Resources are the declaration layer for Copilotz applications.
section: Core Concepts
order: 10
status: stable
---

# Resources

Resources are how you tell Copilotz what your app has.

Instead of wiring every capability manually, you declare resources and let
`createCopilotz(...)` load, merge, normalize, and compose them into one runtime.

## What Counts as a Resource

Copilotz supports these resource families:

- agents
- tools
- APIs
- MCP servers
- processors
- memory
- skills
- features
- channels
- LLM providers
- embedding providers
- storage adapters
- collections

Resources can be provided in code, loaded from a local `resources/` directory,
or imported from packaged resource modules.

## Why Resources Matter

Resources keep the application model declarative.

You can look at a project and answer:

- which agents exist?
- what tools can they call?
- which app endpoints exist?
- which collections hold product data?
- which channels are enabled?
- which providers and storage backends are available?

That is the difference between an LLM script and an AI application.

## The Runtime Flow

At startup:

1. bundled resources are loaded
2. user resources are loaded from `resources.path`
3. explicit config resources are merged
4. filters and overrides are applied
5. agents, tools, providers, processors, features, channels, collections, and
   skills become runtime capabilities

## Minimal Example

```ts
const copilotz = await createCopilotz({
  resources: {
    path: "./resources",
    imports: ["tools.get_current_time", "channels.web"],
  },
  agents: [agent],
  dbConfig: { url: ":memory:" },
});
```

## Related Pages

- [Resource Loading](../runtime/resource-loading.md)
- [Resource Types](../resources/resource-types.md)
- [Resource Manifest](../reference/resource-manifest.md)
