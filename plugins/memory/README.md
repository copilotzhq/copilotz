# Conversation memory

## What it is

A durable memory plugin with conversation continuity and immutable plain-text
notes.

## Why it exists

It preserves conversation continuity and keeps searchable notes with optional
source references.

## How to use it

```ts
import { memoryPlugin } from "@copilotz/copilotz/memory";
// Include memoryPlugin in the final createCopilotz({ plugins: [...] }) call.
```

Configure `resources.memory.config`; optionally supply embeddings through
`adapters.memoryEmbedding.default`. The agent writes
`{ continuity, remember?, retire? }` through `consolidate_memory`, and reads
notes through `search_memory` and `inspect_memory`. Existing checkpoints stay
stored without conversion.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
