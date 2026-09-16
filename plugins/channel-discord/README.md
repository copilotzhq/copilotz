# Discord Channel

## What it is

A Discord interactions and Bot API Channel provider.

## Why it exists

Discord authentication, interaction parsing, media handling, and delivery need a
provider-specific boundary around generic Channel semantics.

## How to use it

```ts
import { discordChannelPlugin } from "@copilotz/copilotz/channels";
// Include discordChannelPlugin in the final createCopilotz({ plugins: [...] }) call.
```

Channel policy belongs in `resources.channels[alias]`. Bind a static provider
adapter at `adapters.channels[alias]`; credentials, resolver hooks, and
transports belong in `adapters.channelProviders[alias]`. Configuration is
isolated by alias.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
