# Core

## What it is

The semantic plugin for agent Messages, LLM routing, Tools, parallel plans, and
Agent-to-Agent Ask.

## Why it exists

Applications need one durable orchestration layer over provider-neutral LLM and
domain storage primitives.

## How to use it

```ts
import { corePlugin } from "@copilotz/copilotz/core";
// Include corePlugin in the final createCopilotz({ plugins: [...] }) call.
```

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
