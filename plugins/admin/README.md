# Admin plugin

## What it is

Read-only typed administrative projections.

## Why it exists

Applications need safe administrative views without raw storage access.

## How to use it

```ts
import { adminPlugin } from "@copilotz/copilotz/admin";
// Include adminPlugin in the final createCopilotz({ plugins: [...] }) call.
```

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
