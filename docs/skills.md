# Skills

Copilotz uses the Agent Skills directory format as the canonical authoring
format and a portable plugin as the runtime format. Filesystem discovery is a
build concern, not an application capability.

```text
standard skill directories
          │ validate + pack
          ▼
portable Copilotz plugin
          │ grant-filtered metadata context + lazy skill chunks
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
import { buildOpenSkillsPlugin } from "@copilotz/copilotz/skills/deno";

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

The generated Skill module itself is runtime-neutral and its lazy reads are
covered by the Deno packager test. Core collection declarations use the
declaration-only `@copilotz/copilotz/collections/authoring` entry, so they do
not pull the persistence kernel into browser or workerd bundles. Use the full
`@copilotz/copilotz/collections` entry only for runtime collection operations.

## Inline skills

Small or generated applications can define a portable skill without any host
adapter:

```ts
import { defineInlineSkill, skillsPlugin } from "@copilotz/copilotz/skills";

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

import { definePlugin } from "@copilotz/copilotz/plugins";
export default definePlugin({
  id: "@acme/support-skills",
  version: "0.1.0",
  plugins: [skillsPlugin],
  resources: { skills: { triage } },
});
```

`defineSkill()` is the lower-level contract used by packagers. It exposes eager
manifest metadata, immutable file descriptors, and a lazy `read(path)` closure.
It imports no filesystem, package-loader, or subprocess APIs. Skill factories
live on the explicit `/skills` subpath rather than the root barrel, keeping the
feature out of applications that do not install it.

## Progressive disclosure

A skills plugin contributes logical `skills` resources, a grant-filtered
conversation-context catalog, and its associated tools. Before the first tool
call, an agent sees only the name and description of the skills explicitly
listed in `agent.capabilities.skills`, their declared supporting paths, and the
route used to retrieve them. The contribution contains metadata only: it does
not read `SKILL.md`, references, assets, or scripts.

The plugin's stable use policy is a trusted `promptInstructions` resource. The
catalog remains ordinary dynamic context so skill metadata cannot become
application authority.

- `list_skills` remains an on-demand metadata and file-descriptor API.
- `load_skill` lazily reads and validates `SKILL.md` before returning its body.
- `read_skill_resource` lazily reads one declared supporting text file.

Agents see only skills granted through `agent.capabilities.skills`. A later
plugin resource with the same skill name replaces an earlier one through normal
plugin composition. Generic Copilotz installs no skills and exposes neither a
Skills catalog nor skill tools. Granting a bundled skill automatically derives
`list_skills`, `load_skill`, and—when supporting files exist—
`read_skill_resource`; those mechanism tools do not need to be repeated in
`capabilities.tools`. The Skills plugin owns that derivation; Core only asks the
composed capability resource for the effective tools. An application resource at
the final composition root can still replace the capability policy.

The bundled reader also supports an explicit host API call with no `agentId`;
that call is application-owned and may enumerate the registered Skills. Once
`agentId` is present, it must identify a configured Agent and the reader
intersects the final policy with that Agent's explicit Skill grants; unknown or
malformed metadata fails closed.

### Reading and paths

Use `load_skill` before following a bundled skill. Use `read_skill_resource`
with its skill name and one catalog-declared relative path for a reference,
asset, or script. The plugin checks the current grant on every read, rejects
traversal and undeclared paths, honors cancellation, and applies
`resources.skillConfig.default.maximumTextBytes` to text results.

The plugin reader is deliberately a text reader. Binary files are preserved as
bytes in the generated package but are not converted to text or silently
corrupted for an agent tool call. Scripts are inert text assets: reading one
does not execute it or grant a terminal/tool capability.

### External locations

Some applications make a skill available through an actual `file:` or `http(s):`
location instead of a generated bundle. Its catalog entry must name that
reachable location; the application must separately grant a compatible file or
HTTP tool in the environment where the agent runs. A source-tree path, a Compass
server path, and a bundled module are not automatically reachable from a Sandbox
or browser. Relative references are resolved by that external location's owning
application; bundled references are always slash-separated paths relative to the
skill directory. Skills adds no universal URI scheme, filesystem mount, or
implicit fetch grant.

### Migration

Initial discovery no longer comes from Core's `AVAILABLE SKILLS` prompt branch:
it is a plugin-owned context contribution. Existing `list_skills`, `load_skill`,
and `read_skill_resource` calls continue to work for bundled skills. The reader
tools remain intentionally named and separate because they preserve existing
Action lifecycle history, grant checks, bounded reads, and cancellation behavior
while the catalog moves into context contributions. Remove code that parses a
Core-rendered catalog; depend on the explicit grant and normal context/tool
composition instead.
