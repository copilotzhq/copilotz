# Plugins and Processors

Plugins package logical resources and declare them in a validated manifest.

```ts
import {
  type CopilotzProcessorContext,
  definePlugin,
  defineProcessor,
} from "jsr:@copilotz/copilotz@^0.59.0";

const audit = defineProcessor<CopilotzProcessorContext>({
  id: "audit.messages",
  on: ["message.created"],
  delivery: "durable",
  filter: (event) => event.visibility !== "restricted",
  async handle(event, context) {
    if (!event.durable || !event.subject) return;
    await context.collections.audit.create({
      id: `audit:${event.id}`,
      messageId: event.subject.id,
      position: event.position,
    }, { operationKey: "audit-message" });
  },
});

export default definePlugin({
  manifest: {
    id: "@acme/audit",
    version: "1.0.0",
    provides: { processors: [audit.id] },
  },
  resources: { processors: [audit] },
});
```

## Loading

Inline plugins need no loader. String/package/path sources require an injected
`PluginResolver`; the core never reads a directory or assumes Deno/Node package
resolution.

```ts
plugins: [
  inlinePlugin,
  "jsr:@acme/copilotz-plugin@^2",
  {
    source: "./plugins/local.ts",
    imports: ["agents.support", "tools.lookup"],
    presets: ["production"],
  },
];
```

`imports` selects stable resources. `presets` expands selectors declared by the
plugin manifest. A plugin manifest must exactly match the resources it exports.

Installing a tool, agent, or skill resource does not grant it to every agent.
Agents use explicit `capabilities`; see
[agent capabilities](agent-capabilities.md).

## Processor semantics

- Processor IDs are logical consumer IDs. Different IDs run independently.
- Reusing an ID overrides an earlier plugin resource at composition time.
- Durable filters run synchronously before commit and must be pure. Dynamic
  checks belong inside `handle()`.
- Durable delivery is at-least-once. Use the scoped mutation capabilities and
  operation keys supplied by context so retries deduplicate.
- Live processors receive ephemeral events without delivery rows.
- A processor cannot claim, swallow, reprioritize, or replace another
  subscription's work.
- Collection `beforeCreate`, `beforeUpdate`, and `beforeDelete` hooks may
  validate/transform the atomic mutation. Reactions after commit are processors.

Processor contexts expose scoped content, conversation, collections, relations,
LLM attempts, tool executions, events, resources, schedules, and knowledge—not
raw SQL or graph mutation primitives.

Detailed contracts: [plugins/resources](v3/plugins-and-resources.md) and
[event-native collections](v3/event-native-collections.md). Skills use the same
resource precedence while keeping their standard directories outside runtime;
see [skills](skills.md).
