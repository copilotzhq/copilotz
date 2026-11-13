---
title: "The ways in"
description: "Every way into an app says who the caller is and where they work, then reaches the same Actions, Views and rules: the browser's socket, the REST API and its client, MCP, and the other doors."
section: Architecture
order: 5
---

# The ways in

Every way in says who the caller is and where they work. From there, every caller reaches the same
Actions, Views and rules.

| Way in                  | Who, for whom                                | Where (`in`)                                 |
| ----------------------- | -------------------------------------------- | -------------------------------------------- |
| The web                 | the person                                   | the page's space, which each call says       |
| A chat's turn           | its agent, for whoever started it            | the chat's space                             |
| WhatsApp                | the customer (a contact), or a linked person | the number's space, or the one they write in |
| Voice                   | the caller (a contact), and its agent for it | the line's space                             |
| A web line, an MCP line | the visitor or conversation (a contact)      | the line's space                             |
| A developer key         | its person, through it                       | the key's space                              |
| The terminal            | its person                                   | where they work (`/space`, `/work`)          |
| A routine               | its maker                                    | the routine's space                          |

## HTTP is the runtime's

`runtime.fetch` takes a web-standard `Request` and answers a `Response`, for every request the app
gets. A host only calls it: `Deno.serve(runtime.fetch)`, `listen(runtime.fetch)` on Node and Bun, or
`export default { fetch: runtime.fetch }` on Cloudflare Workers. Tests need no listener at all.

The runtime answers its own paths, then plugins' routes:

- `POST /connect` gives the page a one-time ticket for its socket.
- `/oxian` is the socket, for browsers, remote executors and plugins' workers.
- `/api/` is the REST API.
- Plugins' `routes` are plain functions by URL pattern: a webhook, a sign-in, a download.
- `GET /health` answers `ok` when no route takes it.

Who a request is comes from plugins' `who`, asked in plugin order. The first that answers wins:
identity reads the session cookie, the api plugin a `Authorization: Bearer` key, a site chat its
visitor's cookie. When none answers, the caller is anonymous, `{ kind: "anonymous", id: "" }`. No
request is ever the system. A request that may change something, sent by a page of another site
without an `Authorization` header, is refused with a 403.

## The browser's socket

A browser connects to the owner over Oxian, as an untrusted worker bound to one actor.

1. The page posts its cookie to `POST /connect` and gets a one-time ticket, good for a minute.
2. It presents the ticket on `/oxian`, and the runtime turns it back into the actor.
3. From then on, every read, call, write and event it sends is that actor's.

A browser asks for reads, which the owner watches, Actions, declared events, and writes to a
collection where a rule speaks for them. A read of a collection goes direct only where a rule speaks
for it. Anything else goes through a named query whose `allow` lets the person in. Its Views run in
the browser, and their reads go over the socket, as [Views](views.md) shows.

**Each call says where its page is.** A call, an event or a write carries `in`, the space the page
shows, and the client says it with `client.call(action, input, { in })`. It's said, never proved. So
it's what the work is recorded with, and what an agent's work there is narrowed to. A person's own
reach isn't narrowed by it: they reach what they reach from any page.

A browser holds little. Each actor has 16 browsers at most, and each connection watches 512 reads at
most. A contact holds less: 2 browsers, 32 reads each, and caps by network and by line, so people
always find room.

## REST and the client

The REST API at `/api/` is the same contract over plain HTTP:

- `GET`, `POST`, `PATCH`, `PUT` and `DELETE` on `/api/collections/<name>`, for collections a rule
  speaks for;
- `POST /api/actions/<name>`, whose `Idempotency-Key` header is the call's id, so a call sent again
  answers what the first did;
- `/api/queries/<collection>.<query>`, `/api/views/<name>` and `POST /api/events/<type>`;
- `GET /api/events`, what commits, of what the caller may see;
- `GET /api/`, what this caller may use.

Any `GET` with `Accept: text/event-stream` becomes a watch: its result, then a new one after each
commit that changes it. A stream asks `who` again every 20 seconds, so a revoked key ends it.

A developer key is its person, with the key's id and a `scope` that lists exactly what it may use.
Its `in` is the key's own space, and it reaches what its membership there and its person both reach.
The runtime checks the scope only where a call comes in, never inside the work it starts.

Since 1.0.0-rc.32, a key can't call what only its person decides. Those Actions say `inPerson`,
which never lets in a key, an agent or a routine's work: `space.create`, `member.set`, invitations,
`chat.move`, `agent.create` and the rest. Listing one in a key's scope changes nothing.

`connect(url, { key })` is the client for scripts. It joins over the socket with a ticket, or over
the REST API with `over: "http"`, and the rest of the script is the same either way. Its collections
are spelled as plugin code's: `find`, `updateOne`, a named `query`, and `watch`. See
[the REST API and the client](../guides/rest-and-the-client.md).

## MCP

The mcp plugin makes an MCP server of each line an app declares in `resources.mcp`, at
`POST /mcp/<name>`. It speaks Streamable HTTP and JSON-RPC 2.0, with no session.

- **A conversation is a contact,** in a chat of its own in the line's space. ChatGPT names its
  conversation in every call, and a client that names none is given a handle. The contact's id comes
  from these through an HMAC with the app's `links` secret, so a stranger can't work out another's.
- **A call runs the tool through chat's runner,** as that contact, where its chat is. The tool's
  `ctx.in` is the line's space. Every Action it calls asks its `allow` of the contact, so an Action
  that says `people` refuses it, and one that says `peopleOrContacts` lets it in.
- **What the model reads is the tool's View,** `tool:<name>`, the same one the app's own agents
  read. A line that lists a tool without its View stops the app from starting.
- **Widgets** draw a tool's calls with one of the app's web Views, inside the assistant, through MCP
  Apps and ChatGPT's Apps SDK. The widget's reads are answered as the conversation's contact.

MCP has no sign-in yet, so anyone may call a line, and every caller is a contact. The
[mcp plugin's page](../reference/plugins/mcp.md) lists its settings and limits.

## More doors

WhatsApp, voice and web lines work like an MCP line. Each makes a stranger a contact, in the line's
space, and their messages reach the line's agents through chat. A contact is never a person: every
Action and query stays shut to it unless its `allow` says otherwise. `chat.send` and `chat.attach`
let in people and contacts writing as themselves, never an agent.

The terminal is a person at a keyboard. Its host observes the terminal shell's View as that person,
where they work, and its commands call Actions as them.
