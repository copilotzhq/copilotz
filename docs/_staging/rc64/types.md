# Action inputs for rc.64

## CHANGELOG.md

Under **Unreleased**, in **New**:

- **An Action's input from its TypeScript type.** In a plugin built by `copilotz gen`, type `run`'s
  second parameter and the generator writes its JSON Schema. An imported type works too. A field's
  comment tells a tool what to send, and `@minimum 1`, for example, is checked on every call. An
  Action with its own `input` keeps it.

## AGENTS.md

Add after **Types from schemas** in **Recipes**:

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
existing schema. [Actions](https://copilotz.com/docs/reference.md#actions).

## Capability index

Validate an Action's input without writing JSON Schema → type `run`'s second parameter;
`copilotz gen` makes `input` → `docs/reference.md#actions`

## Compiler guide section

### An Action's input from its type

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

An inline type, an imported alias or an interface works. The generator reads TypeScript's view of
the files, including paths from the app's `tsconfig.json`. Give the TypeScript compiler paths for
import-map aliases it cannot resolve on its own.

| The type says                                                     | The schema checks                                                                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `string`, `number`, `boolean`, `null`                             | A value of that JSON type                                                                                                                    |
| `"ship"`, `1 \| 2`, `true`                                        | A constant or an enum                                                                                                                        |
| `field?: T`, `field: T \| undefined`                              | The field may be omitted. `T \| null` also accepts an explicit `null`                                                                        |
| `T[]`, `readonly T[]`, `[string, number?]`                        | Array items, or the length and each position of a tuple. A trailing rest has its own item type                                               |
| `Date`                                                            | A date-time string. The caller sends a string and `run` receives that string. Use `string` with `@format date-time` to type it as it arrives |
| Objects, intersections of object types, `Pick`, `Omit`, `Partial` | Named fields and which ones are required. Extra fields are refused                                                                           |
| `Record<string, T>`                                               | Any string key, with its value checked against `T`                                                                                           |
| A union of objects                                                | The input must fit at least one complete variant (`anyOf`)                                                                                   |

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

A function, symbol, bigint, class instance other than `Date`, `any`, `unknown`, or a generic whose
parameters are still open gives a generation error. Recursive types and tuples with a rest before a
fixed suffix need a hand-written schema too. The error names the Action and the path, such as
`input.lines[].quantity`. Specify `input` by hand for such a type, for constraints the type and tags
cannot express, to share a schema, or in a plugin with a hand-written `mod.ts`. An explicit `input`
always wins.

## Integration

In `cli/generate.ts`, gather the Action source paths for the invocation and call
`await inputSchemas(files, { tsconfig })` once. The returned map uses the supplied path strings as
keys. A value of `undefined` means the Action already has an input or its `run` takes no input. An
entry with `error` is a diagnostic to print. Fail generation before writing any files if there is an
error. A missing compiler or unreadable tsconfig rejects the call.

For a `schema` entry, emit the imported Action with the schema **after** the spread, e.g.:

```ts
actions: {
  "order.place": {
    ...orderPlace,
    input: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "The customer placing the order." },
        note: { type: "string" },
        quantity: { type: "number", minimum: 1 },
      },
      required: ["customerId", "quantity"],
      additionalProperties: false,
    },
  },
}
```

This replaces any empty default that `defineAction` supplied. For an `undefined` entry, keep the
original Action. If the compiler also supplies the empty default for plain objects, emit
`{ input: emptyInput, ...original }` for that case, so an explicit schema wins.

In `runtime/define.ts`, keep the schema-first signature first and add this overload for an Action
without `input`:

```ts
export function defineAction<I = Record<string, never>, R = unknown>(
  def: Pick<ActionDef, "description" | "record" | "private" | "atomic"> & {
    input?: never;
    run(ctx: Context, input: I): R | Promise<R>;
    allow?(actor: Actor, input: NoInfer<I>): boolean;
  },
): ActionDef;
```

Infer `I` from the annotation on `run`. The context remains `Context`, and `allow` sees the same
`I`. The schema-first overload keeps using `Infer<S>`. In the implementation, when
`def.input === undefined`, return a copy with
`input: { type: "object", additionalProperties: false }`. Otherwise return the original Action. Test
the two overloads, an empty call, an explicit schema, and the generated plugin through
`runtime.call` once the streams are together.
