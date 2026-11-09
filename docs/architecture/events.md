---
title: "Events, Processors and schedules"
description: "Every change is an event written in the commit that made it; Processors react to events from durable cursors; and time is one more caller of Actions."
section: Architecture
order: 3
---

# Events, Processors and schedules

Every change is an event, written in the commit that made it. Processors react to events, and timers
call Actions when they come due.

## Events

An event is an immutable fact in the owner's log.

| Field   | What it holds                                                         |
| ------- | --------------------------------------------------------------------- |
| `seq`   | its place in the log, given when it commits                           |
| `id`    | its id, which a retry finds again                                     |
| `type`  | what happened: `booking.created`, `action.completed`                  |
| `data`  | what it says, checked against its type's schema                       |
| `cause` | the event that caused it: an Action call's start, a Processor's event |
| `actor` | who did it, for whom and where. None: the system                      |
| `at`    | when                                                                  |

The actor is the whole actor, as the work ran: `for`, `in` and `via` included. So the log tells Ana
from an agent working for her, and both from a stranger's assistant, and it says where each acted.

The runtime records 3 kinds of events of its own:

- **A collection's changes:** `<collection>.created`, `.updated` and `.deleted`, with
  `{ _id, doc }`. An update also says which fields `changed` and which were `removed`. The document
  goes without the collection's private fields.
- **An Action's calls:** `action.started`, `action.completed` and `action.failed`, and
  `action.retried` when a call runs again. The call's input goes without the Action's private
  fields, and an unrecorded Action (`record: false`) leaves no events at all.
- **A Processor's trouble:** `processor.retried`, and `processor.failed` with what failed.

Maintenance SQL records `maintenance.sql`. Every other event is a plugin's, and a plugin declares it
with a schema. Emitting a type nobody declared fails, so every event is in some plugin's contract.
An event's `allow` says who may emit it from outside. Without one, only code does.

What stays off the log is what a plugin declares off it: a collection with `events: false`, a
`records` ledger (its documents are their own record), a `durable: false` collection, and private
fields.

### Ids that survive a retry

A nested call's id comes from its cause, its place among the calls made under it, and a hash of its
input. A retried job makes the same calls in the same order, so it finds the same ids. A call whose
id is already in the log answers from it instead of running again. So a retry rewrites what it wrote
instead of writing it twice.

## Processors

A Processor is what happens when an event happens. It runs in an executor, as the actor of the event
it handles, and so where that event's work was.

```ts
processors: {
  "booking.confirm": {
    on: "booking.created",
    where: { "doc.status": "pending" },
    key: (event) => String(event.data._id),
    run: async (ctx, event) => { /* … */ },
  },
},
```

- **`on`** names the event types it handles, or every type.
- **`where`** is a MongoDB filter on the event's data. The owner skips the events that don't match,
  before it sends any work.
- **`key`** puts events in lanes. Events with the same key run in order, and different keys run at
  once. Without a key, each event is its own lane.

The owner keeps a durable cursor for each Processor: the last event it finished. The cursor never
moves past an event still being handled, and the owner saves it with its commits. When an owner
starts, each Processor resumes from its cursor, reading the log back in batches.

Delivery is at least once. A delivery that fails is tried 3 times in all, a little longer apart each
time, and each try is on the record as `processor.retried`. The last failure records
`processor.failed`, with the event and the error, so another Processor can answer for it. A delivery
that runs again knows it (`ctx.retry`). Since work's ids come from its cause, running again rewrites
instead of duplicating.

An owner that closes gives running deliveries 5 seconds to finish. One that doesn't finish keeps its
cursor before its event, so the next owner delivers it again.

## Timers and schedules

Time is a caller too. A timer calls an Action with an input when it comes due: once (`at`), by a
cron expression in a timezone, or every so long.

- **A plugin declares recurring ones** as `schedules`, and later plugins patch them like resources.
- **Code sets its own** at run time with `ctx.schedule(action, input, when)`, and stops one with
  `ctx.unschedule`. Scheduling the same id again replaces it.

Every timer is a document in `sys.timers`, written in the commit of whatever set it. The owner keeps
one clock, armed for the earliest. When it rings, the owner claims what's due in a commit. It moves
each recurring timer to its next time, and calls each occurrence's Action with the occurrence's id.
So the log keeps an occurrence once, however often it's called. A failed occurrence tries again
later as the same occurrence: a declared schedule retries 2 times by default, after 10 s, 30 s and
so on. An Action called by time reads its timer and when it was due in `ctx.scheduled`.

A timer runs as whoever set it, where they were: the timer keeps the actor, `in` included. A
declared schedule runs as the system. Copilotz's routines run as the person who made them, in the
routine's space, wherever their timer was set from. So a routine reaches only what its maker's work
reaches there.
