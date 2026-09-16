# Schedule Core

## What it is

Schedule Core connects generic durable Scheduled Jobs to Core conversations and
exposes the `scheduled_jobs` Tool.

## Why it exists

Generic scheduling should not depend on conversation concepts. This plugin owns
the explicit bridge that turns typed due occurrences into Core Messages.

## How to use it

```ts
import { coreSchedulesPlugin } from "@copilotz/copilotz/schedules/core";
// Include coreSchedulesPlugin in the final createCopilotz({ plugins: [...] }) call.
```

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
