---
title: "Chapter 1: One booking"
description: "A salon's bookings as a Copilotz plugin: a collection, an Action, a View and a resource. Sam books a slot, and the record says he did."
section: Getting Started
order: 10
status: stable
---

# Chapter 1: One booking

> Part 1, one app · Needs: Node 24 · Code: `chapter-1`

## The pain

A booking system looks small: a list of times, and who took each. Then a second way in arrives. The
staff's page books one way, the chatbot another, an integration a third. Each checks a little
differently. One day two customers hold the same Tuesday, and nobody can say who booked it.

## The problem

You want one place that says what a booking is and how one is made. Every caller goes through it,
and every booking remembers who made it. And the salon's hours should be settings, not code.

## The solution

A Copilotz app is a **runtime** made of **plugins**, and a plugin is plain objects. The salon's
first plugin, bookings, has four:

- a **collection**, `booking`: documents with a JSON Schema;
- an **Action**, `booking.make`: the one way to make a booking;
- a **View**, `bookings`: what anyone sees, here as text;
- a **resource** kind, `slots`: the salon's times, which the app sets.

### The plugin

`plugins/bookings/mod.ts` puts them together:

```ts
export const bookings: Plugin = definePlugin({
  name: "bookings",
  collections: {
    booking: {
      schema: {
        type: "object",
        properties: { slot: { type: "string" }, label: { type: "string" } },
        required: ["slot", "label"],
      },
    },
  },
  actions: { "booking.make": makeAction },
  views: { bookings: bookingsView },
  // The salon's times: the app sets its own.
  resources: { slots: {} },
});
```

### The Action

An Action has a name, an input schema, who may call it, and what it does (`actions.ts`):

```ts
export const makeAction = defineAction({
  description: "Books a free slot",
  input: {
    type: "object",
    properties: { slot: { type: "string", minLength: 1 } },
    required: ["slot"],
    additionalProperties: false,
  },
  // Who may call it: people.
  allow: people,
  run: async (ctx, input) => {
    const label = slotsOf(ctx)[input.slot];
    if (!label) throw failure("not_found", `There's no slot "${input.slot}".`);
    const bookings = ctx.db.collection("booking");
    if (await bookings.findOne({ slot: input.slot })) throw failure("taken", `${label} is taken.`);
    const { insertedId } = await bookings.insertOne({ slot: input.slot, label });
    return { booking: insertedId, label };
  },
});
```

- `allow` says who may call it, whichever way the call comes in. `people` lets in people, and an
  agent working for one of them (chapter 4).
- `ctx.db` reads and writes collections with the MongoDB API.
- A refusal is a `failure`: a code callers act on, and a message people read.
- `slotsOf(ctx)` reads the `slots` resource, whatever the app set it to.

Every write records an event in the same commit as the write. You don't log anything yourself.

### The View

A View reads, and returns what to show (`views.ts`):

```ts
export const bookingsView = (_: unknown, ctx: ViewContext<unknown>): string => {
  const order = Object.keys(slotsOf(ctx));
  const found = (ctx.db.collection<Booking>("booking").find({}).value ?? [])
    .toSorted((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
  return found.length ? found.map((b) => `${b.label} (${b.slot})`).join("\n") : "No bookings.";
};
```

A View never writes. The runtime remembers what it read, which is how a screen stays live. Chapter 3
puts that to work.

### The app

The salon's settings are a plugin too, last in the list (`app.ts`). A later plugin's resources patch
an earlier one's, so the salon fills in the `slots` that bookings declared empty:

```ts
const salon = definePlugin({
  name: "salon",
  resources: {
    // The salon's week: each slot is booked once.
    slots: {
      "tue-10": "Tue 10:00",
      "tue-11": "Tue 11:00",
      "wed-15": "Wed 15:00",
      "thu-09": "Thu 09:00",
      "fri-14": "Fri 14:00",
      "sat-10": "Sat 10:00",
    },
  },
});

export function plugins(): Plugin[] {
  return [bookings, salon];
}
```

### Sam books

`hello.ts` starts the runtime in memory, and books as Sam, who works at the salon:

```ts
const store = memoryStore();
const runtime = await createRuntime({ store, plugins: plugins() });

// Every call is someone's. Sam works at the salon: a person.
const sam: Actor = { kind: "person", id: "sam" };
await runtime.call("booking.make", { slot: "tue-10" }, { actor: sam });
await runtime.call("booking.make", { slot: "tue-10" }, { actor: sam })
  .catch((error) => console.log(`Refused: ${error.message}`));
console.log(await runtime.render("bookings", {}));

console.log("\nThe record:");
for (const { seq, type, actor, data } of await store.events(0)) {
  const what = (data.doc as { label?: string } | undefined)?.label ?? data.action;
  console.log(`#${seq} ${type.padEnd(17)} ${String(what).padEnd(13)} ${actor?.kind} ${actor?.id}`);
}
```

Every call carries an **actor**: who is asking. Here it's a person, `sam`. Later chapters add
customers, the salon's agent and assistants outside, and each call still says who.

## Run it

```sh
npm run hello
```

```text
Refused: Tue 10:00 is taken.
Tue 10:00 (tue-10)

The record:
#1 action.started    booking.make  person sam
#2 booking.created   Tue 10:00     person sam
#3 action.completed  booking.make  person sam
#4 action.started    booking.make  person sam
#5 action.failed     booking.make  person sam
```

Two kinds of event, both with their actor:

- **An Action's lifecycle:** `action.started`, then `action.completed` or `action.failed`. The
  refused call is on the record too.
- **A collection write:** `booking.created`, in the same commit as the booking itself. The record
  can't miss one.

There are no tests yet: `npm test` runs none, and passes. Chapter 2 writes the first ones.

## What this unlocks

- **One way to make a booking.** The page, the salon's agent, ChatGPT and WhatsApp will all call
  `booking.make`. None of them gets a second, looser way.
- **Who did it, on every write.** The actor rides along with each event, so "who booked Tuesday?"
  has an answer.
- **Settings, not code.** Another salon sets other slots, and uses the same plugin.

## Your challenge

Add Saturday at 11:00 to the salon's slots and book it in `hello.ts`. Then book `sun-10`, a slot
that doesn't exist: what does the record say?

Next, customers come in, and each one may see only their own bookings.
