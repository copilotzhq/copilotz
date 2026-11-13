---
title: "The REST API and the client"
description: "Every app answers a REST API at /api/, checked as the socket is, and connect is its client for scripts: the endpoint list, developer keys, and the client's collections."
section: Guides
order: 4
---

# The REST API and the client

Every app answers a REST API at `/api/`, and `connect` is its client for scripts. Both go through
the same Actions and rules as the app's own page.

## Who calls

The runtime answers `/api/` itself, for whoever plugins' `who` say a request is:

- a developer key's person, with the key's scope;
- a session from the app's own page;
- anonymous, where an `allow` lets it.

Everything is checked as it is over the socket: each Action's and query's `allow`, the caller's
scope, and the rules.

## The endpoints

```
GET    /api/collections/<name>?filter=<json>&sort=<json>&limit=&skip=   find (&count=true: how many)
GET    /api/collections/<name>/<id>                                      findOne
POST   /api/collections/<name>                                           insert
PATCH  /api/collections/<name>/<id>    an update document, or the fields to set ($set)
PUT    /api/collections/<name>/<id>    replace           DELETE /api/collections/<name>/<id>
POST   /api/actions/<name>             call (Idempotency-Key: the call's id, the caller's own)
GET    /api/queries/<c>.<q>?params=<json>, or POST with the params as the body
GET    /api/views/<name>?item=<json>   a View, rendered by the runtime
POST   /api/events/<type>              emit (a scoped caller emits nothing)
GET    /api/events                     what happens, of what the caller reaches
GET    /api/                           the reference: what this caller may use
any GET with Accept: text/event-stream: the result, then each new result after a commit
```

`PATCH`, `PUT` and `DELETE` also work on the collection itself, with `?filter=<json>` in place of an
id. They then change the first document that matches, and `?upsert=true` inserts one when none does.

An `Idempotency-Key` on an Action call is the call's id. Sent again, the call answers what the first
did, without doing it twice.

## What an outsider may touch

A collection reaches an outsider only where a rule speaks for it. For writes, that's a rule asked
about writes. `sys.*` collections never do.

Private fields are never returned, filtered by or written.

Every write is the caller's own. The owner's guard keeps it within their reach, the schema checks
it, and it's recorded as its events.

Plugins' collections that only their Actions may change say so in their rules. Spaces and
memberships, sessions, keys, messages, routines and computers are some of them.

## Errors

Errors are `{ error: { code, message } }`, with the status their code says. A credential that proves
nobody gets a 401.

## Keys

The `api` plugin gives people developer keys. A person makes a key in a space, for the Actions,
queries, Views and collections it may use there. That's its scope, and every key has one.

Code then calls the REST API or the socket with it, as `Authorization: Bearer <key>`. It acts as
that person, in that space only. Its work is there (`in`), and the record says which key did it
(`actor.key`).

A key is a member of its space, `key:<id>`. The space's managers see and revoke it there.

A key reaches only its space, even an admin's. So it names that space (`in`) where an Action takes
one.

A browser on another site may call the API with a key, since a key is a header no page sends by
itself. With a session's cookie, only the app's own page can call it.

The runtime checks a key's scope where its call comes in. An Action's `allow` is asked at every call
the work makes after that. So code a key sets going calls only what the key could, unless it goes
beyond on purpose, as a named grant (`ctx.as(grant("…"))`).

## What a key can't call

A key is its person, so an Action that lets people in (`people`) lets their key in too. What only
the person decides is `inPerson`, and that never lets a key in, even when its scope lists it. Since
1.0.0-rc.32, that's these Actions:

| Plugin      | Actions                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`  | `session.end`                                                                                                                                                                                                                     |
| `spaces`    | `space.create`, `space.leave`, `member.set`, `member.remove`, `invitation.send`, `invitation.accept`, `invitation.decline`, `request.grant`, `request.deny`, `org.role`, `org.remove`, `org.invite`, `org.uninvite`, `org.rename` |
| `contacts`  | `contact.forget`                                                                                                                                                                                                                  |
| `accounts`  | `account.connect`, `account.complete`, `account.callback`, `account.disconnect`, `modelKey.set`, `modelKey.remove`                                                                                                                |
| `api`       | `api_key.create`, `api_key.revoke`                                                                                                                                                                                                |
| `chat`      | `chat.move`, `chat.approve`, `chat.forgetGrant`                                                                                                                                                                                   |
| `memory`    | `memory.move`                                                                                                                                                                                                                     |
| `team`      | `agent.create`, `agent.update`, `agent.delete`                                                                                                                                                                                    |
| `tiers`     | `tiers.choose`, `tiers.pick`                                                                                                                                                                                                      |
| `credits`   | `billing.setPlan`, `billing.grant`, `billing.waive`, `billing.pay`, `billing.budget`, `billing.redeem`                                                                                                                            |
| `stripe`    | `billing.checkout`, `billing.portal`                                                                                                                                                                                              |
| `computers` | `computer.code`, `computer.work`, `computer.allowOrigin`                                                                                                                                                                          |
| `voice`     | `voice.block`, `voice.unblock`                                                                                                                                                                                                    |
| `whatsapp`  | `whatsapp.connect`, `whatsapp.credentials`, `whatsapp.set`, `whatsapp.move`, `whatsapp.link`, `whatsapp.unlink`, `whatsapp.block`, `whatsapp.disconnect`, `whatsapp.webhook`                                                      |

A key can't list keys either: the `api_key.mine` query is `inPerson` too. The person does these
themselves, on the app's page or in its terminal.

Each plugin's [reference page](../reference/plugins.md) says who may call each of its Actions.

## The client

The client, `connect` from `copilotz`, is spelled like plugin code's `ctx.db.collection`. It works
over the socket or over HTTP, and only how `app` is made differs:

```ts
import { connect } from "copilotz";

const app = await connect("https://app.example.com", { key: env.APP_KEY }); // the socket
// const app = await connect("https://app.example.com", { key: env.APP_KEY, over: "http" });

const open = await app.db.collection("booking").find({ status: "open" }).toArray();
await app.db.collection("booking").updateOne({ _id: "42" }, { $set: { note: "janela" } });
await app.call("booking.cancel", { id: "42" });
const stop = app.db.collection("booking").watch({ status: "open" }, (rows) => show(rows));
```

`connect(url, { key, over })` takes an org's address too, such as `https://app.example.com/o/acme`.

Over the socket, it asks `/connect` for a ticket, with the key as its `Authorization`. Each line is
then a frame, and watches are pushed. Over HTTP, each line is a request, and a watch is a
server-sent stream.

Its collections have `find` (then `.toArray()`), `findOne`, `countDocuments`, `insertOne`,
`updateOne`, `replaceOne`, `deleteOne`, a named `query`, and `watch(filter, options?, onChange)`.

`app.call(action, input, { id })` gives a call an id of its own. Sent again, it answers what the
first did. Over the socket, `{ in }` says where the call is, as a page's space does. A key's calls
are in its own space.

## In Build Compass

[Chapter 33](../build-compass/part-11-other-ways-in/33-the-rest-api.md) moves a card from a script
over the REST API, and [Chapter 34](../build-compass/part-11-other-ways-in/34-the-client.md) watches
the board with the client.
