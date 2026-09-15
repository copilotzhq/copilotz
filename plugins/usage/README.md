# Usage plugin

## What it is

The Usage plugin projects metered LLM and Tool work into a durable accounting
ledger.

## Why it exists

Applications need consistent usage analytics without coupling the generic
runtime to semantic LLM or Tool events.

## How to use it

```ts
import { usagePlugin } from "@copilotz/copilotz/usage";
// Include usagePlugin in the final createCopilotz({ plugins: [...] }) call.
```

Set `resources.usage.config.enabled`; put `resolveCost` and `onRecord` in
`adapters.usage.hooks`. Disabling usage suppresses persistence and hooks.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
