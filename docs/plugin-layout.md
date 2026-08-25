# Plugin Layout

Copilotz organizes plugin source by concrete capability and runtime primitive.
The layout makes ownership visible without changing the runtime composition
model: plugins still contribute Collections, Actions, Processors, Resources, and
Adapters through `definePlugin`.

## Why this layout exists

The former tree mixed concrete plugins, provider families, public helpers, and
private implementation modules at the same level. That made it difficult to
identify which plugin owned a primitive, which files were public, and where a
new implementation belonged. The canonical layout gives every concrete plugin
one root and every hand-authored primitive one local owner.

This is a physical ownership convention. It must not change public package
subpaths, APIs, event semantics, or runtime behavior.

## Canonical plugin root

```text
plugins/<plugin-name>/
  README.md
  index.ts
  plugin.ts
  plugin.test.ts
  internal/                         # only when shared across categories

  actions/                          # only when used
    index.ts
    internal/                       # only when shared by Actions
    <action-name>/
      README.md
      index.ts
      index.test.ts
      internal/                     # only when private to this Action

  adapters/                         # same shape as actions/
  collections/                      # same shape as actions/
  processors/                       # same shape as actions/
  resources/                        # same shape as actions/

  authoring/                        # public cross-primitive authoring APIs
    index.ts
    internal/                       # only when shared by helpers
    <helper-or-generator>/
      README.md
      index.ts
      index.test.ts
      internal/                     # only when private to this helper
```

Empty directories are omitted. A concrete plugin root always owns `README.md`,
`index.ts`, `plugin.ts`, and `plugin.test.ts`.

## Ownership rules

1. One concrete `definePlugin(...)` unit has one plugin root. A family barrel
   may aggregate concrete plugins but cannot own their implementation.
2. Singleton capabilities use concise names such as `core`, `llm`, `skills`, and
   `memory`. Variants use semantic prefixes such as `channel-whatsapp`,
   `tool-openapi`, and `schedule-core`.
3. `plugin.ts` contains composition only: it imports owned primitives and
   assembles them with `definePlugin(...)`.
4. `index.ts` is the deliberate public barrel. Private implementation modules
   are never re-exported accidentally.
5. Each hand-authored primitive owns its implementation, focused tests, README,
   and source-level module documentation in its own directory.
6. Private code goes in the nearest `internal/` directory. The root
   `dependencies/` directory is reserved for wrapped external packages and is
   not used inside plugins; registry selections and versions belong exclusively
   in `deno.json#imports`.
7. `authoring/` is only for public helpers, compilers, and generators that are
   not runtime primitives and may produce more than one primitive. Examples
   include object-form `defineTool`, `createToolsPlugin`, OpenAPI generation,
   and MCP generation.
8. A compound helper has one implementation owner under `authoring/`; its
   generated Action and Resource source is never duplicated under both primitive
   categories.
9. Hand-authored Actions and Resources remain in their primitive directories.
   Generated operations do not receive one directory per generated primitive;
   their generator owns implementation, documentation, validation, and tests.
10. Every plugin and primitive module begins with a module doc ending in an
    `@module` tag. Its README explains what it is, why it exists, how to use it,
    and how it works.

## Family barrels

The compatibility boundary is the published package subpath, not the old
physical path. Family barrels may remain where a package subpath aggregates
multiple concrete plugins:

- `plugins/channels/index.ts` aggregates the channel plugins exported by
  `@copilotz/copilotz/channels`.
- `plugins/tools/index.ts` aggregates Tool contracts and concrete Tool plugin
  exports for `@copilotz/copilotz/tools` and owns only its public
  cross-primitive authoring helpers.

Family barrels contain exports only. They contain no `definePlugin` call or
concrete primitive implementation.

## Migration inventory

This table is the authoritative old-path to concrete-owner map. Published
subpaths in the final column remain stable while internal paths move.

| Existing factory                                                                  | Final owner                         | Primitive ownership                                    | Stable package subpath                                            |
| --------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| `plugins/admin/plugin.ts#createAdminPlugin`                                       | `plugins/admin/`                    | Actions                                                | `./admin`                                                         |
| `plugins/channels/plugin.ts#channelsPlugin`                                       | `plugins/channel-core/`             | Collections, Actions, Processors                       | `./channels`                                                      |
| `plugins/channels/web.ts#createWebChannelPlugin`                                  | `plugins/channel-web/`              | Resources, Adapters                                    | `./channels`                                                      |
| `plugins/channels/discord/channel.ts#createDiscordChannelPlugin`                  | `plugins/channel-discord/`          | Resources, Adapters                                    | `./channels`                                                      |
| `plugins/channels/telegram/channel.ts#createTelegramChannelPlugin`                | `plugins/channel-telegram/`         | Resources, Adapters                                    | `./channels`                                                      |
| `plugins/channels/whatsapp/channel.ts#createWhatsAppChannelPlugin`                | `plugins/channel-whatsapp/`         | Resources, Adapters                                    | `./channels`                                                      |
| `plugins/channels/zendesk/channel.ts#createZendeskChannelPlugin`                  | `plugins/channel-zendesk/`          | Resources, Adapters                                    | `./channels`                                                      |
| `plugins/core/plugin.ts#coreCollectionsPlugin`                                    | `plugins/core-collections/`         | Collections, Actions, Processors                       | `./core`                                                          |
| `plugins/core/plugin.ts#corePlugin`                                               | `plugins/core/`                     | Collections, Actions, Processors, Resources            | `./core`, `./core/cli`, `./core/cli/node`                         |
| `plugins/llm/plugin.ts#llmPlugin`                                                 | `plugins/llm/`                      | Actions, provider Adapters                             | `./llm`                                                           |
| `plugins/knowledge/plugin.ts#createKnowledgePlugin`                               | `plugins/knowledge/`                | Collections, Actions, Processors, Resources, authoring | `./knowledge`                                                     |
| `plugins/skills/plugin.ts#createSkillsPlugin`                                     | `plugins/skills/`                   | Actions, Resources, authoring                          | `./skills`, `./skills/deno`                                       |
| `plugins/memory/plugin.ts#createLongTermMemoryPlugin`                             | `plugins/memory/`                   | Collections, Actions, Processors, Resources, Adapters  | `./memory`                                                        |
| `plugins/schedules/plugin.ts#schedulesPlugin`                                     | `plugins/schedules/`                | Collections, Actions, Processors                       | `./schedules`                                                     |
| `plugins/core-schedules/plugin.ts#coreSchedulesPlugin`                            | `plugins/schedule-core/`            | Actions, Processors, Resources                         | `./schedules/core`                                                |
| `plugins/usage/plugin.ts#createUsageWorkflowPlugin`                               | `plugins/usage/`                    | Collections, Processors                                | `./usage`                                                         |
| `plugins/tools/plugin.ts#createToolsPlugin`                                       | `plugins/tools/authoring/`          | generated Actions and Resources                        | `./tools`                                                         |
| `plugins/tools/builtin/plugin.ts#createBuiltInToolsPlugin`                        | `plugins/tool-builtin/`             | Actions, Resources                                     | `./tools/builtin`                                                 |
| `plugins/tools/deno/index.ts#nativePlugin`                                        | `plugins/tool-deno/`                | Actions, Resources                                     | `./tools/deno`                                                    |
| `plugins/tools/finance/plugin.ts#createFinanceToolsPlugin`                        | `plugins/tool-finance/`             | Actions, Resources                                     | `./tools/finance`                                                 |
| `plugins/tools/mcp/generator.ts#createMcpToolsPlugin`                             | `plugins/tool-mcp/authoring/`       | generated Actions and Resources                        | `./tools/mcp`, `./tools/mcp/stdio`                                |
| `plugins/tools/openapi/generator.ts#createOpenApiToolsPlugin`                     | `plugins/tool-openapi/authoring/`   | generated Actions and Resources                        | `./tools/openapi`                                                 |
| `plugins/tools/persistent-terminal/plugin.ts#createPersistentTerminalToolsPlugin` | `plugins/tool-persistent-terminal/` | Actions, Resources                                     | `./tools/persistent-terminal`, `./tools/persistent-terminal/deno` |
| `plugins/tools/web/plugin.ts#createWebToolsPlugin`                                | `plugins/tool-web/`                 | Actions, Resources                                     | `./tools/web`                                                     |

`nativePlugin` remains a private implementation helper; it does not create an
additional public plugin owner. The stable `./goals` subpath exposes the
application-level Core `runGoal` authoring helper, not a concrete plugin.

## Stable published subpaths

The restructuring preserves these published entrypoints:

```text
./admin
./channels
./core
./core/cli
./core/cli/node
./goals
./knowledge
./llm
./memory
./schedules
./schedules/core
./skills
./skills/deno
./tools
./tools/builtin
./tools/deno
./tools/finance
./tools/mcp
./tools/mcp/stdio
./tools/openapi
./tools/persistent-terminal
./tools/persistent-terminal/deno
./tools/web
./usage
```

Both `deno.json#exports` and matching self-import aliases must resolve directly
to final owner or family-barrel paths. Retired internal paths are deleted; they
are not retained as forwarding modules.

## Authoring versus runtime execution

An authoring helper may accept callbacks and compile a developer declaration
into runtime primitives. That does not make the helper a primitive itself. For
example, object-form `defineTool({ execute, ... })` owns the declaration that
can later produce one Action and one Tool Resource, while those generated values
remain ordinary runtime primitives.

Conversely, a hand-authored Tool Action and its data-only Tool Resource remain
under `actions/` and `resources/`. The distinction is ownership of source, not
the shape of the values returned at composition time.

## Automated enforcement

`deno task check:plugin-layout` validates concrete roots, category barrels,
primitive documentation/tests, module docs, family-barrel purity, and the
absence of plugin-local `dependencies/` directories. It is part of
`deno task check` and must be updated atomically when a concrete plugin is
added, renamed, or removed.
