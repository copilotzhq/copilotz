---
title: Copilotz v3 Plugins and Resources
description: Factory-first plugin composition and independent processor subscriptions.
section: Internal Design
status: implementation
---

# Copilotz v3 Plugins and Resources

Copilotz keeps agents, tools, processors, collections, providers, channels,
skills, memory, APIs, MCP servers, features, and storage as resource kinds. A
plugin is the package and composition boundary that declares and provides those
resources.

```ts
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "@copilotz/copilotz/plugins";

const audit = defineProcessor({
  id: "audit.message-created",
  on: ["message.created"],
  delivery: "durable",
  filter: (event) => event.namespace === "customer-a",
  handle: async (event, context) => {
    // Persist an audit projection through typed collections.
  },
});

const plugin = definePlugin({
  manifest: {
    id: "@acme/copilotz-audit",
    version: "2.0.0",
    provides: { processors: [audit.id] },
    presets: { default: ["processors.audit.message-created"] },
  },
  resources: { processors: [audit] },
});

const registry = await createPluginRegistry({ plugins: [plugin] });
```

## Composition

Resources compose in this order:

1. built-in core plugin;
2. declared plugins, in declaration order;
3. explicit application resources.

Within one resource kind, a later resource with the same stable ID replaces the
earlier resource. Resources with different IDs remain independent. The registry
records the winning resource's plugin origin and exposes `list`, `get`, and
`require` lookups.

A plugin manifest must exactly describe its provided resources. Presets and
named imports use selectors such as `agents.support`, `tools.lookup`, or the
whole resource kind `channels`. A runtime adapter resolves string sources such
as local paths, JSR, or npm; the core registry imports no filesystem, server,
Deno, Node, or Bun APIs.

Built-in resources use the same mechanism. Skills are optional plugin resources,
not a default development catalog. `createSkillsPlugin()` packages portable
skills and their progressive-disclosure tools; later plugins or explicit
resources can replace a skill by stable name. Standard `SKILL.md` directories
are validated and packed before runtime rather than read by the registry.

## Processor subscriptions

A processor is a resource with a stable ID, an event-type subscription, a
delivery mode, an optional filter, and a handler. There is no processor chain,
phase, claim, swallowing behavior, or produced-event side channel.

- `durable` subscriptions become sparse delivery obligations in the same
  transaction as the semantic event. Their filters must return synchronously so
  matching can finish before commit. Dynamic or asynchronous checks belong in
  `handle`.
- Durable subscriptions use `settlement: "inherit"` by default. A subscription
  may declare `settlement: "detached"` to fork durable background work from the
  caller's completion scope while retaining causation, retries, recovery, and
  automatic scope inheritance for its descendants.
- `live` subscriptions observe ephemeral events such as stream frames. They do
  not create delivery rows and cannot declare detached durable settlement.
- Logical durable consumer IDs are derived from processor IDs, never from an
  Oxian worker identity.

Processor handlers receive events and an application-supplied plain context. The
isolated registry does not yet dispatch handlers or replace the current resource
loader. Those switches happen only as complete verticals gain parity tests and
move onto the new event/delivery executor.

## Public surface

The factory and type APIs are available from both the root package and
`@copilotz/copilotz/plugins`. This module is additive during Gate 2. The legacy
`resources` configuration and processor runtime remain canonical until their
port and downstream compatibility gates are complete; v3 will then remove that
loader rather than retain two composition paths.
