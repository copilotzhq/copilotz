---
title: "The compiler: plugins from folders"
description: "Start an app with copilotz init. Generate a plugin's server, web and terminal entry points from its declarations, get checked names from the app, watch for changes, check the build or take over a plugin by hand."
section: Guides
order: 10
---

# The compiler: plugins from folders

An app keeps its declarations in files and chooses its plugins in `app.ts`. The compiler writes the
imports that assemble each plugin. It runs during development and build. The runtime loads ordinary
TypeScript modules.

## Start an app

On Node 24 or newer:

```sh
npx copilotz@1.0.0-rc.64 init orders
cd orders
npm run dev
```

`copilotz init [dir]` uses an empty directory (the current one by default), installs the app's npm
dependencies and runs the compiler. Open the address the server prints and sign in by name on this
machine. The example shows how many orders await shipment. It uses an in-memory store.

`npm test` checks the example plugin with `describe()`. `npm run check` also checks the generated
files, the types, unused code, lint and formatting. ESLint and Prettier belong to the app.
`npm run build` generates the modules and type-checks the app. `npm start` serves it.

## The files and their names

Each declaration has a default export. Its filename, without the extension, is the registry name.
Keep named queries with the collection they read.

| Path inside `plugins/orders/` | What the compiler registers                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `collections/order.ts`        | Collection `order`, including its schema, indexes and queries                       |
| `actions/order.ship.ts`       | Action `order.ship` (keep the dots in its filename)                                 |
| `events/order.shipped.ts`     | Event `order.shipped`                                                               |
| `processors/receipt.ts`       | Processor `receipt`                                                                 |
| `schedules/dispatch.ts`       | Schedule `dispatch`                                                                 |
| `resources/tools.ts`          | The object of entries under `resources.tools`                                       |
| `adapters/mail/local.ts`      | `adapters.mail.local`                                                               |
| `routes/orders.ts`            | The Route at `/orders`                                                              |
| `views/orders.ts`             | Text View `orders`                                                                  |
| `views/tool/ship_order.ts`    | Text View `tool:ship_order`                                                         |
| `views/web/screen/orders.tsx` | Web View `screen:orders`                                                            |
| `views/terminal/orders.ts`    | Terminal View `orders`                                                              |
| `plugin.ts`                   | The plugin's own fields, including `requires`, `guard`, `who`, `check` and `labels` |

A folder under a View's host supplies a colon in its name, including on Windows. Web and terminal
Views can use `.ts` or `.tsx`. Put shared code and shared UI components in `lib/`. Another plugin
imports only the plugin's `contract.ts`. The compiler skips both. A misplaced file in a declaration
folder, a missing default export or two files giving the same host View its name stops generation.

For example, `plugins/orders/collections/order.ts` can be the whole declaration:

```ts
import { defineCollection, people } from "copilotz";

export default defineCollection({
  schema: {
    type: "object",
    properties: { shipped: { type: "boolean" } },
    required: ["shipped"],
    additionalProperties: false,
  },
  queries: {
    pending: { allow: people, run: (orders) => orders.countDocuments({ shipped: false }) },
  },
});
```

## Load a plugin

The compiler writes `mod.ts`, `web.ts` and `terminal.ts` into `.copilotz/build/plugins/<name>/`.
Keep `.copilotz/build/` in `.gitignore`. In an existing app, add the package import to
`package.json`:

```json
{ "imports": { "#copilotz/*": "./.copilotz/build/*" } }
```

The app still sets the order in `app.ts`:

```ts
import orders from "#copilotz/plugins/orders/mod.ts";

export function plugins() {
  return [orders];
}
```

The browser imports `#copilotz/plugins/orders/web.ts`, the terminal
`#copilotz/plugins/orders/terminal.ts`. Each loads only that host's declarations. The compiler
itself loads the declaration modules and calls `plugins()` with no settings. Put browser work in the
View or its handlers. Node loads the app's `tsx.ts` loader when present. Bun and Deno load TSX
directly.

Run `npx copilotz gen` in an npm app. On Deno the entry is
`deno run -A jsr:@copilotz/copilotz@1.0.0-rc.64/gen`. Pass `--check`, `--watch`, `--eject` or
`init [dir]` after the entry. A JSR app maps `copilotz` to the same JSR version in `deno.json`; it
uses the same `package.json` imports for generated modules.

## Typed names

Commit `copilotz-env.d.ts` at the root. It augments `AppNames` in `copilotz` with the Actions,
collections, queries and Views in the merged registry, including those of installed plugins.
Generated host Views also complete in the editor. A TypeScript app includes the file in its project.
For `deno check`, include it in `compilerOptions.types` in `deno.json`.

```ts
import type { Runtime, ViewContext } from "copilotz";

export function pending(runtime: Runtime, view: ViewContext) {
  view.db.collection("order").query("pending");
  view.show("screen:orders", {});
  return runtime.query<number>("order.pending");
}
```

With the starter app, `runtime.call("order.ship", { id })` compiles and a misspelling fails.
Collection and query names are checked too. Views accept any string because another host can supply
one at runtime. Apps without the declaration keep their string parameters.

## Watch and check

`copilotz gen --watch` generates once and watches `plugins/` and `app.ts`. The starter's
`npm run dev` runs it beside the server with Node's TSX loader and `--watch`.

`copilotz gen --check` compares the expected files with the build directory and the committed
declaration. It exits with a failure on drift and leaves the files as it found them. On a fresh
checkout the build directory is absent. In CI, install dependencies, then run:

```sh
npm run build
git diff --exit-code -- copilotz-env.d.ts
npm run check
```

## Mix generated and hand-written plugins

A plugin with its own `mod.ts` uses its own assembly. Import it as usual and list it beside
generated plugins in `app.ts`. Its declarations still contribute typed names if the app loads it.

To take over the orders plugin, run `npx copilotz gen --eject orders`. It writes the three entry
points in `plugins/orders/` with local imports and gives that plugin a specific mapping in
`package.json`. Existing `#copilotz` imports keep working. Commit these files and the regenerated
names. `--eject` with no plugin takes over all generated plugins.
