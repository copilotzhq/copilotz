# Plugins and Processors

Plugins package logical resources and declare them once through `definePlugin`.

```ts
import {
  type CopilotzProcessorContext,
  definePlugin,
  defineProcessor,
} from "jsr:@copilotz/copilotz@^0.60.2";

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
  id: "@acme/audit",
  version: "1.0.0",
  processors: [audit],
});
```

## Loading

Plugins are ordinary imported values. Package/path resolution belongs to the
embedding application's module system; Copilotz composition receives concrete
plugin objects only.

```ts
import auditPlugin from "./plugins/audit.ts";
import supportPlugin from "jsr:@acme/copilotz-plugin";

plugins: [
  auditPlugin,
  supportPlugin,
];
```

Composition does not support string sources, named imports, presets, or module
loading. A plugin can depend on other plugins with
`definePlugin({ plugins:
[...] })`, and the registry composes those dependencies
before the declaring plugin.

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
- Durable processors inherit the triggering completion scope by default. Declare
  `settlement: "detached"` for durable background work that must remain
  recoverable without delaying or failing the foreground run. Its descendants
  inherit the detached scope automatically.
- Live processors receive ephemeral events without delivery rows.
- A processor cannot claim, swallow, reprioritize, or replace another
  subscription's work.
- Collection `beforeCreate`, `beforeUpdate`, and `beforeDelete` hooks may
  validate/transform the atomic mutation. Reactions after commit are processors.

Processor contexts expose scoped content, collections, events, schedules,
knowledge, and the composed property context maps such as `context.tools` and
`context.agents`—not raw SQL, graph mutation primitives, or a generic resource
registry.

Detailed contracts: [plugins/resources](v3/plugins-and-resources.md) and
[event-native collections](v3/event-native-collections.md). Skills use the same
resource precedence while keeping their standard directories outside runtime;
see [skills](skills.md).
