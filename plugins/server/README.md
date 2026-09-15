# Server Plugin

## What it is

The semantic Copilotz HTTP facade over composed Actions, Collections, Channels,
Assets, and safe Agent projections.

## Why it exists

Applications should not rebuild primitive discovery, validation, durable Action
dispatch, streaming, and OpenAPI generation for every HTTP server.

## How to use it

```ts
import { serverPlugin } from "@copilotz/copilotz/server";
// Include serverPlugin in the final createCopilotz({ plugins: [...] }) call.
```

Override `resources.server.default` using
`defineServerFacade({ authenticate, authorize, expose })`. Routes compile after
final composition.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
