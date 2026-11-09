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
import { type Actor, createRuntime, defineAction, definePlugin, peopleOrContacts } from "copilotz";
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
      // Asked of every caller, tools included: people, agents working for them, and contacts.
      allow: peopleOrContacts,
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
        // A tool works where its chat is (ctx.in), for whoever the chat is with.
        run: ({ slot }, ctx) => ctx.call("booking.make", { slot, in: ctx.in, thread: ctx.thread }),
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

// The record: every write names who made it, for whom, and where.
const who = (a: Actor): string => `${a.kind} ${a.id}${a.for ? `, for ${who(a.for as Actor)}` : ""}`;
runtime.subscribe((item) => {
  if (item.kind !== "event" || item.event.type !== "booking.created") return;
  const { doc } = item.event.data as { doc: { slot: string } };
  console.log(`${doc.slot} booked by ${who(item.event.actor!)}, in ${item.event.actor!.in}`);
});

// Ana books a slot herself, then asks the app's agent for another.
const ana: Actor = { kind: "person", id: "ana" };
const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor: ana });
// She works in her own space, and says so, as the app's page does.
const here = { actor: { ...ana, in: space } };
await runtime.call("booking.make", { slot: "Tue 10:00", in: space }, here);
await runtime.call("chat.send", { text: "Book me Wed 15:00 too.", in: space }, here);
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
Tue 10:00 booked by person ana, in personal:ana
Wed 15:00 booked by agent concierge, for person ana, in personal:ana
Thu 09:00 booked by contact c-5c57fa89cbd474cea4610f8b, in desk
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Thu 09:00"}]}}
ana sees: Tue 10:00, Wed 15:00
```

- **One Action, every door.** Ana called `booking.make` as herself, the way the app's page does for
  her. The concierge called it through the `book` tool, as an agent working for Ana. The assistant
  posted a JSON-RPC `tools/call` to `/mcp/salon` and ran the same tool. MCP has no sign-in yet, so
  it came in as a contact, with a chat of its own.
- **`allow` was asked at every door.** It's asked of a tool's `ctx.call` too, for the agent and for
  whom it works. So `booking.make` says `peopleOrContacts`: with `people`, the assistant's call
  would have been refused, because a contact isn't a person.
- **The rules held at every door.** `shared` puts bookings under the access rules, which filter
  every read and write of them. The same `bookings` View showed Ana her 2 bookings and the assistant
  its 1. Had Ana named the front desk's space instead of hers, the rules would have refused the
  write.
- **The record says who, for whom, and where.** Each write is an event naming its actor and where it
  worked. The log tells Ana from the agent working for her, and both from a stranger's assistant at
  the front desk. The tool never looked its space up: `ctx.in` is where its chat is.

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
(`"copilotz": "jsr:@copilotz/copilotz@^1.0.0-rc.32"`) so the imports read the same everywhere.
Copilotz runs on Node, Deno and Bun, and it's built on web standards for Cloudflare Workers and the
browser.

## How it works

Copilotz is a runtime with one contract, and every way in is a thin layer over it.

```text
web page · terminal · REST API · client · MCP and widgets · WhatsApp · voice · your agents
                                        │
                                        ▼
         who, for whom, where ..... an actor, on every call
         what can be done ......... Actions
         what anyone sees ......... Views
         what they may touch ...... the rules, checked at the data
         what happened ............ the record
```

A door speaks its protocol and says who the caller is, and where they work. The web reads a session
cookie, and the page says its space. The REST API reads a developer key, which works in its space.
MCP, WhatsApp and the phone make a stranger a contact, with a chat of their own in the line's space.
From there it's the same for everyone: the work is an Action, what anyone sees is a View, the rules
decide what's in reach, and the record keeps it. Your own agents are one more client. `chat` runs
the model, and its tools call your Actions as the agent, for its person, where the chat is.

The contract is built from 6 primitives, and the runtime knows nothing else. An app is a list of
plugins, yours and Copilotz's, each made of them.

| Primitive       | What it is                                                                                       | What it replaces                                        |
| --------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Actions**     | What can be done, by name, with a JSON Schema input and an `allow` asked of every caller         | your API endpoints and your agent's tools, at once      |
| **Views**       | How data shows in one place: React in the browser, Ink in the terminal, text in a model's prompt | your UI, your terminal output and your prompt templates |
| **Processors**  | What happens when events happen, in order per key, at least once, from a durable cursor          | your job queue and your event handlers                  |
| **Collections** | Documents with a JSON Schema, read and written with the MongoDB collection API                   | your data layer                                         |
| **Resources**   | Configuration as named plain objects (`agents`, `tools`, `mcp`…) that later plugins patch        | your config, and the fork you'd need to change a plugin |
| **Adapters**    | One implementation of a port, by name: a model provider's protocol, an embedder, a search engine | your provider clients                                   |

Plugins reach each other only by name. They call each other's Actions, fill each other's resource
kinds and hear each other's events. A plugin that builds on another imports only its contract, never
its code.

## Why it's safe to open your app to AI

An agent reaches what its person reaches, in the space it works in, and `allow` holds for tools too.
The runtime keeps these promises at every door, so your plugins don't have to.

- **Every caller is someone, somewhere.** It's a person, an agent working for one, a contact,
  someone signed out or the system. Where the work happens (`in`) goes with the caller, into
  everything the call causes.
- **`allow` is asked of every caller.** That's a person's page, a key, and a tool or any code acting
  for someone. For an agent, it's asked for the agent and for its person, so an agent never calls
  what its person couldn't. Going further takes a grant named in code (`ctx.as(grant("…"))`), and
  the record shows it.
- **What only a person decides stays theirs.** Actions that say `inPerson`, such as inviting someone
  or making a key, refuse agents, keys and routines, whomever they work for.
- **Where an agent works bounds what it reaches.** It reaches what its person does, but only in
  spaces it's a member of, and only in its chat's space and what that space draws on. In the
  person's own Personal space, it reaches everything the person does.
- **The rules are checked at the data.** In every collection they cover, they filter each read and
  write an actor's work makes, whichever door it came in by.
- **A model never holds your keys.** Tools use them in code, for the person. A connected account's
  tokens are a private field that no View, event or actor's read gets.
- **Everything is on the record.** Every write and Action call is an event naming who acted, for
  whom and where. Only what a plugin declares stays off it, like live state kept in memory.
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
  for scripts. `api` gives people developer keys, each working in one space, with a scope.
- **MCP:** `mcp` offers your tools to ChatGPT, Claude and any MCP client. `copilotz/web/widget`
  draws your web Views inside them, through MCP Apps and ChatGPT's Apps SDK.
- **WhatsApp and the phone:** `whatsapp`, through Meta's Cloud API, and `voice`, for calls through
  Twilio.
- **Your site:** `webLines` puts a chat with your agents on a public page.
- **Your agents:** `chat` runs conversations, agents and their tools, and `models` talks to model
  providers.

**The rest**

- **Agents:** `history` summarizes long chats, and `memory` with `memoryExtraction` remembers across
  them. `skills` gives them know-how, and `routines` runs them on a schedule. `openapi` turns an
  API's spec into tools, and `webTools` searches and reads the web.
- **Access:** `access` for spaces, people and contacts, with `googleSignIn`, `emailSignIn` and
  `email`, and `devSignIn` for this machine. `accounts` connects a person's own accounts.
- **Billing:** `usage` keeps a ledger of what every model call used and cost.
- **Compute:** `computers`, people's own machines, where agents run commands once their person says
  yes.
- **Product packages,** released with Copilotz at its version: `@copilotz/work` has `boards` for
  kanban and `documents` for Markdown whose saves are versions that merge. `@copilotz/team` lets
  people make agents (`team`) and pick their models (`tiers`). `@copilotz/directory` puts many orgs
  behind one address. `@copilotz/billing` stops an org at what it can spend (`credits`), and takes
  its payments (`stripe`, `stripeWebhook`).
- **Stores:** `memoryStore`, `sqliteStore` and `postgresStore`. One conformance suite holds them to
  the same behavior, so moving from memory to PostgreSQL changes one line. Blobs stay in the store,
  or go to files with `fileBlobs`, a bucket with `httpBlobs` or Google Cloud Storage with
  `gcsBlobs`.
- **Running it:** `maintenance` runs SQL over HTTP for operators who can't reach the database, and
  metrics leave through `copilotz/exporters`. `copilotz/testing` is one test API for Node, Deno and
  Bun.

## Learn it

- **[Getting Started](docs/getting-started.md)** builds a salon's booking app: one booking, then who
  sees what, its own web page and its own agent, ChatGPT, Claude and Gemini over MCP, a chat on its
  site and WhatsApp, in 10 chapters.
- **[Build Compass](docs/build-compass.md)** is the deep track. In 41 chapters you build Compass, a
  workspace where people and agents share chats, a board and documents, and with it every part of
  the runtime's contract. [The video course](#), in Portuguese and English, follows the same
  chapters. <!-- TODO: link the video course, PT and EN -->
- **Guides:** [serving on the web](docs/guides/serving-on-the-web.md),
  [many orgs behind one address](docs/guides/many-orgs.md), [visitors](docs/guides/visitors.md),
  [the REST API and the client](docs/guides/rest-and-the-client.md) and
  [installing a computer](docs/guides/installing-a-computer.md).
- **Operations:** [stores](docs/operations/stores.md), [maintenance](docs/operations/maintenance.md)
  and [metrics](docs/operations/metrics.md).
- **[Reference](docs/reference.md)** lists every entry point, primitive, event type and schedule,
  with a page for each plugin, read from the plugin itself.
- **[Architecture](docs/architecture.md)** shows how the runtime keeps its contract: the owner and
  its executors, the store, events and Views, the ways in, and the invariants.
- **[Design records](design/)** hold the decisions behind Views, access, work (who, for whom,
  where), memory and tenancy.

## Status

Copilotz 1.0 is a release candidate, `1.0.0-rc.32`. It's a new runtime, and it doesn't read 0.x
data. Copilotz 0.x lives on the [`v0`](https://github.com/copilotzhq/copilotz/tree/v0) branch, and
[CHANGELOG.md](CHANGELOG.md) says what each release changed, and how to upgrade.

To work on Copilotz itself, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
