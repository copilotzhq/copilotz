# Skills

Copilotz uses the Agent Skills directory format as the canonical authoring
format and a portable plugin as the runtime format. Filesystem discovery is a
build concern, not an application capability.

```text
standard skill directories
          │ validate + pack
          ▼
portable Copilotz plugin
          │ metadata catalog + lazy skill chunks
          ▼
Deno / Node / Bun / browser / Cloudflare runtime
```

## Canonical source

Each immediate child of a plugin's skills directory follows the open Agent
Skills specification:

```text
plugins/support/skills/
└── customer-support/
    ├── SKILL.md
    ├── references/
    ├── scripts/
    └── assets/
```

`SKILL.md` must contain valid YAML frontmatter. Copilotz validates the standard
`name`, `description`, `license`, `compatibility`, `metadata`, and experimental
`allowed-tools` fields. The name must match its directory. Put Copilotz-specific
values under `metadata` instead of adding top-level fields.

The `allowed-tools` value describes skill compatibility. It never grants a tool
or overrides an agent/application tool policy. Packaged scripts are inert files;
execution requires a separately installed, explicitly authorized executor.

## Build a local plugin

Directory enumeration belongs to the build host. The Deno adapter validates and
packs source directories into a catalog module plus one lazy chunk per skill:

```ts
import { buildOpenSkillsPlugin } from "@copilotz/copilotz/adapters/deno";

await buildOpenSkillsPlugin({
  root: "./plugins/support/skills",
  output: "./.copilotz/plugins/support-skills",
  id: "@acme/support-skills",
  version: "0.1.0",
});
```

Treat `.copilotz/` as generated build output. Do not replace `SKILL.md` with
generated data modules or commit a duplicate module beside every source skill.

The application imports the resulting ordinary plugin:

```ts
import supportSkills from "./.copilotz/plugins/support-skills/plugin.ts";
import { createCopilotz } from "@copilotz/copilotz";

const app = await createCopilotz({
  plugins: [supportSkills],
});
```

The application never calls a Deno-specific skill source. Node, Bun, browser,
and Cloudflare builds consume the generated runtime-neutral module. Package
authors can run the same build before publishing and export the portable plugin
as their package's default entrypoint while retaining the standard directories
as canonical source.

## Inline skills

Small or generated applications can define a portable skill without any host
adapter:

```ts
import {
  createSkillsPlugin,
  defineInlineSkill,
} from "@copilotz/copilotz/skills";

const triage = defineInlineSkill({
  directoryName: "support-triage",
  markdown: `---
name: support-triage
description: Triages customer support requests and selects the next action.
---
# Support triage

Classify urgency before choosing a tool.`,
  files: {
    "references/severity.md": "# Severity levels\n...",
  },
});

export default createSkillsPlugin({
  id: "@acme/support-skills",
  version: "0.1.0",
  skills: [triage],
});
```

`defineSkill()` is the lower-level contract used by packagers. It exposes eager
manifest metadata, immutable file descriptors, and a lazy `read(path)` closure.
It imports no filesystem, package-loader, or subprocess APIs. Skill factories
live on the explicit `/skills` subpath rather than the root barrel, keeping the
feature out of applications that do not install it.

## Progressive disclosure

A skills plugin contributes logical `skills` resources and owns its associated
tools:

- `list_skills` returns only discovery metadata and file descriptors.
- `load_skill` lazily reads and validates `SKILL.md` before returning its body.
- `read_skill_resource` is included by default only when a packaged skill has
  files beyond `SKILL.md`.

Agents see only skills granted through `agent.capabilities.skills`. A later
plugin resource with the same skill name replaces an earlier one through normal
plugin composition. Generic Copilotz installs no skills and exposes no skill
tools by default. Granting a skill automatically derives `list_skills`,
`load_skill`, and—when supporting files exist—`read_skill_resource`; those
mechanism tools do not need to be repeated in `capabilities.tools`.
