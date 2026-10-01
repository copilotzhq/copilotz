---
title: "Ch 15: Deployment and Next Steps"
description: "Start embedded, then split durable ingress from Processor execution with a Gateway and Worker."
section: Getting Started
order: 150
status: stable
---

# Chapter 15: Deployment and Next Steps

## The pain

The embedded application is a good default: one process owns the Gateway,
Worker, and local persistence lifecycle. When HTTP ingress and Processor
capacity need different scaling or failure domains, separate those roles while
keeping the same plugin composition and durable event contract.

## The solution

Begin with embedded mode. Use a Gateway and Worker only when you have a host or
capacity reason to split them. This complete `topology.ts` file uses the same
Notes Action in a generic event Processor and starts both roles with the
supported in-process transport. It makes no Agent or provider call.

The in-process transport below is for a single-process topology exercise. A
Gateway and Worker in separate processes need matching WebSocket transport
configuration, a shared reconnectable persistence layer, and a BodyStore that
both roles can reach.

```ts
// Read a shared PostgreSQL URL from the host environment.
import { env } from "node:process";
// Import generic runtime authoring contracts and the discriminated app factory.
import {
  type ActionCallers,
  createCopilotz,
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "@copilotz/copilotz";
// Reuse the application-owned Action and Collection declarations.
import { notesPlugin } from "./notes-plugin.ts";

// Narrow the Processor to the one Action supplied by notesPlugin.
type NotesWorkerContext = ProcessorContext<
  // Preserve the complete Resource namespace composition.
  ProcessorContext["resources"],
  // Preserve the complete Adapter namespace composition.
  ProcessorContext["adapters"],
  // Expose only the Action caller this deployment Processor needs.
  ActionCallers<{ saveNote: typeof notesPlugin.actions.saveNote }>
>;

// Turn one generic durable Event into the already-defined save Action.
const saveNoteOnRequest = defineProcessor<NotesWorkerContext>({
  // Keep the delivery identity stable for Processor recovery.
  id: "notes.deploy.save-on-request",
  // Subscribe only to the application's note-save request Event.
  on: [{ eventType: "notes.save.requested" }],
  // Invoke the shared Action instead of duplicating its write behavior.
  async handle(event, context) {
    // This workflow only acts on Events persisted by the Gateway.
    if (!event.durable) return;
    // Narrow the application Event payload to the Action's validated input.
    const input = event.payload as Readonly<{ text: string }>;
    // Reuse the existing Action with retry identity derived from this Event.
    await context.actions.saveNote(input, {
      // Recover the same Action result when this Event delivery is retried.
      operationKey: `gateway-note:${event.id}`,
    });
  },
});

// Package the reusable Action and its Gateway-triggered Worker behavior.
const notesDeploymentPlugin = definePlugin({
  // Give the topology-specific composition its own stable identity.
  id: "@example/notes-deployment",
  // Keep this composition version distinct from the Notes feature itself.
  version: "1.0.0",
  // Reuse the same Collection and Action in both process roles.
  plugins: [notesPlugin],
  // Register the Processor that performs the durable follow-up.
  processors: { saveNoteOnRequest },
});

// Use an explicit namespace and database shared by the two local roles.
const composition = {
  // Place this example's records in the selected tenant partition.
  namespace: "notes-production",
  // Connect both roles to the same PostgreSQL database.
  database: { url: env.DATABASE_URL! },
  // The child plugin statically composes notesPlugin and the saving Processor.
  plugins: [notesDeploymentPlugin],
};

// Select a process-local transport that both roles can attach to.
const transport = {
  // Use this transport only while the Gateway and Worker share a process.
  type: "in-process",
  // Give this local transport a stable topic for its paired roles.
  config: { topic: "notes-production" },
} as const;

// Create the durable ingress role and assign its work to one Worker ID.
const gateway = await createCopilotz({
  // Select the Gateway role from the root factory's discriminated options.
  role: "gateway",
  // Apply the same namespace, database, and plugin composition to this role.
  ...composition,
  // Connect the Gateway to the local transport.
  transports: [transport],
  // Route Processor execution to the Worker declared below.
  target: { workerId: "notes-worker" },
});

// Keep a close-capable reference available for cleanup after startup failures.
let worker:
  | Readonly<{
    // Wait until this Worker has composed plugins and subscribed to deliveries.
    ready: Promise<void>;
    // Close this Worker and its role-owned persistence connection.
    close(reason?: string): Promise<void>;
  }>
  | undefined;

try {
  // Create the matching execution role with exactly the same composition.
  worker = await createCopilotz({
    // Select the Worker role from the root factory's discriminated options.
    role: "worker",
    // Apply the same namespace, database, and plugin composition here too.
    ...composition,
    // Match the target ID configured on the Gateway.
    id: "notes-worker",
    // Attach to the same local transport as the Gateway.
    transport,
  });

  // Do not submit work until plugin composition and Worker subscriptions are ready.
  await worker.ready;

  // Submit one durable generic Event through the Gateway ingress.
  const operation = await gateway.send({
    // Route this envelope to the Processor declared above.
    type: "notes.save.requested",
    // Supply the input accepted by notesPlugin's saveNote Action.
    payload: { text: "Review the export flow with the product team." },
  });

  // Wait for the Action and its in-scope work to settle before shutdown.
  await operation.done;

  // The host HTTP listener, if any, can use gateway.fetch when serverPlugin is composed.
} finally {
  // Close the Worker when it was created, even if work or readiness failed.
  try {
    await worker?.close();
  } finally {
    // Close the Gateway and its owned Hypervisor even if Worker shutdown fails.
    await gateway.close();
  }
}
```

For two separate processes, give each role the same namespace, plugin IDs,
database, Assets policy, and protocol-compatible transport settings. Use the
Gateway's `target.workerId` and the Worker `id` to match placement. The
`in-process` transport cannot cross a process boundary. Configure the WebSocket
transport's path and Worker connection, identity, registration, and handshake
callbacks according to your host; those are host-owned connection details, not
provider credentials embedded in a guide. See
[Embedding, Gateways, and Workers](../../embedding-and-hypervisors.md).

For production sharing, `createCopilotzPersistence()` can provide both roles a
single reconnectable Ominipg facade. The embedding owns that shared persistence
and closes it only after Gateway and Worker have closed. If each role opens its
own database configuration, point both at the same supported database and let
each role own its connection. Keep durable Events and Processor deliveries as
the recovery authority; an in-memory broker alone is not shared persistence.

The Gateway returned by the root factory exposes `fetch(request)` when
`serverPlugin` is composed. Pass that Fetch handler to the HTTP host described
in [Chapter 11](11-http-and-client.md). Keep authentication and authorization at
that boundary. Configure a durable BodyStore shared by every role that must read
the same Asset; see [Chapter 13](13-content-and-usage.md).

## Breaking it down

Embedded mode already includes a Gateway and Worker connected in-process, so
small deployments do not need a topology rewrite. A split Gateway accepts
application ingress and manages durable dispatch; Workers reconstruct the same
static plugin composition and execute Processor deliveries. The transport
carries work and results, not plugin objects or database connections.

Persistence and body storage are separate concerns. Events, Actions, and
Collection records need shared durable database state for recovery. Content
references additionally require bodies to remain readable from every role that
consumes them. Verify both before increasing Worker count.

## What this unlocks

- One generic Processor can run with or without the Core agent harness.
- A Gateway can admit durable work while Worker capacity scales separately.
- The same Action, Collection, and Processor contracts survive a host split.

## What's next

You can stop here with an embedded application or follow only the production
chapters that match your deployment. The [Getting Started index](../README.md)
links the foundations, optional capabilities, and production choices. For
complete API and host details, continue with the
[documentation index](../../README.md), [API reference](../../api.md), and
[Events, Deliveries, and Recovery](../../events-deliveries-recovery.md).
