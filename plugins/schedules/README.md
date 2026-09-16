# Schedules plugin

## What it is

The Schedules plugin turns host clock inputs into durable Scheduled Job due
facts while keeping job payloads opaque.

## Why it exists

Scheduling requires atomic claims, deterministic occurrence identities, and
restart-safe delivery without making time a generic runtime concern.

## How to use it

```ts
import { schedulesPlugin } from "@copilotz/copilotz/schedules";
// Include schedulesPlugin in the final createCopilotz({ plugins: [...] }) call.
```

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
