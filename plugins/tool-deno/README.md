# Deno Tools

## What it is

Selectable workspace filesystem and subprocess Tools for Deno hosts.

## Why it exists

Agents need bounded local capabilities without coupling host code to individual
Action and Tool Resource definitions.

## How to use it

```ts
import { denoToolsPlugin } from "@copilotz/copilotz/tools/deno";
// Include denoToolsPlugin in the final createCopilotz({ plugins: [...] }) call.
```

This explicit Deno subpath owns native filesystem and process tools. Select
individual exported declarations in `resources.tools` to omit process execution
or other capabilities.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
