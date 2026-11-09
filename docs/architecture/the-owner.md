---
title: "The owner"
description: "One owner holds the store and commits every write; executors run plugin code; the rules apply at every op; and 2 caches keep reads cheap without ever going stale."
section: Architecture
order: 2
---

# The owner

One owner holds the store and commits every write. Plugin code runs elsewhere, in executors, and
reaches the store only through the owner.

## The owner and its executors

A runtime is one owner and its executors, joined by Oxian.

- **The owner** is the only holder of its store. It commits every write and numbers the events. It
  sends committed events and live frames to subscribers, runs Processors from their cursors, and
  keeps the timers.
- **Executors** run plugin code: Actions, Processor deliveries, queries, and Views rendered once.
  They hold no store. Each read or write is an op they send to the owner, and live frames ride the
  job's output stream back to it.

Oxian takes a stream in chunks of at most 1 MiB, so a line longer than that goes in parts: a long
history, a prompt with pictures. What's meant to be large never goes in an answer at all. Host code
reads a file's content from the owner in parts, with `runtime.bytes`.

By default the owner and one executor share a process. They can also run apart, as
[Topology and runtimes](topology.md) shows. The code is the same either way.

## The store and its 5 kinds of data

The store keeps 5 kinds of data, and nothing else. That's the whole storage port, in
`runtime/store.ts`.

| Kind    | What it holds                                                        |
| ------- | -------------------------------------------------------------------- |
| events  | the log: every change and Action call, in order, each with its actor |
| nodes   | documents, by collection and `_id`                                   |
| edges   | directed relations between documents                                 |
| vectors | embeddings, one per document and field, for `nearest`                |
| blobs   | large values, kept once by the hash of their content                 |

The SQL stores keep these as 5 tables, plus `meta` for the fencing epoch and the Processors'
positions. Each collection is also a SQL view, so `SELECT * FROM booking` works in any client while
the app runs. [Stores](../operations/stores.md) has the details for each store.

Plugin code speaks MongoDB's collection API: `insertOne`, `find`, `updateOne` with `$set`, and the
usual filter and update operators. The runtime turns each call into one store op. The memory store
runs it in JavaScript, and it's the reference. The SQL stores translate it to SQL, and one
conformance suite holds all of them to the same results.

By default, a string over 16 KiB becomes a blob, and the document keeps a reference in its place.
The owner moves blobs out on write and back in on read. A read's `projection` applies before any
blob loads, so a file's metadata costs no read of its content.

Collections can say how they're kept:

- **`records: true`** is a ledger. Documents are appended, never changed, and are their own record,
  with no events. `ctx.record` appends one from any job, and it rides the job's next write.
- **`durable: false`** lives in the owner's memory, not the store, with no events. Chat's live text
  is one. It goes in the commit that writes the reply it became, so a screen never shows both.
- **`private: ["token"]`** keeps fields out of every event and every outside read.

## One writer, and its transactions

The store has one writer at a time. Each write commits on its own, as one short transaction. A
request of several writes runs as the store's single command when it can: the fence check, the
writes, their events and their blobs in one round trip.

`ctx.transaction(tx => …)` makes several writes and their events atomic. The executor sends the
transaction's ops as the code makes them, and the owner holds the store's transaction open for that
job until it ends. So plugin code keeps slow work, such as a model call, outside its transactions.

- **An op that fails ends the transaction.** It rolls back at once, and its later ops fail with "The
  transaction is closed.", even when the code caught the error. A write the rules refuse counts:
  before 1.0.0-rc.31 it left the transaction open, holding the writer, and every write in the app
  waited.
- **An idle transaction rolls back.** One with no op for 5 seconds is rolled back, so a stuck
  executor can't hold the writer for long.
- **Each one is measured.** `copilotz.transaction.duration` records how long it held the writer, by
  outcome: `commit`, `abort`, `idle` or `error`. See [Metrics](../operations/metrics.md).

A new owner claims the store with `open`, which moves its fencing epoch. From then on, an old
owner's commits fail with `fenced`, so 2 owners never write one store.

## The rules, at every op

The owner applies the rules to every op an actor's work makes, whoever sent it. A plugin declares a
rule as its `guard`. For an actor and a collection, it returns the filter the documents must match.
When several plugins have one, all of them apply.

| Op                         | What the rule does                                                 |
| -------------------------- | ------------------------------------------------------------------ |
| `find`, `findOne`, `count` | the op's filter and the rule's both apply                          |
| `aggregate`                | the rule's filter goes first, as a `$match`                        |
| `nearest`                  | the rule's filter joins the search's                               |
| `insert`                   | each document must match, or the op is refused                     |
| `update`, `replace`        | they reach only what matches, and what they leave must still match |
| `delete`                   | it reaches only what matches                                       |

The system passes every rule, and so do the runtime's own `sys.` collections. A collection no rule
speaks for is unchecked for plugin code, and closed to callers from outside: REST and the socket
reach a collection directly only where a rule speaks for it.

Rules see the whole actor, `in` included. The access plugin declares them for the collections it
shares, and that's where an agent's reach is narrowed to where it works. It also declares labels:
the owner keeps what each job read, and a document the job then writes carries the spaces it drew
on, so nothing reaches eyes that couldn't see where it came from.

What an outsider reads comes without the collection's private fields. Actions and Processors acting
for them still read them.

## Acting as someone else

Trusted code can act as someone other than its actor, and it's always on the record.

- **`ctx.as(person)`** acts as that person. A webhook mapping a phone number to its person does
  this.
- **`ctx.as()`** acts as the system, which no rule restricts.
- **`ctx.as(grant("hand-over"))`** acts as the system for one named reason. Copilotz's own grants
  are `chat.hand-over`, `chat.hand-back` and `web.budget`.

Each of these records `via`, the actor whose work it was, and stays where that work is unless it
says otherwise. The owner counts every op made as the system on someone's behalf in
`copilotz.elevated.ops`, by grant. The model never holds a grant: code decides when to use one, and
what leaves it.

## The owner's cache

The owner is the only writer, so every change passes through it, and what it caches is never stale.
It caches documents by `_id`, filled by reads and by every committed write. It also caches query
results: `find` with a filter, sort and limit, and `count`.

Each commit updates the cached results with the reference semantics, the ones the conformance suite
holds every store to. When a change can't be applied exactly, the query is dropped, and the next
read fetches it again. That happens when a sort key changed, a limited result lost a member, or a
document newly matched among ties.

- **Not cached:** queries with `skip`, queries that compare whole objects or arrays, and reads
  inside a transaction, which see the transaction's own writes.
- **Fresh:** a read that raced a commit to its collection doesn't fill the cache. A transaction's
  changes reach the cache once it commits, before its events go out.
- **Maintenance SQL** changes what the cache can't follow, so the owner empties it after a statement
  commits.

`runtime/tests/cache.test.ts` checks every cached query against a direct store read after each of
900 random writes, on every store. `createRuntime({ cache: false })` turns the cache off, and
`runtime.stats()` counts `hits` and `misses`.

## Kept reach

The rules run on every op, and much of what they work out changes rarely: who's a member of what. So
the owner keeps what rules work out, in `runtime/kept.ts`.

A rule asks for an answer with `ctx.kept(key, work)`. The owner runs `work` once and keeps its
answer with what it read: each read's collection and filter. It lets the answer go when a commit
changes a document one of those reads matched, before or after the change. That's exactly when the
answer could have changed.

- **Keyed by who, for whom and where.** The access plugin keeps reach under that key. It keeps an
  agent's memberships and its person's reach apart, so each is worked out once for every place the
  agent works.
- **Nested.** An agent's reach asks for its person's, and reads what that one read. So a change to
  the person's memberships lets both go.
- **Followed.** A View observed for an actor reads what its rules read, kept or not. When someone is
  let in, their screen shows it at once.
- **Bounded.** The owner keeps 1,000 answers, and the least recently used go past that. Maintenance
  SQL lets everything go, and `cache: false` keeps nothing.

An agent's turn works out its reach once, not on every op. On `examples/work-bench.ts`, with 1,000
spaces of 50 notes on SQLite, an agent's turn of 13 ops for Ana took 21.5 ms at the median before
1.0.0-rc.32 and 4.4 ms after. Ana's own took 11.7 ms before and 4.7 ms after. The full table is in
[the work design](../../design/work.md).
