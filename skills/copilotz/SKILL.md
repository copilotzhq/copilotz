---
name: copilotz
description: Builds and tests apps on Copilotz, the TypeScript runtime (Node 24+, Deno, Bun) where one set of Actions, Views and access rules serves people on the web and in the terminal, the app's own agents through tools, and outside assistants over MCP. Use when a project depends on `copilotz` or `@copilotz/copilotz`, or when asked to build, test or debug a Copilotz plugin, Action, View, agent, tool, access rule or MCP server.
license: MIT
metadata:
  homepage: https://copilotz.com
  repository: https://github.com/copilotzhq/copilotz
---

# Building with Copilotz

Copilotz is a runtime for apps that people and AI use alike. You write the app once: its data, what
can be done, who may do it, and how it shows. People use it on a web page or in a terminal, the
app's own agents use it through tools, and outside assistants (ChatGPT, Claude, any MCP client) use
it over MCP. Every way in calls the same Actions, under the same rules, and every write is on one
record of who did what, for whom.

The guide that ships with the installed version is the source of truth:
`node_modules/copilotz/AGENTS.md`
([on GitHub](https://github.com/copilotzhq/copilotz/blob/main/AGENTS.md)). Where it and this skill
differ, it wins. When you're unsure of a name, read the package's types
(`node_modules/copilotz/**/*.d.ts`) or its docs page. Don't guess.

## When to use this skill

- The project's `package.json` or `deno.json` names `copilotz` or `@copilotz/…`, or its code imports
  from `copilotz`.
- You're asked to build an app, an agent or an MCP server on Copilotz, or to add a plugin, an
  Action, a View, a tool, an agent, an access rule, a schedule or a test to one.
- Not for changing Copilotz itself: in its repository, follow AGENTS.md's last section and
  CONTRIBUTING.md.

## The model, in a few lines

- An app is a **runtime** made of **plugins**: plain objects built from six primitives.
  **Collections** are documents with a JSON Schema, read and written with the MongoDB collection
  API. **Actions** are what can be done, by name, with an `input` schema and an `allow` (who may).
  **Processors** react to events. **Views** show data in one place: text for a model or the
  terminal, React for the web. **Resources** are configuration by kind (`agents`, `tools`,
  `provider`…), and **Adapters** implement a port (a model provider's protocol).
- Every call carries an **actor**, `{ kind, id, for?, in? }`: a person, a contact, or an agent
  working `for` one of them, `in` a space.
- **The rules hold at the data.** Reads come back filtered by what the actor reaches, and writes are
  checked, whichever way the call came in.
- **Every write is on the record.** A collection write records `<collection>.created`, `.updated` or
  `.deleted`. An Action call records `action.started`, then `action.completed` or `action.failed`.
- **Queries and Views read; Actions write.** `runtime.observe` keeps a View live, and
  `runtime.subscribe` hears events.
- Plugins reach each other only through the runtime, by name. One that builds on another says so
  (`requires: ["chat"]`) and imports only that plugin's `contract.ts`.

## Set up

There's no project generator. On Node 24 or newer:

```sh
mkdir my-app && cd my-app
npm init -y && npm pkg set type=module
npm install copilotz@next react@19 react-dom@19
npm install -D typescript @types/node @types/react @types/react-dom esbuild
```

Release candidates are on npm's `next` tag; plain `npm install copilotz` gets an early one. On Deno,
run `deno add jsr:@copilotz/copilotz` and map `"copilotz"` to it in `deno.json`, so imports read the
same. Node runs `.ts` files as they are, with no build step. Then add the `tsconfig.json`, the
`test` and `check` scripts, the layout and the project's own `AGENTS.md`, as
[the walkthrough](references/plugin-walkthrough.md) shows.

## The loop: test offline, with a scripted model

No test needs an API key or the network. After every change, run `npm test`. Before you stop, run
`npm run check` for the types.

A test runs the app as `app.ts` makes it, on `memoryStore()`, with the agents' model alias pointed
at a scripted model: an `LlmAdapter` that plays fixed moves, a text or a tool call, one per call.

```ts
const { runtime, store, helper } = await start([
  { tool: "add_task", input: { title: "Bo" } },
  "Done.",
]);
await runtime.call("chat.send", { in: space, text: "Add Bo." }, { actor: here });
await runtime.idle(); // until nothing is left to run
```

Then check three things: what the model read (`helper.sent`), the record (`store.events(0)`: who
wrote, for whom), and what a person sees (`runtime.observe(view, item, { actor }).ready`). Test what
callers may not do as well: call as someone else, and expect the refusal. `tests/kit.ts` (`start`
and the scripted model) and the patterns for time, outside calls and HTTP are in
[testing](references/testing.md). To run the app without a key, set the agents' model alias to
`"fake/echo"`, the offline model.

## The rules

Each one, with why and code: [rules](references/rules.md).

1. **One Action per change, called from every way in.** A button and a tool call it with `ctx.call`,
   a script with `runtime.call`. A tool is a thin caller of Actions.
2. **Rules at the data, not in handlers.** Name the collection in the `shared` resource, or write a
   `guard`. Don't filter by who's asking inside an Action.
3. **Say `allow` on every Action outsiders call,** by kind: `people`, `contacts`,
   `peopleOrContacts`, `publicCallers`, or `inPerson` for what only the person decides. An Action
   without `allow` is internal.
4. **A View for whatever anyone reads, a model included.** Each tool gets a `tool:<name>` View:
   short text, with ids the model can act on. Views never write.
5. **Errors for callers are `failure(code, message, { public: true })`.** Only a public failure's
   words reach a caller outside, or a model.
6. **Settings are resources, not code.** `app.ts` reads no environment, and agents name a model
   alias that the app sets.
7. **Writes that must agree go in one `ctx.transaction`.**
8. **Who acts is `personOf(ctx.actor)`, not `ctx.actor.id`; where is `ctx.in`.**
9. **Going past the actor's reach is a named grant,** `ctx.as(grant("…"))`. Keys stay in code: never
   in Action inputs, never with a model.
10. **The audience rule: an agent tells a conversation only what everyone in it could see.** Its
    work reads only what both its asker and the place its answer goes reach. Writing where those
    readers don't all reach is refused with `needs_approval`, and the turn asks its person: don't
    catch it in a tool, let it through.
11. **A tool that goes past its caller, offered to a contact or the public, is a declassifier.**
    Scope it to them, take no free-form query that could widen it, and return only what they may
    see. The public reads only spaces that have it as a viewer, and writes nothing.
12. **Outside effects:** write the intent, call out with its id as the idempotency key (a tool's
    `callId`), then write the result.

## Where to find more

- [references/plugin-walkthrough.md](references/plugin-walkthrough.md): the project, its layout, and
  a plugin built step by step (collection, Actions, rules, Views, a tool, an agent, `app.ts`).
- [references/rules.md](references/rules.md): the rules above, each with its reason and code.
- [references/testing.md](references/testing.md): the test kit, and testing refusals, time, outside
  calls and HTTP.
- **The docs, as Markdown:** every page is at `https://copilotz.com/docs/<slug>.md`, and
  https://copilotz.com/llms.txt lists them all. Start with the
  [reference](https://copilotz.com/docs/reference.md) (every entry point, option, event and context
  field), [the plugins](https://copilotz.com/docs/reference/plugins.md) (`chat`, `spaces`, `mcp`…, a
  page each) and [Getting Started](https://copilotz.com/docs/getting-started.md) (a booking app in
  10 chapters).
- **The docs over MCP (planned, not live yet):** `https://copilotz.com/api/mcp`, over streamable
  HTTP, will offer `search_docs`, `read_doc` and `agents_guide`. The Copilotz plugin (for Claude
  Code, Codex, Cursor, Copilot CLI and Gemini CLI) registers it. If those tools are there and
  answer, use them; otherwise fetch the `.md` pages.
