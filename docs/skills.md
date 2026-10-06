# Skills

Declare a Skill directory once. The same import works in Node, Deno, Bun,
browsers, and Workers; readable locations depend on the host's capabilities.

```ts
import { defineSkill } from "@copilotz/copilotz/skills";
import { createCopilotz } from "@copilotz/copilotz";

const app = await createCopilotz({
  resources: {
    skills: {
      planning: defineSkill({ root: "./skills/planning/" }),
    },
  },
});
```

The resource key must match `name` in SKILL.md front matter. Explicit agent
`capabilities.skills` grants select skills. Declaring a resource installs the
Skills mechanisms automatically; there is no additional feature plugin import.
Front-matter `allowed-tools` describes compatibility and never grants authority.

## Progressive loading

Declarations perform no reads. During ordinary turn preparation, the catalog
loads the front matter of authorized roots. SKILL.md metadata and instructions
are read as one validated snapshot. The prompt contains metadata only; the agent
calls `load_skill` to receive the body, then `read_skill_resource` for
supporting paths referenced by those instructions. Files need no upfront
inventory. `list_skills` uses the same metadata resolver. Scripts remain inert
text.

Missing or invalid manifests, mismatched names, and permission errors surface as
errors. Supporting paths must remain within the root. Filesystem symlinks and
HTTP redirects outside the root are rejected. Reads respect cancellation and a
1,000,000-byte bound; an application may impose a smaller tool text limit with
`resources.skillConfig.default.maximumTextBytes`.

## Roots and runtimes

`root` accepts a string or a URL:

```ts
// Relative filesystem root, pinned on first read per application scope.
defineSkill({ root: "./skills/planning/" });
// Remote root; optionally provide a custom fetch for authenticated reads.
defineSkill({ root: "https://example.com/skills/planning/" });
// Module-relative root in an ESM host with a suitable module URL.
defineSkill({ root: new URL("./skills/planning/", import.meta.url) });
```

Relative filesystem paths use the host working directory. Explicit file URLs and
absolute paths also work where filesystem access is available. The public
entrypoint has no unconditional native imports; it obtains the filesystem
capability when needed. Browsers read HTTP(S) roots subject to CORS and network
permissions. Workers require an allowed I/O context for network reads. For local
Worker bundle files, include the files in the deployment, enable the relevant
Node filesystem compatibility, and use an explicit `/bundle/...` path when
`import.meta.url` is unavailable. An unsupported filesystem read produces a
clear error; a local path is never silently reinterpreted as an HTTP URL.

`import.meta.url` is optional and is unavailable in CommonJS and some Worker
module configurations. Bundling or compiling JavaScript does not automatically
copy skill directories. Include them in a container image, Deno compiled binary,
Worker bundle, or served browser assets as appropriate. For Deno compile, use
`--include` for the skill directory.

## Cache behavior

Completed manifest/body snapshots are scoped to the application's resource
namespace object and source. They stay fresh for five minutes, with at most 64
entries and 4 MiB retained Markdown per scope. Expired entries reload on access;
there is no background polling, SQL catalog, or shared request-bound pending
I/O. Supporting files are read on demand. Unchanged metadata produces stable
catalog text without timestamps. Failed refreshes do not silently serve expired
data.

## Inline and packaged resources

For small embedded definitions, use the same constructor:

```ts
const planning = defineSkill({
  markdown:
    "---\nname: planning\ndescription: Plans work.\n---\nFollow the plan.",
  files: { "references/checklist.md": "Check the acceptance criteria." },
});
```

For frozen portable packages, `buildOpenSkillsPlugin` from
`@copilotz/copilotz/skills/deno` packs validated directories on a Deno build
host. The generated definitions use `defineSkill({manifest, files, read})`, with
lazy file chunks and the consumer's selected framework import. Existing
generated packages must be rebuilt; they must not bundle another copy of
Copilotz.

## Convention loading

A conventional `resources/skills/planning/index.ts` can default-export
`defineSkill({root})`. `copilotz build` imports that declaration and the normal
composition path supplies its dependencies. The build-host loader never needs a
special Skills registration rule. Runtime-loaded directory contents are not
included automatically in the JavaScript output.
