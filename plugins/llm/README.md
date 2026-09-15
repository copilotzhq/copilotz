# LLM plugin

## What it is

Copilotz’s provider-neutral, durable LLM execution plugin.

## Why it exists

It lets agents select configured models while keeping provider protocols,
credentials, streaming, and recovery behind one Action boundary.

## How to use it

```ts
import { llmPlugin } from "@copilotz/copilotz/llm";
// Include llmPlugin in the final createCopilotz({ plugins: [...] }) call.
```

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
