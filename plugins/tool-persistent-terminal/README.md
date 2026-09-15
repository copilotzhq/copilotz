# Persistent Terminal Tools

## What it is

A configurable Tool that exposes scoped, stateful terminal sessions.

## Why it exists

Long-running agent work needs shell state that survives individual Tool calls
without making the portable plugin own host processes.

## How to use it

```ts
import { persistentTerminalToolsPlugin } from "@copilotz/copilotz/tools/persistent-terminal";
// Include persistentTerminalToolsPlugin in the final createCopilotz({ plugins: [...] }) call.
```

Supply an application-owned service in `adapters.terminal.default`; application
code retains shutdown ownership.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
