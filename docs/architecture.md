---
title: "Architecture"
description: "How Copilotz works underneath: one contract for every caller, one owner that writes, and the promises the runtime keeps whichever way a call comes in."
section: Architecture
order: 1
---

# Architecture

Copilotz is a runtime with one contract. A web page, the terminal, a script, ChatGPT over MCP and
your own agents all call the app the same way, and the runtime checks them the same way.

This page is the contract, a call from end to end, the runtime's promises and its layers. The pages
under it go one level down. For every name and option, see the [reference](reference.md).

## The one contract

The runtime knows 5 things about every call.

- **Who, for whom, where.** All work runs as an actor. It says who acts, for whom an agent works
  (`for`) and where the work is (`in`). The runtime carries the actor into everything the work
  causes: nested calls, tools, the Processors its events wake, its timers and the Views observed for
  it. Without an actor, the system acts.
- **Actions** are what can be done, by name, with a JSON Schema input. An Action's `allow` says who
  may call it, and the runtime asks it wherever someone calls: from outside, and from code acting
  for someone, such as a tool's `ctx.call`. For an agent, it asks for the agent and for its person.
- **Views** are what anyone sees. A View turns data into what one place shows: React in a browser,
  Ink in a terminal, text in a model's prompt. Observed, it runs again when what it read changes.
- **Rules at the data.** A plugin's `guard` gives, for an actor and a collection, the filter its
  documents must match. The owner applies it to every read and write the actor's work makes,
  whichever door the work came in by.
- **The record.** Every write records events in the same commit, each naming its actor, for whom and
  where. The log is the audit trail.

Here is one actor, as the log keeps it. It's the agent from the README's salon, booking a slot for
Ana in her own space:

```json
{
  "kind": "agent",
  "id": "concierge",
  "for": { "kind": "person", "id": "ana" },
  "in": "personal:ana",
  "via": { "kind": "person", "id": "ana" }
}
```

`in` is opaque to the runtime, as `id` is. It carries it and records it, and a plugin gives it
meaning. With the access plugin, `in` is a space, and an agent's work for a person reaches only what
the person reaches, within the agent's own memberships, in that space and what it draws on. In the
person's own Personal space, that's everything they reach, and what its agents do there for them is
theirs, wherever it goes: their chief of staff. The decisions behind this are in
[the work design](../design/work.md).

## One call, end to end

A call goes through the same steps whatever door it came in by.

```text
a page · the terminal · REST · MCP · WhatsApp · a turn of your agent
     │  1. the door says who, for whom, where
     ▼
allow(actor, input) ─── 2. asked of the actor, and of its person
     │
     ▼
executor: the Action's code ─── 3. every read and write is an op sent to the owner
     │
     ▼
owner: the rules (guard) ─► one writer ─► store ─── 4. writes and their events, one commit
     │
     ▼
cache and kept reach ─► subscribers ─► Processors ─► observed Views ─── 5. the commit goes out
```

1. **The door says who.** Plugins' `who` turns a request's credential into an actor: a session's
   cookie, a developer key. A line (MCP, WhatsApp, a site's chat) makes a stranger a contact. Each
   door also says where the work is.
2. **`allow` is asked.** An actor calls only an Action whose `allow` lets them in. A key also calls
   only what its scope lists.
3. **An executor runs the code.** Actions, Processor deliveries and queries run in executors, which
   hold no store. Each read or write is an op they send to the owner, as the actor.
4. **The owner applies the rules and commits.** It narrows each read to what the actor reaches and
   checks each write against it. Then it commits the writes with their events, one writer at a time.
5. **The commit goes out.** The owner updates its cache and lets go of the reach it kept that the
   commit changed. Then subscribers get the events, Processors handle them, and observed Views that
   read what changed run again.

## The pages

- [The owner](architecture/the-owner.md): the owner and its executors, the store and its 5 kinds of
  data, one writer and its transactions, the rules at every op, and the 2 caches.
- [Events, Processors and schedules](architecture/events.md): what the record holds, how Processors
  react to it, and time as a caller.
- [Views](architecture/views.md): rendering once, observing, parts, and Views for an actor.
- [The ways in](architecture/transports.md): the browser's socket, REST and the client, MCP, and the
  other doors.
- [Topology and runtimes](architecture/topology.md): where the owner, executors, workers and
  browsers run, what a turn costs, and the runtimes Copilotz runs on.

## The promises

The runtime keeps these whatever the plugins do.

1. **A fenced owner can't commit.** An owner claims its store by moving the store's epoch, and every
   commit checks it. An old owner that's still running fails with `fenced`.
2. **An event commits with the writes that caused it,** or neither commits.
3. **An op that fails ends its transaction.** It rolls back, and nothing after it in that
   transaction commits, even when the code caught the error. A write the rules refuse is such an op.
4. **Outside effects run outside the writer.** Their results are written with ids derived from their
   cause, so a retry rewrites instead of duplicating.
5. **Processors resume from their cursors.** A cursor never passes an event its Processor hasn't
   finished, so each event is delivered at least once.
6. **Every op an actor's work makes passes the rules.** Only the system passes by, and trusted code
   acting as the system is on the record as such, `via` whose work it was.
7. **`allow` is asked wherever an actor calls,** and for an agent, for its person too. An agent
   never calls an Action its person couldn't.
8. **What the owner keeps is never stale.** Each commit updates its cache and lets go of the kept
   answers it changed before anything reacting to that commit reads.

With the access plugin, one more holds: **an agent's work for someone reaches at most what they
reach,** within the agent's memberships, where it works and what that place draws on.

## The layers

An app is a list of plugins over a runtime, run by a host. Each layer imports only what it may, and
`testing/boundaries.test.ts` fails otherwise.

| Layer                    | What it is                                                    | What it imports                                                                 |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| The runtime              | the engine, its contract and its ports                        | nothing outside it                                                              |
| Stores and exporters     | where the runtime keeps things, and where its measurements go | the runtime                                                                     |
| Hosts                    | the places the app runs in: the browser, the terminal         | the runtime's public API                                                        |
| Plugins                  | the features, Copilotz's and yours                            | the runtime, the hosts' toolkits, their own files, other plugins' `contract.ts` |
| Tests, examples and apps | what composes the layers                                      | anything                                                                        |

The runtime knows only its primitives: collections, Actions, Processors, Views, resources and
adapters, plus routes and `who` for HTTP. It never knows what a plugin is for.

Plugins merge in order. Two collections, Actions or Processors of one name are a mistake. Resources
and schedules are configuration, and a later plugin patches an earlier one's entries as a JSON Merge
Patch: objects merge, `null` removes, and anything else replaces. A later View, adapter or route
replaces an earlier one of its name. Then each plugin's startup check reads the merged result.

The layout and the import rules in full are in [CONTRIBUTING.md](../CONTRIBUTING.md).
