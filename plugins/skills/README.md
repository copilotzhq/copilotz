# Skills

## What it is

A plugin for Open Agent Skill Resources and progressive-disclosure Tools.

## Why it exists

Agents need portable instructions and related files without placing every Skill
body in every model prompt.

## How to use it

```ts
import { skillsPlugin } from "@copilotz/copilotz/skills";
// Include skillsPlugin in the final createCopilotz({ plugins: [...] }) call.
```

Register named skills in `resources.skills`. Set the read bound at
`resources.skillConfig.default.maximumTextBytes`. Explicitly grant individual
skill names in `agent.capabilities.skills`; the plugin then contributes their
metadata to conversation context without reading their bodies and derives its
reader tools. It never adds an implicit filesystem or network grant.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery. The generated plugin owns the catalog contribution and reader-tool
derivation; Core stays generic and respects any final application capability
resource override. Direct host API reads may omit `agentId`; Agent-bound reads
must carry a known Agent ID and remain limited to that Agent's explicit grants.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
