---
title: "Chapter 33: The REST API"
description: "Other programs reach Compass: the runtime answers /api/ itself, as whoever identity's who says a request is, so a script on your machine reads your board and moves a card through the same Actions and rules as a click."
section: Build Compass
order: 330
status: stable
---

# Chapter 33: The REST API

> Part 11, other ways in · Requires: Chapter 32 · Code: `lesson-11.1`

## The pain

Compass has three ways in: the browser, the terminal, and North. But you live in other programs too:
a shell script, a git hook, a cron job, the editor. "Move the card when the build passes" means
opening the browser and dragging it.

## The problem

A script needs a way in that isn't a page. And it can't be a back door: what it reads and changes
must be what you may read and change, through the same Actions, checked by the same rules, recorded
the same way. Whoever isn't you must get nothing at all.

## The solution

You don't write the way in: **the runtime answers `/api/` itself**, for whoever the plugins' `who`
says a request is, with everything checked as it is over the socket (each Action's and query's
`allow`, and the rules). Compass's identity already says who: a request from this machine is you.

```text
GET    /api/collections/<name>?filter=<json>&sort=<json>&limit=&skip=   find
GET    /api/collections/<name>/<id>                                      findOne
POST   /api/actions/<name>             call
GET    /api/queries/<c>.<q>?params=<json>
GET    /api/                           the reference: what this caller may use
```

(That's part of the README's list; writes to collections are there too, `POST`, `PATCH`, `PUT` and
`DELETE`, and the rules decide them.)

### The script

`scripts/board.ts` uses nothing but `fetch`. It asks for your Personal space with its Action, reads
its first board and that board's cards, and moves a card with `card.move`:

```ts
/** How the script reaches the API: `fetch` here, `runtime.fetch` in a test. */
export type Api = (path: string, init?: RequestInit) => Promise<Response>;

/** One request to `/api/`, its JSON answer back; an error says what the API said. */
async function ask<T>(api: Api, path: string, body?: unknown): Promise<T> {
  const response = await api(
    `/api/${path}`,
    body === undefined ? {} : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const said = await response.json();
  if (!response.ok) throw new Error(said.error?.message ?? `The API answered ${response.status}`);
  return said as T;
}

const json = (value: unknown) => encodeURIComponent(JSON.stringify(value));

/** Your Personal space's first board, and its cards in order. */
export async function firstBoard(api: Api): Promise<{ board: Board; cards: Card[] }> {
  const { space } = await ask<{ space: string }>(api, "actions/space.personal", {});
  const [board] = await ask<Board[]>(
    api,
    `collections/board?filter=${json({ in: space })}&sort=${json({ at: 1 })}&limit=1`,
  );
  if (!board) throw new Error("Your Personal space has no board yet.");
  const cards = await ask<Card[]>(
    api,
    `collections/card?filter=${json({ board: board._id })}&sort=${json({ order: 1 })}`,
  );
  return { board, cards };
}

// … shown(board, cards): the board as text, each column, then its cards

/** Moves the card titled `title` to the column named `column`, with `card.move`. */
export async function move(api: Api, title: string, column: string): Promise<string> {
  const { board, cards } = await firstBoard(api);
  // … the card by its title, the column by its name
  await ask(api, "actions/card.move", { card: card._id, column: to.id });
  return `Moved "${card.title}" to ${to.name}.`;
}
```

Reading is reading the collections; changing is calling the Action, as the page does. A card can't
be moved with a `PATCH`: Chapter 9's boards guard says cards change only through their Actions, and
the API asks it.

The functions take an `Api`, so the same code runs against the server (the platform's `fetch`) and
in a test (`runtime.fetch`). At the bottom, only when the file is run (`import.meta.main`), it reads
the command line:

```ts
if (import.meta.main) {
  const base = process.env.COMPASS_URL ?? "http://127.0.0.1:8080";
  const api: Api = (path, init) => fetch(new URL(path, base), init);
  const [command, title, column] = process.argv.slice(2);
  // … move if asked, then print the board
}
```

### Nobody gets nothing

The API answers whoever `who` says, and that includes nobody. What keeps nobody out is identity's
rule from Chapter 3: for anyone who isn't you or your agents, it returns a filter nothing matches.
The runtime asks every rule about every read and write an actor makes, from outside or not, and
applies all their filters together. So it holds even where another rule has nothing against a read:
spaces' rule says `true` to reading shared documents, cards among them, and a stranger still reads
nothing.

```ts
// Everything here is yours, and your agents' as they work for you. Nobody else reaches
// anything: the runtime asks this for every read and write they'd make, from outside or not.
if (actor.kind === "person") return true;
return actor.kind === "agent" ? undefined : { _id: { $in: [] } };
```

That matters even with the server on `127.0.0.1`: a page on another site can point its own name at
your machine (DNS rebinding), and its requests then come from this machine but for another host.
Identity's `who` calls that nobody (Chapter 3), and nobody reads nothing.

## Run it

With a board, Launch, in your Personal space and three cards in To do, start the server
(`npm run dev`), and in another shell:

```text
$ node scripts/board.ts
Launch
  Backlog
  To do
    - Write the intro
    - Record the demo
    - Publish the page
  Doing
  Blocked
  In review
  Done

$ node scripts/board.ts move "Write the intro" Doing
Moved "Write the intro" to Doing.
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
```

The browser's Board tab shows the card move as the script moves it. A card that isn't there, or a
write around the Actions, says why:

```text
$ node scripts/board.ts move "Nothing" Doing
No card "Nothing" on Launch.

$ curl -X PATCH http://127.0.0.1:8080/api/collections/card/d45913fd9143 \
    -H 'content-type: application/json' -d '{"column":"done"}'
{"error":{"code":"forbidden","message":"Boards and cards change through their Actions."}}

$ curl http://localhost:8080/api/collections/card -H "Host: example.com"
[]
```

`curl` works as well as the script: any program on your machine is you.

## Check it

`tests/api.test.ts` runs the script's own functions through `runtime.fetch`, with the address a
listener would have seen (`setClientAddress`, from `copilotz`): from `127.0.0.1` it reads the board
and moves a card; from `203.0.113.7` it's nobody, reads an empty list and gets a 401 from
`card.move`.

```text
✔ from this machine, the script reads your board and moves a card
✔ from anywhere else, it's nobody: nothing is read, nothing moves
```

`git diff lesson-10.2 lesson-11.1` shows every change.

## What you have now

Any program on your machine reads and changes Compass as you, over HTTP, through the same Actions
and rules as the browser. Next, a script that doesn't have to ask again: the client, and a live
board.
