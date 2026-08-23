---
title: Copilotz v3 Plugins, Resources, and Adapters
description: Direct plugin composition over Collections, Actions, Processors, Resources, and Adapters.
section: Internal Design
status: implementation
---

# Copilotz v3 Plugins, Resources, and Adapters

A plugin is the only semantic composition boundary. It may contribute five
independent categories:

- Collections: graph state and its mutation contract;
- Actions: executable capabilities with durable lifecycle Events;
- Processors: event subscriptions and orchestration;
- Resources: named semantic definitions and configuration;
- Adapters: named implementations of variable external boundaries.

```ts
import { definePlugin, defineProcessor } from "@copilotz/copilotz/plugins";
import { defineAction } from "@copilotz/copilotz/actions";

const notify = defineAction({
  id: "acme.notify",
  async execute(input: Notification, context: NotificationContext) {
    return await context.adapters.notifications.default.send(input);
  },
});

const onMessage = defineProcessor<MessageProcessorContext>({
  id: "acme.notify-on-message",
  on: [{ eventType: "message.created" }],
  async handle(event, context) {
    await context.actions.notify({ eventId: event.id });
  },
});

export const notificationsPlugin = definePlugin({
  id: "@acme/notifications",
  version: "1.0.0",
  actions: { notify },
  processors: { onMessage },
  resources: {
    notificationPolicies: { default: defaultPolicy },
  },
  adapters: {
    notifications: { default: notificationAdapter },
  },
});
```

## Direct maps and identities

Collections, Actions, and Processors are keyed maps. The key is the ergonomic
context alias; each definition carries its own stable durable identity.

```ts
context.collections.message.create(input);
context.actions.notify(input);
context.resources.notificationPolicies.default;
context.adapters.notifications.default;
```

There are no locator methods, manifests that repeat the definition, dependency
declarations on Actions or Processors, or filtered capability proxies. Actions
and Processors describe the narrower context they expect with ordinary
TypeScript interfaces. The runtime passes the complete composed context.

## Composition

A plugin may depend on concrete plugin values through `plugins: [...]`.
Dependencies compose depth-first before the declaring plugin. Top-level plugins
then compose in caller order, followed by application Resource and Adapter
overlays.

Executable aliases and stable IDs must be unique. A duplicate Collection,
Action, or Processor is an error rather than an implicit replacement. Resource
and Adapter namespaces merge independently by key; later values replace earlier
values with the same namespace and alias.

Resources and Adapters remain separate all the way through composition and
execution:

```ts
createCopilotz({
  plugins: [notificationsPlugin],
  resources: {
    notificationPolicies: { urgent: urgentPolicy },
  },
  adapters: {
    notifications: { default: productionAdapter },
  },
});
```

Plain typed objects are canonical Resource and Adapter values. A semantic plugin
may export helpers when they add useful inference, defaults, normalization, or
validation, but the helper does not create a privileged runtime object form.

## Processor subscriptions

Durable Processors match committed Events and create sparse delivery obligations
in the same transaction as those Events. They default to inherited settlement
and may use `settlement: "detached"` for causally linked background work.
Transient Processors observe ephemeral events without delivery rows.

Processor handlers decide what happens next by invoking Actions or mutating
Collections. Durable retries reuse runtime-derived operation identities, while
the semantic logic stays in the plugin.

## Host boundaries

Plugin loading is application code, not a runtime adapter. The embedding host
imports concrete plugin values and passes them to composition. Filesystem,
subprocess, server, and provider-specific behavior belongs in explicit host or
semantic Adapter packages; the generic runtime does not discover modules or
guess resource kinds.
