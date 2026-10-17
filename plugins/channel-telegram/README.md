# Telegram Channel

## What it is

A Telegram Bot API Channel provider.

## Why it exists

Telegram webhook authentication, update parsing, media, and delivery need a
provider-specific boundary around generic Channel semantics.

## How to use it

```ts
import { telegramChannelPlugin } from "@copilotz/copilotz/channels";
// Include telegramChannelPlugin in the final createCopilotz({ plugins: [...] }) call.
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

The explicit [send-text Action](actions/send-text/README.md) is the first
owner-effect-aware provider path. It sends one bounded ordinary text request;
automatic legacy egress, content/View routing, media and protected credential
hydration are not yet converted.
