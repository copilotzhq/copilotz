---
title: "Chapter 22: Organize, Share and Evolve Plugins"
description: "Move the Notes declarations into one file per primitive, generate a static plugin module from them on a Deno build host, and share it without changing a single stored ID."
section: Getting Started
order: 220
status: stable
---

# Chapter 22: Organize, Share and Evolve Plugins

> Part 6 — Evolve and Reuse · Track: R · Requires: Chapter 5 · Needs: Deno 2.9+
> on the build host; the generated plugin runs wherever Chapter 5 ran (Deno 2.9+
> or Node 24+)

## The pain

`notes-plugin.ts` started as one Collection, one Action and one Processor. A
real plugin keeps growing: more Collections, more Actions, Processors that react
to each of them, and later perhaps Skills or API definitions. One file becomes a
long scroll. Every new declaration also has to be added by hand to the
`collections`, `actions` or `processors` map of `definePlugin`, and forgetting
that line produces a declaration that exists in the source but is never
registered.

When the plugin is shared with another team or another repository, a second
question appears: which of these names can they rely on, and what may change
when you release a new version?

## The problem

You want three things at once, and they pull in different directions:

- **One file per primitive**, so that a reader finds the `notes.save` Action in
  a predictable place and a reviewer sees one concern per change.
- **No hand-maintained registration list**, so that adding a file is enough.
- **No filesystem scanning at run time.** The application runs on Node, Deno,
  inside bundles and on hosts with no filesystem access at all. A runtime that
  discovered files when it started would lose that portability, and it would run
  arbitrary modules found on disk.

Moving files must also not change anything that is stored. The `note` Collection
name, the `notes.save` and `notes.capture` IDs, the schemas and the operation
keys are already part of recorded Events. A tidy-up that renamed one of them
would split history in two.

## The solution

Copilotz separates **discovery** from **runtime**:

1. Each primitive lives in its own conventional directory, as an `index.ts` with
   a **default export**: `collections/<name>/index.ts`,
   `actions/<name>/index.ts`, `processors/<name>/index.ts`.
2. A `copilotz.json` file at the plugin root records the plugin `id` and
   `version`.
3. On a **build host** with Deno, the Copilotz build command reads those files
   as source text, without executing them, and writes `plugin.generated.ts`: an
   ordinary module with static imports and one `definePlugin` call.
4. Applications import that generated module. At run time nothing is discovered;
   the generated file is just TypeScript, so it runs wherever the hand-written
   plugin ran.

The directory name becomes the composition alias in camelCase: `save-note`
becomes `saveNote` and `capture-note` becomes `captureNote`, so the aliases from
Chapter 5 stay the same. Stable IDs are not derived from paths. They stay
written inside each declaration, exactly as before.

This chapter moves the Chapter 5 declarations unchanged:

| Chapter 5 (`notes-plugin.ts`)       | Chapter 22                                    |
| ----------------------------------- | --------------------------------------------- |
| `note` Collection                   | `notes/collections/note/index.ts`             |
| `saveNote` Action (`notes.save`)    | `notes/actions/save-note/index.ts`            |
| `captureNote` (`notes.capture`)     | `notes/processors/capture-note/index.ts`      |
| `definePlugin({ id, version, ...})` | `notes/copilotz.json` → `plugin.generated.ts` |
| imports from `./notes-plugin.ts`    | `notes-plugin.ts`, now a small public barrel  |

> **If your Notes plugin has evolved.** The leaf files below copy the Chapter 5
> baseline, because that is all this chapter requires. For Notes schemas with
> optional file content, such as an optional `body` field with a content
> declaration, move your current Collection and its `NoteRecord` type unchanged
> into `collections/note/index.ts`, together with the schema and content
> declarations, instead of pasting the baseline. Replacing an evolved schema
> with the baseline would remove fields that stored records and existing callers
> already use. A separate file Action or plugin moves into its own leaf or root
> the same way. A structural move keeps schemas, IDs, operation keys and grants
> exactly as they are.

### Create `notes/copilotz.json`

The manifest names the plugin. It is read only by the build command.

```json
{
  "id": "@team-notes/notes",
  "version": "1.0.0"
}
```

`id` and `version` are the values `definePlugin` received in Chapter 5, so the
composed application sees the same plugin identity. No `aliases` entry is
needed, because the default directory aliases already equal the Chapter 5
aliases. No `include` list is needed either: without one, every conventional
entry under the root is discovered. `plugins` would list dependencies as
`{ "from": "<module>", "export": "<name>" }` entries; Notes depends on nothing.

### Create `notes/collections/note/index.ts`

```ts
// Declares a Collection. Leaf files import the same portable runtime package
// as Chapter 5, never the agent harness.
import { defineCollection } from "@copilotz/copilotz";

// Application state for captured notes, moved unchanged from Chapter 5. The
// build command registers the default export under this directory's alias,
// `note`.
const note = defineCollection({
  // Stable name. It prefixes the Event types this Collection appends, such as
  // `note.created`, so keep it once records are stored.
  name: "note",
  // JSON Schema for one stored record. `as const` lets the record types be
  // derived from it.
  schema: {
    type: "object",
    properties: {
      // Record identity. The runtime assigns it when the writer omits it.
      id: { type: "string", readOnly: true },
      // The note itself, as the user captured it.
      text: { type: "string" },
    },
    // A note without text is rejected before it is stored.
    required: ["text"],
  } as const,
});

// Shape of one stored note, derived from the Collection's schema. A named
// export next to the default one; discovery only looks at the default.
export type NoteRecord = typeof note.$inferSelect;

// The discovered declaration.
export default note;
```

### Create `notes/actions/save-note/index.ts`

```ts
// Declares an Action, and types the context it receives.
import { defineAction } from "@copilotz/copilotz";
import type { ActionContext } from "@copilotz/copilotz";

// Input that callers pass to `notes.save`. TypeScript checks calls against this
// type; the Action's `inputSchema` enforces the same shape at run time.
export type SaveNoteInput = { text: string };

// Reusable, validated operation that stores one note, moved unchanged from
// Chapter 5. Registered under this directory's alias, `saveNote`.
const saveNote = defineAction({
  // Stable identity. Lifecycle Event types are built from it, such as
  // `notes.save.invoked` and `notes.save.completed`, so keep it once Events are
  // stored. The directory name does not change it.
  id: "notes.save",
  // Checked against every call's input before this Action's lifecycle Events
  // or `execute` start.
  inputSchema: {
    type: "object",
    properties: {
      // At least one character, so an empty note never reaches the Collection.
      text: { type: "string", minLength: 1 },
    },
    // A call without text is rejected before the Action starts.
    required: ["text"],
    // Reject unexpected fields instead of silently storing or dropping them.
    additionalProperties: false,
  } as const,
  // Runs once the input is accepted. Its return value is the caller's result
  // and the `output` of the `notes.save.completed` Event.
  execute(input: SaveNoteInput, context: ActionContext) {
    // Store the validated note through the `note` alias, which the generated
    // plugin registers from `collections/note/`.
    return context.collections.note.create(
      // Only the note's own field. The runtime fills in `id`, `namespace` and
      // the timestamps.
      { text: input.text },
      // Same key as Chapter 5: prefix the write with this call's identity, so
      // two calls in one delivery make two writes and a retried call resolves
      // to its stored note.
      { operationKey: `${context.operationKey}:save-note` },
    );
  },
});

// The discovered declaration.
export default saveNote;
```

### Create `notes/processors/capture-note/index.ts`

The Processor still types its Action callers from the real Action declaration.
It imports that declaration as a type only, from the sibling leaf.

```ts
// Declares a Processor, and types its context and Action callers.
import { defineProcessor } from "@copilotz/copilotz";
import type { ActionCallers, ProcessorContext } from "@copilotz/copilotz";
// The `notes.save` declaration and its input type. Type-only: the Processor
// calls the Action through its context, not through this import.
import type saveNote from "../../actions/save-note/index.ts";
import type { SaveNoteInput } from "../../actions/save-note/index.ts";

// The context `captureNote` expects. The third type parameter declares the
// Action callers it uses, so TypeScript checks their input and output.
type CaptureContext = ProcessorContext<
  // Keep the default resource and adapter types.
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  // `context.actions.saveNote` calls the `notes.save` Action.
  ActionCallers<{ saveNote: typeof saveNote }>
>;

// Decides when a note is saved, moved unchanged from Chapter 5. Registered
// under this directory's alias, `captureNote`.
const captureNote = defineProcessor<CaptureContext>({
  // Stable identity recorded on each delivery. Keep it once Events are stored.
  id: "notes.capture",
  // Match every Event of this type, in any namespace this application admits.
  on: [{ eventType: "notes.capture.requested" }],
  // Runs for each selected delivery and may run again for it on retry.
  async handle(event, context) {
    // Save notes only for stored requests, so every note traces back to a
    // recorded Event and its delivery.
    if (!event.durable) return;
    // Pass the request's payload to the Action, which validates it against its
    // input schema before it runs.
    await context.actions.saveNote(
      event.data as SaveNoteInput,
      // Same key as Chapter 5: a retried delivery gets the recorded result
      // instead of a second note.
      { operationKey: "save-request" },
    );
  },
});

// The discovered declaration.
export default captureNote;
```

Code reused by more than one primitive goes in `notes/shared/`, which the build
command never treats as an entry. Notes needs none: each leaf exports the types
that belong to it. A helper used by only one primitive stays inside that
primitive's directory.

### Generate the static plugin

The build command is the `build` export of the Copilotz package. It runs on Deno
2.9 or later, even when the application itself runs on Node. Run it from the
project directory, naming the plugin root:

```sh
# Discover notes/**/index.ts as source text and write notes/plugin.generated.ts.
# -A lets the command read the plugin root and write the generated file.
deno run -A jsr:@copilotz/copilotz@^0.86.2/build build notes --source-only
```

`--source-only` writes the TypeScript module and stops. Without it, the command
also type-checks the generated module, imports it in a separate child process
that has only read permission to validate the composition, and bundles it to
`notes/dist/plugin.js` (`--output=path` chooses another file). The bundle marks
`@copilotz/copilotz` and all its subpaths as external, so a built plugin never
carries a second copy of the framework: the application's own copy defines the
plugin and runs it.

The generated file looks like this:

```ts
// Generated by copilotz build. Edit source declarations, not this file.
import { type DefinedPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import entry0 from "./actions/save-note/index.ts";
import entry1 from "./collections/note/index.ts";
import entry2 from "./processors/capture-note/index.ts";
const definition = {
  id: "@team-notes/notes",
  version: "1.0.0",
  collections: {
    "note": entry1,
  },
  actions: {
    "saveNote": entry0,
  },
  processors: {
    "captureNote": entry2,
  },
} as const;
const plugin: DefinedPlugin<typeof definition> = definePlugin(definition);
export default plugin;
```

It contains static imports and one `definePlugin` call: no directory reads, no
TypeScript compiler, nothing that needs the build host. Paths are sorted, so the
same sources always generate the same file. Never edit it by hand; change a leaf
or `copilotz.json` and generate again.

The listing above is illustrative: a code formatter may rewrap or requote it.
`--check` compares the file with the generator's exact output, so either exclude
generated modules from automatic formatting or regenerate after formatting.
Commit it with the sources, so that hosts without Deno can run the application.

The generated module is exactly as pure as its leaves. The build command reads
leaves without running them, but it does not remove anything they do when they
are imported. A leaf that read the environment or opened a connection at the top
level would do so in every test and application that imports the plugin.

### Replace `notes-plugin.ts` with a public barrel

Chapter 6's scenarios, Chapter 9's tool and later chapters import `note`,
`saveNote`, `captureNote`, `notesPlugin`, `NoteRecord` and `SaveNoteInput` from
`./notes-plugin.ts`. Keep that path, with the same export names, and point it at
the new files. Replace the whole of `notes-plugin.ts`:

```ts
// The public surface of the Notes package. Callers keep importing from this
// file; the declarations now live in notes/, one primitive per directory.

// The plugin generated from notes/copilotz.json and the discovered leaves.
export { default as notesPlugin } from "./notes/plugin.generated.ts";
// The `note` Collection and the record type derived from its schema.
export { default as note } from "./notes/collections/note/index.ts";
export type { NoteRecord } from "./notes/collections/note/index.ts";
// The `notes.save` Action, for wrappers such as an agent tool, and its input.
export { default as saveNote } from "./notes/actions/save-note/index.ts";
export type { SaveNoteInput } from "./notes/actions/save-note/index.ts";
// The `notes.capture` Processor.
export { default as captureNote } from "./notes/processors/capture-note/index.ts";
```

The barrel is ordinary application code, not a framework feature. Because
`saveNote` here and `saveNote` inside `notesPlugin` are the same object, a
plugin that depends on `notesPlugin` and wraps `saveNote`, such as Chapter 9's
`notesToolsPlugin`, still composes one `notes.save` Action. `composition.ts`,
`app.ts`, the tests and every later module need no change.

### Optional: integration resources as leaves

Skip this if your plugin has only Collections, Actions and Processors.

Resources follow the same convention with one extra directory level,
`resources/<namespace>/<alias>/index.ts`. Skills, OpenAPI definitions and MCP
servers each contribute their own Actions, Tools and dependencies when the
generated plugin is composed, so the manifest lists no extra feature plugins and
you import no marker plugin:

```text
assistant-integrations/
  copilotz.json
  resources/skills/planning/index.ts     default-exports defineSkill({ root })
  resources/skills/planning/SKILL.md     read at run time; copy it on deploy
  resources/apis/posts/index.ts          default-exports defineApi({ ... })
```

Keep these in a **separate plugin root**, not inside `notes/`. A Skill or API
resource brings in the agent harness, while Notes stays a runtime-only
definition that tests and servers import without Core. A Skill leaf keeps
Chapter 11's module-relative root, so it finds `SKILL.md` next to the leaf no
matter which directory the application starts in:

```ts
// The same Skills import that Chapter 11 used.
import { defineSkill } from "@copilotz/copilotz/skills";

// The planning Skill, read lazily from this directory when an agent with the
// grant uses it. The alias `planning` must equal the `name` in SKILL.md.
export default defineSkill({
  // Relative to this leaf file, not to the process's working directory.
  root: new URL("./", import.meta.url),
});
```

`SKILL.md` and its supporting files are not code, so neither the build nor a
bundler copies them. Include them in every deployment and package explicitly.

An MCP leaf is different. It default-exports `await defineMcp({...})`, which
connects to a live server while the module is imported. The generator can
discover it, but importing the generated plugin then performs that connection.
Keep such a leaf in its own host-only plugin root that only host composition
imports, as `notes-mcp.ts` was in Chapter 10, and never in a root that tests or
other packages import. Generate that root with `--source-only`. A full build
validates by importing the generated module in a child process that has only
read permission; the `-A` you pass to the build command is not passed on, so a
leaf that connects or performs other I/O at the top level can fail validation.
The host then imports the generated module itself, with the permissions and
server it controls. Credentials stay in host composition in every case. See
[Convention authoring](../../convention-authoring.md) for each resource layout.

### Share the plugin as a package

To publish Notes for other applications, describe it in the package's own
`deno.json`. This is a separate package from your application; adapt the scope
and license to yours:

```jsonc
{
  // Package name and release on the registry. Its version is the package
  // release; the plugin's stable `id` in copilotz.json does not change with it.
  "name": "@team-notes/notes",
  "version": "1.0.0",
  "license": "MIT",
  // The only public entrypoint: the barrel, with its six exported names.
  "exports": { ".": "./notes-plugin.ts" },
  // Ship the barrel, the leaves, the manifest and the generated module.
  "publish": {
    "include": ["notes-plugin.ts", "notes/**/*.ts", "notes/copilotz.json"],
    "exclude": ["notes/dist/"]
  },
  // The framework is an ordinary semver dependency, not a peer. A consumer whose
  // own range resolves to the same version shares one module; different
  // installed framework versions are not guaranteed to be deduplicated.
  "imports": {
    "@copilotz/copilotz": "jsr:@copilotz/copilotz@^0.86.2",
    "@copilotz/copilotz/plugins": "jsr:@copilotz/copilotz@^0.86.2/plugins"
  }
}
```

A registry publishes the files you include; it does not discover directories or
run the build command for you. Generate `plugin.generated.ts` before you
publish. Package-level assets such as `SKILL.md` must be listed in `include`
too.

Decide what the public API is. For Notes it is the barrel's export names, the
plugin `id`, the Collection name and schema, the Action ID and input schema, the
Event types they produce, and the aliases `note` and `saveNote` that callers use
in `context.collections` and `context.actions`. Leaf paths, `shared/` helpers
and the generated module's internals are not public: keep consumers on the
barrel, so you can reorganize directories freely.

### Evolve without breaking stored data

New versions of a shared plugin change the package version, and the plugin
`version` in `copilotz.json` if you track it alongside, but not the plugin `id`
or any stored identity. Within a release:

- Adding an optional schema field, a new Action, a new Collection or a new
  Processor is additive.
- Renaming a Collection name, Action ID, Processor ID or Event type, removing a
  field that stored records use, or making an optional field required changes
  stored data and its consumers. Treat it as a breaking release.
- Directory names are aliases. Renaming `save-note/` changes the alias that
  callers use, unless you pin the old one with an `aliases` entry in
  `copilotz.json`.

Copilotz does not migrate records or Events automatically, and nothing in this
chapter resets a database. Plan data changes explicitly, as described in
[Upgrading](../../upgrading.md).

## Check it works

Generate the plugin, then confirm in CI that the committed file matches the
sources:

```sh
# Write notes/plugin.generated.ts from the leaves and copilotz.json.
deno run -A jsr:@copilotz/copilotz@^0.86.2/build build notes --source-only
# Fail, without writing, if the committed generated file is stale.
deno run -A jsr:@copilotz/copilotz@^0.86.2/build build notes --check
```

The generated file should list `note`, `saveNote` and `captureNote` with the
`@team-notes/notes` ID and `1.0.0` version. The `--check` command exits with
status 0 and prints nothing. Add, rename or remove an entry directory, or change
`copilotz.json`, without regenerating, and it fails with a message that
`plugin.generated.ts` is stale. This is a registration drift check over the
generated imports, identity and aliases. It does not hash leaf sources or test
behaviour: editing the body of an existing leaf leaves the file current, which
is why the scenarios below still run.

For automated regression checks, first create the scenario files from
[Chapter 6](../part-2-verify-and-recover/06-test-and-inspect.md). This
validation step is optional and is not needed to generate or run the plugin. Its
scenarios then run unchanged on both runtimes:

```sh
# Deno: the scenarios import the barrel, which now re-exports generated code.
deno test -A notes.test.ts
# Node 24+: the same scenarios through node:test.
node --test notes.node-test.ts
```

Those scenarios pass because every observable contract is the same. To check the
generated plugin directly from this chapter's required starting point, run
Chapter 5's entrypoint:

```sh
# Deno: compose the generated plugin through composition.ts.
deno run -A app.ts "Prepare the release."
# Node 24+: the same run, with no build tooling at run time.
node app.ts "Prepare the release."
```

The output matches Chapter 5: one `notes.save.invoked`, one `note.created` and
one `notes.save.completed` line, and the operation settles as `completed`. An
empty note still fails validation. The Event types did not change because no
stored identity changed.

## What this unlocks

The Notes plugin can now grow one file at a time, and adding a primitive no
longer means editing a registration list. You can:

- add a Collection, Action or Processor by creating a directory and running the
  build command, with deterministic output and a `--check` guard in CI;
- run the generated plugin on any host where the hand-written one ran, since
  discovery happens only on the build host;
- publish Notes as a package whose public surface is a small barrel, while its
  stable IDs and schemas carry stored data across releases;
- keep integrations such as Skills and APIs in their own plugin roots, and live
  MCP connections in host-only modules.

This completes the lifecycle path: design, verify, release, operate and evolve.
Not every project needs every chapter; agent behaviour, channels and usage
measurement remain optional additions to the same runtime.

## Next steps

- Reference: [Convention authoring](../../convention-authoring.md) covers every
  directory category, `copilotz.json` options, resource leaves and build flags.
- Reference: [Plugins and Processors](../../plugins-and-processors.md) explains
  composition, dependencies and alias conflicts.
- Reference: [Upgrading](../../upgrading.md) lists release changes and how to
  plan data changes between versions.
- Map: [Documentation index](../../README.md) lists every guide and reference.
