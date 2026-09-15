# Channel core

## What it is

The shared graph, ingress, and egress runtime used by every concrete channel
provider.

## Why it exists

It gives providers one durable mapping from their external threads to Copilotz
threads.

## How to use it

```ts
import { channelsPlugin } from "@copilotz/copilotz/channels";
// Include channelsPlugin in the final createCopilotz({ plugins: [...] }) call.
```

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
