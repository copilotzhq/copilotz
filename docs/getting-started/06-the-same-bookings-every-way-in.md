---
title: "Chapter 6: The same bookings, every way in"
description: "The payoff: one test drives the desk's page, the salon's agent and an assistant over MCP at once, reads the record of who acted for whom, and proves the rules held at each. Then a tour with a real model."
section: Getting Started
order: 60
status: stable
---

# Chapter 6: The same bookings, every way in

> Part 2, the ways in · Requires: Chapter 5 · Code: `chapter-6`

## The pain

An app with several ways in is usually several apps that share a database. Each passed its own
tests. Nobody can show that a customer can't cancel someone else's booking from all of them, and
when someone asks "who booked Wednesday?", the answer is in three logs, in three shapes.

## The problem

You want one test that drives every way in at once, against the same bookings, and checks three
things: that every screen sees every change, that the record says who acted and for whom, and that
the rules held at each door. No new code in the app. If the app is really one app, the test is
short.

## The solution

One test file, a helper that reads the record, and a tour script for a real model.

### The same bookings, from three ways in

`tests/every-way-in.test.ts` opens the desk's Bookings tab as Sam and keeps it open. Then three ways
in book, one after another:

```ts
// 1. The web page: Sam presses Book for a walk-in.
await tab().props.book("tue-10");
// 2. The salon's own agent, in a customer's chat.
const bia = await customer(runtime, "Bia");
await runtime.call("chat.send", { thread: bia.thread, text: "Tuesday 11?" }, {
  actor: bia.actor,
});
await runtime.idle();
// 3. An assistant over MCP.
await assistant(runtime, "conversation-1").call("book", { slot: "wed-15" });

// The desk's tab followed every one, as it happened.
await runtime.idle();
const html = renderToStaticMarkup(tab()).replace(/<style[^>]*>[^<]*<\/style>/g, "");
const lines = [...html.matchAll(/<li>([^<]+?) <button[^>]*>Cancel/g)].map((m) => m[1]);
assert.deepEqual(lines, [
  "Tue 10:00, for a walk-in",
  "Tue 11:00, for Bia",
  "Wed 15:00, for Assistant",
]);
```

Each is a different kind of actor: a person at a page, an agent acting for a contact, a contact over
MCP. Each called `booking.make`. The tab didn't ask again: each commit ran its View again.

### The record says who, and for whom

Every booking's `booking.created` event carries its actor, and an agent's actor says whom it acted
for (`for`). `bookedBy`, in the kit, reads the store's events and names each contact by its name, or
by the way it came in:

```ts
const made: Record<string, string> = {};
for (const event of await store.events(0)) {
  if (event.type !== "booking.created") continue;
  const { doc } = event.data as { doc: { label: string } };
  made[doc.label] = who(named(event.actor!));
}
return made;
```

```ts
// The record: who made each, and for whom.
assert.deepEqual(await bookedBy(store), {
  "Tue 10:00": "person sam",
  "Tue 11:00": "agent concierge for contact Bia",
  "Wed 15:00": "contact by mcp",
});
```

The audit trail isn't a feature you added. It's the record every write already leaves.

### The rules, at every door

The second test books for Bia, then tries to reach her booking from each way in, as someone else:

- **The web page:** Eve, a signed-in person who isn't staff, can't cancel it, and sees "No
  bookings."
- **The salon's agent:** Caio's concierge is told to cancel it, and reads "Error: No booking of
  yours at tue-10."
- **An assistant:** it can't cancel it, can't book the slot, and sees no bookings.

Then it checks that nothing else happened:

```ts
// Bia's booking stands, and the record has nothing else.
assert.equal(await seen(runtime, "bookings", sam), "Tue 10:00 (tue-10), for Bia");
assert.deepEqual(
  (await store.events(0)).filter((e) => e.type.startsWith("booking.")).map((e) => e.type),
  ["booking.created"],
);
```

None of those doors has a check of its own. They're all the same rule, from chapter 2.

### A tour, with a real model

`scripts/tour.ts` runs the same three ways in, in memory, with whatever model `.env` says, and
prints what each said, what the desk sees, and the record. `npm run tour` runs it.

## Run it

```sh
node --import ./tsx.ts --test tests/every-way-in.test.ts
```

```text
✔ the same bookings, live, from every way in, and the record says who acted for whom (116.506833ms)
✔ the rules hold at every way in: nobody else can see or cancel Bia's booking (73.817667ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 618.614916
```

With `OPENAI_API_KEY` in `.env`:

```sh
npm run tour
```

```text
desk      › booked Tue 10:00 for Rui
bia       › Yes—Tuesday at 11:00 was available, and I booked it for you.
assistant › Booked Wed 15:00.

The desk sees:
Tue 10:00 (tue-10), for Rui
Tue 11:00 (tue-11), for Bia
Wed 15:00 (wed-15), for Assistant

The record:
  Tue 10:00  person sam
  Tue 11:00  agent concierge for contact Bia
  Wed 15:00  contact by mcp
```

Bia asked for "Tuesday late morning". The model chose 11:00 itself: 10:00 was already Rui's.

## What this unlocks

- **One app, for people and for AI.** A page, your own agent, and everyone else's assistants, on the
  same Actions, rules and record.
- **Proof, not hope.** The test that says "nobody else can cancel Bia's booking" runs at every door
  in one go, offline, in about a second.
- **An audit trail you didn't write.** Who did what, and for whom, is in every event.

## Your challenge

Have Sam cancel the assistant's booking in the first test, then extend `bookedBy` into a
`cancelledBy` that reads `booking.deleted`. Who does the record say cancelled it?

The next three chapters add a way in each, and the app doesn't change. First, a widget inside the
assistant.
