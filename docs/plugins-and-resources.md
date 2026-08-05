# Plugins and resources

A plugin is the package/loading boundary. Resources are the logical capabilities
it provides.

```ts
import { definePlugin, defineProcessor } from "@copilotz/copilotz";

export default definePlugin({
  manifest: {
    id: "@acme/support",
    version: "2.0.0",
    provides: {
      agents: ["support"],
      processors: ["memory.consolidation"],
    },
    presets: {
      basic: ["agents.support"],
      full: ["agents", "processors"],
    },
  },
  resources: {
    agents: [{ id: "support", name: "Support", role: "Help users" }],
    processors: [defineProcessor({
      id: "memory.consolidation",
      on: ["message.created"],
      delivery: "durable",
      handle: async (_event, context) => {
        await context.collections.memory.create({/* ... */});
      },
    })],
  },
});
```

Configuration accepts inline plugins or sources:

```ts
const copilotz = await createCopilotz({
  plugins: [
    "./plugins/local.ts",
    {
      source: "jsr:@acme/copilotz-plugin@^2",
      imports: ["agents.support", "tools.lookup"],
    },
    inlinePlugin,
  ],
});
```

The runtime composes resources in this order:

1. built-in core;
2. declared plugins, in declaration order;
3. explicit top-level resources.

A later resource with the same resource type and stable ID replaces the earlier
value. Processor overrides therefore use only the same processor ID; no claim,
priority, or phase adapter exists.

Resource types are agents, tools, processors, collections, providers, channels,
skills, memory, APIs, and MCP servers. Worker requests contain resource and
delivery identities, never serialized closures. Every worker that may receive a
workload must compose compatible plugins.

Enabled memory resources may implement `prepare(context)` to contribute
provider-facing messages immediately before an LLM attempt. They run inside the
same Oxian delivery worker, can read event-native collections, and do not create
a parallel orchestration mechanism. Core provides the overridable `history`
memory resource; a plugin may replace or disable it by stable ID.

Source loading is adapter-driven. Pass `pluginResolver` in runtimes that cannot
use dynamic module imports or filesystem-relative URLs.
