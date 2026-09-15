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
`resources.skillConfig.default.maximumTextBytes`. Individual tool declarations
can be selected explicitly.

## How it works

`copilotz.json` declares this root. `plugin.generated.ts` contains its static
composition and `plugin.ts` exposes its public name. Regenerate with
`deno task build:plugins`. Actions and Processors read final context
configuration at invocation; there is no plugin factory or runtime directory
discovery.

See [convention-first authoring](../../docs/convention-authoring.md) for the
shared file structure, compiler, configuration locations, and migration guide.
