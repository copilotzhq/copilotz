# Schemas from types for rc.64

## CHANGELOG.md

Under **Unreleased**, in **New**:

- **An Action's input from its TypeScript type.** In a plugin built by `copilotz gen`, type `run`'s
  second parameter and the generator writes its JSON Schema. An imported type works too. A field's
  comment tells a tool what to send, and `@minimum 1`, for example, is checked on every call. An
  Action with its own `input` keeps it.

- **A collection from its TypeScript type.** Declare `defineCollection<Order>({ indexes, queries })`
  and `copilotz gen` writes its schema. Queries and named collection reads know the document and its
  string id. Explicit schemas keep their constraints. Both forms of generation reject `Date` and
  name the file and field that needs a JSON type.

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

**A collection's schema from its type.** In a plugin built by `copilotz gen`, use
`export default defineCollection<Order>({ indexes: [["customerId"]] })`. The compiler writes its
schema and a named collection read knows `Order & { _id: string }`. Leave `_id` out of the document
type. Write timestamps as `string` with `/** @format date-time */` on the field. An explicit
`schema` wins.
[The compiler](https://copilotz.com/docs/guides/the-compiler.md#a-collection-from-its-type).

## Capability index

- Validate an Action's annotated input → `defineAction({ run })`, `copilotz gen` →
  `docs/guides/the-compiler.md#an-actions-input-from-its-type`
- Validate collection writes from a document type → `defineCollection<Order>({ indexes, queries })`
  → `docs/guides/the-compiler.md#a-collection-from-its-type`
- Read a typed document by collection name → `ctx.db.collection("order")` →
  `docs/reference.md#collections`
