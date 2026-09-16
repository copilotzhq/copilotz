# Semantic memory

## What it is

A durable semantic-memory plugin for Copilotz conversations.

## Why it exists

It consolidates conversation evidence into queryable, provenance-aware records.

## How to use it

```ts
import { memoryPlugin } from "@copilotz/copilotz/memory";
// Include memoryPlugin in the final createCopilotz({ plugins: [...] }) call.
```

Configure `resources.memory.config` and `resources.memory.kinds`; supply
embedding through `adapters.memoryEmbedding.default`. Custom kinds are validated
from the final context.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
