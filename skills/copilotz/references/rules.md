# The rules, with their reasons

[SKILL.md](../SKILL.md) lists them in a line each. Here is why each one holds, and what it looks
like in code. The installed version's AGENTS.md ("Rules: do this, not that", in
`node_modules/copilotz/AGENTS.md`) is the source of truth: where this file differs, follow it.

## One Action per change, called from every way in

An Action is where a change gets its input schema, its `allow`, its record (`action.started`, then
`action.completed` or `action.failed`) and its retry by id. A page's button, the app's agent, an
assistant over MCP and a script all call the same one, so they all get the same checks and the same
history.

```ts
// The tool: a thin caller, as the agent, for its person, where its chat is.
run: ({ title }, ctx) => ctx.call("task.add", { title }),
  // A script or a host: the same Action, as whoever it acts for.
  await runtime.call("task.add", { title: "Bo" }, { actor: { ...ana, in: space } });
```

Don't give a tool its own `insertOne`, or a route that writes a collection itself: that's a second,
looser path, with none of the Action's validation, failures or record.

## Rules at the data, not in handlers

Name a collection in the `shared` resource and the access plugin's rules cover it: each document
lives `in` a space, and reads and writes reach only what the actor reaches. `part` ties a document
to another one, as a booking to the chat it was made in (`shared: { booking: { part: "thread" } }`).
For anything else, a plugin declares a `guard`, which returns the filter an actor's documents must
match.

Don't write `find({ owner: ctx.actor.id })` as access control in an Action or a View. It holds only
on that one path. The REST API, the socket, a View or another plugin's Action reads the collection
without it, and for an agent `ctx.actor.id` is the agent's own id anyway.

To keep a collection changing only through its Actions, refuse writes from outside (`direct`: the
REST API, a browser's socket) in a `guard`, as Copilotz's boards and documents do. See
[the walkthrough](plugin-walkthrough.md), step 3.

## `allow` on every Action outsiders call

`allow(actor, input)` is asked wherever an actor calls: a page, a key, a tool's `ctx.call`, a timer
an actor set. For an agent it's asked twice, of the agent and of whom it works for, so a tool never
calls what its person couldn't. Write it by kind, never by identity:

| Helper             | Lets in                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `people`           | a person, their key, their routines, and an agent working for a person          |
| `inPerson`         | the person themselves, never a key, an agent or a routine: consent, keys, money |
| `contacts`         | a contact (a customer on WhatsApp, an MCP conversation), and an agent for one   |
| `peopleOrContacts` | both                                                                            |
| `publicCallers`    | the public, `{ kind: "public" }`: whoever calls a public interface as no one    |

An Action without `allow` is internal. Outside callers are refused, but code acting for an actor
(another Action, a Processor, a tool) runs it. So a tool that calls an internal Action goes past its
caller: see "Declassifiers" below.

## A View for whatever anyone reads, a model included

Each tool gets a `tool:<name>` View: what the model reads after it calls the tool. Keep it short,
with the ids the model needs next. A failed call's output is its error's words: pass them on, don't
throw. An MCP server that offers a tool without its View doesn't start.

A View reads in its own body. A React View reads with `ctx.db` and hands the result to its
component, so it stays live when a commit changes what it read. Views never write: a button in one
calls an Action.

## Errors for callers are public failures

```ts
import { failure } from "copilotz";

throw failure("not_found", `No task ${task} here.`, { public: true });
```

Only a public failure's words reach a caller outside, or a model. No other error's words do (a
driver's, a stack's, the runtime's about its insides). Over HTTP the code is the status: `invalid`
400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `too_many` 429, and 500 for the rest.

## Settings are resources, not code

`app.ts` reads no environment. The server, the terminal or a test reads it and passes settings to
`plugins(settings)`. Agents name a model alias (`model: "helper"`), and the app sets what it means:
`"openai/gpt-5.4-mini"` with a key, `"fake/echo"` without one, a scripted model in tests. A later
plugin's resources patch an earlier one's, so the app changes one agent's settings without
redefining it.

## Writes that must agree go in one transaction

```ts
await ctx.transaction(async (tx) => {
  await tx.db.collection("card").updateOne({ _id: card }, { $set: { column } });
  await tx.db.collection("board").updateOne({ _id: board }, { $inc: { moves: 1 } });
});
```

A refused write rolls it all back. A transaction holds the store's writer, so keep slow work out of
it: no model calls, no `fetch`. One with no op for 5 seconds rolls back.

## Who acts, and where

`personOf(ctx.actor)` is the person whose work this is, the one acting or the one an agent works
for. `ctx.actor.id` is the agent's own id when an agent acts. Where the work is, is `ctx.in`, and a
tool works where its chat is. A tool that takes a space as input checks it with `workIn`, from
`copilotz/plugins/agents/contract`.

## Going past the actor's reach is a named grant

Trusted code that must do what its actor couldn't acts as a named grant, and the record shows it,
`via` whose work it was:

```ts
import { grant } from "copilotz";

const slots = await ctx.as(grant("availability")).call("slots.all", { in: ctx.in });
```

Keys stay in code. Never put one in an Action's input (inputs are recorded), and never hand one to a
model.

## The audience rule

**An agent tells a conversation only what everyone in it could see.** Its work reads only what both
its asker and the place its answer goes reach:

- in a space: that space, and what it draws on;
- in a customer's chat: what that customer reaches (a space drawing on another with
  `contacts: "read"` lets them read that one);
- in its person's own Personal space: all they reach.

So an answer never shows anyone what they couldn't see, and nothing has to be hidden after it's
written. Writing anywhere whose readers don't all reach that bound is refused with `needs_approval`:
a Personal space's agent posting into a team's space, a team's agent writing into a customer's chat,
work handed to another space. The turn then asks its person ("May I post this to Launch? Its 12
members will see it."): yes this once, for this conversation, for the routine that set it going, or
no. On a yes, the work runs again.

In code: **don't catch `needs_approval` in a tool.** Let it through to the turn. If a tool turns
errors into words for the model, it lets that one pass:

```ts
try {
  await ctx.call("note.post", { text });
  return "Posted.";
} catch (error) {
  if ((error as { code?: string }).code === "needs_approval") throw error; // the turn asks its person
  return `Couldn't post it: ${(error as Error).message}`;
}
```

## Declassifiers, and the public

A tool that goes past its caller (a grant, an internal Action, a read the caller couldn't make),
offered to a contact or the public, is a declassifier. Scope it to them: their own bookings, never
any record. Take no free-form query that could widen it, and return only what they may see.

In a customer's chat, an Action people call that goes past its caller is refused. The app's own
Actions (no `allow`) run as its tool chose. The public (`publicCallers`, `{ kind: "public" }`) reads
only spaces that have it as a viewer, and writes nothing.

## Outside effects

Write the intent, call out with its id as the idempotency key, then write the result. In a tool, the
key is `ctx.callId`: a tool call that already returned isn't run again, and the key keeps the
outside service from doing it twice if the call is retried before it returned.

## Online

`devSignIn` is for this machine only: Copilotz won't start it with a public origin. Keep the `links`
secret (32 bytes or more) the same across restarts, or MCP conversations start over.

## What people often get wrong

- **Two kinds of events.** A collection write records `<collection>.created`, `.updated` or
  `.deleted`. An Action call records `action.started`, then `action.completed` or `action.failed`.
  Callers call Actions; events are what Actions and writes produce.
- **`runtime.subscribe` hears events; `runtime.observe` keeps a View live.**
- **Queries and Views read; Actions write.**
- **Plugins reach each other by name.** Say `requires: ["chat"]` and import only the other plugin's
  `contract.ts`, never its code.
