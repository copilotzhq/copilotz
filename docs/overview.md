---
title: "Overview"
description: "Why Copilotz records application work as Events, Collections, Actions and Processors, how Plugins package them, where the optional agent harness fits, and which learning path to start."
section: Start
order: 20
status: stable
---

# Overview

## The pain

A typical application handles a request by calling a function, writing a row and
perhaps calling an outside service. That works until something goes wrong
part-way. The process restarts after the row is written but before the follow-up
work runs. A client retries and two notes appear instead of one. A support
engineer asks what happened to one request and the only answer is scattered
across logs. When an agent is added, it gets the same problems with less
predictable input: a model decides to call a tool, and nobody can say afterwards
which call ran, with which input, or whether it finished.

## The problem

The missing piece is a shared contract for **ownership and history**:

- which code owns a piece of state, and which validated operation may change it;
- which input started a piece of work, and which reactions it triggered;
- whether that work finished, failed or must be retried, and how a retry finds
  the result that was already recorded instead of doing the work twice;
- which choices belong to a reusable package and which belong to one host, such
  as its tenant namespace, database and credentials.

An agent framework alone does not answer these questions, and a database alone
does not say why a row changed. Copilotz answers them first, in a generic
runtime, and then builds its agent harness on the same contract.

## The solution

Copilotz is a TypeScript runtime that records application work as durable facts.
The same public imports run on Deno and Node. Browser and Worker hosts can use
the runtime only within their storage and filesystem limits.

### The runtime primitives

| Primitive      | What it owns                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Event**      | An immutable fact, such as `notes.capture.requested`. Inputs admitted with `app.send` become durable Events.                                                              |
| **Collection** | Schema-checked application state. Every change appends an Event, such as `note.created`.                                                                                  |
| **Action**     | A named, validated operation with a recorded lifecycle (`notes.save.invoked`, `notes.save.completed`).                                                                    |
| **Processor**  | Code that reacts to matching Events. A durable match becomes a recorded delivery that may be retried; live Event handling is best effort without that recovery guarantee. |
| **Resource**   | A process-local definition or policy that code looks up, such as an agent's role and capability grants.                                                                   |
| **Adapter**    | A replaceable implementation of an outside dependency, such as a model provider, file store or channel.                                                                   |
| **Plugin**     | A named, versioned package of the above. Defining it starts nothing; an application composes it with `createCopilotz`.                                                    |

Every input starts an **operation** that covers the deliveries, Action calls and
Collection writes it causes under the default `inherit` settlement. The
operation settles as completed or failed, and you can read its state back by ID.
A Processor that explicitly detaches records its durable work separately, and
that work does not delay the original operation; the
[Plugins and Processors reference](plugins-and-processors.md) covers settlement
modes. Stable **operation keys** name each Action call and write within a
delivery, so a retried delivery gets the recorded result instead of a second
write. An outside service that the Action calls still needs its own idempotency
support.

### One small plugin

This example reuses `notes-plugin.ts` exactly as
[Chapter 5](getting-started/part-1-design-and-build/05-package-a-plugin.md)
creates it. That file is a **definition module**: it declares the `note`
Collection, the `notes.save` Action, the `notes.capture` Processor and
`notesPlugin`, reads no environment and opens nothing when imported. Its core
ownership rules, in short:

- `notes.capture` decides _when_ a note is saved: once per durable
  `notes.capture.requested` Event. It calls the Action with the operation key
  `save-request`.
- `notes.save` decides _how_ a note is validated and stored. It writes the
  `note` Collection with a key prefixed by its own call's operation key.
- `notesPlugin` packages both under the stable IDs `note`, `notes.save` and
  `notes.capture`, with no namespace or database of its own.

Install the package before running the entrypoint:

```sh
# Deno: add the runtime package to deno.json.
deno add jsr:@copilotz/copilotz@^0.85.5
# Node 24+: add the same package from JSR.
npx jsr add @copilotz/copilotz@^0.85.5
```

`overview.ts` is an **entrypoint**. It makes the host choices, sends one input
and reports the settled operation. Place it next to `notes-plugin.ts`:

```ts
// Runtime factory: composes plugins into a running application.
import { createCopilotz } from "@copilotz/copilotz";
// The reusable Notes package from Chapter 5.
import { notesPlugin } from "./notes-plugin.ts";

// Host choices live here, not in the plugin. Omitting `database` uses a
// private in-memory database that disappears when the application closes.
const app = await createCopilotz({
  // Tenant namespace recorded on every Event and record this run owns.
  namespace: "team-notes",
  // Registers the note Collection, notes.save Action and notes.capture
  // Processor under their stable IDs.
  plugins: [notesPlugin],
});

try {
  // Admit one input. Copilotz stores it as a durable Event, creates a delivery
  // for notes.capture and starts an operation covering its inherited work.
  const handle = await app.send({
    type: "notes.capture.requested",
    payload: { text: "Prepare the release." },
  });

  // Print each Event type while waiting. `done` rejects if the delivery, the
  // Action call or the note write fails.
  const printTypes = async () => {
    for await (const output of handle.outputs) {
      if ("type" in output) console.log(`event ${output.type}`);
    }
  };
  const [drained, settled] = await Promise.allSettled([
    printTypes(),
    handle.done,
  ]);
  if (drained.status === "rejected") throw drained.reason;
  if (settled.status === "rejected") throw settled.reason;

  // Read the recorded operation state back by its ID.
  const status = await app.operationStatus({
    operationId: handle.operationId,
  });
  console.log(`operation ${status?.state ?? "unknown"}`);
} finally {
  // Release the runtime and its database, including after a failure.
  await app.close();
}
```

Run it with `deno run -A overview.ts` or `node overview.ts`. The Event lines
include `notes.capture.requested`, `notes.save.invoked`, `note.created` and
`notes.save.completed`, in an order you should not rely on except that
`note.created` precedes `notes.save.completed`. The last line reports
`operation completed`.

### The optional agent harness

The agent harness, imported from `@copilotz/copilotz/core`, is a set of plugins
built on the same primitives. Threads, messages and participants are
Collections. A model call is an Action, so it has the same recorded lifecycle as
`notes.save`. An agent is a Resource that names its model connections and grants
specific tools, agents and Skills. A tool can wrap an existing Action such as
`notes.save`, so the agent reuses the validation and history you already have
instead of a second implementation.

The harness is optional. Runtime-only applications never import `/core`, and
nothing in the runtime track depends on a model provider.

### Choose a track

| Track             | Start with                                                                                              | Path                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **R** — runtime   | [Chapter 1: Send Your First Event](getting-started/part-1-design-and-build/01-send-your-first-event.md) | Chapters 1–7, then 15, 16, 18, 19, 21 and 22                                                                                           |
| **H** — harness   | [Chapter 8: Hello Agent](getting-started/part-3-add-agent-behavior/08-hello-agent.md)                   | Setup, then Chapter 8; Chapters 9–14 add tools and behaviour; later, optionally, Chapter 17 (chat and Channels) and Chapter 20 (usage) |
| **Fast overview** | [Quickstart](quickstart.md)                                                                             | One runtime and one agent snippet                                                                                                      |

The tracks join at Chapter 9, where an agent tool wraps the Notes Action.

## What this unlocks

With these foundations you can:

- design state and operations once, as a plugin that tests, servers, schedules
  and agents share without copying;
- inspect what happened to any request through its operation, Events and Action
  lifecycle, including model and tool calls;
- retry and recover work without duplicating recorded writes;
- add an agent later, granting it only the operations it needs;
- keep tenant, database and credential choices in host code, separate from
  reusable definitions.

## Next steps

- Start building: [Getting Started](getting-started.md) introduces both tracks
  and the Notes application.
- Fastest result: [Quickstart](quickstart.md).
- Contracts: [Architecture](architecture.md) explains how the primitives relate.
- Packaging: [Plugins and Processors](plugins-and-processors.md) covers
  composition, dependencies and aliases.
