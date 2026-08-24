# Plugins and Processors

[`ARCHITECTURE.md`](../ARCHITECTURE.md) defines the canonical plugin and runtime
boundaries. This guide covers only composition and Processor execution.

## Plugin composition

Plugins contribute keyed Collections, Actions, Processors, Resources, and
Adapters:

```ts
export const auditPlugin = definePlugin({
  id: "@acme/audit",
  version: "1.0.0",
  plugins: [archivePlugin],
  collections: { audit: auditCollection },
  actions: { rebuildAudit },
  processors: { auditMessages },
  resources: {
    auditPolicies: { default: auditPolicy },
  },
  adapters: {
    archive: { default: archiveAdapter },
  },
});
```

Plugins are ordinary imported values. Dependencies in `plugins` compose first,
then root plugins compose in caller order. Collection, Action, and Processor map
aliases must be unique across the final composition. Resource and Adapter
namespaces merge independently by key; application values are their final
overlays.

Definition IDs are durable semantic identities. Map keys are ergonomic context
aliases. Processors are subscriptions and therefore are not exposed as callable
context members.

## Processor definition

A Processor receives the resolved immutable Event first and the shared composed
`RuntimeContext` second:

```ts
interface AuditContext extends RuntimeContext {
  collections: RuntimeContext["collections"] & {
    audit: ScopedCollection;
  };
}

const auditMessages = defineProcessor<AuditContext>({
  id: "audit.messages",
  on: [{ eventType: "message.created" }],
  async handle(event, context) {
    if (!event.subject?.id) return;

    await context.collections.audit.create({
      id: `audit:${event.id}`,
      messageId: event.subject.id,
    }, { operationKey: "audit-message" });
  },
});
```

Each `on` entry is an alternative match; fields within one entry must all match.
Use `event.data` for the resolved Event Body. Checks that depend on changing
state belong in `handle`, not in subscription metadata.

Durable Processor delivery is at least once. Collection operation keys and
Action invocation identity must therefore remain stable across retries.
Processors inherit the triggering settlement scope by default. Set
`settlement: "detached"` only when durable background work should not delay or
fail the foreground operation.

Thrown errors retry with bounded backoff by default. Deterministic defects that
cannot heal—such as invalid configuration—should retain their useful error type
and opt out explicitly:

```ts
import { markNonRetryable } from "@copilotz/copilotz/plugins";

throw markNonRetryable(new TypeError("Archive configuration is invalid."));
```

The delivery then dead-letters immediately. Do not infer permanence from broad
JavaScript classes such as `TypeError`; network APIs can throw the same class.

## Runtime context

Actions and Processors receive the same complete runtime-neutral context. A
semantic interface narrows that context for TypeScript; it does not filter the
runtime value or declare dependencies.

The useful access paths are direct and compositional:

```ts
context.collections.audit;
context.actions.rebuildAudit;
context.resources.auditPolicies.default;
context.adapters.archive.default;
```

`context.signal` and `context.streams` are always present. Plugin context does
not expose raw storage/database access, executors, Event or delivery services,
or schedule services. Collections emit mutation Events, Actions emit lifecycle
Events, and Processors react through their first argument.

Collection reactions after commit belong in Processors. Atomic validation and
transformation intrinsic to one Collection mutation belongs in that Collection's
definition.

See also [events, deliveries, and recovery](events-deliveries-recovery.md) and
[content and assets](content-assets.md).
