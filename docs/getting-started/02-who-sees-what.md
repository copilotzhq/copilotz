---
title: "Chapter 2: Who sees what"
description: "Staff and customers: people and contacts, a space for the desk, and one rule at the data that filters every read and checks every write, whoever calls. Then the first tests."
section: Getting Started
order: 20
status: stable
---

# Chapter 2: Who sees what

> Part 1, one app · Requires: Chapter 1 · Code: `chapter-2`

## The pain

Customers arrive, and now the bookings are private. Staff see all of them. A customer sees only
their own. The usual fix is a filter in each handler: `if staff … else where customer = …`. It works
until the fifth way in, written in a hurry, forgets it.

## The problem

You want the rule written once, where the data is, so that it holds for every caller and every way
in: the page, the salon's agent, an assistant outside. Reads should come back already filtered.
Writes should be checked. And a customer must learn that Tuesday is taken without learning by whom.

## The solution

Three parts: who is asking, where things live, and one rule.

### Who is asking

Copilotz's `access` plugins know who is who. `spaces` keeps spaces and their members, `identity`
keeps people, and `contacts` keeps people from outside. `app.ts` adds them, with Copilotz's `models`
and `chat`, because a customer's chat is chat's `thread`:

```ts
export function plugins(): Plugin[] {
  return [models, chat, ...access, bookings, salon];
}
```

Staff are **people**. The desk is a **space**, and Sam manages it:

```ts
/** Sam, and the desk he manages: staff are its members. */
export async function openDesk(runtime: Runtime): Promise<void> {
  const sam: Actor = { kind: "person", id: "sam" };
  await runtime.call("person.set", { person: "sam", name: "Sam" });
  await runtime.call("space.create", { id: DESK, name: "Front desk" }, { actor: sam });
}
```

Customers are **contacts**. Each has a chat of their own at the desk, and nothing else. Chapters 5,
8 and 9 make one for each customer who comes in. For now the tests make them, through contacts'
Actions.

### One rule

A booking now lives in a space (`in`), and is part of the chat it was made in (`thread`). One line
in bookings' resources says so:

```ts
// The rules, at the data: a booking is in a space, and part of its chat.
shared: { booking: { part: "thread" } },
```

That's the rule. You reach a booking if you reach where it lives. Sam is a member of the desk, so he
reaches every booking there. A contact reaches only their own chat, so only the bookings in it. The
runtime ANDs every read with the reader's reach, and checks that every write lands within the
writer's. Your Action's code doesn't filter anything.

### A slot taken, and by whom

If Bia reads bookings, she sees only hers. So "is Tuesday free?" can't be asked of `booking`. It
goes to a second collection, `slot_taken`, with no rule at all. Nobody outside can read it. Only
plugin code does:

```ts
slot_taken: {
  schema: {
    type: "object",
    properties: { booking: { type: "string" } },
    required: ["booking"],
  },
},
```

### Booking, now

`booking.make` books into a chat (a customer's), or, with none, where the call is: a walk-in that
staff book at the desk. It runs in one transaction (`actions.ts`):

```ts
allow: peopleOrContacts,
// One transaction: the look and the writes commit together, or nothing does.
run: (ctx, input) =>
  ctx.transaction(async (tx) => {
    const label = slotsOf(ctx)[input.slot];
    if (!label) throw said("not_found", `There's no slot "${input.slot}".`);
    // A chat the caller can't reach reads as no chat: the rules filtered it out.
    const chat = input.thread
      ? await tx.db.collection<{ in: string }>("thread").findOne({ _id: input.thread })
      : null;
    if (input.thread && !chat) throw said("not_found", "That chat isn't one of yours.");
    // In a chat, where the chat is. Without one, where the call is (`ctx.in`): a walk-in.
    const where = chat?.in ?? ctx.in;
    if (!where) throw said("invalid", "Book in a chat, or from a space.");
    // Whether a slot is free is the salon's to know, not in anyone's bookings.
    if (await tx.db.collection("slot_taken").findOne({ _id: input.slot })) {
      throw said("taken", `${label} is taken.`);
    }
    const booking = crypto.randomUUID();
    await tx.db.collection("slot_taken").insertOne({ _id: input.slot, booking });
    await tx.db.collection<Omit<Booking, "_id">>("booking").insertOne({
      _id: booking,
      slot: input.slot,
      label,
      in: where,
      ...(chat ? { thread: chat._id } : {}),
      ...(input.name ? { name: input.name } : {}),
    });
    return { booking, slot: input.slot, label };
  }),
```

- **The Action runs as its caller.** When Caio names Bia's chat, the read finds nothing: the rules
  filtered it out. There is no `if` about who Caio is.
- **Where** is the chat's space, or, without a chat, the call's. An actor says where it's working
  (`in`), as it says who it is, and code reads it as `ctx.in`. A page of the desk says the desk
  (chapter 3), and so does every way customers come in: their chats are there. It's said, not
  proved: the rules still check that the booking lands within the caller's reach.
- **The transaction** makes the look and both writes one step. Nobody books in between, and a write
  the rules refuse ends it at once, with nothing kept.
- **`said`** is a public failure, `failure(code, message, { public: true })`. Its message reaches
  any caller, also a model outside the app (chapter 5). Any other error says only that something
  failed.

`booking.cancel` reads the booking, then deletes it and its `slot_taken`. Someone else's booking
isn't found, for the same reason.

### Who may call

`allow: peopleOrContacts` says who may call the Action: people and contacts, and an agent working
for one of them (chapter 4). What each of them reaches is the rule's to decide.

`allow` is asked wherever someone acts: from outside, and from the app's own code acting for
someone, such as a tool the salon's agent calls. For an agent, it's asked of the agent and of whom
it works for. So an agent working for a customer can't call what only staff may (`allow: people`),
whatever the model is told. Chapter 4 tests it.

What only a person decides says `inPerson`, which never lets in an agent or a key. Copilotz's own
`space.create`, which `openDesk` calls as Sam, is one.

### Only through the Actions

The rule lets a browser read and write bookings directly, within its reach. A booking written that
way would skip `slot_taken`. A `guard` closes that door:

```ts
// Bookings change only through their Actions, never written directly from outside.
guard: (_actor, { collection, access, direct }) => {
  if (collection === "booking" && direct && access === "write") {
    throw failure("forbidden", "Bookings change through their Actions.", { public: true });
  }
  return undefined;
},
```

### What each sees

The `bookings` View now says whom each booking is for: the name staff gave, the chat's title, or a
walk-in. A second View, `slots`, lists the free ones. Each reads as whoever is looking, so the rule
has done its work before a line is written.

### The first tests

`tests/kit.ts` starts the app as `app.ts` makes it, in memory, and opens the desk. Sam works there,
so his calls say so:

```ts
/** Staff: a person, at the desk. His calls are there (`in`), as a page of the desk says. */
export const sam: Actor = { kind: "person", id: "sam", in: DESK };
```

`customer` makes a contact with a chat at the desk, and `seen` reads a View as someone. The first
test books for two customers and a walk-in, then reads as each:

```ts
// A walk-in, booked by Sam at the desk: in the space, in no chat.
await runtime.call("booking.make", { slot: "thu-09", name: "Rui" }, { actor: sam });

assert.equal(
  await seen(runtime, "bookings", sam),
  "Tue 10:00 (tue-10), for Bia\nWed 15:00 (wed-15), for Caio\nThu 09:00 (thu-09), for Rui",
);
assert.equal(await seen(runtime, "bookings", bia.actor), "Tue 10:00 (tue-10), for Bia");
assert.equal(await seen(runtime, "bookings", caio.actor), "Wed 15:00 (wed-15), for Caio");
```

The second has Caio try what he shouldn't. One of his tries says he's at the desk, and books there,
outside his chat. Nothing in the Action stops him; the rule does:

```ts
// At the desk, outside his chat: the booking would be out of his reach, so the rules refuse it.
await assert.rejects(
  runtime.call("booking.make", { slot: "tue-11" }, { actor: { ...caio.actor, in: DESK } }),
  /would be out of your reach/,
);
```

`hello.ts` goes: the tests do what it did, and check it.

## Run it

```sh
npm test
```

```text
✔ staff see every booking; a customer sees only their own (73.702708ms)
✔ a customer can't book into another's chat, take a slot, or cancel what isn't theirs (40.759958ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 260.016834
```

## What this unlocks

- **Rules that come with the data.** Every way in you add later inherits them without a line of its
  own. Chapter 6 checks that at all of them at once.
- **No leaks through "taken".** A customer learns that a slot is gone, never whose it is.
- **All or nothing.** A refused booking leaves no `slot_taken` behind.

## Your challenge

Write `booking.move`: it changes a booking's slot, in one transaction, freeing the old one. Test
that Bia can move hers, and that Caio can't move Bia's.

Next, the desk gets a web page of its own.
