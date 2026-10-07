---
title: "Contributing to Built-In Plugins"
description: "How library contributors lay out built-in plugin roots, keep generated composition and public indexes in sync, respect dependency boundaries, and map each repository check to what it actually guarantees."
section: Contributors
order: 10
status: stable
---

# Contributing to Built-In Plugins

This page is for people who change the Copilotz repository itself. If you are
building an application, read
[Filesystem Plugin Authoring](convention-authoring.md) instead. Your application
never needs to copy the repository's internal folder layout.

## The pain

Say you add a Processor to the Usage plugin. You write the handler, import a
helper from `runtime/` through a relative path, and register the Processor in
`plugin.ts` by hand. Your tests pass, but:

- the generated composition no longer matches its sources, so the next
  contributor who runs the generator gets a confusing diff;
- the relative import couples the plugin to private runtime paths instead of the
  supported package surface;
- moving the helper into the runtime would create a reverse dependency if it
  still imported Usage definitions, pulling plugin meaning into generic code.

None of these problems show up in a unit test. Each one shows up later, in
someone else's build.

## The problem

The repository needs a contract for built-in plugins that answers these
questions:

1. Which directories count as concrete plugin roots, and which files must each
   root contain?
2. Where does each primitive live, and where do helpers go?
3. Which file is the source of truth for composition: hand-written code or
   generated code?
4. Which imports are allowed between `runtime/` and `plugins/`?
5. Which check enforces which part of this contract, and what is left to review?

## The solution

Built-in plugins use the same declaration-per-directory convention that
applications use. They add a fixed root shape and a few repository checks on
top. [`REPO.md`](https://github.com/copilotzhq/copilotz/blob/main/REPO.md) and
[`ARCHITECTURE.md`](https://github.com/copilotzhq/copilotz/blob/main/ARCHITECTURE.md)
are the authoritative contributor contracts. This page summarises the parts you
need when you edit a plugin.

### Concrete plugin roots

The layout check validates a fixed list of concrete roots under `plugins/`:
`admin`, `channel-core`, `channel-discord`, `channel-telegram`, `channel-web`,
`channel-whatsapp`, `channel-zendesk`, `core`, `core-http`, `knowledge`, `llm`,
`memory`, `schedule-core`, `schedules`, `server`, `skills`, `tool-builtin`,
`tool-deno`, `tool-finance`, `tool-persistent-terminal`, `tool-web`,
`transcription` and `usage`.

Not every directory under `plugins/` is on this list. For example, the OpenAPI
and MCP tool providers are not concrete roots. Do not add the five root files to
every plugin directory. When you create a new concrete root, add it to the list
in `scripts/check-plugin-layout.ts` in the same change.

Each concrete root contains exactly these required files:

| File                  | Role                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `README.md`           | What the plugin owns, for contributors                                   |
| `copilotz.json`       | Plugin `id`, `version`, explicit `include` list and declared `plugins`   |
| `plugin.generated.ts` | Generated `definePlugin` composition; never edit by hand                 |
| `plugin.ts`           | Gives the generated default export its public name                       |
| `index.ts`            | Public barrel: plugin, intentionally public primitives, types, authoring |

Only these other entries may sit at the root: `plugin.test.ts`, `actions/`,
`collections/`, `processors/`, `resources/`, `adapters/`, `shared/` and
`authoring/`. Plugin `internal/` and `dependencies/` folders are rejected.

### Where code lives

- **Collections, Actions, Processors:** `<category>/<alias>/index.ts`. The leaf
  module calls its own `defineCollection`, `defineAction` or `defineProcessor`
  and default-exports the result.
- **Resources and Adapters:** `<category>/<namespace>/<alias>/index.ts`. They
  also default-export the instance they own.
- **Helpers used by one primitive:** inside that primitive's directory. For
  example, the Usage Collection keeps its query modules under
  `collections/usage/queries/`.
- **Helpers shared by several primitives:** `shared/`. Discovery skips this
  folder.
- **Public declaration helpers and clients:** `authoring/`. Discovery skips this
  folder. Authoring helpers declare primitives when called; module-level
  primitive instances belong in the discovered leaves.
- **READMEs:** the root `README.md` is required. Add leaf READMEs where a
  primitive needs explanation; no check requires them.

A primitive owns its stable ID and its definition. Avoid factories that assemble
definition fragments, wrappers around plugin factories, duplicated registration
maps and runtime filesystem discovery. Read configuration from the final
context, as the Usage Processors do with `context.resources` and
`context.adapters`.

## Reference

### A complete root: Usage

The Usage plugin is a small root that follows the whole contract:

```text
plugins/usage/
├── README.md
├── copilotz.json
├── index.ts                     # public barrel
├── plugin.ts                    # public name for the generated plugin
├── plugin.generated.ts          # generated; do not edit
├── plugin.test.ts
├── authoring/                   # HTTP client/adapter helpers, not discovered
├── collections/usage/           # defineCollection leaf + private queries/
├── processors/record-llm-usage/ # defineProcessor leaf
├── processors/record-tool-usage/
└── shared/                      # contracts and accounting used by both Processors
```

`copilotz.json` lists every discovered leaf explicitly. The build never infers
dependencies or entries from arbitrary imports:

```json
{
  "id": "@copilotz/core-usage",
  "version": "3.0.0",
  "include": [
    "collections/usage/index.ts",
    "processors/record-llm-usage/index.ts",
    "processors/record-tool-usage/index.ts"
  ]
}
```

A root that depends on another plugin declares it with
`"plugins": [{ "from": "...", "export": "..." }]` in this file. Do not express
the dependency through an import inside a leaf.

The generator turns that manifest into a static composition. Primitive keys come
from the directory alias in camelCase:

```ts
// Generated by copilotz build. Edit source declarations, not this file.
import { type DefinedPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import entry0 from "./collections/usage/index.ts";
import entry1 from "./processors/record-llm-usage/index.ts";
import entry2 from "./processors/record-tool-usage/index.ts";
const definition = {
  id: "@copilotz/core-usage",
  version: "3.0.0",
  collections: {
    "usage": entry0,
  },
  processors: {
    "recordLlmUsage": entry1,
    "recordToolUsage": entry2,
  },
} as const;
const plugin: DefinedPlugin<typeof definition> = definePlugin(definition);
export default plugin;
```

`plugin.ts` only gives that default export its public name:

```ts
/** Public names for generated plugin composition. @module */
export { default as usagePlugin } from "./plugin.generated.ts";
```

`index.ts` is the root's public barrel. Package entrypoints re-export from it.
It names the plugin, the primitives and types applications may rely on, and the
authoring helpers. Deliberate subpaths, such as `/usage/client`, can expose
their own barrel directly. The `exports` map in `deno.json` defines those public
entrypoints; exporting a symbol from an arbitrary internal file does not make it
public.

### Import boundaries

- Plugin code imports the framework through the public package aliases, such as
  `@copilotz/copilotz/plugins` and `@copilotz/copilotz/actions`. Never use a
  relative path into `runtime/`.
- Every `@copilotz/copilotz/...` self-import must map to a declared package
  export in `deno.json`.
- `runtime/` production code must never import a concrete plugin, directly or
  transitively.
- External dependency versions belong in `deno.json` imports. Production files
  must not use inline `jsr:`, `npm:` or URL specifiers.

### Checks and what they guarantee

Run all of them with `deno task check`. Each one has a narrow job:

| Task                   | What it guarantees                                                                                                                                                                                                          | What it does not cover                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `check:plugin-layout`  | Each listed concrete root has the five required files and only allowed root entries. Each Collection/Action/Processor leaf textually contains its own `define*` call. `plugin.generated.ts` matches freshly generated text. | Import boundaries, runtime behaviour, leaf READMEs           |
| `check:generated`      | Every `plugins/*` directory that has a `copilotz.json` is up to date with the compiler (`build:plugins` regenerates them)                                                                                                   | Whether the composition is correct                           |
| `check:boundaries`     | No relative plugin→runtime imports, no unmapped self-imports, runtime never reaches a concrete plugin, no hidden `createCorePlugin` factory or exported `PLUGIN_RESOURCE_TYPES`                                             | Folder layout                                                |
| `check:surface`        | Package exports are files, self-import mappings mirror exports, exports type-check, release lint rules, no inline external specifiers, every production module is reachable from an export, no unused dependency wrappers   | Plugin semantics                                             |
| `check:core-ownership` | In Core and Core HTTP, checked top-level primitive instances stay out of `authoring/`, Resource/Adapter modules default-export, and audited helpers stay with their owning Processor                                        | Ownership of other semantic helpers, which is still reviewed |
| `check:forbidden`      | Removed or forbidden symbols do not reappear                                                                                                                                                                                | Anything else                                                |

These checks enforce structure. Behaviour comes from functional tests: leaf
`index.test.ts` files and the root `plugin.test.ts`. A module that only forwards
exports does not need its own test.

### Adding a primitive to an existing root

1. Create `<category>/<alias>/index.ts`. Define the primitive and default-export
   it.
2. Add the path to `include` in the root `copilotz.json`.
3. Run `deno task build:plugins`. Commit the regenerated `plugin.generated.ts`.
4. If applications need to import the primitive or its types, export them from
   the root `index.ts`.
5. Add a behavioural test next to the leaf, then run `deno task check`.

## What this unlocks

- Contributors can review generated composition as a plain diff and never have
  to hand-merge a registration map.
- Runtime-only applications stay free of agent and channel plugins, because the
  boundary check rejects the import path that would pull them in.
- Public barrels and explicit subpaths make API changes visible when an export
  is removed or renamed.

## Next steps

- [Filesystem Plugin Authoring](convention-authoring.md): the same convention as
  applications use it, with the Deno build command.
- [Plugins and Processors](plugins-and-processors.md): the public plugin and
  Processor contracts your leaves implement.
- [`REPO.md`](https://github.com/copilotzhq/copilotz/blob/main/REPO.md) and
  [`ARCHITECTURE.md`](https://github.com/copilotzhq/copilotz/blob/main/ARCHITECTURE.md):
  the full contributor contracts.
