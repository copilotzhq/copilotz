# AGENTS.md

A guide for coding agents (Claude Code, Codex, Cursor, Gemini) building an app with Copilotz. Read
it whole before you write code. The last section is for work on Copilotz itself.

It ships in the package (`node_modules/copilotz/AGENTS.md`, and `@copilotz/copilotz` on JSR) and
goes with `copilotz@1.0.0-rc.64`. The [reading list](llms.txt) links to every docs page in the
installed package. The same pages are online at https://copilotz.com/llms.txt. When you're unsure of
a name, fetch its page or read the package's types (`node_modules/copilotz/**/*.d.ts`). Don't guess.

It also comes as an Agent Skill, for any coding agent: `npx skills add copilotzhq/copilotz`.

## What Copilotz is

A runtime for apps that people and AI use alike. You write the app once: its data, what can be done,
who may do it, and how it shows. People use it on a web page or in a terminal, the app's own agents
through tools, and outside assistants (ChatGPT, Claude, any MCP client) over MCP. Every way in calls
the same Actions, under the same rules, and every write is on one record of who did what, for whom.
It runs on Node 24+, Deno 2.9+ and Bun.

## Find it: what an app needs, and where it's documented

**Starting and checking an app**

- Start a checked TypeScript app → `copilotz init [dir]` →
  [Start an app](docs/guides/the-compiler.md#start-an-app).
- Assemble plugins from declarations → `copilotz gen` →
  [The files and their names](docs/guides/the-compiler.md#the-files-and-their-names).
- Load only one host's declarations → `#copilotz/plugins/<name>/web.ts` →
  [Load a plugin](docs/guides/the-compiler.md#load-a-plugin).
- Catch misspelled registry names → `AppNames` →
  [Typed names](docs/guides/the-compiler.md#typed-names).
- Keep generated files current → `copilotz gen --watch` →
  [Watch and check](docs/guides/the-compiler.md#watch-and-check).
- Check generated files in CI → `copilotz gen --check` →
  [Watch and check](docs/guides/the-compiler.md#watch-and-check).
- Take over a plugin's assembly → `copilotz gen --eject [plugin]` →
  [Mix generated and hand-written plugins](docs/guides/the-compiler.md#mix-generated-and-hand-written-plugins).
- Validate an Action's annotated input → `defineAction({ run })`, `copilotz gen` →
  [An Action's input from its type](docs/guides/the-compiler.md#an-actions-input-from-its-type).
- Validate collection writes from a document type → `defineCollection<Order>({ indexes, queries })`
  → [A collection from its type](docs/guides/the-compiler.md#a-collection-from-its-type).
- Read a typed document by collection name → `ctx.db.collection("order")` →
  [Collections](docs/reference.md#collections).
- Test without an API key → a scripted `LlmAdapter`, `memoryStore` →
  [Fakes at the edges](docs/build-compass/part-10-testing/31-fakes-at-the-edges.md).

**Actions, access and mail**

- Call an Action that takes nothing → `defineAction({ run })` →
  [Actions with no parameters](docs/reference.md#actions-with-no-parameters).
- Type an Action's parameters from its fields → `defineAction({ input, run })` →
  [A grant and a transaction for the whole Action](docs/reference.md#a-grant-and-a-transaction-for-the-whole-action).
- Share caller rules across a plugin → `definePlugin({ defaults: { allow } })` →
  [One permission check for Actions and queries](docs/reference.md#one-permission-check-for-actions-and-queries).
- Check a person's permission before an Action runs → `async allow(actor, input, ctx)` →
  [One permission check for Actions and queries](docs/reference.md#one-permission-check-for-actions-and-queries).
- Record writes under a named grant → `defineAction({ as: "inventory-adjust" })` →
  [A grant and a transaction for the whole Action](docs/reference.md#a-grant-and-a-transaction-for-the-whole-action).
- Run an Action in one transaction → `defineAction({ transaction: true })` →
  [A grant and a transaction for the whole Action](docs/reference.md#a-grant-and-a-transaction-for-the-whole-action).
- Test mail without sending it → `captureEmail()` →
  [Mail in tests: the capture adapter](docs/reference/plugins/email.md#mail-in-tests-the-capture-adapter).
- Open development mail as files → `resources.email.capture.directory` →
  [Mail in tests: the capture adapter](docs/build-compass/part-10-testing/31-fakes-at-the-edges.md#mail-in-tests-the-capture-adapter).
- Send a receipt or build its MIME source → `email.send`, `mime(message, from)` →
  [Mail in tests: the capture adapter](docs/reference/plugins/email.md#mail-in-tests-the-capture-adapter).
- Limit reads and writes at the data → `resources.shared`, `guard`, `byCollection` →
  [Rules: `guard` and `labels`](docs/reference.md#rules-guard-and-labels).
- Group several writes inside an Action → `ctx.transaction`, `tx.call` →
  [A grant and a transaction for the whole Action](docs/reference.md#a-grant-and-a-transaction-for-the-whole-action).
- Read a named query as its caller → `collection.query`, `runtime.query` →
  [Collections](docs/reference.md#collections).

**Screens and dates**

- UI components several screens or plugins share → `lib/web/` (the plugin's, or the app's) →
  [Shared UI: an app's own components](docs/guides/a-business-apps-screens.md#shared-ui-an-apps-own-components).
- Build a form with labelled inputs → `Form`, `Field`, `Input` →
  [Forms](docs/guides/the-web-toolkit.md#forms).
- Search, sort and page a list → `DataTable`, `tableAddress`, `tableQuery` →
  [Tables and their files](docs/guides/the-web-toolkit.md#tables-and-their-files).
- Choose a day, time or range → `DatePicker`, `DateTimePicker`, `DateRangePicker` →
  [Dates](docs/guides/the-web-toolkit.md#dates).
- Save from a View handler → `ctx.db.collection(name).insertOne/updateOne/deleteOne` →
  [The rules every screen keeps](docs/guides/a-business-apps-screens.md#the-rules-every-screen-keeps).

**Files, exports and paper**

- Export a table to CSV/JSON/SQL/PDF with totals → `DataTable exportOptions/formats/footerRows` →
  [Exporting a table](docs/guides/the-web-toolkit.md#exporting-a-table).
- Share a custom file format across screens → `TableExportFormats` →
  [Exporting a table](docs/guides/the-web-toolkit.md#exporting-a-table).
- Put New or Print beside the table controls → `DataTable toolbar` →
  [A toolbar of your own](docs/guides/the-web-toolkit.md#a-toolbar-of-your-own).
- Show a page-size menu with one choice → `DataTable/Pagination showSinglePageSize` →
  [A toolbar of your own](docs/guides/the-web-toolkit.md#a-toolbar-of-your-own).
- Print or email a table with aligned totals and a logo → `tablePdf` →
  [Printing a table](docs/guides/the-web-toolkit.md#printing-a-table).
- Place a transparent PNG or a JPEG on an invoice → `pdfImage/documentPdf` →
  [Images and barcodes in a document](docs/guides/the-web-toolkit.md#images-and-barcodes-in-a-document).
- Print a barcode on paper or screen → `documentPdf/Barcode/bars` →
  [Images and barcodes in a document](docs/guides/the-web-toolkit.md#images-and-barcodes-in-a-document).
- Make a barcode PNG for a product label or email → `barcodePng` →
  [Images and barcodes in a document](docs/guides/the-web-toolkit.md#images-and-barcodes-in-a-document).
- Compute or verify a product's EAN check digit → `eanDigits` →
  [Images and barcodes in a document](docs/guides/the-web-toolkit.md#images-and-barcodes-in-a-document).
- Print a screen → `NoPrint`, `PrintOnly` → [Printing](docs/guides/the-web-toolkit.md#printing).
- Build a PDF on the server → `documentPdf` from `copilotz/web/export` →
  [PDFs on a server](docs/guides/the-web-toolkit.md#pdfs-on-a-server).
- Read a file without loading it in a list → `projection`, `runtime.bytes` →
  [Pictures in a list](docs/guides/a-business-apps-screens.md#pictures-in-a-list).

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
- **Plain saves write the collection; Actions do what's more.** A screen's handler, a tool, a script
  and REST insert, update and delete documents directly, under the rules and the schema. An Action
  is for business logic: a rule a schema can't say, several writes that must agree, an effect
  outside (a message, a payment). Named queries and Views read, and never write while they render.

Plugins reach each other only through the runtime, by name. One that builds on another says so
(`requires: ["chat"]`) and imports only that plugin's `contract.ts`, never its code.

## Start a project

Start on Node 24 or newer:

```sh
npx copilotz@1.0.0-rc.64 init orders
cd orders
npm run check
npm run dev
```

Open the local address the server prints. The starter installs dependencies, configures Node to load
TSX, and includes an orders plugin with a collection, query, Action, web View and test.

In `app.ts`, list the plugins in order. In `plugins/<name>/`, each declaration is a file with a
default export. Put a collection's type and named queries in `collections/`, business logic in
`actions/`, and Views in `views/` (including `views/web/` and `views/terminal/`). Use `plugin.ts`
for fields such as `requires`, `defaults` and `guard`, `lib/web/` for React components, and
`contract.ts` for shapes other plugins import.

`copilotz gen` assembles the files, writes schemas from the TypeScript types, and records the app's
names in `copilotz-env.d.ts`. Commit that declaration and ignore `.copilotz/build/`. The server
imports `#copilotz/plugins/<name>/mod.ts`, the browser `web.ts` and the terminal `terminal.ts` from
the same folder. The starter's dev script watches declarations and the server. On Deno, the compiler
entry is `deno run -A jsr:@copilotz/copilotz@1.0.0-rc.64/gen`.

Existing plugins with a hand-written `mod.ts` keep their own assembly and explicit schemas. List
them alongside generated plugins in `app.ts`. [The compiler](docs/guides/the-compiler.md).

**Give the project its own guide.** Write `AGENTS.md` at its root, and `CLAUDE.md` holding the one
line `@AGENTS.md` (Claude Code reads `CLAUDE.md`, and follows the import). Keep it short and true:

```markdown
# AGENTS.md

This app runs on Copilotz (copilotz@1.0.0-rc.64). Read node_modules/copilotz/AGENTS.md first;
node_modules/copilotz/llms.txt lists the installed guides.

- `npm test` runs offline. Run `npm run build` after editing declarations. `npm run check` checks
  generated files, types, unused code, lint, formatting and the plugin's declaration.
- `app.ts` lists the plugins in order. Each file in a plugin's primitive folders default-exports its
  declaration. Put React components in `lib/web/`.
- Plain saves write the collection. Actions hold business logic. Keep access rules at the data
  (`shared` first, then a `guard`). Give each tool a `tool:<name>` View.
```

## A plugin, end to end

A collection, a tool that adds to it, an Action for what's more than a save, a View for the model, a
rule and an agent: `plugins/tasks/`, a file each.

Each path below is relative to `plugins/tasks/` until `app.ts`. The compiler names each declaration
from its file. The example adds tasks to the starter's orders app.

`collections/task.ts` declares the document and its open-tasks query. The plugin sets who may call
the query in `plugin.ts`.

```ts
import { defineCollection } from "copilotz";

export interface Task {
  /** @minLength 1 */
  title: string;
  done?: boolean;
  in: string;
}

export default defineCollection<Task>({
  queries: {
    open: (tasks) => tasks.find({ done: { $ne: true } }).toArray(),
  },
});
```

`resources/tools.ts`: a plain save, so the tool writes the collection itself (as its agent, for the
person it works for, under the rules):

```ts
import { failure } from "copilotz";
import { tool } from "copilotz/plugins/agents";

export default {
  // A plain save: the tool writes the collection, under the rules, as its agent's person.
  add_task: tool({
    description: "Adds a task to this chat's space",
    input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    run: async ({ title }, ctx) => {
      if (!ctx.in) throw failure("invalid", "Add tasks in a space.", { public: true });
      const { insertedId } = await ctx.db.collection("task").insertOne({ title, in: ctx.in });
      return { task: insertedId };
    },
  }),
  // An Action, as a tool: its description and input are the Action's.
  complete_task: { action: "task.complete" },
};
```

`actions/task.complete.ts`: completing a task holds a rule the schema can't say, so it's an Action,
the one way every caller completes one:

```ts
import { defineAction, failure } from "copilotz";

/** Done once, by whoever reaches the task: a rule the schema can't say, so an Action. */
export default defineAction({
  description: "Marks a task done, once",
  run: async (ctx, { task }: { task: string }) => {
    const tasks = ctx.db.collection("task");
    // The filter holds the rule: of two at once, one completes it.
    const { matchedCount } = await tasks
      .updateOne({ _id: task, done: { $ne: true } }, { $set: { done: true } });
    if (matchedCount) return { done: task };
    // Not one they reach, or done already: say which.
    if (!await tasks.findOne({ _id: task })) {
      throw failure("not_found", `No task ${task} here.`, { public: true });
    }
    throw failure("invalid", "That task is done already.", { public: true });
  },
});
```

`views/tasks.ts` shows the records the viewer can reach, with the ids a model needs to complete
them.

```ts
import type { ViewContext } from "copilotz";
import type { Task } from "../collections/task.ts";

export default function tasks(_: unknown, ctx: ViewContext) {
  const read = ctx.db.collection("task").query<(Task & { _id: string })[]>("open");
  const open = read.value ?? [];
  return open.length ? open.map((t) => `- ${t.title} (${t._id})`).join("\n") : "No tasks.";
}
```

`views/tool/add_task.ts` shows the list after a save. A failure passes its words to the model.

```ts
import type { ViewContext } from "copilotz";

export default (call: { output: string }, ctx: ViewContext) =>
  call.output.startsWith("Error:") ? call.output : ctx.show("tasks", {});
```

`views/tool/complete_task.ts` shows the same list after completion.

```ts
export { default } from "./add_task.ts";
```

`resources/shared.ts`, `resources/agents.ts` and `plugin.ts`:

```ts
/** The rule, at the data: a task lives in a space (its `in`), and its members reach it. */
export default { task: {} };
```

```ts
export default {
  helper: {
    default: true,
    instructions: "Keep tasks.",
    model: "helper",
    tools: ["add_task", "complete_task"],
  },
};
```

```ts
import { people, type Plugin } from "copilotz";

export default { requires: ["chat", "spaces"], defaults: { allow: people } } satisfies Partial<
  Plugin
>;
```

`app.ts` lists the plugins and sets the model alias the agent names. Without a key it's
`"fake/echo"`, Copilotz's offline model: it echoes what it's told, and calls a tool, with no input,
when the message names it ("add task" for `add_task`).

```ts
import { definePlugin, type Plugin } from "copilotz";
import { models } from "copilotz/plugins/models";
import { chat } from "copilotz/plugins/agents";
import { access, devSignIn } from "copilotz/plugins/access";
import orders from "#copilotz/plugins/orders/mod.ts";
import tasks from "#copilotz/plugins/tasks/mod.ts";

export function plugins(settings: { openai?: string } = {}): Plugin[] {
  const provider = settings.openai ? { openai: { apiKey: settings.openai } } : {};
  const model = { helper: settings.openai ? "openai/gpt-5.4-mini" : "fake/echo" };
  const app = definePlugin({ name: "app-settings", resources: { provider, model } });
  return [models, chat, ...access, devSignIn, orders, tasks, app];
}
```

## Test without an API key: the default loop

Run `npm run build` to generate and type-check changes, `npm test` after each change, and
`npm run check` before you stop. The starter checks generated files, types, unused code, lint,
formatting and the plugin's declaration. No test needs a key or the network. Run the app as `app.ts`
makes it, with fakes only where it meets the world: a scripted model (below);
`createRuntime({ clock: manualClock(Date.now()) })` and `clock.advance(ms)` for time;
`createRuntime({ fetch })` for what plugins call outside (`ctx.fetch`). A model provider is called
with the platform's `fetch`, so a fake one is a local server (`serve`, from `copilotz/testing`) set
as the provider's `baseURL`. `runtime.fetch(new Request(…))` tests HTTP without a port, and
`await runtime.idle()` waits until nothing is left to run.

**Mail in tests.** Trusted code sends invoices and receipts with `ctx.call("email.send", message)`.
In a test, import `captureEmail` and `email` from `copilotz/plugins/access/email`, make
`const inbox = captureEmail()`, register `adapters: { email: { capture: inbox } }` and select
`resources: { email: { adapter: "capture", from: "orders@example.com" } }`. Read `inbox.messages`
after the send and call `inbox.clear()` to empty it. The exported `mime(message, from).source`
builds its MIME source.
[Mail in tests](docs/reference/plugins/email.md#mail-in-tests-the-capture-adapter).

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

test("the agent adds a task for Ana; she completes it, once", async () => {
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
    const made = (await store.events(0)).find((e) => e.type === "task.created");
    assert.equal(personOf(made?.actor), "ana"); // the record: written for Ana…
    assert.equal(made?.actor?.kind, "agent"); // …by the agent
    const task = made!.data._id as string;
    const listing = `- Bo (${task})`;
    assert.equal(helper.sent[1].messages.at(-1)?.text, listing); // what the model read
    const seen = await runtime.observe<string>("tasks", {}, { actor: here }).ready;
    assert.deepEqual(seen, { status: "ready", value: listing }); // what Ana sees
    // Completing it is business logic: once, and refused after.
    await runtime.call("task.complete", { task }, { actor: here });
    await assert.rejects(runtime.call("task.complete", { task }, { actor: here }), /done already/);
  } finally {
    await runtime.close();
  }
});
```

Test what callers may not do as well: call as someone else, and `assert.rejects`. And a test that
reads each of the app's plugins as a tool does (`copilotz/describe`), and fails on what it finds
wrong (a schema that names no fields, a route outside the plugin's name), `tests/describe.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { describe } from "copilotz/describe";
import tasks from "#copilotz/plugins/tasks/mod.ts";

// Each of the app's own plugins, as a tool reads it: no schema that names no fields, no route
// outside its name, no setting outside its contract.
for (const plugin of [tasks]) {
  test(`${plugin.name} describes itself without problems`, async () => {
    assert.deepEqual((await describe(plugin)).listing.problems, []);
  });
}
```

And one that holds the app's plugins to their boundaries (`copilotz/testing`'s `boundaries`: one
imports another only through its `contract.ts`, and only one it `requires`),
`tests/boundaries.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { boundaries } from "copilotz/testing";
import { plugins } from "../app.ts";

test("each plugin imports another only through its contract, and requires it", () => {
  assert.deepEqual(
    boundaries({ root: new URL("../plugins/", import.meta.url), plugins: plugins() }),
    [],
  );
});
```

## Rules: do this, not that

- **A tool can be an Action, by name:** `tools: { complete_task: { action: "task.complete" } }`
  offers the model the Action's description and input, and calls it as the agent; don't write its
  schema twice. A tool that only saves writes the collection (`ctx.db`).
- **Plain saves are collection writes.** A screen's handler writes with its View's collections
  (`ctx.db.collection("customer").insertOne(…)`, `updateOne`, `deleteOne`), a tool with `ctx.db`, a
  script with `connect()`'s `db`, REST at `/api/collections/<name>`. Each writes as its caller,
  under the rules, checked against the schema, on the record as theirs. Don't write an Action that
  only saves what it's given.
- **An Action is for business logic,** and every way in calls it: a rule the schema can't say (done
  once, a stock that can't go below zero), writes that must agree, an effect outside. Never a
  second, looser path beside it: once a collection changes only by its Actions, refuse `direct`
  writes to it in the guard.
- **Rules at the data, `shared` first.** Name a collection in the `shared` resource: its documents
  live `in` a space (`field` says where else), `part` ties one to another document (a booking to its
  chat), `write: "manage"` keeps writes to managers. What `shared` can't say goes in the plugin's
  `guard` (in `plugin.ts`): `byCollection({ sale: …, item: … })`, a rule for each collection it
  rules and none for any other, its larger rules in `lib/guards/<collection>.ts`. A rule knows which
  write it's asked about (`write`: `"insert"`, `"update"`, `"replace"` or `"delete"`), so it can let
  people add and change documents but not delete them. Don't filter by who's asking inside an
  Action.
- **A schema says what a document is, and every write keeps to it.** Generated object schemas are
  closed. When writing a schema by hand, name each field and its type, say what's required, and
  close it (`additionalProperties: false`). Inserts and replaces are checked; so are updates, as
  MongoDB's `$jsonSchema` validator checks them: what `$set` gives must fit, a field the schema
  doesn't allow can't be set nor a required one unset, `$inc` counts numbers, and the document an
  update leaves must be valid. An update names its operators (`$set`, `$inc`, `$push`…): plugin
  code's update with none is refused (REST's `PATCH` and a View's `updateOne` set plain fields). A
  document older than its schema can still be updated with what fits; a migration fixes the rest.
- **Say who may call a plugin's Actions and queries once.** Set `defaults: { allow: people }` in
  `plugin.ts`. Each Action or query may override it, for example with `inPerson` when only the
  person decides. Without either, it's internal. An async `allow(actor, input, ctx)` reads with
  `ctx.db` as the caller, before a grant. An agent and its principal must both pass.
- **Give an Action the declarations it needs.** For no parameters, omit `input` and the second
  parameter to `run`. Call it with nothing or `{}`. Extra fields are refused. For a typed input,
  annotate `run`'s second parameter and generate. An explicit schema types both `run` and `allow`.
  For example, an inventory plugin can keep the permission check and the stock rule in its `lib/`.
  Its `actions/stock.issue.ts` then reads:

  ```ts
  import { defineAction } from "copilotz";
  import { canUse, issueOne } from "../lib/inventory.ts";

  export default defineAction({
    as: "inventory-adjust",
    transaction: true,
    run: (ctx, { product }: { product: string }) => issueOne(ctx.db, product, ctx.in),
    allow: canUse("inventory"),
  });
  ```

  `canUse` checks the caller before the grant. The writes record the grant and who called it. A
  throw rolls them back. If every inventory Action shares the check, move it to `defaults.allow`.
  [The full stock example](docs/reference.md#a-grant-and-a-transaction-for-the-whole-action).
- **A View for whatever anyone reads, a model included.** Each tool gets a `tool:<name>` View: short
  text, with ids the model can act on. A failed call's output is its error's words; pass them on,
  don't throw. An MCP server that offers a tool without its View doesn't start.
- **A View reads in its own body.** A React View reads with `ctx.db` and hands the result to its
  component, so it stays live. It writes only from its handlers, never while it renders.
- **Errors for callers are `failure(code, message, { public: true })`.** Only a public failure's
  words reach a caller outside or a model.
- **Settings are resources, not code.** `app.ts` reads no environment: the server, the terminal or a
  test passes settings in. Agents name a model alias that the app sets.
- **Writes that must agree use `transaction: true` for a whole Action or one `ctx.transaction` for
  part of it.** A refused write rolls it all back. It holds the store's writer, so keep slow work
  out. Another plugin's Action joins it with `tx.call` when that Action declares `transaction: true`
  or `atomic: true`.
- **Who acts:** `personOf(ctx.actor)`, not `ctx.actor.id` (an agent's is its own). Where: `ctx.in`.
  A tool works where its chat is.
- **Going past the actor's reach is a named grant,** `as: "inventory-adjust"` for a whole Action or
  `ctx.as(grant("…"))` for one operation, in trusted code, on the record. Keys stay in code: never
  in Action inputs (they're recorded), never with a model.
- **An agent tells a conversation only what everyone in it could see.** Its work reads what both its
  asker and the place its answer goes reach: a space and what it draws on; a customer's chat, what
  that customer reaches (a space drawing on another with `contacts: "read"` lets them read it); its
  person's Personal space, all they reach. Writing anywhere its readers don't all reach that asks
  the person first (`needs_approval`): don't catch it, let it through to the turn.
- **A tool that goes past its caller, offered to a contact or the public, is a declassifier.** Scope
  it to them (their own bookings, never any record), take no free-form query that could widen it,
  and return only what they may see. In a customer's chat, an Action people call that goes past its
  caller is refused; an internal Action (no `allow` of its own or inherited) runs as its tool chose.
  The public (`publicCallers`, `{ kind: "public" }`) reads only spaces that have it as a viewer, and
  writes nothing.
- **Outside effects:** write the intent, call out with its id as the idempotency key (a tool's
  `callId`), then write the result.
- **Online:** `devSignIn` is for this machine only; Copilotz won't start it with a public origin.
  Keep the `links` secret (32 bytes or more) across restarts, or MCP conversations start over.

## The record and bytes

**The record lasts as the store does.** Each commit appends its events to the `events` table, and
the runtime never changes or deletes one. An event is `{ seq, id, type, data, cause, actor, at }`:
`cause` is the event behind it, `actor` the whole actor (`for`, `in`, `via`), `at` its commit's
time. `action.started` holds `{ action, input, inputHash, startedAt, attempt }`, `action.completed`
the `result`, a collection's event `{ _id, doc }`. Read it with `store.events(afterSeq, limit)` in a
test or script, `runtime.subscribe` live, or SQL (`sqlite3`, `psql`,
[maintenance](docs/operations/maintenance.md)). Plugin code reads no log.

**Kept out:** a collection's `private` fields (keys, tokens), an Action's `private` fields, an
unrecorded Action's call (`record: false`; not its writes), and collections with `events: false` or
`durable: false`. All else an Action is given stays for good.

**Large values.** A string over 16 KiB is a blob, stored once by its hash: documents and events keep
a reference, and reads load it whole unless a `projection` leaves the field out. Blobs live in the
store, or in files or a bucket (`createRuntime({ blobs })`), chosen before it fills. A file is a
string (a `data:` address, base64). Nothing deletes a blob: a value deleted or replaced stays on the
record. [Stores](docs/operations/stores.md) and
[BC 36](docs/build-compass/part-12-shipping/36-postgresql-and-blobs.md) have the rest.

**A list reads names, not pictures:** its query leaves them out (`projection: { picture: 0 }`), and
each row shows `/pictures/<id>`, a route that checks who asks before it reads. With `{ actor }`,
`runtime.bytes` reads only where a rule speaks for the collection (else it's refused); `service` has
none, so it's read as the system:

```ts
import { definePlugin, people } from "copilotz";

const PICTURE = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/;

export const pictures = definePlugin({
  name: "pictures",
  routes: {
    "/pictures/:id": async (_request, { runtime, actor, params }) => {
      const none = new Response("Not found", { status: 404 });
      if (!people(actor)) return none;
      const kept = await runtime.bytes("service", { _id: params.id }, "picture");
      if (!kept) return none;
      const text = new TextDecoder().decode(await kept.read(0, kept.size));
      const [, type, base64] = PICTURE.exec(text) ?? [];
      if (!base64) return none;
      const body = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      return new Response(body, {
        headers: { "content-type": type, "x-content-type-options": "nosniff" },
      });
    },
  },
});
```

**Common mistakes:** a list reading pictures whole; a key in an Action's input or in a field that
isn't `private`; a route reading before it checks who asks; counting on a delete to erase a file.

## A business app's web front end

Screens for people at work: lists, forms in dialogs, dates, a home, printed documents.
[A business app's screens](docs/guides/a-business-apps-screens.md) builds each one in full, as files
that compile; [the web toolkit](docs/guides/the-web-toolkit.md) has every piece, prop and token.
Read both before the first screen.

**Files and names.**

- **One View per file** in `plugins/<name>/views/web/`. A folder gives it its prefix
  (`screen/orders.tsx` is `screen:orders`). The compiler writes the web entry point.
- **React components live in `lib/web/`.** Use the plugin's for its own Views, including a component
  with hooks. Use the app's `lib/web/`, beside `plugins/`, for a status badge, table preset or form
  section used across plugins. Build them from the toolkit. The compiler reads `views/**` as Views
  and skips `lib/`.

- **A name says where a View shows.** `screen:<place>` is a whole screen at `/<place>…`.
  `dialog:<name>` is a dialog over a screen, at an address of that screen (`/customers/12`), so Back
  closes it and the list behind keeps its page. `panel:<name>` is a part of another View that reads
  its own data.
- **The app's frame** is a View named `web.shell`, the one the web host observes for the address:
  given `{ path, query }`, it draws the bars and shows ``ctx.show(`screen:${place}`, where)``. List
  its plugin last among the browser's. Under Copilotz's own shell (`webShell`), `/<kind>/<id>` shows
  the View named `<kind>` or `web.<kind>` instead.

**Views read; handlers save, or call Actions.**

- **A View reads in its own body** with `ctx.db`: a named query, `.query(name, params)`, or `find`,
  `findOne`, `countDocuments`. A read is `{ status: "loading" }`, then `{ status: "ready", value }`,
  and the View runs again when a commit changes it. It hands values to React components. Don't fetch
  in an effect, poll, or call `/api/` from the page.
- **Screens read named queries admitted by `allow`**, their own or the plugin default. They run on
  the server as whoever asks. In the browser a View's own `find` reaches only a collection a rule
  speaks for (`shared`, or a `guard`); any other answers `forbidden` ("You can't see this here").
- **Handlers save with the View's collections:** `ctx.db.collection("customer").insertOne(record)`,
  `updateOne({ _id }, fields)` (plain fields are set), `deleteOne({ _id })`, as the person: under
  the rules (one must speak for the collection's writes), checked against the schema, recorded as
  theirs. What's more than a save is an Action, called with `ctx.call(name, input)`. A View writes
  and calls nothing while it renders. Suggestions as someone types come from an unrecorded Action
  (`record: false`, with an `allow`) that runs the query.
- **A View is a function the runtime runs again, not a component:** no hooks, no state. A form's
  draft, a chosen file and `useShortcuts` live in a component the View returns.
- **`ctx.show(name, item)` goes in a View's body only.** It's how a View shows a View: what it
  returns is a part that reads and redraws on its own, handed to a component as a child or a prop.
  Another plugin's View is shown by name, without importing its code (`undefined` when there's
  none). Called later (a component's render, a handler, a table's `render` or `detail`), it throws:
  `<LazyView kind="panel:…" item={…} />` shows a View on demand.
- **Validation errors come from where the write is checked.** The browser's `required` and `type`
  help first. A save the schema refuses rejects with a public `invalid` that names its field
  (`detail: { field: "price" }`), and the form can catch it and pass a message to that `Field`'s
  `error`. An Action's own rule throws `failure("invalid", "Give the name.", { public: true })`,
  with `detail: { field }` when it's about one field (`Object.assign(failure(…), { detail })`), and
  the form shows it at its top or by its field. An Action's `input` schema's messages are for
  developers, so a form says each field's refusal its own way (`{ name: "Give the name." }`, by
  `detail.field`), and the schema's text where it has none. A record whose fields the server sets
  (who made it, when, a number in a sequence) keeps an Action: a browser's View doesn't know who's
  looking. A dialog closes only after the save, or the Action, answered.

**Toolkit first.**

- **Every screen is the toolkit's pieces**, `copilotz/web`, layout included. The look is the theme's
  configuration and nothing else: the `theme` resource's colours (`light`, `dark`), sizes (`tokens`)
  and each piece's own tokens (`button-height`, `table-stripe`…). No stylesheet, no `style={{…}}`
  for a look, no rule on a `.copilotz-*` class, no restyled copy of a piece. `className` may name an
  element for a test, never restyle it.
- **Something the toolkit lacks is a gap to report**, with the smallest example of what's needed,
  never a reason for CSS. Compose first: most "missing" pieces are a `Grid`, a `Stack` or a `Card`
  of existing ones.
- **The one exception is a printed document's paper layout**: `@media print` rules beside it.
- **Words and formats are the app's.** The toolkit's words (`toolkit.noRows`, the date presets) are
  changed by key in the `words` resource
  ([WORDS.md](https://github.com/copilotzhq/copilotz/blob/main/hosts/web/WORDS.md) lists them). Time
  zone and date patterns are settings the screens read, never the browser's locale.
- **Where the names are:** the toolkit guide's sections and its "Every piece's tokens" tables; the
  types, `node_modules/copilotz/hosts/web/toolkit/*.d.ts`, and the theme's,
  `node_modules/copilotz/hosts/web/theme/default.d.ts`.

The pieces, by job:

- **Layout:** `Page`, `Screen`, `Stack`, `Grid`, `GridItem`, `Toolbar`, `Split`, `Card`,
  `ListGroup`, `Tabs`, `Divider`, `Spacer`, `Heading`, `Text`.
- **Fields:** `Form`, `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`,
  `Picker`, `MultiPicker`, `Autocomplete`, `TagsInput`, `FileInput`, `RowsEditor`, `DatePicker`,
  `DateRangePicker`, `DateTimePicker`, `TimeFields`.
- **Actions and overlays:** `Button`, `IconButton`, `Menu`, `Popover`, `Dialog`, `Drawer`,
  `Tooltip`, `toast` and `Toasts`.
- **Data:** `DataTable` (with `tableAddress`, `tableQuery`), `Pagination`, `DetailList`, `Badge`,
  `Chip`, `Avatar`, `Notice`, `EmptyState`, `Skeleton`, `Spinner`, `Kbd`.
- **An app's own frame:** `AppBar`, `TopBar`, `TileGrid`, `LiveClock`, `Logo`, `Icon` (`drawing`: an
  app's own glyph).
- **Paper and files:** `NoPrint`, `PrintOnly`, `Barcode`, `download`, `exportFile`; on a server,
  `documentPdf` from `copilotz/web/export`. **Keys:** `useShortcuts`, `shortcutLabel`.

**Short recipes** (whole, in the guide):

- **A list with search, filters, paging and exports:** a `Page` (`width="lg"`, New in `actions`)
  over a `Toolbar` of filters and a `DataTable`. Up to a few thousand rows, give the table every row
  and it searches, sorts, pages and exports them (`exportAll`: every matching row). More, a named
  query takes the table's state and answers `{ rows, total }`: spread `tableAddress(where, 25)` on
  the table, give it `total`, and keep each filter in the address too, back to the first page
  (`go(path + tableQuery(where, { ...state, offset: 0 }, { from, to }))`). The export menu saves the
  rows shown; every row of a server-paged list is an unrecorded Action's, saved with `download`.
- **Custom table files and totals:** give `DataTable` `formats` (or the shell
  `<TableExportFormats value={formats}>`), `exportName` and `footerRows` by column key.
  `exportOptions` sets CSV's dialect, JSON's shape, SQL's `tableName`, `values: "raw"` and the PDF
  layout. Give `toolbar` a button or filter; `showSinglePageSize` keeps a lone size visible.
  [Exporting a table](docs/guides/the-web-toolkit.md#exporting-a-table).
- **Invoices and product labels:** in an Action, `copilotz/web/export` has `exportFile` and
  `tablePdf` for a report with totals. Prepare a logo with `await pdfImage(bytesOrDataUrl)` for its
  header or a `documentPdf` page. Draw Code 128, Code 39 or EAN-8/13 with `Barcode` on screen,
  `{ barcode, format, x, y, width, height }` in a PDF and `await barcodePng(value, options)` for an
  image.
  [Images and barcodes in a document](docs/guides/the-web-toolkit.md#images-and-barcodes-in-a-document).
- **A create or edit form in a dialog:** the screen shows
  `ctx.show("dialog:customer", { _id, back })` when its address names one (`/customers/new`,
  `/customers/<id>`). The dialog's View reads the record and returns a component: a `Dialog`
  (`placement="top"`) around a `Form` of `Field layout="row"`s, Save in its footer submitting the
  form by its id (`form="customer"`). `onSubmit` writes the record (`insertOne` for a new one,
  `updateOne({ _id }, fields)` for an edit), then `toast()` and `go(back)`.
- **Date, date-time and date-range fields:** days are `YYYY-MM-DD` and times `YYYY-MM-DD HH:mm` or
  `HH:mm:ss`, the app's clock time with no zone, never ISO timestamps. `todayIn(timeZone)` and
  `nowIn(timeZone)` in the app's zone, `format` patterns from its settings. `DatePicker`;
  `DateTimePicker` keeps a value's seconds until its time changes (`seconds` shows them);
  `DateRangePicker` has `presets` (or `rangePresets(…)`), typed From and To, and `time` for ends
  with a time of day.
- **A sign-in page:** Copilotz's own, with `passwordSignIn` (staff with usernames) or `emailSignIn`:
  the theme gives its look (`themeOf([look])` on the server), the `signInPage` resource its words
  and pitch. Accounts come from an Action of the app's that calls `password.set`. Don't write a
  sign-in route or a session cookie. A page before sign-in is `routePage` (`copilotz/web/server`)
  with a `Screen`, which centres a card and keeps a footer at the window's foot.
- **A home of tiles with an app bar:** the frame's `web.shell`: a `TopBar` (`LiveClock`, who's
  signed in, Sign out with `signOut()`), an `AppBar` (`items`, `active`), the screen, and
  `<Toasts />` once. At `/`, a `Page` of a `TileGrid`.
- **A printed document:** a screen at its own address: a `Page` with Print in a `NoPrint`, its
  content (`DetailList`, `DataTable`, `Barcode`), `PrintOnly` for paper's words, and the paper's
  `@media print` rules beside it. It prints without the bars, buttons or the page's header
  (`printHeader` keeps it). The same as a PDF on a server, for e-mail: `documentPdf`.
- **Keyboard shortcuts:** `useShortcuts({ "Alt+N": add, Escape: { run: close, inFields: true } })`
  in a component of the screen, and `<Kbd>{shortcutLabel("Alt+N")}</Kbd>` where it's offered. Keys
  wait while someone types in a field or a dialog is open. No `keydown` listener on `document`.
- **File and image inputs:** `FileInput` (`accept`; `chooseLabel`, `changeLabel`, `removeLabel`;
  `current` and `onRemove` for a stored file). A picture chosen shows in an `Avatar`
  (`picture={URL.createObjectURL(file)}`, `initial={false}`). The form sends it to an Action as a
  `data:` address; `private: ["picture"]` keeps it out of the call's record, and a list shows it
  from a route (The record and bytes).

**Common mistakes:**

- Stylesheets of the app's own, inline styles for looks, or overrides of `.copilotz-*`, instead of
  the toolkit and the theme; components several screens share copied into each, instead of one in
  `lib/`. Hand-made `<table>`s of fields (use `DataTable` with fields in cells, or `RowsEditor`), a
  hidden `<input type="file">` behind buttons (`FileInput`), the browser's `datetime-local`
  (`DateTimePicker`), a `document` key listener (`useShortcuts`), a form part listening for the
  DOM's `submit` (`Form` and `useFormSubmit`).
- One big `web.tsx`; a View that holds state or hooks; a screen fetching `/api/queries/…` from an
  effect instead of reading `ctx.db` in the View; a browser View's `find` on a collection no rule
  speaks for, instead of a named query; `ctx.show` in a row's `render`.
- An Action that only saves what a form gives it (`customer.save`), where the collection write does.
  A refusal returned as a value (`{ ok: false }`) instead of a thrown public `failure`: the REST API
  answers 200 and a script believes it worked. A second Action, or a second input shape, for
  scripts.
- A table's page, sort and filters kept in component state: Back and a closed dialog lose them. Keep
  them in the address.
- Forms as pages, a capability reachable only by an Action no screen calls, a disabled placeholder
  for a field that should work. Open every screen in a browser and use it, not only its tests.
- A save per field on blur, racing the next one: keep a record's edits together and send them once
  (Save, or a row's Update and Enter).
- Dates in the browser's locale (`toLocaleString`, `<input type="date">`) or as ISO timestamps given
  to a picker; a function `format` on a range people type into (it can't be read back: use a
  pattern); a record's date-time saved unchanged without its seconds.
- A `controlWidth` from rc.52–53 or from a CSS-grid habit. Both `labelWidth` and `controlWidth` are
  shares of the whole row: `"33.33%"` and `"66.67%"` fill it.
- A workaround copied from an older release: rc.54 has `Screen`, typed range ends, seconds, `hidden`
  on layout pieces, fields that fit table cells, `detailOpen`, `Toolbar grow`, a file field's own
  words and picture previews.

## Recipes

Each link is a page as Markdown. GS is Getting Started (a salon's bookings, 10 chapters). BC is
Build Compass (41 chapters, written for an earlier release candidate: check names in the reference).

- A plugin: [GS 1](docs/getting-started/01-one-booking.md). People, contacts, spaces, the rules:
  [GS 2](docs/getting-started/02-who-sees-what.md).
- The web: [GS 3](docs/getting-started/03-its-own-web-page.md),
  [serving on the web](docs/guides/serving-on-the-web.md). An agent and its tools:
  [GS 4](docs/getting-started/04-its-own-agent.md).
- MCP: [GS 5](docs/getting-started/05-chatgpt-claude-and-gemini-over-mcp.md). One test, every way
  in: [GS 6](docs/getting-started/06-the-same-bookings-every-way-in.md).
- Widgets: [GS 7](docs/getting-started/07-a-widget-in-the-assistant.md). A site's chat:
  [GS 8](docs/getting-started/08-a-chat-on-your-site.md). WhatsApp:
  [GS 9](docs/getting-started/09-whatsapp.md).
- Shipping (SQLite, PostgreSQL, sign-in by email):
  [GS 10](docs/getting-started/10-shipping-the-salon.md). A container of 512 MiB or less (Deno 2.9+,
  `--max-semi-space-size=2`, SQLite's cache, each plugin from its own entry point):
  [memory](docs/operations/memory.md).
- The prompt and context Views:
  [BC 2](docs/build-compass/part-1-an-agent-of-your-own/02-north-in-your-terminal.md),
  [BC 4](docs/build-compass/part-2-your-own-plugins/04-today-every-turn.md).
- A Processor, below; more in
  [BC 6](docs/build-compass/part-2-your-own-plugins/06-chats-that-name-themselves.md). Transactions:
  [BC 9](docs/build-compass/part-3-the-board/09-the-boards-data-and-actions.md).
- Schedules and a manual clock:
  [BC 27](docs/build-compass/part-8-skills-and-routines/27-routines-on-a-schedule.md). Fakes at the
  edges: [BC 31](docs/build-compass/part-10-testing/31-fakes-at-the-edges.md).
- Scripts over REST: [REST and the client](docs/guides/rest-and-the-client.md). Many orgs:
  [many orgs](docs/guides/many-orgs.md).
- Every entry point, option, event and context field: [reference](docs/reference.md). Each of
  Copilotz's plugins (`chat`, `spaces`, `mcp`…): [plugins](docs/reference/plugins.md). How it runs:
  [architecture](docs/architecture.md).

**An Action's schema from its type.** In a plugin built by `copilotz gen`, give the default export's
`run` a typed second parameter. The generator uses the app's `typescript` devDependency to make its
`input` in `mod.ts`. A field's comment reaches the model. A tag puts a constraint in the schema
checked for every caller.

```ts
import { defineAction } from "copilotz";

export default defineAction({
  description: "Calculate an order line's total in cents.",
  run: (_ctx, input: {
    /** Number of units ordered.
     * @integer
     * @minimum 1
     */
    quantity: number;
    unitPrice: number;
  }) => input.quantity * input.unitPrice,
});
```

A hand-written `input` wins. Use one in a plugin with a hand-written `mod.ts`, or to share an
existing schema. [Actions](docs/reference.md#actions).

**A collection's schema from its type.** In a plugin built by `copilotz gen`, use
`export default defineCollection<Order>({ indexes: [["customerId"]] })`. The compiler writes its
schema and a named collection read knows `Order & { _id: string }`. Leave `_id` out of the document
type. Write timestamps as `string` with `/** @format date-time */` on the field. An explicit
`schema` wins. [The compiler](docs/guides/the-compiler.md#a-collection-from-its-type).

**Schema-first collections and Actions.** When a plugin shares an existing JSON Schema or assembles
its own `mod.ts`, pass `schema` to `defineCollection` and `input` to `defineAction`. Use `as const`
on a schema kept in a variable. `Infer<typeof schema>` names its TypeScript type. An explicit schema
takes precedence when generating too.

```ts
import { defineCollection, type Infer } from "copilotz";

const schema = {
  type: "object",
  properties: { code: { type: "string", minLength: 1 } },
  required: ["code"],
  additionalProperties: false,
} as const;

export type Product = Infer<typeof schema>;
export default defineCollection({ schema });
```

**A Processor, for what follows a commit.** What must happen with a write goes in its transaction
(`ctx.transaction`); what follows it (a count, a message, a call outside) is a Processor: it hears
the events it names after they commit, at least once and in order, and runs as their actor. A
collection's `<name>.updated` event holds `{ _id, doc, changed, removed }`, so `where` wakes it only
for what it's about. `processors/tally.ts`:

```ts
import type { ProcessorDef } from "copilotz";

/** Once a task is done, its space's tally counts it: after the commit, retried until it's done. */
export default {
  on: "task.updated",
  where: { changed: "done", "doc.done": true },
  run: async (ctx, event) => {
    const space = (event.data.doc as { in: string }).in;
    await ctx.db.collection("tally")
      .updateOne({ _id: space }, { $inc: { done: 1 } }, { upsert: true });
  },
} satisfies ProcessorDef;
```

## Entry points

The same names on npm (`copilotz/…`) and JSR (`@copilotz/copilotz/…`); the package's `package.json`
lists them all. Besides those above: `copilotz/stores/sqlite` and `copilotz/stores/postgres`
(stores), `copilotz/plugins/interfaces` (`mcp`, `api`, `whatsapp`, `voice`, `webLines`),
`copilotz/web` (the web host, `web`), `copilotz/web/pt-br` (`ptBR`: every web word in Brazilian
Portuguese, first among the page's plugins), `copilotz/web/server` (`webPage`), `copilotz/web/node`
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
