# A plugin, step by step

From an empty folder to a tested plugin, in the shape the docs use. AGENTS.md has a smaller version
of this app in one piece ("A plugin, end to end"). This file builds it in steps, adds a second
Action and a rule against writes from outside, and says why each piece is there. On a version newer
than this skill, `node_modules/copilotz/AGENTS.md` wins.

## 1. The project

Install as [SKILL.md](../SKILL.md) says (`copilotz@next` on Node 24+). Node runs `.ts` files as they
are, so there's no build step, but `tsc` and the editor need to know imports end in `.ts`. This
`tsconfig.json` comes from
[Build Compass, "What you need"](https://copilotz.com/docs/build-compass.md):

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2024", "DOM", "DOM.Iterable", "DOM.AsyncIterable"],
    "types": ["node"],
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": false,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

Node doesn't run `.tsx`, which web Views are, so every script loads a loader hook first: `tsx.ts`,
which registers `tsx-hooks.ts`, at the project's root.

```ts
// tsx.ts
import { register } from "node:module";

register("./tsx-hooks.ts", import.meta.url);
```

```ts
// tsx-hooks.ts: a .tsx module, made JavaScript by esbuild as it loads.
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

type Loaded = { format?: string; source?: string; shortCircuit?: boolean };
type Next = (url: string, context: unknown) => Promise<Loaded>;

export async function load(url: string, context: unknown, next: Next): Promise<Loaded> {
  if (!url.startsWith("file:") || !url.endsWith(".tsx")) return next(url, context);
  const { code } = await transform(await readFile(new URL(url), "utf8"), {
    loader: "tsx",
    jsx: "automatic",
    format: "esm",
    target: "es2024",
    sourcefile: url,
  });
  return { format: "module", source: code, shortCircuit: true };
}
```

The scripts, in `package.json`, each through the loader (`dev` and `start` once there's a server):

```json
"scripts": {
  "test": "node --import ./tsx.ts --disable-warning=ExperimentalWarning --test --test-timeout=60000 --test-concurrency=1 \"tests/*.test.ts\"",
  "check": "tsc --noEmit -p .",
  "dev": "node --import ./tsx.ts --env-file-if-exists=.env --watch server.ts",
  "start": "node --import ./tsx.ts server.ts"
}
```

The layout:

```text
app.ts            plugins(settings): every plugin, in order. It reads no environment.
plugins/<name>/
  mod.ts          assembles the plugin from its folders, and nothing else
  plugin.ts       optional: its single fields (requires, guard, who, check)
  collections/    one file per collection: its schema, its type (Infer), its named queries
  actions/        one file per Action: business logic, never a plain save
  processors/ views/ resources/ routes/ …   one file per declaration (views/web/ for the web)
  lib/            what its files share
  contract.ts     what other plugins may import: shapes and small helpers, never code
  web.tsx         names its web Views; terminal.ts, its terminal ones
server.ts         the web host: reads the environment, passes settings to plugins()
tsx.ts, tsx-hooks.ts   the loader every script imports
tests/kit.ts      the app as app.ts makes it, in memory, with a scripted model
tests/*.test.ts
.env              OPENAI_API_KEY=… (optional; dev reads it)
```

It's the layout of Copilotz's own plugins: a folder per primitive, one declaration per file, and
`mod.ts` only puts them together. Don't invent others.

**Give the project its own guide.** Write a short `AGENTS.md` at its root that says it runs on
Copilotz, sends agents to `node_modules/copilotz/AGENTS.md` and https://copilotz.com/llms.txt, and
names the commands (`npm test`, `npm run check`) and where things are. Add a `CLAUDE.md` holding the
one line `@AGENTS.md`, since Claude Code reads `CLAUDE.md` and follows the import.

## 2. The data, under the rules

A collection is a JSON Schema, in `plugins/tasks/collections/task.ts`, with its type and its named
queries beside it. Every write keeps to the schema, updates included:

```ts
import { defineCollection, type Infer, people } from "copilotz";

const schema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    done: { type: "boolean" },
    in: { type: "string" },
  },
  required: ["title", "in"],
  additionalProperties: false,
} as const;

/** A task, as its schema says it: the type follows the schema. */
export type Task = Infer<typeof schema>;

export const task = defineCollection({
  schema,
  queries: {
    // What screens and Views list: the open tasks, of what whoever asks reaches.
    open: { allow: people, run: (tasks) => tasks.find({ done: { $ne: true } }).toArray() },
  },
});
```

`contract.ts` re-exports the type for other plugins
(`export type { Task } from
"./collections/task.ts";`). Naming the collection in the `shared`
resource (`resources/shared.ts`) puts it under the access plugin's rules: each task lives `in` a
space, and every read and write of it reaches only the spaces the actor reaches.

```ts
/** The rule, at the data: a task lives in a space (its `in`), and its members reach it. */
export const shared = { task: {} };
```

You write no "where `in` is one of the actor's spaces" filter. Bo asking for Ana's task gets
nothing, and Bo adding one into Ana's space is refused: "That "task" document would be out of your
reach."

## 3. Changing it: plain saves, and Actions for what's more

A plain save is a collection write, from wherever it's made: a screen's handler
(`ctx.db.collection("task").insertOne(…)`), a tool (`ctx.db`, section 5), a script (`connect()`'s
`db`), REST (`POST /api/collections/task`). Each writes as its caller, under the rules, checked
against the schema, and recorded as theirs: no Action needed.

An Action is for business logic. Completing a task happens once, a rule the schema can't say, so
it's an Action (`actions/complete.ts`), with an `allow` that names kinds of caller; a refusal meant
for the caller is a public `failure`:

```ts
import { defineAction, failure, people } from "copilotz";

/** Done once, by whoever reaches the task: a rule the schema can't say, so an Action. */
export const complete = defineAction({
  input: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
  allow: people,
  run: async (ctx, { task }) => {
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

When a collection should change only through its Actions, refuse writes from outside (the REST API,
a browser's socket, a View's handler) in the `guard`, in `plugin.ts`. Copilotz's boards and
documents do the same:

```ts
guard: (_actor, { collection, access, direct }) => {
  if (collection === "task" && direct && access === "write") {
    throw failure("forbidden", "Tasks change through their Actions.", { public: true });
  }
  return undefined; // no rule of its own: the access plugin's `shared` rule still holds
},
```

## 4. Views: what people and the model read

A View shows data in one place, and it reads as whoever looks. A text View serves the terminal and a
model. Each tool gets a `tool:<name>` View: what the model reads after it calls the tool. Keep it
short, with the ids the model needs for its next call.

```ts
import type { ViewContext } from "copilotz";
import type { Task } from "./contract.ts";

views: {
  tasks: (_: unknown, ctx: ViewContext) => {
    const found = ctx.db.collection<Task>("task").find({}).value ?? [];
    if (!found.length) return "No tasks.";
    return found.map((t) => `- [${t.done ? "x" : " "}] ${t.title} (${t._id})`).join("\n");
  },
  "tool:add_task": (_call: unknown, ctx: ViewContext) => ctx.show("tasks", {}),
  "tool:finish_task": (_call: unknown, ctx: ViewContext) => ctx.show("tasks", {}),
},
```

Reads in a View answer at once (`.value` is there when it's ready), and the runtime runs the View
again until nothing new is read. Observed, it runs again when a commit changes what it read. React
Views for the web read the same way and hand the result to a component:
[Getting Started, chapter 3](https://copilotz.com/docs/getting-started/03-its-own-web-page.md).

## 5. A tool and an agent

A tool writes as its agent, for the chat's person, where its chat is (`ctx.in`), so the rules are
asked of both: a plain save writes the collection, and what's more calls the Action. An agent names
a model alias, never a model.

```ts
import { failure } from "copilotz";
import { tool } from "copilotz/plugins/agents";

resources: {
  shared: { task: {} },
  tools: {
    add_task: tool({
      description: "Adds a task to this chat's space",
      input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      run: async ({ title }, ctx) => {
        if (!ctx.in) throw failure("invalid", "Add tasks in a space.", { public: true });
        const { insertedId } = await ctx.db.collection("task").insertOne({ title, in: ctx.in });
        return { task: insertedId };
      },
    }),
    finish_task: tool({
      description: "Marks a task done, by its id",
      input: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      run: ({ task }, ctx) => ctx.call("task.complete", { task }),
    }),
  },
  agents: {
    helper: {
      default: true,
      instructions: "Keep the tasks of this space.",
      model: "helper",
      tools: ["add_task", "finish_task"],
    },
  },
},
```

`mod.ts` assembles the files, `plugin.ts` holds `requires` (and the guard):

```ts
import { definePlugin, type Plugin } from "copilotz";
import plugin from "./plugin.ts";
import { task } from "./collections/task.ts";
import { complete } from "./actions/complete.ts";
import { tasks as tasksView } from "./views/tasks.ts";
import { addTask } from "./views/tool-add-task.ts";
import { agents } from "./resources/agents.ts";
import { shared } from "./resources/shared.ts";
import { tools } from "./resources/tools.ts";

export const tasks: Plugin = definePlugin({
  name: "tasks",
  ...plugin,
  collections: { task },
  actions: { "task.complete": complete },
  views: { tasks: tasksView, "tool:add_task": addTask },
  resources: { shared, tools, agents },
});
```

## 6. The app

`app.ts` lists the plugins in order and sets the model alias. It reads no environment: the server,
the terminal or a test passes settings in. Without a key, the alias is `"fake/echo"`, the offline
model, which echoes what it's told and calls a tool, with no input, when the message names it.

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

Plugins merge in order. A later plugin's resources patch an earlier one's (objects merge, `null`
removes), so `app-settings` can change one agent's `effort` without redefining it.

## 7. Test it, then take it further

Write `tests/kit.ts` and the first tests as [testing](testing.md) shows, and run `npm test`. Then:

- **The web:** a page and its server,
  [Getting Started, chapter 3](https://copilotz.com/docs/getting-started/03-its-own-web-page.md),
  and [serving on the web](https://copilotz.com/docs/guides/serving-on-the-web.md).
- **MCP:** the same tools for ChatGPT, Claude and any MCP client,
  [chapter 5](https://copilotz.com/docs/getting-started/05-chatgpt-claude-and-gemini-over-mcp.md).
  An MCP server offers a tool only with its `tool:<name>` View.
- **Customers:** contacts, spaces and who sees what,
  [chapter 2](https://copilotz.com/docs/getting-started/02-who-sees-what.md).
- **Processors:**
  [chats that name themselves](https://copilotz.com/docs/build-compass/part-2-your-own-plugins/06-chats-that-name-themselves.md).
  **Schedules:**
  [routines on a schedule](https://copilotz.com/docs/build-compass/part-8-skills-and-routines/27-routines-on-a-schedule.md).
- **Shipping** on SQLite or PostgreSQL, with sign-in by email:
  [chapter 10](https://copilotz.com/docs/getting-started/10-shipping-the-salon.md).
- **Every option and context field:** [the reference](https://copilotz.com/docs/reference.md).
