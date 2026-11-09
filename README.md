# Copilotz

One app, for people and for AI.

[![npm](https://img.shields.io/npm/v/copilotz?label=npm)](https://www.npmjs.com/package/copilotz)
[![JSR](https://jsr.io/badges/@copilotz/copilotz)](https://jsr.io/@copilotz/copilotz)

People now act through AI assistants and agents, not only through the screens you build. Today that
means building your app for people, then bolting on a bot, an MCP server and a ChatGPT app. Each is
its own codebase, with its own idea of who's asking and what they may touch. With Copilotz you write
the app once. People use it, and so do your own agents and everyone else's (ChatGPT, Claude, any MCP
client): the same Actions, the same rules, one record of who did what for whom.

<!-- CLIP (~10 s, animated, autoplay, loop): the same booking app, live, in three places. Ana books
on the app's web page, asks its agent for another, and someone books inside ChatGPT, in a widget
drawn by the same View. -->

## One app, 3 callers

Here is a small booking app, in one file. Its one Action, `booking.make`, has 3 callers. Ana, a
person, calls it herself. The app's own agent calls it for her. An assistant from outside calls it
over MCP. The agent thinks with an OpenAI model, so the file needs an `OPENAI_API_KEY`, but the MCP
call needs no model.

```ts
import { type Actor, createRuntime, defineAction, definePlugin, people } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { models } from "copilotz/plugins/models";
import { chat, tool } from "copilotz/plugins/agents";
import { access } from "copilotz/plugins/access";
import { mcp } from "copilotz/plugins/interfaces";

const booking = {
  type: "object",
  properties: { slot: { type: "string" }, in: { type: "string" }, thread: { type: "string" } },
  required: ["slot", "in"],
} as const;

const salon = definePlugin({
  name: "salon",
  collections: { booking: { schema: booking } },
  actions: {
    "booking.make": defineAction({
      input: booking,
      // Who may call it from outside. The rules below hold for every caller.
      allow: people,
      run: (ctx, input) => ctx.db.collection("booking").insertOne(input),
    }),
  },
  views: {
    // Whose bookings? The rules filter the read, for whoever is looking.
    bookings: (_, ctx) =>
      ctx.db.collection<{ slot: string }>("booking").find().value?.map((b) => b.slot).join(", "),
    // What a model reads after it books, the app's own or one over MCP.
    "tool:book": (_, ctx) => ctx.show("bookings", {}),
  },
  resources: {
    // The rules: a booking lives in a space, and belongs to the chat it was made in.
    shared: { booking: { part: "thread" } },
    tools: {
      book: tool({
        description: "Books a slot, like 'Wed 15:00'.",
        input: { type: "object", properties: { slot: { type: "string" } }, required: ["slot"] },
        run: async ({ slot }, ctx) => {
          const chat = await ctx.db.collection<{ in: string }>("thread").findOne({
            _id: ctx.thread,
          });
          return ctx.call("booking.make", { slot, in: chat!.in, thread: ctx.thread });
        },
      }),
    },
    agents: {
      concierge: { instructions: "Book slots.", model: "openai/gpt-5.4-mini", tools: ["book"] },
    },
    provider: { openai: { apiKey: process.env.OPENAI_API_KEY } },
    // An MCP server at /mcp/salon. No sign-in: each conversation is a contact, in its own chat.
    mcp: { salon: { in: "desk", tools: { book: {} } } },
    spaces: { desk: { name: "Front desk" } },
    links: { origin: "http://localhost", secret: "keep-this-in-your-settings-not-in-code" },
  },
});

const runtime = await createRuntime({
  store: memoryStore(),
  plugins: [models, chat, ...access, mcp, salon],
});

// The record: every write names who made it, and for whom.
const who = (a: Actor): string => `${a.kind} ${a.id}${a.for ? `, for ${who(a.for as Actor)}` : ""}`;
runtime.subscribe((item) => {
  if (item.kind !== "event" || item.event.type !== "booking.created") return;
  const { doc } = item.event.data as { doc: { slot: string } };
  console.log(`${doc.slot} booked by ${who(item.event.actor!)}`);
});

// Ana books a slot herself, then asks the app's agent for another.
const ana: Actor = { kind: "person", id: "ana" };
const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor: ana });
await runtime.call("booking.make", { slot: "Tue 10:00", in: space }, { actor: ana });
await runtime.call("chat.send", { text: "Book me Wed 15:00 too.", in: space }, { actor: ana });
await runtime.idle();

// Someone's assistant books over MCP, naming its conversation as ChatGPT does.
const response = await runtime.fetch(
  new Request("http://localhost/mcp/salon", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "book",
        arguments: { slot: "Thu 09:00" },
        _meta: { "openai/session": "conversation-1" },
      },
    }),
  }),
);
console.log(await response.text());

const seen = await runtime.observe<string>("bookings", {}, { actor: ana }).ready;
console.log(`ana sees: ${seen.status === "ready" && seen.value}`);
await runtime.close();
```

It printed this:

```
Tue 10:00 booked by person ana
Wed 15:00 booked by agent concierge, for person ana
Thu 09:00 booked by contact c-5c57fa89cbd474cea4610f8b
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Thu 09:00"}]}}
ana sees: Tue 10:00, Wed 15:00
```

- **One Action, every door.** Ana called `booking.make` as herself, the way the app's page does for
  her. The concierge called it through the `book` tool, as an agent working for Ana. The assistant
  posted a JSON-RPC `tools/call` to `/mcp/salon` and ran the same tool. MCP has no sign-in yet, so
  it came in as a contact, with a chat of its own.
- **The rules held at every door.** `shared` puts bookings under the access rules, which filter
  every read and write of them. The same `bookings` View showed Ana her 2 bookings and the assistant
  its 1. Had Ana named the front desk's space instead of hers, the rules would have refused the
  write.
- **The record says who, and for whom.** Each write is an event naming its actor, so the log tells
  Ana from the agent working for her, and both from a stranger's assistant.

## Install and run

```sh
npm install copilotz                 # Node 24+ (npm, pnpm, yarn)
bun add copilotz                     # Bun
deno add jsr:@copilotz/copilotz      # Deno (or `deno add npm:copilotz`)
```

Save the example as `salon.ts`, and run it with an OpenAI key:

```sh
OPENAI_API_KEY=sk-… node salon.ts    # or bun salon.ts, or deno run -A salon.ts
```

On Deno, map the name `copilotz` in `deno.json`
(`"copilotz": "jsr:@copilotz/copilotz@^1.0.0-rc.29"`) so the imports read the same everywhere.
Copilotz runs on Node, Deno and Bun, and it's built on web standards for Cloudflare Workers and the
browser.

## How it works

Copilotz is a runtime with one contract, and every way in is a thin layer over it.

```text
web page · terminal · REST API · client · MCP and widgets · WhatsApp · voice · your agents
                                        │
                                        ▼
         who is asking ............ an actor, on every call
         what can be done ......... Actions
         what anyone sees ......... Views
         what they may touch ...... the rules, checked at the data
         what happened ............ the record
```

A door speaks its protocol and says who the caller is. The web reads a session cookie, and the REST
API a developer key. MCP, WhatsApp and the phone make a stranger a contact, with a chat of their
own. From there it's the same for everyone: the work is an Action, what anyone sees is a View, the
rules decide what's in reach, and the record keeps it. Your own agents are one more client. `chat`
runs the model, and its tools call your Actions as the agent, on someone's behalf.

The contract is built from 6 primitives, and the runtime knows nothing else. An app is a list of
plugins, yours and Copilotz's, each made of them.

| Primitive       | What it is                                                                                       | What it replaces                                        |
| --------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Actions**     | What can be done, by name, with a JSON Schema input and an `allow` for callers from outside      | your API endpoints and your agent's tools, at once      |
| **Views**       | How data shows in one place: React in the browser, Ink in the terminal, text in a model's prompt | your UI, your terminal output and your prompt templates |
| **Processors**  | What happens when events happen, in order per key, at least once, from a durable cursor          | your job queue and your event handlers                  |
| **Collections** | Documents with a JSON Schema, read and written with the MongoDB collection API                   | your data layer                                         |
| **Resources**   | Configuration as named plain objects (`agents`, `tools`, `mcp`…) that later plugins patch        | your config, and the fork you'd need to change a plugin |
| **Adapters**    | One implementation of a port, by name: a model provider's protocol, an embedder, a search engine | your provider clients                                   |

Plugins reach each other only by name. They call each other's Actions, fill each other's resource
kinds and hear each other's events. A plugin that builds on another imports only its contract, never
its code.

## Why it's safe to open your app to AI

The runtime keeps these promises at every door, so your plugins don't have to.

- **Every caller is someone.** It's a person, an agent working for one, a contact or the system, and
  that actor goes with everything the call causes.
- **The rules are checked at the data.** In every collection they cover, they filter each read and
  write an actor's work makes, whichever door it came in by.
- **An agent reaches only what its person reaches,** and only in the spaces it's a member of.
- **A model never holds your keys.** Tools use them in code, for the person. A connected account's
  tokens are a private field that no View, event or actor's read gets.
- **Everything is on the record.** Every write and Action call is an event naming who acted and for
  whom. Only what a plugin declares stays off it, like live state kept in memory.
- **Retries don't duplicate.** A call sent again with its id answers from the log. A tool call that
  already returned isn't run again, and an MCP call that changes things, sent again, is answered
  from the first.
- **Screens follow commits.** An observed View runs again when a commit changes what it read, so the
  page and the terminal show what's true now.

## In the box

Copilotz's own plugins are built the way yours are. Add the ones you need, and change them through
their resources instead of forking them. They come by theme from `copilotz/plugins/<theme>`, and
their front ends from `/web` and `/terminal` beside it.

**The doors**

- **The web:** `copilotz/web` draws the app in the browser around `webShell`, and `webPage` serves
  the page. `listen` and `bundle` serve and bundle it on Node.
- **The terminal:** `copilotz/terminal` draws the app in a terminal around `terminalShell`.
- **REST and the client:** the runtime answers a REST API at `/api/`, and `connect` is its client
  for scripts. `api` gives people developer keys, each with a scope.
- **MCP:** `mcp` offers your tools to ChatGPT, Claude and any MCP client. `copilotz/web/widget`
  draws your web Views inside them, through MCP Apps and ChatGPT's Apps SDK.
- **WhatsApp and the phone:** `whatsapp`, through Meta's Cloud API, and `voice`, for calls through
  Twilio.
- **Your site:** `webLines` puts a chat with your agents on a public page.
- **Your agents:** `chat` runs conversations, agents and their tools, and `models` talks to model
  providers.

**The rest**

- **Agents:** `history` summarizes long chats, and `memory` with `memoryExtraction` remembers across
  them. `team` lets people make agents, `skills` gives them know-how, `routines` runs them on a
  schedule and `tiers` picks their models. `openapi` turns an API's spec into tools, and `webTools`
  searches and reads the web.
- **Work:** `boards` for kanban, and `documents` for Markdown whose saves are versions that merge.
- **Access:** `access` for spaces, people and contacts, with `googleSignIn`, `emailSignIn` and
  `email`, and `devSignIn` for this machine. `accounts` connects a person's own accounts, and
  `directory` puts many orgs behind one address.
- **Billing:** `usage` keeps a ledger of what every model call used and cost. `credits` stops an org
  at what it can spend, and `stripe` with `stripeWebhook` takes its payments.
- **Compute:** `computers`, people's own machines, where agents run commands once their person says
  yes.
- **Stores:** `memoryStore`, `sqliteStore` and `postgresStore`. One conformance suite holds them to
  the same behavior, so moving from memory to PostgreSQL changes one line. Blobs stay in the store,
  or go to files with `fileBlobs`, a bucket with `httpBlobs` or Google Cloud Storage with
  `gcsBlobs`.
- **Running it:** `maintenance` runs SQL over HTTP for operators who can't reach the database, and
  metrics leave through `copilotz/exporters`. `copilotz/testing` is one test API for Node, Deno and
  Bun.

## Learn it

- **[Getting Started](docs/getting-started.md)** builds Compass, a single-user workspace where you
  and a team of agents share chats, a board and documents, in 41 chapters. You import Copilotz's
  agentic core and rebuild the rest yourself, one primitive at a time.
- **[The video course](#)**, in Portuguese and English, follows the same chapters.
  <!-- TODO: link the video course, PT and EN -->
- **[Reference](docs/reference/)**: every entry point, primitive and resource kind.
  <!-- TODO: docs/reference/ doesn't exist yet -->
- **[Architecture](docs/architecture/)**: the owner, its executors, the store and the log.
  <!-- TODO: docs/architecture/ doesn't exist yet -->
- **[Design records](design/)**: the decisions behind Views, access, memory and tenancy.

## Status

Copilotz 1.0 is a release candidate, `1.0.0-rc.29`. It's a new runtime, and it doesn't read 0.x
data. Copilotz 0.x lives on the [`v0`](https://github.com/copilotzhq/copilotz/tree/v0) branch, and
[CHANGELOG.md](CHANGELOG.md) says what each release changed.

To work on Copilotz itself, see [CONTRIBUTING.md](CONTRIBUTING.md).

<!-- TODO: write CONTRIBUTING.md, from the old README's "Developing Copilotz" and "Layout" -->

## License

MIT
