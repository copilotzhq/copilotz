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
| `postgres` | `sql/postgres/` | Ominipg: a PostgreSQL server for a `postgres://` URL, or PGlite in this process for `:memory:` and files. One schema per owner, so one tenant dumps and moves as a unit.                                    |
| `latency`  | `latency/`      | Wraps any store and adds a delay per database round trip, to see what a turn costs at production latency (`--rtt`).                                                                                         |

The SQL stores share one MongoDB-to-SQL translation (`sql/shared/filter.ts`); each brings its
dialect. Both keep five tables (`events`, `nodes` with documents as JSON, `edges`, `vectors`,
`blobs`) plus `meta` for the fencing epoch, and show every collection as a SQL view
(`SELECT * FROM message`). Read them with any client while the runtime runs
(`sqlite3 -box
.data/copilotz.sqlite`, `psql`), or with `/sql <query>` in the chat.

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
  collection each, and drop ones no longer declared. SQLite keeps the statistics its planner needs
  to prefer them to the primary key: gathered at open when missing, and again each time the table
  about doubles; Postgres gathers its own.
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
