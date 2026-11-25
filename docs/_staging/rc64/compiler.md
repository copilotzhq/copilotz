# The compiler and the project template

## CHANGELOG.md, under New

- **Plugins from their folders.** `copilotz gen` assembles the server, web and terminal entry points
  from one default export per file. An app chooses their order in `app.ts`, alongside its
  hand-written plugins. `--watch` follows edits, `--check` catches a stale build and `--eject` gives
  an app its assembly to keep.
- **Names checked with the app.** The compiler writes `copilotz-env.d.ts` from the plugins the app
  loads. An unknown Action, collection or query fails the type check. View names complete in the
  editor, and a host can still supply another.
- **A project to start from.** `copilotz init [dir]` makes a working orders app, with a TSX loader,
  one plugin, a test and the build, development and check scripts. The app checks unused code, lint,
  formatting and its plugin's declaration.

## AGENTS.md

### Start a project

Replace the setup through the paragraph immediately before “Give the project its own guide” with:

> Start on Node 24 or newer:
>
> ```sh
> npx copilotz@1.0.0-rc.64 init orders
> cd orders
> npm run check
> npm run dev
> ```
>
> The starter installs its dependencies, generates the host entry points and opens a local app with
> a collection, a query, an Action, a web View and a test. `app.ts` lists the plugins in order. Each
> file under `plugins/<name>/` default-exports its declaration. Keep shared helpers and shared UI in
> `lib/`, public shapes in `contract.ts`, and named queries in their collection. A plugin with a
> hand-written `mod.ts` keeps its assembly.
>
> `copilotz gen` writes `.copilotz/build/` (git-ignored) and `copilotz-env.d.ts` (committed). Import
> `#copilotz/plugins/<name>/mod.ts` on the server and `web.ts` or `terminal.ts` for a host. Node
> reads TSX through the starter's loader. On Deno the compiler is
> `deno run -A jsr:@copilotz/copilotz@1.0.0-rc.64/gen`.
> [The compiler](https://copilotz.com/docs/guides/the-compiler.md) gives every filename and option.

In the example app's own AGENTS.md, replace the first two bullets with:

> - `npm test` runs the tests offline. `npm run check` checks generated files, types, unused code,
>   lint, formatting and the plugin's declaration. Run both before handing a change over.
> - `app.ts` lists the plugins in order. The compiler assembles `plugins/<name>/` for each host.

In its third bullet replace “`mod.ts` assembles it” with “each file default-exports its
declaration”.

### A plugin, end to end

After the opening paragraph add:

> ```text
> plugins/tasks/
>   collections/task.ts
>   actions/task.complete.ts
>   views/tasks.ts
>   views/tool/add_task.ts
>   resources/agents.ts
>   resources/shared.ts
>   resources/tools.ts
>   plugin.ts
> ```
>
> Each declaration below is its file's default export. The compiler generates `mod.ts`.

Use these exact substitutions in the declaration examples:

| Replace                                                                               | With                                                                          |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `export const task = defineCollection(`                                               | `export default defineCollection(`                                            |
| `actions/complete.ts`                                                                 | `actions/task.complete.ts`                                                    |
| `export const complete = defineAction(`                                               | `export default defineAction(`                                                |
| `export const tools = {`                                                              | `export default {`                                                            |
| `export const agents = {`                                                             | `export default {`                                                            |
| `export const shared = {`                                                             | `export default {`                                                            |
| `export const tasks = (_: unknown, ctx: ViewContext) => {`                            | `export default function tasks(_: unknown, ctx: ViewContext) {`               |
| `views/tool-add-task.ts`                                                              | `views/tool/add_task.ts`                                                      |
| `export const addTask = (_call: unknown, ctx: ViewContext) => ctx.show("tasks", {});` | `export default (_call: unknown, ctx: ViewContext) => ctx.show("tasks", {});` |

End the `tasks` function with `}`. Remove “`mod.ts` assembles them” and its code block. In `app.ts`
and the declaration test use the generated import:

```ts
import tasks from "#copilotz/plugins/tasks/mod.ts";
```

### Test without an API key: the default loop

Replace the first two sentences with:

> Run `npm test` after every change and `npm run check` before you stop. The starter's checks
> include `copilotz gen --check`, `tsc --noEmit` with unused locals and parameters checked, ESLint,
> Prettier and a test for `describe()`'s problems. Every test runs offline.

### A business app's web front end, Files and names

Replace the first bullet with:

> - **One View per file**, in `plugins/<name>/views/web/`. A folder gives a View its prefix
>   (`screen/orders.tsx` is `screen:orders`). Shared UI components live in the plugin's `lib/` and
>   use the toolkit's pieces. The compiler writes the web entry point with only those Views.

## Capability index

- Start a checked TypeScript app → `copilotz init [dir]` → docs/guides/the-compiler.md#start-an-app
- Assemble plugins from declarations → `copilotz gen` →
  docs/guides/the-compiler.md#the-files-and-their-names
- Load only one host's declarations → `#copilotz/plugins/<name>/web.ts` →
  docs/guides/the-compiler.md#load-a-plugin
- Catch misspelled registry names → `AppNames` → docs/guides/the-compiler.md#typed-names
- Keep generated files current → `copilotz gen --watch` →
  docs/guides/the-compiler.md#watch-and-check
- Check generated files in CI → `copilotz gen --check` → docs/guides/the-compiler.md#watch-and-check
- Take over a plugin's assembly → `copilotz gen --eject [plugin]` →
  docs/guides/the-compiler.md#mix-generated-and-hand-written-plugins
