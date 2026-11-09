# Contributing to Copilotz

## A plugin's declaration

A plugin says what it is by what it declares. `describe(plugin)`, in `runtime/describe.ts`, reads
that data and says it plainly: what the plugin keeps, who may call what, where it shows, what it
needs and what it requires. The plugin hub lists plugins from it, and every page in
`docs/reference/plugins/` is made from it.

```sh
deno run -A scripts/describe.ts plugins/work/mod.ts boards              # the declaration, as JSON
deno run -A scripts/describe.ts plugins/work/mod.ts boards --markdown   # its reference page
deno run -A scripts/describe.ts --docs                                  # every page, and plugins.json
deno run -A scripts/describe.ts --docs --check                          # fails when one is stale
```

From code, `describe` is `copilotz/describe`'s, and its result is plain JSON. Run `--docs` after
changing a plugin. A new plugin needs a layer first, in `scripts/describe/catalog.ts`: `standard`,
`package`, or `private` for what's moving to Compass, which no page shows.

### How it's derived

Most of a declaration is the plugin's own data:

- **What it keeps:** its collections, their schemas and named queries, and the collections its
  `shared` resource puts under the access rules.
- **Who may call what:** its Actions. `allow` is a function, so it's asked about made-up callers: a
  person, an agent working for one, a contact, someone anonymous, a key and the maintenance key.
  Each gets a minimal input from the Action's schema. An `allow` that reads the input, or throws,
  lets that caller in only `some` of the time: it depends on input. `run` never runs.
- **Where it shows:** its Views, by their names. `web.*` is the web, `terminal.*` the terminal, and
  `llm.*`, `context:*`, `tool:*` and `mcp:*` the model's prompt. A front end's other Views show
  where its shell is (`requires: ["web-shell"]`).
- **The rest:** its routes and the methods their code names, `who`, `guard`, `labels`, workers,
  events, Processors, schedules, resources, adapters, and the tools it gives agents.
- **Its startup check:** run on the plugin's own resources, with every call it makes refused. What
  it reads, and what it says with nothing set, is what an operator must add.

The CLI adds what only the code shows:

- **The resource kinds it reads:** `resources.<kind>` in what its declaration uses, followed
  declaration by declaration through its imports, inside its folder.
- **Its settings:** each `<Name>Settings` type its files export, tied to a resource kind by how its
  code reads it (`resources.google … as GoogleSettings`) or by its doc ("the `google` resource").
  Its fields come with their docs. One named like a key, token, secret or password is a secret.
- **What it is:** the first sentence of its doc.

### What makes a plugin listable

The hub lists a plugin whose declaration keeps 4 rules:

1. Every collection has a schema that names its fields.
2. Every Action declares `allow`, or has none and is internal: the app's code, its schedules and the
   system call it, and nobody outside does.
3. Its routes live under its name, `/<name>/…`, and none takes a whole host.
4. Every setting it reads is a type its contract exports.

A declaration's `listing` says which rules a plugin breaks. Its warnings say what a person should
know before adding it: an Action open to someone signed out, or one without a description or an
input schema.

### Saying what it reads

Nothing in `Plugin` says which resource kinds a plugin reads, so the CLI finds them in its code. A
plugin from anywhere should say it itself, so a hub needn't scan it. The proposal is one optional
field, which `describe` already reads when a plugin has it (see `Readable`):

```ts
/** The resource kinds it reads: its settings, and the kinds other plugins fill for it. */
reads?: string[];
```

A plugin reading `google` and `tools` says `reads: ["google", "tools"]`.
