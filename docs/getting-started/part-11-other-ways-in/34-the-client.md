---
title: "Chapter 34: The client"
description: "Copilotz's client, connect, reaches the running server as plugin code reaches the store, over the socket or over HTTP; its watch hears every commit, so a script prints your board again whenever a card moves."
section: Getting Started
order: 340
status: stable
---

# Chapter 34: The client

> Part 11, other ways in · Requires: Chapter 33 · Code: `lesson-11.2`

## The pain

The script of Chapter 33 is always one question behind. To keep the board on a second screen, or to
act when a card reaches Done, it would have to ask again and again, and still miss what happened in
between.

## The problem

A program outside should hear changes as the page does: once, when they're committed, whoever made
them (you in the browser, the terminal, North). And it shouldn't need its own way of spelling
requests: building URLs and JSON by hand is where mistakes hide.

## The solution

**The client**, `connect` from `copilotz`. It's spelled like plugin code's `ctx.db.collection`, and
only how it's made differs:

```ts
const app = await connect("http://127.0.0.1:8080"); // over the socket
const app = await connect("http://127.0.0.1:8080", { over: "http" }); // over HTTP
```

Over the socket, it asks `POST /connect` for a one-time ticket, as whoever the request is, then each
line is a frame and watches are pushed. Over HTTP, each line is a request to the REST API of Chapter
33, and a watch is a server-sent stream. Either way, from this machine it's you: identity's `who`
says so, and no key is needed. (`key` is for a developer key, which Copilotz's `api` plugin makes
for apps with sign-in; Compass has one person, on one machine.)

Its collections have `find` (then `.toArray()`), `findOne`, `countDocuments`, the writes, a named
`query`, and **`watch(filter, options?, onChange)`**: the rows `find` would find, now and after each
commit that changes them. It returns how to stop.

`scripts/watch.ts`:

```ts
/**
 * Watches your Personal space's first board: `show` hears it as text now,
 * and again after each change to its cards. It returns how to stop.
 */
export async function watchBoard(app: Client, show: (text: string) => void): Promise<() => void> {
  const { space } = await app.call<{ space: string }>("space.personal", {});
  const [board] = await app.db.collection<Board>("board")
    .find({ in: space }, { sort: { at: 1 }, limit: 1 }).toArray();
  if (!board) throw new Error("Your Personal space has no board yet.");
  return app.db.collection<Card>("card").watch(
    { board: board._id },
    { sort: { order: 1 } },
    (cards, error) => show(error ? `Can't watch: ${error.message}` : shown(board, cards)),
  );
}

if (import.meta.main) {
  const url = process.env.COMPASS_URL ?? "http://127.0.0.1:8080";
  const app = await connect(url, { over: process.argv.includes("--http") ? "http" : "socket" });
  const stop = await watchBoard(app, (text) => {
    console.log(`\n${new Date().toLocaleTimeString()}\n${text}`);
  });
  // … Ctrl-C stops the watch and closes the client
}
```

`shown` is Chapter 33's, the board as text. `app.call` is the same Action, `space.personal`; the
reads go through the same rules. A write through the client is yours too, and the same guard refuses
it: `app.db.collection("card").updateOne(…)` says cards change through their Actions.

## Run it

Start the server (`npm run dev`), then `node scripts/watch.ts` in one shell. In another, move a card
(Chapter 33's script, the browser, the terminal, or North):

```text
$ node scripts/board.ts move "Record the demo" Doing
Moved "Record the demo" to Doing.
```

The watch printed the board when it started, and again when the card moved:

```text
$ node scripts/watch.ts

7:42:33 AM
Launch
  Backlog
  To do
    - Record the demo
    - Publish the page
  Doing
    - Write the intro
  Blocked
  In review
  Done

7:42:36 AM
Launch
  Backlog
  To do
    - Publish the page
  Doing
    - Write the intro
    - Record the demo
  Blocked
  In review
  Done
```

`node scripts/watch.ts --http` prints the same, over a server-sent stream.

## Check it

`connect` takes the `fetch` it calls the app with, so `tests/client.test.ts` connects in-process,
over HTTP with the runtime's own `fetch` (the address set as a listener would), and opens no port:

```ts
const client = (runtime: Runtime, address = "127.0.0.1") =>
  connect("http://127.0.0.1:8080", {
    over: "http",
    fetch: (input, init) => runtime.fetch(setClientAddress(new Request(input, init), address)),
  });
```

The board prints, a card moves, the board prints again with the card in Doing; a direct write is
refused; and from `203.0.113.7` the client finds no boards and can't call `space.personal`.

```text
✔ the client watches the board: a card moved prints it again
✔ from anywhere else, the client is nobody: it reads nothing
```

`git diff lesson-11.1 lesson-11.2` shows every change.

## What you have now

Programs on your machine read Compass, change it through its Actions, and hear every change as it's
committed, with the same client over the socket or over HTTP. Next, the programs that think: an
assistant on your machine, calling the board's tools over MCP.
