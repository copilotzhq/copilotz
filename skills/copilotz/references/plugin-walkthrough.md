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

The scripts, in `package.json`. Add `dev` and `terminal` once there's a server and a terminal.

```json
"scripts": {
  "test": "node --disable-warning=ExperimentalWarning --test --test-timeout=60000 --test-concurrency=1 \"tests/*.test.ts\"",
  "check": "tsc --noEmit -p ."
}
```

Node doesn't run `.tsx`. Tests that load a `web.tsx` need a loader hook:
[Getting Started, chapter 3](https://copilotz.com/docs/getting-started/03-its-own-web-page.md) adds
a 24-line one, `tsx.ts`, and starts `npm test` with `--import ./tsx.ts`.

The layout:

```text
app.ts            plugins(settings): every plugin, in order. It reads no environment.
plugins/<name>/
  mod.ts          assembles the plugin, and nothing else
  contract.ts     what other plugins may import: shapes and small helpers, never code
  web.tsx         its web front end (React Views); terminal.ts, its terminal one
server.ts         the web host: reads the environment, passes settings to plugins()
tests/kit.ts      the app as app.ts makes it, in memory, with a scripted model
tests/*.test.ts
.env              OPENAI_API_KEY=… (optional; dev and terminal read it)
```

As a plugin grows, give each primitive its own file (`actions.ts`, `views.ts`…) or folder, with one
file per declaration. `mod.ts` only puts them together.

**Give the project its own guide.** Write a short `AGENTS.md` at its root that says it runs on
Copilotz, sends agents to `node_modules/copilotz/AGENTS.md` and https://copilotz.com/llms.txt, and
names the commands (`npm test`, `npm run check`) and where things are. Add a `CLAUDE.md` holding the
one line `@AGENTS.md`, since Claude Code reads `CLAUDE.md` and follows the import.

## 2. The data, under the rules

`plugins/tasks/contract.ts` is what other plugins may import from this one:

```ts
/** A task, as other plugins may read it. Shapes and small helpers only, never code. */
export type Task = { _id: string; title: string; in: string; done?: boolean };
```

In `plugins/tasks/mod.ts`, a collection is a JSON Schema. Naming it in the `shared` resource puts it
under the access plugin's rules: each task lives `in` a space, and every read and write of it
reaches only the spaces the actor reaches.

```ts
collections: {
  task: {
    schema: {
      type: "object",
      properties: { title: { type: "string" }, in: { type: "string" }, done: { type: "boolean" } },
      required: ["title", "in"],
    },
  },
},
resources: {
  shared: { task: {} }, // `{ part: "thread" }` would also tie each task to the chat it came from
},
```

You write no "where `in` is one of the actor's spaces" filter. Bo asking for Ana's task gets
nothing, and Bo adding one into Ana's space is refused: "That "task" document would be out of your
reach."

## 3. The only ways to change it: Actions

Every change is an Action, with an input schema and an `allow` that names kinds of caller. A page's
button, the agent's tool and a script all call the same one. A refusal meant for the caller is a
public `failure`.

```ts
import { defineAction, definePlugin, failure, people } from "copilotz";

const title = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
} as const;
const which = {
  type: "object",
  properties: { task: { type: "string" } },
  required: ["task"],
} as const;

// In definePlugin({ … }):
actions: {
  "task.add": defineAction({
    input: title,
    allow: people, // a person, their key, or an agent working for one; never a contact
    run: async (ctx, { title }) => {
      if (!ctx.in) throw failure("invalid", "Add tasks in a space.", { public: true });
      const { insertedId } = await ctx.db.collection("task").insertOne({ title, in: ctx.in });
      return { task: insertedId };
    },
  }),
  "task.done": defineAction({
    input: which,
    allow: people,
    run: async (ctx, { task }) => {
      // The rules filter the update: a task the caller doesn't reach matches nothing.
      const { matchedCount } = await ctx.db.collection("task")
        .updateOne({ _id: task }, { $set: { done: true } });
      if (!matchedCount) throw failure("not_found", `No task ${task} here.`, { public: true });
      return { task };
    },
  }),
},
```

To keep a collection changing only through its Actions, refuse writes from outside (the REST API, a
browser's socket) in a `guard`. Copilotz's boards and documents do the same:

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

A tool is a thin caller of an Action. It works where its chat is (`ctx.in`), as the agent, for the
chat's person, so `allow` and the rules are asked of both. An agent names a model alias, never a
model.

```ts
import { tool } from "copilotz/plugins/agents";

resources: {
  shared: { task: {} },
  tools: {
    add_task: tool({
      description: "Adds a task to this chat's space",
      input: title,
      run: ({ title }, ctx) => ctx.call("task.add", { title }),
    }),
    finish_task: tool({
      description: "Marks a task done, by its id",
      input: which,
      run: ({ task }, ctx) => ctx.call("task.done", { task }),
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

The whole plugin is
`definePlugin({ name: "tasks", requires: ["chat", "spaces"], collections,
actions, views, resources, guard })`,
typed `Plugin` and exported as `tasks`.

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
