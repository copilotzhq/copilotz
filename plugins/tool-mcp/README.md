# MCP Tools

## What it is

A plugin authoring surface that discovers MCP server Tools and composes them as
native Copilotz Actions and data-only Tool Resources.

## Why it exists

MCP servers describe their capabilities at connection time, so their concrete
Actions and Resources must be generated before application composition.

## How to use it

```ts
import { mcpToolsPlugin } from "@copilotz/copilotz/tools/mcp";
// Include mcpToolsPlugin in the final createCopilotz({ plugins: [...] }) call.
```

Run `await prepareMcpTools({ servers, connect })` before composition and
register the declarations in `resources.tools`. Runtime connectors belong in
`adapters.mcp[serverId]`; execution never performs discovery.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
