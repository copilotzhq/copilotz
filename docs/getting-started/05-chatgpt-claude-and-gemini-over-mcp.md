---
title: "Chapter 5: ChatGPT, Claude and Gemini, over MCP"
description: "The concierge's tools, opened to assistants outside at /mcp/salon. Each conversation is a contact with a chat of its own at the desk, under the same rules, and Sam's tab shows what they book."
section: Getting Started
order: 50
status: stable
---

# Chapter 5: ChatGPT, Claude and Gemini, over MCP

> Part 2, the ways in · Requires: Chapter 4 · Code: `chapter-5`

## The pain

Your customers already ask ChatGPT, Claude and Gemini to plan their week. To be found there, the
usual path is a separate integration per assistant, each with its own copy of "what's free" and
"book it". That's the third copy of the booking logic, and the least watched.

## The problem

Assistants reach tools over MCP, the Model Context Protocol. The salon already has tools: the
concierge's. An assistant outside should get those same tools, run the same way, under the same
rules. Each conversation should reach its own bookings and nobody else's. And the desk should see
what was booked, and by which way in.

## The solution

Copilotz's `mcp` plugin turns a few lines of settings into an MCP server.

### The server

`app.ts` adds `mcp` to the plugins, and declares a server, `salon`, in the salon's settings:

```ts
links: settings.links,
// An MCP server at /mcp/salon, for ChatGPT, Claude, Gemini, any MCP client. No sign-in yet:
// each conversation is a contact, in a chat of its own at the desk.
mcp: {
  salon: {
    in: DESK,
    // Who calls, as its chats show it.
    client: "Assistant",
    title: "The salon",
    instructions: "Book the salon's slots for the person you're helping.",
    tools: {
      list_slots: { annotations: { readOnly: true } },
      book: {},
      my_bookings: { annotations: { readOnly: true } },
      cancel_booking: {},
    },
  },
},
```

- **`POST /mcp/salon`** is the server: MCP's Streamable HTTP, one JSON-RPC message a request.
- **`in`** is its space, the desk. Its conversations' chats are there, and so are their calls.
- **Only the tools it lists** are offered, each with its `tool:<name>` View: what the concierge
  reads after a call is what the assistant's model reads. A tool listed without one stops the app
  from starting, so nothing is offered that a model can't read back.
- **`links`** is where the app is, and a secret of 32 bytes or more. Conversations' ids are made
  from it. Nothing maps them, and a stranger can't work out another's.

`plugins()` now needs `links`. `server.ts` passes them from the environment, with a new secret each
start unless `SALON_SECRET` says otherwise:

```ts
const port = Number(process.env.PORT ?? 8080);
const origin = process.env.SALON_ORIGIN ?? `http://127.0.0.1:${port}`;
// What MCP's ids are sealed with: 32 bytes or more. A new one each start, unless set.
const secret = process.env.SALON_SECRET || randomBytes(32).toString("hex");
const local = new URL(origin).hostname === "127.0.0.1";
```

```ts
...plugins({ openai: process.env.OPENAI_API_KEY, links: { origin, secret } }),
...(local ? [devSignIn] : []),
```

`devSignIn` signs in anyone on this machine by name. With a public origin it would let in anyone a
tunnel forwards, so Copilotz won't start with both, and the server leaves it out.

### A conversation is a contact

There is no sign-in over MCP yet. The salon doesn't know who is behind a conversation, so it doesn't
pretend to. Each conversation is a **contact**, a customer from outside, with a chat of its own at
the desk, titled after the server's `client`, "Assistant". The rule from chapter 2 does the rest:
the conversation reaches its chat, so its bookings, and nothing else.

How a call says which conversation it's in:

- **ChatGPT** names its conversation in every call.
- **Clients that don't** (Claude Code, `curl`) are given a handle at the end of their first answer,
  `chat: …`, and pass it back as the `chat` argument. A call without one starts a new conversation.

So the desk reads "Wed 15:00, for Assistant", and the record says `contact by mcp`. Chapter 11,
coming with MCP sign-in, books for Bia herself.

### Tests, through the server's own door

`tests/ways.ts` gets its first way in: `assistant(runtime, session)`, a client that posts JSON-RPC
to `/mcp/salon` through `runtime.fetch`, naming its conversation as ChatGPT does. No port is opened.
`tests/mcp.test.ts` books from one conversation, and tries the rest from another:

```ts
const booked = await one.call("book", { slot: "wed-15" });
assert.equal(booked.text, "Booked Wed 15:00.\n\nBookings:\nWed 15:00 (wed-15), for Assistant");
// Another conversation is another contact: it reaches none of the first one's bookings.
assert.equal((await two.call("my_bookings")).text, "No bookings.");
const taken = await two.call("book", { slot: "wed-15" });
assert.ok(taken.failed);
assert.equal(taken.text, "Wed 15:00 is taken.");
```

"Wed 15:00 is taken." reaches the model word for word because it's a public failure (chapter 2). Any
other error would say only that the call failed.

A second test lists a tool, `refund`, without its View, and the salon doesn't start. Its error says
why: `offers "refund" without its tool:refund View`.

### Connecting an assistant

- **Claude Code**, on this machine, takes the address as it is:
  `claude mcp add --transport http salon http://127.0.0.1:8080/mcp/salon`.
- **ChatGPT** takes an app's MCP server in developer mode, and needs a public `https` address: a
  tunnel to this machine (`cloudflared tunnel --url http://127.0.0.1:8080`, say), with
  `SALON_ORIGIN` set to its address. Then the desk has no sign-in on this machine until chapter 10.
- **Claude** (the apps) takes it as a custom connector, at a public address too.
- **Gemini**: the consumer Gemini app takes custom remote MCP servers since mid-2026, with limits.
  It's English only, for eligible accounts, with "Keep Activity" on, and the user confirms every
  write. A booking from Gemini waits for that yes.

Widgets, in chapter 7, are ChatGPT's and Claude's only.

## Run it

Start the salon with `npm run dev`, and call the server as an MCP client would. A first booking:

```sh
curl -s http://127.0.0.1:8080/mcp/salon \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"book","arguments":{"slot":"wed-15"}}}'
```

```text
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Booked Wed 15:00.\n\nBookings:\nWed 15:00 (wed-15), for Assistant\n\nchat: b2GLrzvvXueuiUN4TeAhKA"}]}}
```

The same way, three more calls. `cancel_booking` with no handle is a new conversation, and reaches
nothing. Then `my_bookings` and `book` with the first one's handle:

```text
$ tools/call cancel_booking {"slot": "wed-15"}
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"No booking of yours at wed-15.\n\nchat: InxLlCEz5pVftRZOkqcvJg"}],"isError":true}}
$ tools/call my_bookings {"chat": "b2GLrzvvXueuiUN4TeAhKA"}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Wed 15:00 (wed-15), for Assistant"}]}}
$ tools/call book {"slot": "thu-09", "chat": "b2GLrzvvXueuiUN4TeAhKA"}
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"Booked Thu 09:00.\n\nBookings:\nWed 15:00 (wed-15), for Assistant\nThu 09:00 (thu-09), for Assistant"}]}}
```

With Sam's Bookings tab open meanwhile, both bookings appear on it as they're made, "for Assistant",
without a reload. `npm test` adds two tests:

```text
✔ an assistant books as a contact, in a chat of its own, and sees only its bookings (93.325292ms)
✔ every tool the server lists needs its View, or the salon doesn't start (0.486916ms)
```

## What this unlocks

- **Presence in the assistants, from the same code.** No integration per assistant: one server, the
  same tools, the same rules.
- **Strangers, safely.** An assistant's conversation reaches its own chat and bookings. The desk
  sees everything, and knows where each booking came from.
- **Honest about who.** Until MCP has sign-in, an assistant's customer is a contact, and the record
  says so.

## Your challenge

Connect Claude Code to `/mcp/salon` and ask it to book Friday afternoon, with Sam's tab open. Then
ask it to cancel a booking it didn't make.

Next, every way in at once, and one test to prove the rules held at each.
