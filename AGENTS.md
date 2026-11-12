# AGENTS.md

A guide for coding agents (Claude Code, Codex, Cursor, Gemini) building an app with Copilotz. Read
it whole before you write code. The last section is for work on Copilotz itself.

It ships in the package (`node_modules/copilotz/AGENTS.md`, and `@copilotz/copilotz` on JSR) and
goes with `copilotz@1.0.0-rc.45`. Every docs page is Markdown at
`https://copilotz.com/docs/<slug>.md`, and https://copilotz.com/llms.txt lists them all. When you're
unsure of a name, fetch its page or read the package's types (`node_modules/copilotz/**/*.d.ts`).
Don't guess.

## What Copilotz is

A runtime for apps that people and AI use alike. You write the app once: its data, what can be done,
who may do it, and how it shows. People use it on a web page or in a terminal, the app's own agents
through tools, and outside assistants (ChatGPT, Claude, any MCP client) over MCP. Every way in calls
the same Actions, under the same rules, and every write is on one record of who did what, for whom.
It runs on Node 24+, Deno 2.9+ and Bun.

## How Copilotz works, in one minute

An app is a **runtime** made of **plugins**. A plugin is plain objects, made of six primitives:

| Primitive      | What it is                                                                               |
| -------------- | ---------------------------------------------------------------------------------------- |
| **Collection** | documents with a JSON Schema, read and written with the MongoDB collection API           |
| **Action**     | something that can be done, by name, with a JSON Schema `input` and an `allow` (who may) |
| **Processor**  | what happens when events happen: it hears the events it names, at least once, in order   |
| **View**       | how data shows in one place: text for a model or the terminal, Ink, React for the web    |
| **Resource**   | configuration as named plain objects, by kind (`agents`, `tools`, `provider`…)           |
| **Adapter**    | one implementation of a port, by name: a model provider's protocol, an email service     |

A plugin may also declare `routes` and `who` (HTTP), `guard` (rules), `schedules` and a startup
`check`. Plugins merge in order: a later plugin's resources patch an earlier one's (objects merge,
`null` removes), and a later View, adapter or route replaces one of the same name.

The runtime keeps one contract for every caller:

- **Who, for whom, where.** Every call carries an actor, `{ kind, id, for?, in? }`: a person, a
  contact from outside, or an agent working `for` one of them. `in` is where the work is (a space,
  with the access plugin).
- **The rules, at the data.** Reads come back filtered by what the actor reaches, and writes are
  checked, whichever way the call came in.
- **The record.** Every write records an event in the same commit, naming its actor.

What people often get wrong:

- **Two kinds of events.** A collection write records `<collection>.created`, `.updated` or
  `.deleted`. An Action call records `action.started`, then `action.completed` or `action.failed`.
  Callers call Actions; events are what Actions and writes produce.
- **`runtime.subscribe` hears events; `runtime.observe` keeps a View live**, running it again when a
  commit changes what it read.
- **Queries read; Actions write.** Named queries and Views never write.

Plugins reach each other only through the runtime, by name. One that builds on another says so
(`requires: ["chat"]`) and imports only that plugin's `contract.ts`, never its code.

## Start a project

There's no project generator. Set a project up as the docs' courses do, on Node 24 or newer:

```sh
mkdir my-app && cd my-app
npm init -y && npm pkg set type=module
npm install copilotz@1.0.0-rc.45 react@19 react-dom@19
npm install -D typescript @types/node @types/react @types/react-dom esbuild
```

Pin the version: npm's `latest` tag still points at an early release candidate. On Deno, run
`deno add jsr:@copilotz/copilotz` and map `"copilotz": "jsr:@copilotz/copilotz@^1.0.0-rc.45"` in
`deno.json`, so imports read the same.

Node runs `.ts` files as they are, so there's no build step. It doesn't run `.tsx`: tests that load
a `web.tsx` need a loader hook (Getting Started chapter 3 adds one). Copy `tsconfig.json` from
[Build Compass](https://copilotz.com/docs/build-compass.md), under "What you need": `NodeNext`
modules, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `strict`,
`noEmit`, and `jsx: "react-jsx"`. The scripts, in `package.json` (add `dev` and `terminal` once
there's a server and a terminal):

```json
"scripts": {
  "test": "node --disable-warning=ExperimentalWarning --test --test-timeout=60000 --test-concurrency=1 \"tests/*.test.ts\"",
  "check": "tsc --noEmit -p ."
}
```

The layout the docs use:

```text
app.ts            plugins(settings): every plugin, in order. It reads no environment.
plugins/<name>/
  mod.ts          assembles the plugin, and nothing else
  actions.ts …    one file per primitive; or collections/, actions/, views/… with one file per
                  declaration, as Copilotz's own plugins are laid out
  contract.ts     what other plugins may import: shapes and small helpers, never code
  web.tsx         its web front end (React Views); terminal.ts, its terminal one
server.ts         the web host: reads the environment, passes settings to plugins()
tests/kit.ts      the app as app.ts makes it, in memory, with a scripted model
tests/*.test.ts
.env              OPENAI_API_KEY=… (optional; dev and terminal read it: --env-file-if-exists=.env)
```

**Give the project its own guide.** Write `AGENTS.md` at its root, and `CLAUDE.md` holding the one
line `@AGENTS.md` (Claude Code reads `CLAUDE.md`, and follows the import). Keep it short and true:

```markdown
# AGENTS.md

This app runs on Copilotz (copilotz@1.0.0-rc.45). Read node_modules/copilotz/AGENTS.md first;
https://copilotz.com/llms.txt lists the docs, as Markdown.

- `npm test` runs every test offline, with a scripted model: run it after each change.
  `npm run check` checks the types.
- `app.ts` lists the plugins in order; `plugins/<name>/mod.ts` assembles each one.
- Every change to data is an Action that pages, tools and scripts all call. Access rules live at the
  data (the `shared` resource or a `guard`). Each tool has a `tool:<name>` View.
```

## A plugin, end to end

A collection, an Action, a View for people and one for the model, a rule, a tool and an agent, in
`plugins/tasks/mod.ts`:

```ts
import { defineAction, definePlugin, failure, people } from "copilotz";
import type { Plugin, ViewContext } from "copilotz";
import { tool } from "copilotz/plugins/agents";

type Task = { _id: string; title: string; in: string };

export const tasks: Plugin = definePlugin({
  name: "tasks",
  requires: ["chat", "spaces"],
  collections: {
    task: {
      schema: {
        type: "object",
        properties: { title: { type: "string" }, in: { type: "string" } },
        required: ["title", "in"],
      },
    },
  },
  actions: {
    // The one way to add a task: a button, the agent's tool and a script all call it.
    "task.add": defineAction({
      input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      allow: people,
      run: async (ctx, { title }) => {
        if (!ctx.in) throw failure("invalid", "Add tasks in a space.", { public: true });
        const { insertedId } = await ctx.db.collection("task").insertOne({ title, in: ctx.in });
        return { task: insertedId };
      },
    }),
  },
  views: {
    // Text, for the terminal and for a model. It reads as whoever looks.
    tasks: (_: unknown, ctx: ViewContext) => {
      const found = ctx.db.collection<Task>("task").find({}).value ?? [];
      return found.length ? found.map((t) => `- ${t.title}`).join("\n") : "No tasks.";
    },
    // What a model reads after it calls add_task.
    "tool:add_task": (_call: unknown, ctx: ViewContext) => ctx.show("tasks", {}),
  },
  resources: {
    // The rule, at the data: a task lives in a space (its `in`).
    shared: { task: {} },
    tools: {
      add_task: tool({
        description: "Adds a task to this chat's space",
        input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        run: ({ title }, ctx) => ctx.call("task.add", { title }),
      }),
    },
    agents: {
      helper: { default: true, instructions: "Keep tasks.", model: "helper", tools: ["add_task"] },
    },
  },
});
```

`app.ts` lists the plugins and sets the model alias the agent names. Without a key it's
`"fake/echo"`, Copilotz's offline model: it echoes what it's told, and calls a tool, with no input,
when the message names it ("add task" for `add_task`).

```ts
import { definePlugin, type Plugin } from "copilotz";
import { models } from "copilotz/plugins/models";
import { chat } from "copilotz/plugins/agents";
import { access } from "copilotz/plugins/access";
import { tasks } from "./plugins/tasks/mod.ts";

export function plugins(settings: { openai?: string } = {}): Plugin[] {
  const provider = settings.openai ? { openai: { apiKey: settings.openai } } : {};
  const model = { helper: settings.openai ? "openai/gpt-5.4-mini" : "fake/echo" };
  const app = definePlugin({ name: "app-settings", resources: { provider, model } });
  return [models, chat, ...access, tasks, app];
}
```

## Test without an API key: the default loop

Run `npm test` after every change, and `npm run check` before you stop. No test needs a key or the
network. Run the app as `app.ts` makes it, with fakes only where it meets the world: a scripted
model (below); `createRuntime({ clock: manualClock(Date.now()) })` and `clock.advance(ms)` for time;
`createRuntime({ fetch })` for what plugins call outside (`ctx.fetch`). A model provider is called
with the platform's `fetch`, so a fake one is a local server (`serve`, from `copilotz/testing`) set
as the provider's `baseURL`. `runtime.fetch(new Request(…))` tests HTTP without a port, and
`await runtime.idle()` waits until nothing is left to run.

`tests/kit.ts`:

```ts
import { createRuntime, definePlugin } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import type { LlmAdapter, LlmRequest } from "copilotz/plugins/models";
import { plugins } from "../app.ts";

export type Move = string | { tool: string; input?: Record<string, unknown> };

/** A model that plays its moves in order, one per call, and keeps what each call sent it. */
export function scripted(moves: Move[]) {
  const sent: LlmRequest[] = [];
  const adapter: LlmAdapter = {
    async *generate(request) {
      sent.push(request);
      const move = moves.shift();
      if (move === undefined) throw new Error(`The script has no move for call ${sent.length}.`);
      if (typeof move === "string") yield { type: "text", text: move };
      else {
        const call = { id: `call-${sent.length}`, name: move.tool, input: move.input ?? {} };
        yield { type: "tool_call", call };
      }
    },
  };
  return { adapter, sent };
}

/** The app, in memory, with the `helper` alias on a script. */
export async function start(moves: Move[] = []) {
  const store = memoryStore();
  const helper = scripted(moves);
  const script = definePlugin({
    name: "test-script",
    resources: { provider: { script: { adapter: "script" } }, model: { helper: "script/helper" } },
    adapters: { llm: { script: helper.adapter } },
  });
  const runtime = await createRuntime({ store, plugins: [...plugins(), script] });
  return { runtime, store, helper };
}
```

`tests/tasks.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, personOf } from "copilotz";
import { start } from "./kit.ts";

test("the agent adds a task for Ana, through the same Action", async () => {
  const { runtime, store, helper } = await start([
    { tool: "add_task", input: { title: "Bo" } },
    "Done.",
  ]);
  try {
    const ana: Actor = { kind: "person", id: "ana" };
    const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor: ana });
    const here: Actor = { ...ana, in: space };
    await runtime.call("chat.send", { in: space, text: "Add Bo." }, { actor: here });
    await runtime.idle();
    assert.equal(helper.sent[1].messages.at(-1)?.text, "- Bo"); // what the model read
    const made = (await store.events(0)).find((e) => e.type === "task.created");
    assert.equal(personOf(made?.actor), "ana"); // the record: written for Ana…
    assert.equal(made?.actor?.kind, "agent"); // …by the agent
    const seen = await runtime.observe<string>("tasks", {}, { actor: here }).ready;
    assert.deepEqual(seen, { status: "ready", value: "- Bo" }); // what Ana sees
  } finally {
    await runtime.close();
  }
});
```

Test what callers may not do as well: call as someone else, and `assert.rejects`.

## Rules: do this, not that

- **One Action per change, called from every way in.** A button and a tool call it with `ctx.call`,
  a script with `runtime.call`. Never add a second, looser path. A tool is a thin caller of Actions.
- **Rules at the data, not in handlers.** Name a collection in the `shared` resource (its documents
  live `in` a space; `part` ties one to another document, as a booking to its chat), or write a
  `guard`. Don't filter by who's asking inside an Action. To keep a collection changing only through
  its Actions, refuse `direct` writes in a `guard`.
- **Say `allow` on every Action outsiders call:** `people`, `contacts`, `peopleOrContacts`,
  `publicCallers`, or `inPerson` for what only the person decides (consent, keys, who's in a space,
  money). Write it by kind, never by identity. It's asked of agents too, and of whom they work for.
  An Action without `allow` is internal.
- **A View for whatever anyone reads, a model included.** Each tool gets a `tool:<name>` View: short
  text, with ids the model can act on. A failed call's output is its error's words; pass them on,
  don't throw. An MCP server that offers a tool without its View doesn't start.
- **A View reads in its own body.** A React View reads with `ctx.db` and hands the result to its
  component, so it stays live. Views never write.
- **Errors for callers are `failure(code, message, { public: true })`.** Only a public failure's
  words reach a caller outside or a model.
- **Settings are resources, not code.** `app.ts` reads no environment: the server, the terminal or a
  test passes settings in. Agents name a model alias that the app sets.
- **Writes that must agree go in one `ctx.transaction`.** A refused write rolls it all back. It
  holds the store's writer, so keep slow work out.
- **Who acts:** `personOf(ctx.actor)`, not `ctx.actor.id` (an agent's is its own). Where: `ctx.in`.
  A tool works where its chat is.
- **Going past the actor's reach is a named grant,** `ctx.as(grant("…"))`, in trusted code, on the
  record. Keys stay in code: never in Action inputs (they're recorded), never with a model.
- **An agent tells a conversation only what everyone in it could see.** Its work reads what both its
  asker and the place its answer goes reach: a space and what it draws on; a customer's chat, what
  that customer reaches (a space drawing on another with `contacts: "read"` lets them read it); its
  person's Personal space, all they reach. Writing anywhere its readers don't all reach that asks
  the person first (`needs_approval`): don't catch it, let it through to the turn.
- **A tool that goes past its caller, offered to a contact or the public, is a declassifier.** Scope
  it to them (their own bookings, never any record), take no free-form query that could widen it,
  and return only what they may see. In a customer's chat, an Action people call that goes past its
  caller is refused; the app's own (no `allow`) runs as its tool chose. The public (`publicCallers`,
  `{ kind: "public" }`) reads only spaces that have it as a viewer, and writes nothing.
- **Outside effects:** write the intent, call out with its id as the idempotency key (a tool's
  `callId`), then write the result.
- **Online:** `devSignIn` is for this machine only; Copilotz won't start it with a public origin.
  Keep the `links` secret (32 bytes or more) across restarts, or MCP conversations start over.

## Recipes

Each link is a page as Markdown. GS is Getting Started (a salon's bookings, 10 chapters). BC is
Build Compass (41 chapters, written for an earlier release candidate: check names in the reference).

- A plugin: [GS 1](https://copilotz.com/docs/getting-started/01-one-booking.md). People, contacts,
  spaces, the rules: [GS 2](https://copilotz.com/docs/getting-started/02-who-sees-what.md).
- The web: [GS 3](https://copilotz.com/docs/getting-started/03-its-own-web-page.md),
  [serving on the web](https://copilotz.com/docs/guides/serving-on-the-web.md). An agent and its
  tools: [GS 4](https://copilotz.com/docs/getting-started/04-its-own-agent.md).
- MCP: [GS 5](https://copilotz.com/docs/getting-started/05-chatgpt-claude-and-gemini-over-mcp.md).
  One test, every way in:
  [GS 6](https://copilotz.com/docs/getting-started/06-the-same-bookings-every-way-in.md).
- Widgets: [GS 7](https://copilotz.com/docs/getting-started/07-a-widget-in-the-assistant.md). A
  site's chat: [GS 8](https://copilotz.com/docs/getting-started/08-a-chat-on-your-site.md).
  WhatsApp: [GS 9](https://copilotz.com/docs/getting-started/09-whatsapp.md).
- Shipping (SQLite, PostgreSQL, sign-in by email):
  [GS 10](https://copilotz.com/docs/getting-started/10-shipping-the-salon.md).
- The prompt and context Views:
  [BC 2](https://copilotz.com/docs/build-compass/part-1-an-agent-of-your-own/02-north-in-your-terminal.md),
  [BC 4](https://copilotz.com/docs/build-compass/part-2-your-own-plugins/04-today-every-turn.md).
- A Processor:
  [BC 6](https://copilotz.com/docs/build-compass/part-2-your-own-plugins/06-chats-that-name-themselves.md).
  Transactions:
  [BC 9](https://copilotz.com/docs/build-compass/part-3-the-board/09-the-boards-data-and-actions.md).
- Schedules and a manual clock:
  [BC 27](https://copilotz.com/docs/build-compass/part-8-skills-and-routines/27-routines-on-a-schedule.md).
  Fakes at the edges:
  [BC 31](https://copilotz.com/docs/build-compass/part-10-testing/31-fakes-at-the-edges.md).
- Scripts over REST: [REST and the client](https://copilotz.com/docs/guides/rest-and-the-client.md).
  Many orgs: [many orgs](https://copilotz.com/docs/guides/many-orgs.md).
- Every entry point, option, event and context field:
  [reference](https://copilotz.com/docs/reference.md). Each of Copilotz's plugins (`chat`, `spaces`,
  `mcp`…): [plugins](https://copilotz.com/docs/reference/plugins.md). How it runs:
  [architecture](https://copilotz.com/docs/architecture.md).

## Entry points

The same names on npm (`copilotz/…`) and JSR (`@copilotz/copilotz/…`); the package's `package.json`
lists them all. Besides those above: `copilotz/stores/sqlite` and `copilotz/stores/postgres`
(stores), `copilotz/plugins/interfaces` (`mcp`, `api`, `whatsapp`, `voice`, `webLines`),
`copilotz/web` (the web host, `web`), `copilotz/web/server` (`webPage`), `copilotz/web/node`
(`listen`, `serve`, `bundle`), `copilotz/terminal` (`terminal`) and `copilotz/testing`. Each plugin
of `agents`, `access` and `interfaces` is also its own entry point, which loads it alone:
`copilotz/plugins/interfaces/mcp`, `copilotz/plugins/agents/chat`, `copilotz/plugins/access/spaces`…
Front ends sit beside each theme (`copilotz/plugins/agents/web` has `chatWeb`). Product packages
ship at the same version: `@copilotz/work` (`boards`, `documents`), `@copilotz/team`,
`@copilotz/directory` and `@copilotz/billing`.

## Working on Copilotz itself

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest. The checks:

```sh
deno task check && deno task test     # types, the suite (COPILOTZ_TEST_POSTGRES_URL: PostgreSQL)
npm install && npm test               # the suite on Node 24 (bun test --timeout 60000 on Bun)
deno fmt --check                      # the format CI checks
npm run build && node scripts/npm/smoke.ts && deno publish --dry-run    # the packages
```

- The runtime imports nothing outside it. A plugin imports the runtime, the hosts' toolkits, its own
  files and other plugins' `contract.ts` (`testing/boundaries.test.ts`).
- A plugin is `plugins/<theme>/<name>/`, by primitive, one file per declaration; `mod.ts` only
  assembles it. Tests sit in `plugins/<theme>/tests/`. Factories and plain data, no classes.
- After changing a plugin, `deno run -A scripts/describe.ts --docs` remakes its reference page.
  After changing docs, `python3 scripts/docs-index.py && deno fmt docs`.
- `testing/agents-md.test.ts` checks this file's imports, links and version;
  `node scripts/version.ts <version>` moves its version with the rest. Releases are tags the
  maintainers push: don't tag or publish.
