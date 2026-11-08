---
title: "Chapter 5: One store"
description: "Keep Compass in one SQLite file: what the store's tables hold, each collection as a SQL view, and why the store has one writer at a time."
section: Getting Started
order: 50
status: stable
---

# Chapter 5: One store

> Part 2, your own plugins · Requires: Chapter 4 · Code: `lesson-2.2`

## The pain

Close the terminal and everything is gone: `memoryStore()` keeps it only while the process runs.
That's right for tests, wrong for a workspace.

## The problem

You want what Compass knows to last, in a place you can open and read yourself, without designing
tables for each new collection. And when two processes might open it, you want them never to
overwrite each other.

## The solution

A Copilotz store is one of three: in memory, SQLite (`node:sqlite`, `bun:sqlite`) or PostgreSQL. The
plugins never know which; only the line that opens it changes. `store.ts`:

```ts
import process from "node:process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Store } from "copilotz";
import { sqliteStore } from "copilotz/stores/sqlite";

export async function openStore(): Promise<Store> {
  const path = process.env.COMPASS_DATA || ".data/compass.sqlite";
  await mkdir(dirname(path), { recursive: true });
  return await sqliteStore({ path });
}
```

The terminal and the server open it instead of a store in memory:

```ts
const runtime = await createRuntime({
  store: await openStore(),
  plugins: [/* … */],
});
```

Node prints a warning that `node:sqlite` is experimental; the `terminal` and `dev` scripts pass
`--disable-warning=ExperimentalWarning` to keep it quiet.

## Run it

Tell North something, quit, start again, and ask: the conversation is still open where you left it,
and North remembers what you said in it.

## What's in the store

Open the file with the `sqlite3` command:

```sh
sqlite3 .data/compass.sqlite
```

```text
sqlite> .tables
blobs    events   image    message  nodes    shell    thread   wait
edges    file     intent   meta     person   shown    vectors
```

The store is a few tables, whatever the app's collections are:

| Table     | What it holds                                                                    |
| --------- | -------------------------------------------------------------------------------- |
| `nodes`   | every document of every collection: its collection, its id, the document as JSON |
| `events`  | the record, in order: each event's type, data, cause, actor and time             |
| `edges`   | links between documents                                                          |
| `blobs`   | large values (over 16 KiB), stored once by their hash                            |
| `vectors` | embeddings, for search by meaning                                                |
| `meta`    | the store's own state: the owner's epoch, where each Processor has read to       |

The rest (`message`, `person`, `thread`, and the terminal's `shell`…) are SQL **views**, one per
collection, with the document's fields as columns. You read them like tables:

```text
sqlite> SELECT _id, name FROM person;
ana|Ana
sqlite> SELECT seq, type, actor FROM events ORDER BY seq DESC LIMIT 6;
20|thread.updated|{"kind":"agent","id":"north","for":{"kind":"person","id":"ana"},"via":…}
19|message.created|{"kind":"agent","id":"north","for":{"kind":"person","id":"ana"},"via":…}
18|action.completed|{"kind":"person","id":"ana"}
17|turn.requested|{"kind":"person","id":"ana"}
16|message.created|{"kind":"person","id":"ana"}
15|thread.updated|{"kind":"person","id":"ana"}
```

Every event says who did it. Ana's message, and the call that sent it, are hers; an event with no
actor is the system's (the app's own `person.set` as it starts). North's answer is from `north`,
acting **for** Ana: everything an agent does is done for someone, and can reach only what they
reach.

Read the store by hand as much as you like, but never write it by hand: writes go through the
runtime, as Actions, so they're checked and recorded.

## One writer

The runtime that opens a store is its **owner**: the one process that writes it, commits every write
with its events, and runs the Processors in order. A store has one owner at a time. Start the
server, then the terminal on the same file, and the terminal takes the store over: the server is
**fenced**, and every write it tries fails ("another owner holds the store"). Run one at a time.

`tests/store.test.ts` shows both:

```ts
test("a conversation is still there when Compass opens its store again", async () => {
  const file = join(tempDir(), "compass.sqlite");
  const first = await open(file);
  const { thread } = await first.call<{ thread: string }>("chat.send", { text: "Remember me" }, {
    actor: ana,
  });
  await first.idle();
  await first.close();

  const again = await open(file);
  const said = await again.query<Message[]>("message.history", { thread });
  assert.deepEqual(said.map((m) => m.from), ["ana", "north"]);
  await again.close();
});

test("one writer: a second runtime on the same file fences the first", async () => {
  const file = join(tempDir(), "compass.sqlite");
  const first = await open(file);
  const second = await open(file);
  await assert.rejects(first.call("chat.send", { text: "Still mine?" }, { actor: ana }), /fenced/);
  await second.call("chat.send", { text: "Mine now" }, { actor: ana });
  await second.idle();
  await second.close();
  await first.close().catch(() => {}); // fenced: its last save fails, and that's expected
});
```

`{ actor: ana }` makes the call as Ana, the way the terminal and the page do: the Action must
`allow` her, and what it causes is hers.

## What you have now

Everything Compass knows, in one file you can read, written by one owner. On a server, the same app
runs on PostgreSQL with `postgresStore({ url })`, and nothing else changes.
