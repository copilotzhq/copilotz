---
title: "Stores"
description: "Where an app keeps what it keeps: memory, SQLite or PostgreSQL, with the same MongoDB semantics in all three, and blobs in the store, in files or in a bucket."
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

## Blobs

Blobs are strings over 16 KiB and the files people send. They live in the store by default. They can
also go elsewhere:

| Import                 | What it has                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `copilotz/blobs/files` | `fileBlobs({ dir })`: blobs as files                                                                      |
| `copilotz/blobs/http`  | `httpBlobs({ url, headers })`: blobs in a bucket (S3, GCS, R2…)                                           |
| `copilotz/blobs/gcs`   | `gcsBlobs({ bucket, prefix })`: blobs in a Google Cloud Storage bucket, as the instance's service account |

## Related

- [Maintenance](maintenance.md): SQL over HTTP, for operators who can't reach the database.
- [Build Compass, Chapter 5](../build-compass/part-2-your-own-plugins/05-one-store.md): what the
  store's tables hold, and why the store has one writer at a time.
- [Build Compass, Chapter 36](../build-compass/part-12-shipping/36-postgresql-and-blobs.md):
  PostgreSQL and file blobs.
