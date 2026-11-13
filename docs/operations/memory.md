---
title: "Memory"
description: "Running an app in a container of 512 MiB or less: Deno 2.9 or later, V8's young generation capped, SQLite's cache, each plugin from its own entry point, and the read cache, with what each saves."
section: Operations
order: 4
---

# Memory

An app's process holds the runtime, the code of the plugins it imports, and what it reads and
writes. Most of it is fixed once the app starts. Under load, V8's young generation grows on top of
it, and so does whatever the store keeps in the process.

In a container of 512 MiB or less, 5 things keep it small. The numbers on this page come from the
docs app's shape: copilotz.com's docs as an MCP server, with 3 read-only tools, on the memory store.
It was measured on a Mac on 2026-11-12, in MiB of RSS after a full garbage collection unless a table
says otherwise.

## Deno 2.9 or later

Copilotz needs Deno 2.9 or later. The SQLite store refuses an older Deno, whose `node:sqlite` lacks
what the store uses. A newer Deno also holds less for the same app:

|                               | Deno 2.5.4 | Deno 2.9.2 | Node 24 |
| ----------------------------- | ---------: | ---------: | ------: |
| Started, after one call       |        109 |        102 |     121 |
| Peak RSS over 1,000 MCP calls |        266 |        202 |     265 |

## V8's young generation, capped

V8 lets a process's young generation grow as it allocates. Under a steady stream of requests, that
adds 50 to 110 MiB before it levels off. A cap of 2 MiB per semi-space keeps it down, at the cost of
more frequent young collections:

```sh
deno run -A --v8-flags=--max-semi-space-size=2 server.ts
node --max-semi-space-size=2 server.ts
```

Peak RSS over 1,000 MCP calls, each a new conversation:

|                           | Deno 2.5.4 | Deno 2.9.2 | Node 24 |
| ------------------------- | ---------: | ---------: | ------: |
| V8's default              |        266 |        202 |     265 |
| `--max-semi-space-size=2` |        157 |        147 |     156 |

Set it in a container of 512 MiB or less. With more room, V8's default collects less often.

## SQLite's cache

The SQLite store keeps a page cache of 2 MiB per connection and maps nothing into memory. Those are
its defaults since 1.0.0-rc.47, and both are options:

```ts
const store = await sqliteStore({ path, cacheKiB: 2048, mmapMiB: 0 }); // the defaults
```

The store opens 2 connections, and both count in the process's RSS once filled. The sizes before
rc.47 (`cacheKiB: 65_536, mmapMiB: 256`) read a big file faster on a machine with memory to spare.
Over the same 1,000 calls, on SQLite, they peaked 15 to 40 MiB higher on Deno 2.9, and about 40 MiB
higher on Node 24. [Stores](stores.md) has the rest about SQLite.

## Each plugin from its own entry point

A theme's entry point (`copilotz/plugins/interfaces`) loads every plugin in it. Each plugin of
`agents`, `access` and `interfaces` is also an entry point of its own, which loads that plugin
alone. The docs app's plugins, imported one by one:

```ts
import { models } from "copilotz/plugins/models";
import { chat, tool } from "copilotz/plugins/agents/chat";
import { spaces } from "copilotz/plugins/access/spaces";
import { identity } from "copilotz/plugins/access/identity";
import { contacts } from "copilotz/plugins/access/contacts";
import { mcp } from "copilotz/plugins/interfaces/mcp";
```

| Started, after one call | Deno 2.5.4 | Deno 2.9.2 | Node 24 |
| ----------------------- | ---------: | ---------: | ------: |
| The themes' entries     |        109 |        102 |     121 |
| Each plugin's own       |         98 |         90 |     103 |

The [reference](../reference.md#entry-points) lists every entry point.

## The read cache

The runtime keeps up to 10,000 documents and 1,000 query results in memory, so reads skip the store.
A smaller cache holds less, and reads the store more often:

```ts
const runtime = await createRuntime({ store, plugins, cache: { documents: 1_000, queries: 100 } });
```

After 1,000 calls, that cache held about 3.5 MiB less of the heap. `cache: false` reads the store
every time.

## What else holds memory

- **The model catalog:** loaded the first time a model is resolved. An app that never calls a model
  doesn't load it, and saves about 5 MiB of heap.
- **The memory store** keeps every event and document in the process: about 14 KB of JSON for each
  MCP call here, which the heap keeps for as long as the process runs. A server that runs for long
  keeps them in SQLite or PostgreSQL.

`bench/memory/budget.test.ts` holds the docs app's shape to a budget on Deno and Node, as part of
the test suite.

## Related

- [Stores](stores.md): memory, SQLite and PostgreSQL.
- [Metrics](metrics.md): what the runtime measures, the cache's reads among them.
