# OpenAPI Tool Plugin

## What it is

A concrete plugin factory that turns an OpenAPI declaration into executable
Actions and Tool Resources.

## Why it exists

It lets applications expose documented HTTP operations to agents without
hand-writing a separate action and resource for every endpoint.

## How to use it

```ts
import { openApiToolsPlugin } from "@copilotz/copilotz/tools/openapi";
// Include openApiToolsPlugin in the final createCopilotz({ plugins: [...] }) call.
```

Run `compileOpenApiTools({ apis })` explicitly and register the resulting
declarations in `resources.tools`. Resolve auth, request hooks, transport, and
an optional cache through `adapters.openapi[apiId]`.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
