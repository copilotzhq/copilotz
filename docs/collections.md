---
title: "Collections"
description: "Declare schema-checked application state, change it through retry-safe writes and named commands, and query it with composable predicates, snapshots and transactions."
section: Runtime
order: 20
status: stable
---

# Collections

## The pain

A Notes application starts with one stored note per capture request. Soon it
needs more: pin a note, list the pinned ones, find notes that mention a word,
and change two records together. Kept in an ad hoc table, each of those becomes
custom SQL with its own validation, no record of what changed, and no answer to
the question "what happens when this Processor runs a second time?"

## The problem

Application state needs one owner that:

- **checks every record** against a declared shape before it is stored;
- **records every change** as an Event that other Processors can react to;
- **makes each write safe to repeat** when a delivery or Action call is retried;
- **names its domain changes**, such as "pin", instead of letting every caller
  patch arbitrary fields;
- **answers queries** with a bounded, validated language, inside the trusted
  namespace, and consistently when several reads must agree.

## The solution

A **Collection** is a named, JSON-Schema-checked set of records. Define it with
`defineCollection`, register it in `createCopilotz` (or a plugin), and use it
from Actions and Processors through `context.collections.<alias>`. The trusted
namespace always comes from the running context; no read or write option can
override it.

### Declaration

| Property                                       | Purpose                                                                                                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                         | Stable name. It prefixes lifecycle Event types (`note.created`), so keep it once records are stored.                                                                                                           |
| `schema`                                       | JSON Schema for one record, declared `as const` so `$inferSelect` and `$inferInsert` are derived from it.                                                                                                      |
| `readOnly` fields                              | Schema metadata for schema-aware input surfaces, such as `id: { type: "string", readOnly: true }`. It is not an access rule on trusted code. The runtime generates `id` when the input omits it.               |
| `timestamps`, `defaults`                       | `createdAt`/`updatedAt` are maintained for you; `defaults` fills missing fields.                                                                                                                               |
| `indexes`                                      | A field, a compound list, or `{ fields, unique?, type? }`. Provisioned as physical, Collection-scoped SQL indexes. B-tree is the default; `unique` is enforced per namespace. GIN and BRIN are also supported. |
| `relations`                                    | `relation.belongsTo`, `relation.hasMany` or `relation.hasOne`, each naming a target Collection and foreign key. Writes project them as graph edges.                                                            |
| `commands`                                     | Named mutations. Each has `mutate({ current, input })` returning `{ set?, unset? }`, an optional `input` schema and an optional Event type.                                                                    |
| `queries`                                      | Named reads built from `filter`, `query` or `select`, with optional input and output schemas.                                                                                                                  |
| `content`, `search`                            | Fields stored as content references, and full-text search fields. See [Content and Assets](content-assets.md).                                                                                                 |
| `beforeCreate`, `beforeUpdate`, `beforeDelete` | Synchronous hooks for last-moment normalisation or rejection.                                                                                                                                                  |

Command and query names cannot reuse method names such as `create`, `list` or
`query`.

### Provision declared indexes

The default application database provisioning creates declared indexes before
execution begins. An index is scoped to its Collection's physical `nodes` rows;
B-tree and BRIN keys include the namespace. A unique B-tree index enforces
uniqueness within each namespace, with PostgreSQL's default distinct-null
semantics. GIN indexes target JSON field values and support containment; they do
not enforce uniqueness. GiST is unsupported because it requires explicit
operator classes/extensions rather than a generic field declaration.

For an existing schema or a separately provisioned tenant schema, call
`provisionCollectionIndexes(session, schemaName, definitions)` from
`@copilotz/copilotz/collections` during an explicit host provisioning step,
after Core schema provisioning and before serving the new composition.
`definitions` is the complete array of composed Collection definitions,
including plugin Collections. `validateCollectionIndexes` has the same arguments
and only reads the database. Validation-only startup and tenant scope selection
require these indexes and never create them during a request.

Provisioning is additive and idempotent: unchanged declarations reuse their
indexes; changed declarations produce new indexes. It never drops obsolete or
operator-created indexes or rewrites records. Adding a unique declaration fails
if existing rows violate it. By default, index creation runs in a serialized DDL
transaction and can block writes while building. For populated PostgreSQL
schemas, pass a fourth argument `{ concurrently: true }` from a standalone
provisioning operation to build without blocking normal writes. Run one
provisioner per schema and supply a session outside any transaction. Concurrent
builds commit individually; a failed build can leave an invalid index, which
validation rejects for explicit repair. Removed declarations leave their old
indexes, including unique constraints, in place until an explicit operator
cleanup.

Ordering and scalar index creation share the same SQL field expressions. A
compound index should put equality-filter fields before the ordered field. The
database planner still decides whether to use it: `limit: 1` bounds results, not
the amount of scanning, so inspect execution plans for important queries.

### Lifecycle Events

Every committed write appends one durable Event in the caller's operation:
`<name>.created`, `<name>.updated` and `<name>.deleted`. A command appends
`<name>.updated` unless it declares its own `event`, such as `note.pinned`,
which gives Processors a precise fact to subscribe to. A `note.created` Event's
data is `CollectionCreated<T>`: the record exactly as committed.

Commands name domain changes; they do not restrict fields. Trusted Action and
Processor code can still `update` any field, so keep such rules in your Actions.

### Writes and operation keys

`create`, `update({ id, set, unset })`, `delete({ id })` and
`commands.<name>({ id, ... })` all accept `{ operationKey }`. The key is
combined with the **running delivery**, so a retried delivery that repeats a
write gets the stored result instead of a second change.

- **In a Processor**, a fixed key such as `"pin-note"` names one write per
  delivery. That is usually what you want.
- **In an Action**, Collection keys are still scoped to the delivery, not to the
  Action call. Two calls of the same Action in one delivery would share a fixed
  key and collide. Prefix the key with the call's own identity:
  `` `${context.operationKey}:save-note` ``.

Operation keys cover runtime writes only. An email or payment call needs its own
idempotency key with the provider.

### Queries

`get({ id })`, `list(query)`, `search(query)` and `aggregate(query)` read in the
trusted namespace. A `list` query combines these parts with AND:

- `where`: equality on the field's JSON text, such as `{ pinned: true }`. It is
  not type-sensitive: `{ n: 10 }` matches both `10` and `"10"`. A `null` value
  matches neither `null` nor a missing field;
- `contains` / `containsAny`: JSON containment, such as `{ tags: ["release"] }`;
- `filter`: one predicate tree (below);
- `all`: extra filters, each with its own `where`, `contains`, `containsAny` or
  `filter`. Use it to enforce a condition, such as an owner check, outside any
  caller-supplied `or`/`not`.

`order: { field, direction }`, `limit`, and `after`/`before` cursors page the
result. Ordering supports built-in IDs and timestamps, plus declared scalar
fields and nested paths. Numbers sort numerically; strings sort as text;
booleans sort false before true. A field must declare one scalar type,
optionally nullable (homogeneous `enum` and `const` are supported too).
Undeclared, ambiguous, object, and array order fields are rejected. Equal values
use `id` as a deterministic tie-breaker. Missing/null values sort last ascending
and first descending; cursors follow exactly that order. `limit` defaults to 100
and larger values are clamped to 1,000; a non-positive or fractional limit is an
error. `include` loads declared relations. Word search uses `search(query)` with
`text`, and needs fields declared in `search: { enabled: true, fields }`.

A `filter` predicate is `{ and: [...] }`, `{ or: [...] }`, `{ not: p }`, or a
field test with exactly one operator: `eq`, `ne`, `in`, `jsonEquals`, `trimEq`,
`eqIgnoreCase`, `inIgnoreCase`, `lt`, `lte`, `gt`, `gte`, `overlaps`, `exists`,
`isNull` or `isBlank`.

- Nested fields use dotted paths. Unlike `where`, `filter` equality is
  type-sensitive: `eq: 10` does not match `"10"`. `jsonEquals` compares whole
  JSON values, including objects and arrays.
- `trimEq` matches strings whose trimmed value equals the operand.
- A missing field differs from an explicit `null`. `exists: true` includes
  `null`; `eq: null` and `isNull: true` match only `null`. `ne: null` includes
  missing fields, so add `exists: true` when absence should be excluded.
- Empty `and` is true; empty `or`, `in` and `overlaps` are false.
- `eqIgnoreCase` and `inIgnoreCase` accept strings only and compare with the
  database's lower-casing over the whole value; they are not substring or
  pattern matches.
- Predicate trees are limited to 16 levels, 256 nodes and 1,000 values.
  Exceeding these limits, or an invalid field or operator, raises an error
  instead of truncating the predicate.

### Consistency

Each standalone read sees the latest committed state. When several reads must
agree, wrap them in `context.readSnapshot(async ({ collections }) => ...)`: one
repeatable, read-only point in time. Keep it short; do model or network work
after it returns.

When several writes must commit together, use
`context.transaction(async ({ collections }) => ...)`. Its writes stage and
return `{ id }` references; all records and their Events commit at once or not
at all. Do not call the standalone `context.collections` writes inside an open
transaction.

### Content-aware reads

Reads return content fields as references. Pass
`{ content: { fields: ["body"] } }` to `get`, `list` or `search` to resolve
selected fields on the returned page only. Apply visibility rules before
resolving content you would not show. See
[Content and Assets](content-assets.md).

## Reference

This standalone `app.ts` extends the Chapter 4 Notes example with a `pin`
command and a filtered list. It needs `@copilotz/copilotz@^0.86.3` on Deno 2.9+
or Node 24+, and no credential.

```ts
// Runtime factory and primitive helpers.
import {
  createCopilotz,
  defineAction,
  defineCollection,
  defineProcessor,
  isStreamOutput,
} from "@copilotz/copilotz";
// Types of the contexts that Actions and Processors receive.
import type {
  ActionCallers,
  ActionContext,
  CollectionRecord,
  ProcessorContext,
} from "@copilotz/copilotz";
// The note text comes from the command line.
import { argv } from "node:process";

// Schema-checked notes. Each write appends a `note.*` Event.
const note = defineCollection({
  name: "note",
  schema: {
    type: "object",
    properties: {
      // Generated by the runtime when the writer omits it.
      id: { type: "string", readOnly: true },
      // The captured note.
      text: { type: "string" },
      // Set by the `pin` command in this example. Trusted code could still
      // update it directly; commands name changes, they do not guard fields.
      pinned: { type: "boolean" },
    },
    required: ["text"],
  } as const,
  // New notes start unpinned.
  defaults: { pinned: false },
  commands: {
    // A named domain change with its own Event type.
    pin: {
      event: "note.pinned",
      mutate: () => ({ set: { pinned: true } }),
    },
  },
});

// Input that callers pass to `notes.save`.
type SaveNoteInput = { text: string };

// Validated operation that stores one note.
const saveNote = defineAction({
  id: "notes.save",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", minLength: 1 } },
    required: ["text"],
    additionalProperties: false,
  } as const,
  // Returns the stored record as the runtime commits it: a canonical record
  // whose `id`, `namespace` and timestamps are always present.
  execute(
    input: SaveNoteInput,
    context: ActionContext,
  ): Promise<CollectionRecord> {
    // Prefix with this call's identity: Collection keys are delivery-scoped.
    return context.collections.note.create(
      { text: input.text },
      { operationKey: `${context.operationKey}:save-note` },
    );
  },
});

// Declares the Action callers this Processor uses, for TypeScript only.
type CaptureContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<{ saveNote: typeof saveNote }>
>;

// Saves, pins and lists notes for every capture request.
const captureNote = defineProcessor<CaptureContext>({
  id: "notes.capture",
  on: [{ eventType: "notes.capture.requested" }],
  async handle(event, context) {
    if (!event.durable) return;
    const saved = await context.actions.saveNote(
      event.data as SaveNoteInput,
      { operationKey: "save-request" },
    );
    // `saved.id` is the string ID the runtime assigned. A fixed key is enough
    // here: one pin per delivery.
    await context.collections.note.commands.pin(
      { id: saved.id },
      { operationKey: "pin-note" },
    );
    // Two reads that must agree, taken from one snapshot.
    const { pinned, exactMatches } = await context.readSnapshot(
      async ({ collections }) => ({
        // Pinned notes, newest first. `where` compares JSON text.
        pinned: await collections.note.list({
          where: { pinned: true },
          order: { field: "createdAt", direction: "desc" },
          limit: 10,
        }),
        // Notes whose whole text equals this sentence, ignoring case, or that
        // are explicitly unpinned. This is equality, not word search.
        exactMatches: await collections.note.list({
          filter: {
            or: [
              { field: "text", eqIgnoreCase: "prepare the release." },
              { field: "pinned", eq: false },
            ],
          },
          limit: 10,
        }),
      }),
    );
    console.log(`pinned=${pinned.length} matching=${exactMatches.length}`);
  },
});

const app = await createCopilotz({
  namespace: "team-notes",
  collections: { note },
  actions: { saveNote },
  processors: { captureNote },
});

try {
  const handle = await app.send({
    type: "notes.capture.requested",
    payload: { text: argv[2] ?? "Prepare the release." },
  });
  // Print each durable Event type while waiting for settlement.
  const print = async () => {
    for await (const output of handle.outputs) {
      if (!isStreamOutput(output) && output.durable) console.log(output.type);
    }
  };
  const [drained, settled] = await Promise.allSettled([print(), handle.done]);
  if (drained.status === "rejected") throw drained.reason;
  if (settled.status === "rejected") throw settled.reason;
} finally {
  await app.close();
}
```

Run `deno run -A app.ts` or `node app.ts`. Among the printed Event types expect
`note.created`, then `note.pinned`, and a line `pinned=1 matching=1`.

## What this unlocks

- State that is validated, versioned by Events, and safe under retries.
- Domain commands that Processors subscribe to by name.
- Bounded queries with enforced filters, and consistent multi-read snapshots.
- Atomic multi-record changes through transactions.

## Next steps

- [Chapter 3: Keep State in a Collection](getting-started/part-1-design-and-build/03-keep-state-in-a-collection.md)
  introduces Collections step by step.
- [Actions](actions.md) covers Action callers, lifecycle Events and validation.
- [Events, Deliveries, and Recovery](events-deliveries-recovery.md) explains
  delivery-scoped operation keys and retries.
- [Content and Assets](content-assets.md) covers content fields and resolution.
