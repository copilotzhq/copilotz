# Knowledge plugin

## What it is

A first-party plugin for ingesting, indexing, searching, and deleting scoped
knowledge documents.

## Why it exists

It provides durable document lifecycle state, background indexing, and
model-facing search without making the runtime own RAG semantics.

## How to use it

```ts
import { knowledgePlugin } from "@copilotz/copilotz/knowledge";
// Include knowledgePlugin in the final createCopilotz({ plugins: [...] }) call.
```

Set `resources.knowledge.config.embedding` and optional `chunking`. Supply
`adapters.embedding`, with optional `adapters.knowledge.loader` and `extractor`.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
