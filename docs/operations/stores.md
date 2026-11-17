---
title: "Stores"
description: "Where an app keeps what it keeps: memory, SQLite or PostgreSQL, with the same MongoDB semantics in all three; the record of every change, and how to read it back; and large values, kept once, in the store, in files or in a bucket."
section: Operations
order: 1
---

# Stores

An app keeps everything in one store: in memory, in SQLite or in PostgreSQL. Moving from one to
another changes one line.

## Three stores, one behavior

`memory` is the reference. `sqlite` and `postgres` keep the same MongoDB semantics, and one
conformance suite, `stores/tests/`, holds all three to it.

[stores/README.md](../../stores/README.md) describes each one. It lists exactly which parts of the
MongoDB collection API they support, and how.

| Import                     | What it has                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `copilotz/stores/memory`   | `memoryStore()`: in memory, the reference                                                                    |
| `copilotz/stores/sqlite`   | `sqliteStore({ path })`: `node:sqlite` or `bun:sqlite`, one file                                             |
| `copilotz/stores/postgres` | `postgresStore({ url, schema, tenant })` (a server, or PGlite in the process), `postgresPool`, `copyTenant`… |
| `copilotz/stores/latency`  | `withLatency(store, ms)`: a store with round trips, to measure                                               |

## SQLite

SQLite opens `node:sqlite` on Node and Deno, and `bun:sqlite` on Bun. It also takes any database
with the same small API, through `sqliteStore({ path, open })`, such as a Durable Object's. On Deno
it needs 2.9 or later: an older Deno's `node:sqlite` lacks what the store uses, and the store says
so when it opens.

The store opens 2 connections to the file, one that writes and one that reads. Each keeps a page
cache of 2 MiB (`cacheKiB: 2048`, SQLite's own size), and nothing of the file is mapped into memory
(`mmapMiB: 0`). Both count in the process's memory: the cache once it fills, once per connection,
and mapped pages once they're read. Small sizes leave a container's memory to the app. A big file on
a machine with memory to spare reads faster with more:

```ts
const store = await sqliteStore({ path, cacheKiB: 65_536, mmapMiB: 256 }); // the sizes before rc.47
```

With the docs app's shape (an MCP server, 1,000 calls), the larger sizes peaked 15 to 40 MiB higher
on Deno 2.9, and about 40 MiB higher on Node 24. [Memory](memory.md) has the rest of what a small
container needs.

## PostgreSQL

The PostgreSQL store runs on Ominipg: a server for a `postgres://` URL, or PGlite in the process.
PGlite needs `@electric-sql/pglite` installed beside Copilotz.

A PostgreSQL store holds one tenant, an org. Many tenants share a schema, and the store itself keeps
each apart. An org's rows copy elsewhere unchanged with `copyTenant`.

## The record

Every store keeps the record the same way. Each commit appends its events, in order, to the store's
`events` table (in memory, a list), and the runtime never changes or deletes one. Nothing prunes it:
it grows with every write, for as long as the store lasts. [Events](../architecture/events.md) says
what kinds there are.

| Column  | What it holds                                                                      |
| ------- | ---------------------------------------------------------------------------------- |
| `seq`   | its place in the log, given when it commits                                        |
| `id`    | its id: for `action.started`, the call's                                           |
| `type`  | what happened: `customer.created`, `action.completed`…                             |
| `data`  | what it says, as JSON (`jsonb` on PostgreSQL); a large value is a blob's reference |
| `cause` | the id of the event that caused it: a write's, its call's `action.started`         |
| `actor` | who did it, for whom and where, as JSON (`for`, `in`, `via`); none: the system     |
| `at`    | when its commit was made: the events of one commit share it                        |

On PostgreSQL the table is in the store's schema (`copilotz` unless `schema` says), with a `tenant`
column, and `seq` counts each tenant's events.

What a call records: `action.started` holds `{ action, input, inputHash, startedAt, attempt }`, then
`action.completed` its `result` and `ms`, or `action.failed` its `error`. A collection's write
records `{ _id, doc }`, and for an update the fields `changed` and `removed`.

What stays out is what the app declares out:

- **A collection's `private` fields** (keys, tokens, passwords): no event holds them, and an actor's
  reads come without them.
- **An Action's `private` fields**, of its input and its result. Its `inputHash` still covers the
  whole input, and a result that had any is kept whole apart (`sys.results`, which records no
  events), so a retry answers with all of it.
- **An unrecorded Action's call** (`record: false`): no `action.*` events. What it writes is still
  recorded, as any write is, with no call as its cause.
- **Collections with `events: false`**, `records: true` ledgers (their documents are their own
  record) and `durable: false` collections (in memory only).

Everything else an Action is given is on the record for good: a key or a password never goes in an
input, and never in a field that isn't `private`.

### Reading it back

- **From code that holds the store** (a test, a script, the server that opened it):
  `store.events(afterSeq, limit)` gives the events after that `seq`, 1,000 at most unless `limit`
  says, as they're stored: a large value is still a reference. `store.related(id, types)` gives the
  event with that id and the events it caused, of those types: a call's start, its writes and its
  end.
- **As it happens:** `runtime.subscribe(listener)` hears each event as it commits,
  `{ kind: "event", event, full }`, where `full()` loads its large values. It hears nothing from
  before, and holds nothing: a Processor is what reacts to events durably.
- **In SQL:** `sqlite3` on the file, `psql`, or [maintenance](maintenance.md) over HTTP. A
  document's history, on SQLite and PostgreSQL alike:

```sql
SELECT seq, at, type, actor ->> 'id' AS who, cause FROM events
  WHERE type LIKE 'customer.%' AND data ->> '_id' = 'c-12' ORDER BY seq;
```

The same, from code that holds the store, a thousand events at a time:

```ts
import type { Event, Store } from "copilotz";

/** Every event of one document, in order: who did what, when, and in which call. */
export async function historyOf(store: Store, collection: string, id: string): Promise<Event[]> {
  const found: Event[] = [];
  for (let after = 0;;) {
    const batch = await store.events(after, 1_000);
    if (!batch.length) return found;
    found.push(...batch.filter((e) => e.type.startsWith(`${collection}.`) && e.data._id === id));
    after = batch.at(-1)!.seq;
  }
}
```

Plugin code reads no log: nothing on `ctx` does. A screen that shows a document's history reads a
collection the app keeps, written by the Action that makes each change or by a Processor that hears
its events.

## Blobs

A blob is a large value, kept once.

- **What becomes one:** a string over 16 KiB of UTF-8 (`createRuntime({ blobThreshold })` sets
  another size), wherever it is: a document's field, an update, an edge's data, an event's data (a
  call's input and result too). A file is such a string, base64 or a `data:` address: documents and
  events are JSON, and hold no other bytes.
- **Kept once:** it's named by the SHA-256 of its content (`sha256-…`), and putting one that's there
  does nothing. The document and each event that holds it keep a reference in its place,
  `{ $blob, size, type }`: a picture saved, its `.created` event and a call that was given it share
  one blob. A smaller value is kept in place, in the document and in each event that holds it.
- **Out of sight:** the owner moves large values out on write and back in on read, so plugin code,
  queries, Views and the browser get the string whole and never see a reference. A `$blob` key in
  data is refused. A `projection` that leaves a field out (`{ picture: 0 }`) loads nothing of it: a
  list that shows no pictures reads none.
- **As bytes:** trusted host code (a route) reads one with
  `runtime.bytes(collection, filter, field, { actor })`: the first document `filter` finds, read as
  `actor` reads it, or as the system without one. It answers its `size` and `read(start, end)`, the
  UTF-8 bytes of the string: a `data:` address's text, which the route decodes. The owner loads the
  blob once, at the first part asked for, and its reference never leaves the owner. Where no rule
  speaks for the collection, any actor reads it, the anonymous too: check who asks first.
  [A business app's screens](../guides/a-business-apps-screens.md) serves pictures this way; chat's
  `/files/<id>` streams files of any size, with ranges.
- **Not searched:** a `$regex` doesn't match a value kept as a blob, since the store holds its
  reference.
- **Never deleted:** nothing in the runtime deletes a blob. A document deleted or changed leaves its
  blobs, which its earlier events still refer to. Only `dropTenant` removes an org's blobs, when
  they're in its PostgreSQL store, with the rest of its rows.
- **Limits:** a call carries at most 16 MiB to the owner, and the REST API takes a body of 16 MB at
  most. A file of more than a few MB goes in a call of its own, as chat's `chat.attach` takes one of
  about 10 MB.

They live in the store's own `blobs` table by default. `createRuntime({ blobs })` puts them
elsewhere:

| Import                 | What it has                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `copilotz/blobs/files` | `fileBlobs({ dir })`: blobs as files                                                                      |
| `copilotz/blobs/http`  | `httpBlobs({ url, headers })`: blobs in a bucket (S3, GCS, R2…)                                           |
| `copilotz/blobs/gcs`   | `gcsBlobs({ bucket, prefix })`: blobs in a Google Cloud Storage bucket, as the instance's service account |

```ts
import { createRuntime } from "copilotz";
import { fileBlobs } from "copilotz/blobs/files";
import { sqliteStore } from "copilotz/stores/sqlite";
import { plugins } from "./app.ts";

const runtime = await createRuntime({
  store: await sqliteStore({ path: ".data/app.sqlite" }),
  blobs: fileBlobs({ dir: ".data/blobs" }),
  plugins: plugins(),
});
```

The runtime looks for blobs in one place: with `blobs`, only there; without, only in the store. A
store that already holds blobs keeps them in its `blobs` table, where the runtime no longer looks
once `blobs` is set. Choose before the store fills. `store.blob(id)` reads those the store keeps;
maintenance answers any, wherever it lives (`GET /maintenance/blobs/<sha256-…>`).

## Related

- [Maintenance](maintenance.md): SQL over HTTP, for operators who can't reach the database.
- [Build Compass, Chapter 5](../build-compass/part-2-your-own-plugins/05-one-store.md): what the
  store's tables hold, and why the store has one writer at a time.
- [Build Compass, Chapter 36](../build-compass/part-12-shipping/36-postgresql-and-blobs.md):
  PostgreSQL and file blobs.
