# Stores

Where the runtime keeps what it keeps, and reads back: the implementations of its two persistence
ports. The host picks them; plugins never see them (they use the MongoDB-style collection API, and
the owner turns each call into an op).

- **The store** (`Store`, `runtime/store.ts`): the log and the data (events, documents, edges,
  vectors), transactional, one per runtime. Every deployment has one: they sit at the top of this
  folder.
- **Blobs** (`Blobs`, `runtime/blobs.ts`): large values, kept once by the hash of their content; a
  document holds a reference in their place, and the owner moves them out on write and back in on
  read. Optional: without one, the store keeps them itself. They sit in `blobs/` (`files`: a
  directory; `http`: a bucket over HTTP).

What the runtime sends out and never reads back (metrics) isn't kept here: that's `exporters/`.

| Store      | Where           | What it is                                                                                                                                                                                                  |
| ---------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory`   | `memory/`       | The reference: runs the MongoDB API in JavaScript (`runtime/mongo.ts`). Nothing survives the process. The runtime's own (`runtime/memory.ts`, what `durable: false` collections live in); picked from here. |
| `sqlite`   | `sql/sqlite/`   | The runtime's SQLite (`node:sqlite` on Node and Deno, `bun:sqlite` on Bun, or a database passed in), one file, WAL.                                                                                         |
| `postgres` | `sql/postgres/` | Ominipg: a PostgreSQL server for a `postgres://` URL, or PGlite in this process for `:memory:` and files. Tenant-scoped: many orgs share a schema, each reaching only its own rows ([Tenants](#tenants)).   |
| `latency`  | `latency/`      | Wraps any store and adds a delay per database round trip, to see what a turn costs at production latency (`--rtt`).                                                                                         |

The SQL stores share one MongoDB-to-SQL translation (`sql/shared/filter.ts`); each brings its
dialect. Both keep five tables (`events`, `nodes` with documents as JSON, `edges`, `vectors`,
`blobs`) plus `meta` for the fencing epoch, and show every collection as a SQL view
(`SELECT * FROM message`). Read them with any client while the runtime runs
(`sqlite3 -box
.data/copilotz.sqlite`, `psql`), or with `/sql <query>` in the chat.

## Tenants

An org is a tenant. The Postgres store is bound to `(schema, tenant)`
(`postgresStore({ url | pool, schema, tenant })`), and every statement it makes names its tenant, so
isolation never depends on rules elsewhere being right. Without `tenant`, a store is its schema's
only tenant (`""`), in the same tables.

- **Every row carries `tenant`, and every key and index leads with it:** documents are keyed
  `(tenant, collection, id)`, and so on for edges, vectors and declared indexes.
  `meta (tenant, key)` holds each tenant's fencing epoch and Processor positions. Blobs are keyed
  `(tenant, id)`: content dedupes within an org, never across.
- **Events are numbered per tenant,** `(tenant, seq)`. The owner is its tenant's only writer, so the
  store numbers them itself. It loads the highest number when it opens, and each write takes a range
  before it is sent, so an owner's writes still run together. A recorded update or delete of many,
  whose events can't be counted first, runs alone. A number a write doesn't use stays a gap, as a
  sequence's would.
- **Placement is the host's choice:** small orgs share a few schemas; a big one gets a schema, or a
  database, of its own. `sql/postgres/tenants.ts` moves them:
  - `copyTenant({ from, to, tenant })` copies a tenant's rows unchanged, from one consistent
    snapshot: in one transaction within a database, streamed in batches between two;
  - `dropTenant` deletes them in batches, its epoch first, which fences its owner;
  - `exportTenant` streams them as a script of one COPY per table, which `psql` restores.
- **Connections:** `postgresPool({ url })` is shared by every store a process opens on a database.
  Commits go through its write lane and reads through its read lane, taking a connection per
  statement or open transaction: idle and closed stores hold none. A store given a `url` makes a
  pool of its own.
- **Views:** one per collection for the schema, showing the tenant a session names
  (`SET copilotz.tenant = 'org_1'`; else `""`, a schema's only tenant). Not a view per tenant: that
  grows the catalog with sign-ups, with DDL on every open. They're for reading: SQL can reach the
  tables beside them, so `inspect` (`/sql` in the chat) runs only in a schema of its own.
- **The layout before tenants** (no `tenant` column) migrates in place when a store opens it, in one
  transaction under a lock: its rows become the tenant `""`, keys are rebuilt to lead with it, and
  nothing is renumbered.
- **SQLite and memory stay one tenant per store,** a file per org: a file already moves and deletes
  whole, and has a single writer, the org's.

## MongoDB compatibility

The semantics are MongoDB's, and the same in every store. `stores/tests/store.test.ts` holds each
store to them two ways: "answers like MongoDB" checks MongoDB's own answers for the cases below, and
the conformance tests check every store against the reference on a wider set of queries, pages and
updates.

Processor `where` filters follow the same semantics. The owner evaluates them in JavaScript with the
reference (`runtime/mongo.ts`) on each event's `data` as it commits, with no query to any store, and
refuses at start a filter it can't evaluate.

### Collection methods

All stores support:

- **Writes:** `insertOne`, `insertMany`, `updateOne` and `updateMany` (with `upsert`), `replaceOne`
  (with `upsert`), `deleteOne`, `deleteMany`.
- **Reads:** `find` with filter, `sort`, `limit` and `skip` (also as cursor methods, and `toArray`),
  `findOne`, `countDocuments`.
- **`aggregate`** with a pipeline of `$match`, one `$group`, then `$sort`, `$skip`, `$limit`. A
  group key (`_id`) is null, a field (`"$tags.agent"`), `$substr` of one (`["$at", 0, 10]`: the
  day), or an object of them; accumulators are `$sum` (of a field's numbers, or a number per
  document), `$count`, `$avg`, `$min` and `$max` (numbers below strings, as MongoDB orders them).
  SQL stores run the match and the group as one `GROUP BY`: only the groups come back.
- **Indexes** declared on a collection (`indexes: [["at"], ["tags.tenant", "at"]]`), on fields its
  schema types as scalars (strings, numbers, booleans), so they never hold arrays: filters on them
  (equality, `$in`, comparisons with a value of the field's type) use the index, and so do sorts on
  them (missing first, as MongoDB orders them). SQL stores make them as partial indexes, one
  collection each, and drop ones no longer declared (Postgres: from a schema of its own; tenants
  sharing one may run another version of the app). SQLite keeps the statistics its planner needs to
  prefer them to the primary key: gathered at open when missing, and again each time the table about
  doubles; Postgres gathers its own. Until it has (a new table, or a tenant that grew fast since),
  its planner may read and sort more rows than an index would.
- **`writeConcern: { w: 0 }`** on updates, replaces and deletes: in a transaction the write goes
  with the commit, unacknowledged.

Not supported: projection, other `aggregate` stages and operators, `distinct`, `findOneAnd…`,
`bulkWrite`, `estimatedDocumentCount`, `watch` (Processors and the event feed do this job).

### Filters

All stores support:

- **Operators:** `$eq` (or a plain value), `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`,
  `$exists`, `$not`, `$and`, `$or`, `$nor`.
- **Paths:** dot paths into objects and arrays (`"o.k"`, `"tags.0"`).
- **`$in` lists** of one scalar type go to SQL as one parameter (a JSON array: SQLite `json_each`,
  Postgres `jsonb_array_elements`), so a statement is the same whatever their length; `null` and
  objects in them go one by one. On an indexed field the index serves them.

With MongoDB's semantics:

- **Equality** is type-strict (`1` isn't `"1"`), and also matches an element of an array.
- **null** matches null and a missing field; `$ne: null` means "present and not null".
- **Comparisons** only match values of the operand's type: numbers with numbers, strings with
  strings. Null and missing fields never compare with them.
- **Arrays** match a comparison when one of their elements does. Each condition may be met by a
  different element: `{ scores: { $gt: 4, $lt: 5 } }` matches `[3, 9]`, as in MongoDB.
- **`$gte: null`** and **`$lte: null`** match null and missing; `$gt: null` and `$lt: null` match
  nothing.

Not supported: `$regex`, `$elemMatch`, `$all`, `$size`, `$type`, `$mod`, `$expr`, `$text`, `$where`,
geospatial and bitwise operators. A filter using one fails in every store.

### Sorting

- **Order across types** is MongoDB's: null and missing first (as equals), then numbers, strings,
  objects, arrays, booleans.
- **Within a type:** numbers by value, strings by code point, `false` before `true`.
- **Ties** keep insertion order in every store. MongoDB leaves ties unordered, so this only makes
  results deterministic.

### Updates

All stores support:

- `$set`, `$unset`, `$inc`, `$push` (with `$each`), `$addToSet`, `$pull` (with a value or a
  condition);
- replacement documents;
- upserts, which start from the filter's equality fields.

How each store runs them:

|                                                                                                 | memory     | sqlite                                               | postgres                                             |
| ----------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Top-level fields: `$set`, `$unset`, `$inc`, `$push`; `$addToSet` and `$pull` with a plain value | JavaScript | Read, apply in JavaScript, write, in its transaction | One SQL statement                                    |
| Nested paths; `$pull` with a condition; `$addToSet` with an object                              | JavaScript | Same                                                 | Read, apply in JavaScript, write, in its transaction |

Not supported: `$min`, `$max`, `$mul`, `$rename`, `$currentDate`, `$setOnInsert`, `$pop`,
`$pullAll`, the `$push` modifiers other than `$each`, the positional `$`, `arrayFilters`.

### Known differences

- **Equality with a whole embedded document:** key order matters in memory and SQLite, as in
  MongoDB. It doesn't in PostgreSQL, whose `jsonb` doesn't keep key order. The owner doesn't cache
  these queries.
- **Sorting by objects or arrays:** they keep insertion order among themselves. MongoDB compares
  objects field by field, and sorts arrays by their smallest element (largest, descending).
- **Comparison operands** are numbers, strings or null. Dates are ISO strings, so they compare as
  strings. Booleans, objects and arrays as operands fail.
- **Values are JSON:** numbers are doubles, with no int, long or decimal; `_id` is always a string.
- **Strings beyond U+FFFF** sort by UTF-16 code unit in memory and by code point in SQL. The orders
  differ only against characters from U+E000 to U+FFFF.

## Vectors

A collection declares its vector fields: `defineCollection({ schema, vectors: ["embedding"] })`.
They are written like any field (`insertOne({ text, embedding })`, `$set`, `$unset`, a replacement)
and kept as the store's vectors, never in the document, so reads, the owner's cache and prompts
don't carry them. A deleted document takes its vectors with it.

`collection.nearest(vector, { filter, limit, field })` returns the documents matching `filter` whose
vector is nearest, best first, each with its cosine similarity as `_score`; ties keep insertion
order, and vectors of another length don't take part.

|           | memory            | sqlite                            | postgres                                                                             |
| --------- | ----------------- | --------------------------------- | ------------------------------------------------------------------------------------ |
| Stored as | JavaScript arrays | JSON text                         | pgvector's `vector` (PGlite loads it; a server needs it installed), else `jsonb`     |
| `nearest` | JavaScript        | filter in SQL, rank in JavaScript | filter and rank in one SQL statement (`<=>`), or rank in JavaScript without pgvector |

## Commits

Each owner commit is one store transaction. Some go in as one statement:

- **Postgres:** writes and events go in as one fenced statement when no write depends on another's
  effect. Each collection must get either inserts, or one update, replace or delete; each edge, one
  link or unlink.
- **In a transaction:** inserts are held back and go in with the transaction's next statement, or
  with its commit.

A chat turn is three statements; an agent asking another agent, six (`deno task bench`).
