---
title: "Views"
description: "A View turns data into what one place shows; the runtime renders it once or observes it, running again only the parts a commit changed, for whoever is looking, where they are."
section: Architecture
order: 4
---

# Views

A View turns an item into what one place shows. The runtime renders it once, or observes it and runs
it again when what it read changes.

## A name, a place

A View is found by its name alone, and the name says what it shows: a collection's name,
`tool:book`, or a named datum such as `bookings`. Where the same thing shows in several places, the
place is a prefix: `llm.message`, `web.message`, `terminal.message`.

```tsx
views: {
  "web.booking": (b) => <Card>{b.slot}</Card>, // Card is the web toolkit's
  "terminal.booking": (b) => `${b.slot}`,
  "llm.booking": (b) => `Booked: ${b.slot}`,
},
```

`ctx.show(name, item)` renders exactly the View with that name, or nothing when there's none.
There's no inheritance and no fallback. A host asks for its own default, `web.default` or
`terminal.default`, when a name has no View. For a name, the last plugin's View wins, so the app
always has the last word.

The runtime gives names no meaning. The places come from the hosts and plugins that ask for them:
the web host, the terminal host, and chat, which builds an agent's prompt from Views.

## Reads that answer at once

Inside a View, a read returns at once, as `{ status: "loading" }` until its data arrives, then as
`{ status: "ready", value }`. After a pass, the runtime waits for the reads still loading and runs
the View again. It stops when a pass reads nothing new, and that pass's output is the result.

Repeated reads are answered from the render's own cache and the owner's, so a pass costs little. A
View that still reads new things after 25 passes is a bug, and it fails.

A View only reads. Its handlers, in what it returns, call Actions (`ctx.call`) and emit events
(`ctx.emit`), as any client does.

## Rendered once, or observed

- **Rendered once:** `ctx.render(name, item)` in plugin code, or `runtime.render(name, item)` from a
  host. An agent's prompt is rendered this way, once per model call.
- **Observed:** `runtime.observe(name, item, { actor, part })` runs in the owner's process and keeps
  the output live. `ready` resolves with the first output, `subscribe` hears each new one, and
  `close` stops it.

An observed View remembers what each run read: each read's collection and filter. When a commit
changes a document one of those reads matched, before or after, the View runs again. Nothing else
makes it run.

### Parts

Each View an observed View shows with `ctx.show` is a part of its own. A part runs again on its own,
so a reply being written re-runs its line, not the screen. The `part` option says how a part goes
into its parent's output: for React or Ink, a component that redraws when the part's output changes.
Without it, shown Views render inline, and the whole runs again.

A part shown again with the same item and hints keeps its output. Parts are known by their name and
their item's `_id`, so a list keeps its parts across runs.

What one commit changes shows at once. The parts it made run again tell their new output together,
once the last has it, so a finished reply and the live text it replaces never show both, or neither.
A part that takes longer than 2 seconds doesn't hold the others back.

## For whom, and where

An observed View runs for an actor. Every read it makes passes the rules for that actor, and comes
without the collection's private fields.

It also reads what the rules read to work out the actor's reach, kept or not. So when Ana is let
into a space, or out of one, her open screens change at once.

A View knows where it's shown, as `ctx.in`, the actor's `in`. Its handlers act as the actor, there.
An actor with a scope, such as a developer key, observes only the Views its scope lists.

## The prompt is a View

An agent's prompt is chat's `llm.thread` View. It returns the agent's tools and 3 zones, ordered for
the provider's prompt cache: the stable system part, the conversation, and what's new this turn.
Other plugins add to it with contexts: a `context` resource says where one goes, and a View says
what it is.

So a model reads the same data a person sees, through Views written for it. `thread.prompt`, a
query, and the terminal's `/prompt` show exactly what an agent is sent. The decisions behind Views,
the prompt and history are in [the Views design](../../design/views.md).

## Views in the browser

A browser runs Views itself. Its client joins the owner as the person signed in, and its Views'
reads go over that connection, one batch per pass. The owner watches each read there, under the
rules, and pushes a new result when a commit changes it. Then the parts that read it run again.
[The ways in](transports.md) has how a browser connects.
