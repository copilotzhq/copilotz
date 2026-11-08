---
title: "Chapter 36: PostgreSQL and blobs"
description: "Run the same Compass on PostgreSQL when DATABASE_URL says so, and keep large values once, as files in a folder of their own, with Copilotz's postgresStore and fileBlobs."
section: Getting Started
order: 360
status: stable
---

# Chapter 36: PostgreSQL and blobs

> Part 12, shipping · Requires: Chapter 35 · Code: `lesson-12.1`

## The pain

Everything Compass knows is in one SQLite file on your laptop. That was the point in Chapter 5, and
it's still right for one person. But the day you want it on a server you already back up, or on a
machine that isn't this one, the file is in the way. And it grows in an awkward place: a long tool
result, a file's text, a report North read, all sit inside the same rows as everything else.

## The problem

Moving to another database must not change the app: not a plugin, not a test, not a query. The
plugins already never know which store they run on; what's left is to let the host pick one from the
environment. And large values want a place of their own: kept once, however many documents and
events hold them, somewhere you can size and back up apart from the database.

## The solution

Copilotz has both. A store is memory, SQLite or PostgreSQL, with the same MongoDB semantics in all
three and one conformance suite; SQLite and PostgreSQL keep the same five tables (`events`, `nodes`,
`edges`, `vectors`, `blobs`) plus `meta`. `postgresStore({ url })`, from `copilotz/stores/postgres`,
opens a PostgreSQL server for a `postgres://` URL, or PGlite, PostgreSQL in this process, for
`:memory:` or a file, when `@electric-sql/pglite` is installed (an optional peer dependency).

Large values are **blobs**: every string over 16 KiB is stored once, named by the hash of its
content (`sha256-…`), and a document or event holds a small reference in its place,
`{ $blob, size, type }`. The owner moves them out on write and back in on read, so plugin code never
sees a reference. By default the store keeps them in its own `blobs` table;
`createRuntime({ blobs })` puts them elsewhere: `fileBlobs({ dir })` (`copilotz/blobs/files`) as
files in a folder, `httpBlobs` in a bucket, `gcsBlobs` in Google Cloud Storage.

`store.ts` reads two more settings, and returns both things `createRuntime` takes:

```ts
type Env = Record<string, string | undefined>;

/** Where the environment says to keep things: a database or a file, and a folder for blobs. */
export function placesOf(env: Env) {
  return {
    store: env.DATABASE_URL
      ? { postgres: env.DATABASE_URL }
      : { sqlite: env.COMPASS_DATA || ".data/compass.sqlite" },
    ...(env.COMPASS_BLOBS ? { blobs: env.COMPASS_BLOBS } : {}),
  };
}

/** The store and the blobs, as `createRuntime` takes them. */
export async function openStorage(
  env: Env = process.env,
): Promise<{ store: Store; blobs?: Blobs }> {
  const places = placesOf(env);
  let store: Store;
  if ("postgres" in places.store) {
    // Loaded only when asked for: PostgreSQL's client is more to load than SQLite's.
    const { postgresStore } = await import("copilotz/stores/postgres");
    store = await postgresStore({ url: places.store.postgres });
  } else {
    await mkdir(dirname(places.store.sqlite), { recursive: true });
    store = await sqliteStore({ path: places.store.sqlite });
  }
  return { store, ...(places.blobs ? { blobs: fileBlobs({ dir: places.blobs }) } : {}) };
}
```

Two small functions on purpose. `placesOf` only reads the environment, so a test can ask it what a
setting picks without opening anything. `openStorage` opens what it says, and takes the environment
as an argument, so a test can hand it a temporary folder.

The terminal and the server spread what it returns into `createRuntime`:

```ts
const runtime = await createRuntime({
  ...(await openStorage()),
  plugins: [
    ...plugins({ you: me, openai: process.env.OPENAI_API_KEY }),
    // …
  ],
});
```

That's the whole change. Nothing in `app.ts` or any plugin knows where it runs. On PostgreSQL the
store is still the one writer it was on SQLite: the runtime that opens it fences the one before.

### Choose before the store fills up

`fileBlobs` keeps each blob as a file under a folder named for the first two hex digits of its hash,
and writes it to a temporary file first, then renames it, so a reader never sees half of one. But
the runtime looks for blobs in one place: with `blobs`, only there; without, only in the store. Set
`COMPASS_BLOBS` on a store that already holds large values, and they're still in its `blobs` table,
where the runtime no longer looks. So decide where blobs live when you decide where the store does.

## Run it

Two messages, the second one 21 000 bytes long, with a folder for blobs:

```sh
long=$(python3 -c "print('report-'*3000)")
printf "Hello North\n${long}\n/quit\n" | COMPASS_ME=ana COMPASS_DATA=.data/l121/compass.sqlite \
  COMPASS_BLOBS=.data/l121/blobs OPENAI_API_KEY= node --disable-warning=ExperimentalWarning terminal.ts
```

```text
Compass
Ana → north › Hello North
north › You said: Ana: Hello North
…
```

Two blobs: your long message, and North's echo of it (the offline model answers "You said: …").

```text
$ find .data/l121 -type f
.data/l121/compass.sqlite
.data/l121/blobs/f5/sha256-f534a56cc2d74b49c475073b949ec0f99b6196720f9c3b82b10c714f46060175
.data/l121/blobs/07/sha256-071581ef7fe3b324d20aae156bdaf34fb89ae059d79376392bdcc1233509f34a
```

In the database, the short messages are themselves, and the long ones are references; the store's
own `blobs` table is empty:

```text
$ sqlite3 .data/l121/compass.sqlite "select substr(text,1,120) from message"
Hello North
You said: Ana: Hello North
{"$blob":"sha256-071581ef7fe3b324d20aae156bdaf34fb89ae059d79376392bdcc1233509f34a","size":21000,"type":"text/plain; char
{"$blob":"sha256-f534a56cc2d74b49c475073b949ec0f99b6196720f9c3b82b10c714f46060175","size":21015,"type":"text/plain; char
$ sqlite3 .data/l121/compass.sqlite "select count(*) from blobs"
0
```

And with `DATABASE_URL`, Compass goes to PostgreSQL. Without a server listening there, it says so:

```text
$ printf 'Hello\n' | DATABASE_URL=postgres://compass@127.0.0.1:5999/compass COMPASS_ME=ana \
    OPENAI_API_KEY= node --disable-warning=ExperimentalWarning terminal.ts
…
Error: connect ECONNREFUSED 127.0.0.1:5999
    at …/node_modules/pg-pool/index.js:45:11
```

With a real one, the terminal starts as it always does, and its tables are in the `copilotz` schema.

## Check it

`tests/store.test.ts` keeps its two tests from Chapter 5, and adds three:

- **Which store**: `placesOf` with nothing set is the SQLite file; with `COMPASS_DATA` and
  `COMPASS_BLOBS`, that file and that folder; with `DATABASE_URL`, PostgreSQL, whatever else is set.
- **Blobs as files**: Compass opened on a temporary SQLite file and blobs folder, a 21 000-byte
  message sent, and read back whole from `message.history`, while the folder holds a `sha256-` file.
  The message is one long word on purpose: the offline model echoes word by word, waiting 15 ms on
  each, and a long sentence would make a slow test.
- **The same app on PostgreSQL**: Compass on `DATABASE_URL=:memory:`, PGlite in the process; a chat
  in your Personal space, and North answers. PGlite isn't in `package.json`, so without it the test
  is skipped, and says how to run it:

```text
✔ a conversation is still there when Compass opens its store again (154.617917ms)
✔ one writer: a second runtime on the same file fences the first (109.388ms)
✔ DATABASE_URL puts Compass on PostgreSQL; without it, it's a SQLite file (0.17325ms)
✔ a large value is kept once, as a file in the blobs folder (94.949958ms)
﹣ the same app on PostgreSQL, in this process (0.050583ms) # PGlite isn't installed (npm i -D @electric-sql/pglite runs this test)
```

With PGlite installed (0.4.6 here), it runs:

```text
✔ the same app on PostgreSQL, in this process (1226.105334ms)
```

## Also in this chapter

- `.env.example`: `DATABASE_URL` and `COMPASS_BLOBS`, empty, each with a line saying what it does
  and what happens without it.
- `server.ts` and `terminal.ts`: `...(await openStorage())` in place of `store: await openStore()`.

`git diff lesson-11.3 lesson-12.1` shows every change.

## What you have now

The same Compass on SQLite or PostgreSQL, picked by one setting, and large values kept once, in a
folder of their own. Next, you watch it run: what Copilotz measures as it works, read at `/metrics`.
