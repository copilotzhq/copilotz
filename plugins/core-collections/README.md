# Core Collections

## What it is

The durable conversation storage boundary shared by Core applications.

## Why it exists

Collection mutation and typed input projection are useful independently from LLM
routing and higher-level agent semantics.

## How to use it

```ts
import { coreCollectionsPlugin } from "@copilotz/copilotz/core";
// Include coreCollectionsPlugin in the final createCopilotz({ plugins: [...] }) call.
```

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
