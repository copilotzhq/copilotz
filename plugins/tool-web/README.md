# Web Tools

## What it is

A selectable plugin of runtime-neutral HTTP, text-fetching, and web-search
Tools.

## Why it exists

Agents often need bounded network access without receiving filesystem or
subprocess capabilities.

## How to use it

```ts
import { webToolsPlugin } from "@copilotz/copilotz/tools/web";
// Include webToolsPlugin in the final createCopilotz({ plugins: [...] }) call.
```

Select individual exported Tool declarations in `resources.tools`; only selected
Tools contribute Actions.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
