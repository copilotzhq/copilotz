---
title: "The compiler: plugins from folders"
description: "Start an app with copilotz init. Generate plugin entry points, Action inputs and collection schemas from TypeScript. Get checked names, watch for changes, check the build or take over a plugin by hand."
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

`npm test` checks the example plugin with `describe()`. `npm run check` runs, in order:
`copilotz gen --check` (the generated files are current), `tsc --noEmit` (with `noUnusedLocals` and
`noUnusedParameters` in `tsconfig.json`), `eslint .` (`typescript-eslint`'s recommended rules, and
`@typescript-eslint/no-unused-vars` as an error; a parameter starting with `_` may go unused),
`prettier --check .` and `npm test`. ESLint and Prettier belong to the app. `npm run build`
generates the modules and type-checks the app. `npm start` serves it.

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

Give the orders plugin a shared caller rule in `plugins/orders/plugin.ts`:

```ts
import { people, type Plugin } from "copilotz";

export default { defaults: { allow: people } } satisfies Partial<Plugin>;
```

Then `plugins/orders/collections/order.ts` declares the document and the query the screen reads:

```ts
import { defineCollection } from "copilotz";

type Order = { shipped: boolean };

export default defineCollection<Order>({
  queries: {
    pending: (orders) => orders.countDocuments({ shipped: false }),
  },
});
```

## An Action's input from its type

Give the second parameter of `run` a type. In `plugins/orders/actions/order.place.ts`, for example,
an order may only be placed for an existing customer:

```ts
import { defineAction, failure, people } from "copilotz";

export default defineAction({
  description: "Place an order for a customer.",
  allow: people,
  run: async (ctx, input: {
    /** The customer placing the order. */
    customerId: string;
    /** @minimum 1 */
    quantity: number;
    note?: string;
  }) => {
    const customer = await ctx.db.collection("customer").findOne({ _id: input.customerId });
    if (!customer) throw failure("not_found", "No such customer.", { public: true });
    const { insertedId } = await ctx.db.collection("order").insertOne(input);
    return { order: insertedId };
  },
});
```

Install `typescript` as a devDependency (`npm install -D typescript` or
`deno add --dev npm:typescript`). Run `copilotz gen` after changing the type. It writes a closed
object schema in the plugin's `mod.ts`. Here `customerId` and `quantity` are required, `note` is
optional, and a quantity below one is refused. A tool sees the words on `customerId` when it lists
the Action. The runtime uses this same schema for calls from code, REST and MCP.

If an inline `allow` reads the input, put it after `run` so TypeScript can infer its parameter. To
put `allow` first, supply the input type explicitly, for example `defineAction<PlaceOrder>(...)`,
and keep the `input: PlaceOrder` annotation on `run` for the compiler.

An inline type, an imported alias or an interface works. The generator reads TypeScript's view of
the files, including paths from the app's `tsconfig.json`. Give the TypeScript compiler paths for
import-map aliases it cannot resolve on its own.

| The type says                                                     | The schema checks                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `string`, `number`, `boolean`, `null`                             | A value of that JSON type                                                                      |
| `"ship"`, `1 \| 2`, `true`                                        | A constant or an enum                                                                          |
| `field?: T`, `field: T \| undefined`                              | The field may be omitted. `T \| null` also accepts an explicit `null`                          |
| `T[]`, `readonly T[]`, `[string, number?]`                        | Array items, or the length and each position of a tuple. A trailing rest has its own item type |
| `Date`                                                            | Generation fails. Use `string` with `/** @format date-time */` for a JSON timestamp            |
| Objects, intersections of object types, `Pick`, `Omit`, `Partial` | Named fields and which ones are required. Extra fields are refused                             |
| `Record<string, T>`                                               | Any string key, with its value checked against `T`                                             |
| A union of objects                                                | The input must fit at least one complete variant (`anyOf`)                                     |

The description comes from the field or its type. A comment on the field takes precedence. Write
tags in that JSDoc comment, one per line:

- `@minimum`, `@maximum`, `@exclusiveMinimum`, `@exclusiveMaximum` take numbers. `@integer` or
  `@type integer` on a `number` requires a whole number.
- `@minLength`, `@maxLength` take character counts. `@pattern ^[A-Z]+$` gives the regular
  expression, and `@format email`, for example, gives a string format.
- `@minItems`, `@maxItems` take item counts. `@uniqueItems` requires distinct items.
- `@default` describes a default value. The runtime still passes the input as supplied. Use JSON for
  values such as `@default 1` or `@default false`. `@examples ["AB", "CD"]` gives a JSON array of
  examples.

If a collection already exports `type Product = Infer<typeof schema>`, use `Product` or, for
example, `Pick<Product, "code">`. For a literal schema the generator can read the original
constraints, such as the code's pattern. `Pick`, `Omit` and `Partial` on a simple closed object keep
its selected fields' constraints. When a schema's value or projection can't be read that way, the
generator derives the shape from TypeScript. To share every constraint exactly, use the schema
itself as `input`.

A function, symbol, bigint, class instance, `any`, `unknown`, or a generic whose parameters are
still open gives a generation error. Recursive types and tuples with a rest before a fixed suffix
need a hand-written schema too. The error names the Action and the path, such as
`input.lines[].quantity`. Specify `input` by hand for such a type, for constraints the type and tags
cannot express, to share a schema, or in a plugin with a hand-written `mod.ts`. An explicit `input`
always wins.

## A collection from its type

In `plugins/orders/collections/order.ts`, give `defineCollection` the type of one document. An
imported interface works too.

```ts
import { defineCollection } from "copilotz";

interface Order {
  /** The customer placing the order. */
  customerId: string;
  /** @minimum 1 */
  quantity: number;
  note?: string;
  /** @format date-time */
  shippedAt?: string;
}

export default defineCollection<Order>({
  indexes: [["customerId"]],
  queries: {
    customers: async (orders) => (await orders.find({})).map((order) => order.customerId),
  },
});
```

The compiler writes the collection's `schema` into the generated plugin. It uses the same type
rules, comments and tags as an Action input. Every insert, replace and update uses the usual
collection checks. Setting `quantity` to zero with `$set` fails with `detail.field` equal to
`quantity`. In a query or on `ctx.db.collection("order")`, a read returns an `Order` with a string
`_id`. Leave the top-level `_id` out of the document type. The runtime assigns it on insert and
checks the remaining fields against the schema.

An explicit `schema` takes precedence. Use `defineCollection({ schema })` and `Infer<typeof schema>`
to share an existing schema, or to write a plugin by hand. Starting a type-only collection without
its generated schema reports the collection name and how to fix it.

Run `copilotz gen --check` to catch a type edit that changes either generated schema. A conversion
failure names the source file and field and leaves the build alone. Ejecting writes the current
schemas into the plugin's own `mod.ts`. After ejection, maintain those schemas there.

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

`copilotz gen --watch` generates once and watches plugin declarations, local TypeScript files and
project settings. The starter's `npm run dev` runs it beside the server with Node's TSX loader and
`--watch`.

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
