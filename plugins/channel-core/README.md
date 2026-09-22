# Channel core

## What it is

The shared conversation graph, ingress, and durable egress integration used by
Core channel providers. Generic event channels can use application sends
without this conversation integration.

## Why it exists

It gives providers one durable mapping from their external threads to Copilotz
threads.

HTTP admission is optional. Trusted session hosts can submit channel
occurrences directly; live sessions choose their own interruption policy. See
[Channels](../../docs/channels.md) for the ingress/egress boundary and examples.

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
