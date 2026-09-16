# Plugin layout

The library and applications share the
[convention-first authoring format](convention-authoring.md).

Each concrete root owns a `copilotz.json`, its source declarations, a public
`index.ts`, and a generated `plugin.generated.ts`. `plugin.ts` exports public
names for that generated composition. The build never infers dependencies from
arbitrary imports.

- Collections, Actions, and Processors: `<category>/<alias>/index.ts`.
- Resources and Adapters: `<category>/<namespace>/<alias>/index.ts`.
- Explicit dependencies: `plugins: [{from, export}]` in `copilotz.json`.
- Private helpers used by one primitive: inside that primitive module.
- Helpers shared across different primitives: `shared/`, excluded from
  discovery.
- Public authoring APIs: `authoring/`, excluded from discovery.

Core owns its collections and Tool authoring. Optional tool providers remain
separate plugins. Provider-specific OpenAPI and MCP contracts belong to those
providers. Plugin `internal/` and `dependencies/` folders are not supported.

A primitive owns its definition and stable identity. Avoid definition-fragment
factories, plugin factory wrappers, duplicated registration maps, and runtime
filesystem discovery. Use static declarations and final-context configuration.

`deno task check:plugin-layout` verifies ownership and generated composition.
`deno task check:generated` detects drift. Functional tests cover behavior and
integration boundaries; forwarding-only wrappers do not need mirrored tests.
