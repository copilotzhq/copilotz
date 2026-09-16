# Web Channel

## What it is

An in-process request/observation Channel provider for web applications.

## Why it exists

Web hosts need a small transport-neutral bridge from typed request bodies into
durable Channel ingress.

## How to use it

```ts
import { webChannelPlugin } from "@copilotz/copilotz/channels";
// Include webChannelPlugin in the final createCopilotz({ plugins: [...] }) call.
```

Web uses request observation. Override `resources.channels.web` for policy, or
bind the exported Web Resource and Adapter under your own alias.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
