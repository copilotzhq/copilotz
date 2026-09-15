# Built-in Tools

## What it is

This plugin provides the portable tools supplied with every Copilotz runtime.

## Why it exists

Applications need common time, asset, memory, and thread operations without a
host-specific adapter.

## How to use it

```ts
import { builtInToolsPlugin } from "@copilotz/copilotz/tools/builtin";
// Include builtInToolsPlugin in the final createCopilotz({ plugins: [...] }) call.
```

Select individual exported Tool declarations in `resources.tools`. Optional
clock and sleep implementations belong in `adapters.clock.default`.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
