# Finance Tool Plugin

## What it is

A concrete Tool plugin that provides bounded market and company data through a
swappable Finance provider.

## Why it exists

Applications need one composed Action and data-only Tool Resource for finance
queries while keeping provider implementation private and replaceable.

## How to use it

```ts
import { financeToolsPlugin } from "@copilotz/copilotz/tools/finance";
// Include financeToolsPlugin in the final createCopilotz({ plugins: [...] }) call.
```

Register provider objects in `adapters.financeProviders[name]`. The default
provider remains Yahoo when no override is supplied.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
