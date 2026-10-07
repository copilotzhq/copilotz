---
title: "Filesystem Plugin Authoring"
description: "Lay out plugin declarations one per directory, describe the plugin in copilotz.json, and generate a static, deterministic plugin module with the Deno build command."
section: Evolve
order: 10
status: stable
---

# Filesystem Plugin Authoring

## The pain

A plugin that started as one `definePlugin` call keeps growing. Each new
Collection, Action or Processor has to be added by hand to the plugin's
`collections`, `actions` or `processors` map. Forgetting that line leaves a
declaration that exists in the source but is never registered, and nothing
complains until a caller finds `context.actions.saveNote` missing.

## The problem

You want one file per primitive and no hand-maintained registration list. But
the application must not scan directories when it starts: it runs on Node, Deno,
in bundles and on hosts without a filesystem, and evaluating whatever modules
happen to be on disk is not a safe way to compose a plugin. Moving files must
also leave every stored identity unchanged: Collection names, Action and
Processor IDs, schemas and operation keys are already part of recorded Events.

What is missing is a contract that says which files are declarations, how their
registration names are chosen, and where discovery happens.

## The solution

Discovery happens once, on a **build host** with Deno 2.9 or later. The Copilotz
build command reads conventional `index.ts` files as source text, without
executing them, and writes `plugin.generated.ts`: an ordinary module with sorted
static imports and one `definePlugin` call. Applications import that module. At
run time nothing is discovered, so the generated plugin runs on every host where
a hand-written plugin runs.

[Chapter 22](getting-started/part-6-evolve-and-reuse/22-organize-and-share-plugins.md)
applies this to the Notes plugin step by step. This reference uses the same
`notes/` root and states the rules behind it.

### Layout

```text
notes/
  copilotz.json                        plugin id, version and options
  collections/note/index.ts            default-exports defineCollection(...)
  actions/save-note/index.ts           default-exports defineAction(...)
  processors/capture-note/index.ts     default-exports defineProcessor(...)
  shared/                              helpers reused by several leaves; never an entry
  plugin.generated.ts                  written by the build command; commit it
  dist/plugin.js                       optional bundle from a full build
```

A **leaf** is an `index.ts` file at an exact depth with a default export:

| Category    | Path                                    | Registered as                     |
| ----------- | --------------------------------------- | --------------------------------- |
| Collections | `collections/<name>/index.ts`           | `collections[<alias>]`            |
| Actions     | `actions/<name>/index.ts`               | `actions[<alias>]`                |
| Processors  | `processors/<name>/index.ts`            | `processors[<alias>]`             |
| Resources   | `resources/<namespace>/<name>/index.ts` | `resources[<namespace>][<alias>]` |
| Adapters    | `adapters/<namespace>/<name>/index.ts`  | `adapters[<namespace>][<alias>]`  |

Rules that follow from the build command:

- The alias is the leaf's directory name with `-x` turned into `X`: `save-note`
  becomes `saveNote`. Aliases must match `^[a-z][a-zA-Z0-9_]*$`.
- Only the leaf alias is camel-cased. A resource or adapter **namespace** is
  used as written and must already match the same pattern, so
  `resources/my-policy/` is rejected; an `aliases` entry cannot rename it.
- `index.ts` files at any other depth are ignored, so a helper module at
  `actions/save-note/format/index.ts` is not an entry.
- Directories named `shared`, `authoring`, `node_modules`, `dist` and `.git` are
  skipped. A directory named `internal` or `dependencies` is an error in scanned
  directories: use primitive-local helpers, `shared/`, or manifest `plugins`.
  Symlinked directories are not followed.
- A leaf without a default export, an invalid alias or namespace, and two leaves
  with the same category, namespace and alias each stop the build with the
  offending path.

Aliases are local registration names only. Stable identities stay written inside
each declaration, so renaming a directory changes how callers reach a primitive,
not what is stored.

### `copilotz.json`

The manifest is read only by the build command. Chapter 22 needs just the first
two fields:

```json
{
  "id": "@team-notes/notes",
  "version": "1.0.0"
}
```

Every supported field:

```jsonc
{
  // Required. Become the generated definePlugin's id and version.
  "id": "@team-notes/notes",
  "version": "1.0.0",
  // Optional. Exact entry paths to register; omit to register every
  // conventional entry. Not globs; each path must be discovered or the build fails.
  "include": [
    "collections/note/index.ts",
    "actions/save-note/index.ts",
    "processors/capture-note/index.ts"
  ],
  // Optional. Exact entry path to explicit alias, for example a model-facing
  // snake_case name or a pinned old alias after a directory rename.
  "aliases": { "actions/save-note/index.ts": "saveNote" },
  // Optional. Plugin dependencies, emitted as static imports. Notes is
  // self-contained, so its dependency list is empty.
  "plugins": []
}
```

Each dependency entry supplies `from` (its module specifier) and `export` (the
exported binding name, or `"default"`). For example, a separate plugin root
beside `notes/` can list
`{ "from": "../notes/plugin.generated.ts", "export":
"default" }` in its own
manifest. Notes itself depends on nothing. Dependencies are never inferred from
imports.

### A leaf

Leaves are pure definitions: no environment reads, connections or other I/O at
the top level, because every test and application that imports the generated
plugin imports them too. This is Chapter 22's `notes/collections/note/index.ts`,
unchanged:

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

The `saveNote` Action and `captureNote` Processor leaves, and the barrel that
keeps `./notes-plugin.ts` imports working, are in Chapter 22.

### Build commands

The command is the `build` export of the package and its first argument is the
literal word `build`. Run it from the project directory:

```sh
# Write notes/plugin.generated.ts only. Leaves are read as text, not imported.
deno run -A jsr:@copilotz/copilotz@^0.86.0/build build notes --source-only
# Fail without writing if the committed plugin.generated.ts is stale.
deno run -A jsr:@copilotz/copilotz@^0.86.0/build build notes --check
# Full build: generate, type-check, validate in a read-only child, bundle.
deno run -A jsr:@copilotz/copilotz@^0.86.0/build build notes
```

| Option                     | Effect                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| roots (positional)         | One or more plugin roots; `.` when omitted. All are generated before any is validated.    |
| `--source-only`            | Write `plugin.generated.ts` and stop.                                                     |
| `--check`                  | Compare `plugin.generated.ts` with the exact generator output; write nothing.             |
| `--output=path`            | Bundle path instead of `<root>/dist/plugin.js`. Only with a single root.                  |
| `--platform=browser\|deno` | Bundle target, `browser` by default. Use `deno` only for leaves importing native modules. |

What each mode proves:

- **Generation is deterministic.** Paths are sorted, so the same sources and
  manifest always produce the same file. `--check` therefore detects added,
  removed or renamed entries and manifest changes. It does not hash leaf bodies
  or test behaviour; keep your scenarios for that.
- **A full build** writes `plugin.generated.ts` first, then type-checks it,
  imports it in a child process that has only read permission to validate the
  composed plugin graph, and bundles it. Only the final bundle replacement is
  atomic. If a later step fails, the new generated source can sit next to the
  previous `dist/plugin.js`, so treat a generated file's presence as
  "generated", not "validated".
- **`--source-only`** neither rebuilds nor invalidates an existing bundle.
- The bundle marks `@copilotz/copilotz` and all its subpaths as external. A
  built plugin never carries a second framework copy, so plugin identity and
  dependency checks use the application's own framework module.

A code formatter may rewrap the generated file; `--check` compares exact text,
so exclude generated modules from formatting or regenerate after formatting.

### Integration resource leaves

Declarative integration resources are ordinary resource leaves. When the
generated plugin is composed, each one contributes its own Actions, Tools and
plugin dependencies, so `copilotz.json` lists no extra feature plugins:

| Leaf                                | Default export           | Notes                                                   |
| ----------------------------------- | ------------------------ | ------------------------------------------------------- |
| `resources/apis/<alias>/index.ts`   | `defineApi({...})`       | Pure definition; credentials stay in host adapters.     |
| `resources/skills/<alias>/index.ts` | `defineSkill({ root })`  | Alias equals the `SKILL.md` name; root module-relative. |
| `resources/mcp/<alias>/index.ts`    | `await defineMcp({...})` | Connects to a live server on import: host-only root.    |

Keep these in a **separate plugin root** from runtime-only definitions such as
Notes. API, Skill and MCP resources bring in the agent harness, while Notes
stays importable by tests and servers without it.

A Skill leaf reads files at run time from its `root`. Neither the build command
nor a bundler copies `SKILL.md` or its supporting files, and the runtime never
scans directories for them: package and deploy them explicitly, and check that
`import.meta.url` still points next to them after bundling.

An MCP leaf performs discovery while its module is evaluated, so importing the
generated plugin connects. Keep it in its own root imported only by host
composition, as `notes-mcp.ts` was in
[Chapter 10](getting-started/part-3-add-agent-behavior/10-connect-apis-and-mcp.md),
and generate that root with `--source-only`. A full build's validation child has
read permission only; the `-A` you pass is not forwarded, so a leaf that spawns
a server or opens a network connection at the top level can fail validation.

## What this unlocks

- Adding a primitive means creating a directory and regenerating, with a
  `--check` guard in CI instead of a registration list to review.
- The generated plugin is plain TypeScript with static imports, so it runs on
  Deno, Node and in bundles with no build tooling at run time.
- Independently built plugins share one framework identity because the framework
  stays external.
- Integrations get the same layout while live connections stay a host choice.

## Next steps

- Tutorial:
  [Chapter 22](getting-started/part-6-evolve-and-reuse/22-organize-and-share-plugins.md)
  moves Notes into leaves, adds the barrel and shares the package.
- Reference: [Plugins and Processors](plugins-and-processors.md) explains
  composition, dependencies and alias conflicts.
- Reference: [Integrations](integrations.md) covers API and MCP resources and
  their host adapters.
- Contributors: documentation conventions live in
  [DOCUMENTATION.md](https://github.com/copilotzhq/copilotz/blob/main/DOCUMENTATION.md).
