---
title: "Chapter 4: Its own agent"
description: "The concierge: the salon's agent, with four tools that call the same Actions, a text View for each that the model reads, acting for whoever it talks with. Tested with a scripted model, and talked to in the terminal."
section: Getting Started
order: 40
status: stable
---

# Chapter 4: Its own agent

> Part 2, the ways in · Requires: Chapter 3 · Code: `chapter-4`

## The pain

A chatbot that books usually gets an API client and a service account that can do anything. Then one
customer writes "cancel Tuesday at 10" and the bot cancels it, though it was someone else's booking.
The bot never had the customer's limits. It had the database's.

## The problem

The agent should act **for** the person it talks with. It should reach what they reach, through the
same Actions, and the record should say it acted for them. And a model reads differently from a
person: it wants short text, with ids it can act on.

## The solution

An agent, four tools, a View for each tool, and a model you can script in tests.

### The concierge

`app.ts` gives the salon an agent, and the model it thinks with, by an alias:

```ts
provider: settings.openai ? { openai: { apiKey: settings.openai } } : {},
// The concierge thinks with `concierge`, a model by its alias: tests swap in a scripted one.
model: {
  concierge: settings.openai ? { model: "openai/gpt-6-luna", effort: "low" } : "fake/echo",
},
agents: {
  concierge: {
    // New spaces start with it: the desk's chats are answered by it.
    default: true,
    instructions: "You book the salon's slots. List the free ones before you book, " +
      "and book only what the person asked for.",
    model: "concierge",
    tools: ["list_slots", "book", "my_bookings", "cancel_booking"],
  },
},
```

`plugins()` now takes the app's settings, which the host reads from the environment: here, the
OpenAI key. Without one, the concierge answers with Copilotz's offline fake model.

### Its tools

A tool is a thin caller of the same Actions a person uses (`tools.ts`). Two of them:

```ts
book: tool({
  description: "Books a free slot, in this chat",
  input: {
    type: "object",
    properties: {
      slot,
      name: { type: "string", description: "Who it's for, when staff book for someone else" },
    },
    required: ["slot"],
    additionalProperties: false,
  },
  // The tool passes its chat; the Action finds the space from it.
  run: ({ slot, name }, ctx) =>
    ctx.call("booking.make", { slot, thread: ctx.thread, ...(name ? { name } : {}) }),
}),
```

```ts
cancel_booking: tool({
  description: "Cancels a booking, by its slot's id",
  input: {
    type: "object",
    properties: { slot },
    required: ["slot"],
    additionalProperties: false,
  },
  run: async ({ slot }, ctx) => {
    const found = await ctx.db.collection<Booking>("booking").findOne({ slot });
    if (!found) throw failure("not_found", `No booking of yours at ${slot}.`, { public: true });
    return ctx.call("booking.cancel", { booking: found._id });
  },
}),
```

A tool runs as the agent **acting for** whoever it works for: in Bia's chat, the concierge for Bia;
at the desk, the concierge for Sam. Its reads and its Actions are checked against that person's
reach. In Caio's chat, `findOne({ slot: "tue-10" })` can't find Bia's booking, whatever the model
was told.

The tools join bookings' resources (`tools`), the resource kind chat reads them from.

### What the model reads

After each call, the model reads that tool's View, `tool:<name>`. Here each one is a line, then the
same text Views people see in the terminal:

```ts
/** What a model reads after each tool: a line, then the bookings it now reaches. */
export const toolViews = {
  "tool:list_slots": (_: Call, ctx: ViewContext<unknown>) => ctx.show("slots", {}),
  "tool:book": (call: Call, ctx: ViewContext<unknown>) => {
    const booked = result<{ label: string }>(call);
    if (!booked) return call.output;
    return `Booked ${booked.label}.\n\nBookings:\n${ctx.show("bookings", {})}`;
  },
```

A failed call's output is its error's words (`Error: …`), which `result` passes on as they are. A
View that threw on it would sink the agent's turn.

### A model you can script

Tests can't wait on a real model, or pay for one. `tests/kit.ts` adds a model that plays a list of
moves, one per call, and keeps what each call was sent:

```ts
export type Move = string | { tool: string; input?: Record<string, unknown> };

/** A model that plays its moves in order, one per call, and keeps what each call sent it. */
export function scripted(moves: Move[]) {
  const sent: LlmRequest[] = [];
  const adapter: LlmAdapter = {
    async *generate(request) {
      sent.push(request);
      const move = moves.shift();
      if (move === undefined) throw new Error(`The script has no move for call ${sent.length}.`);
      if (typeof move === "string") yield { type: "text", text: move };
      else {
        const call = { id: `call-${sent.length}`, name: move.tool, input: move.input ?? {} };
        yield { type: "tool_call", call };
      }
    },
  };
  return { adapter, sent };
}
```

`salon({ moves })` adds it as an adapter and points the `concierge` alias at it. The app's code
doesn't change. Then the model can be told to do the wrong thing:

```ts
// Caio's concierge is told to cancel Bia's slot.
await runtime.call("chat.send", { thread: caio.thread, text: "Cancel tue-10." }, {
  actor: caio.actor,
});
await runtime.idle();
assert.equal(concierge.sent[1].messages.at(-1)?.text, "No bookings.");
assert.equal(lastRead(concierge.sent), "Error: No booking of yours at tue-10.");
assert.equal(await seen(runtime, "bookings", bia.actor), "Tue 10:00 (tue-10), for Bia");
```

And when it does the right thing, the record says for whom:

```ts
const made = (await store.events(0)).find((e) => e.type === "booking.created")!;
assert.equal(who(made.actor!), `agent concierge for contact ${bia.actor.id}`);
```

### In the terminal

`terminal.ts` runs the same app in Copilotz's terminal, as Sam at the desk. `bookingsTerminal` adds
one command:

```ts
"/bookings": command({
  description: "Show the bookings you see, and the free slots",
  async run(_args, term) {
    await term.show("bookings", {});
    await term.show("slots", {});
  },
}),
```

## Run it

```sh
npm test
```

```text
✔ the concierge books for a customer, in their chat, and the record says for whom (173.034667ms)
✔ whatever the model asks, it reaches only what its customer does (107.330375ms)
✔ staff ask the same concierge at the desk, and it reaches every booking (89.993459ms)
✔ staff see every booking; a customer sees only their own (144.355583ms)
✔ a customer can't book into another's chat, take a slot, or cancel what isn't theirs (75.076333ms)
✔ the page is served, with the salon's code (294.521375ms)
✔ staff's Bookings tab: every booking, live, and its buttons are the Actions (95.325958ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2064.72275
```

With `OPENAI_API_KEY` in `.env`, talk to the concierge as Sam:

```sh
npm run terminal
```

```text
The salon
Sam → concierge › Book Thursday 9 for Rui, a walk-in.
  ⚙ concierge: list_slots → ["tue-10","tue-11","wed-15","thu-09","f…
  ⚙ concierge: book → {"booking":"fa1a2dc9-480a-4cda-a9fd-f4c…
concierge › Booked Thursday at 9:00 for Rui.
sam › /bookings
Thu 09:00 (thu-09), for Rui
Free: Tue 10:00 (tue-10), Tue 11:00 (tue-11), Wed 15:00 (wed-15), Fri 14:00 (fri-14), Sat 10:00
(sat-10).
```

The concierge listed the free slots before it booked, as its instructions say, and gave the walk-in
a name.

## What this unlocks

- **Tool, Action, the world.** The model calls a tool, the tool calls an Action, and the Action is
  the only thing that changes anything.
- **An agent with its customer's limits.** Tell it anything: it reaches what the person it works for
  reaches, and the record says so.
- **Tests without a model.** A script plays the model's part, offline, in milliseconds.

## Your challenge

Give the concierge a tool, `next_free`, that books the first free slot from a given day on. Write
its `tool:next_free` View, and a test where the script calls it for a customer.

Next, the same tools open to ChatGPT, Claude and Gemini.
