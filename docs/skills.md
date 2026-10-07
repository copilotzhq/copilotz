---
title: "Skills"
description: "Declare reusable agent instructions as a Skill root, grant them by name, and understand lazy loading, caching, limits, containment and host deployment requirements."
section: Agent Harness
order: 40
status: stable
---

# Skills

## The pain

An agent needs a team method, such as a planning procedure with a checklist, but
only on some turns. Pasting it into the agent's `role` sends it on every turn.
Copying it into a second agent duplicates it. Writing your own Actions to read
instruction files means writing path checks, size limits and caching yourself,
and that code can then read any file the process can.

## The problem

Instructions need a contract of their own:

- a name and a description the model can choose from without reading the body;
- a body that is read only when the Skill applies;
- supporting files that are read only on request and never leave their
  directory;
- a location the host chooses (a local directory or an HTTP(S) location) that is
  declared without reading anything;
- an authorization rule, so an agent reads only the Skills it was granted.

## The solution

A **Skill** is a directory whose `SKILL.md` holds front matter and instructions,
next to any supporting files. Declare it with `defineSkill` from
`@copilotz/copilotz/skills`, giving it one `root`, register it under
`resources.skills`, and grant it in an agent's `capabilities.skills`. The same
import is used on every host; which roots can be read depends on the host.

Registering a Skill also installs the Skills plugin. There is no separate plugin
import, marker plugin or compiler step.

### The worked example

This is the example from
[Chapter 11](./getting-started/part-3-add-agent-behavior/11-package-skills.md).
It needs the Chapter 8 `agent.ts` and `assistant.ts`, and permission to read
local files (`deno run -A`, or Node 24+).

Create `skills/planning/SKILL.md` next to `agent.ts`:

```markdown
---
name: planning
description: >-
  Use when someone asks for a plan, a breakdown of work or next steps for a
  task. Produces ordered steps, acceptance checks for each step and a list of
  decisions that are still open.
compatibility: Needs only conversation context; no tools are required.
---

# Planning

Turn the request into a plan that someone else could pick up and carry out.

1. Restate the goal in one sentence. If the goal is unclear, say what you are
   assuming instead of guessing silently.
2. Read `checklist.md` from this Skill and follow it while you write the plan.
3. Break the work into a short, ordered list of steps. Each step should be small
   enough to finish and check on its own.
4. Give every step at least one acceptance check: an observable fact that shows
   the step is done, such as "the note appears in the list after a restart".
5. End with a section called **Open decisions** that lists every choice the plan
   depends on but that nobody has made yet, and who should make it. If there are
   none, say so.

Keep the plan in the conversation. Do not claim that any step has been carried
out, and do not invent tools, files or people that the request did not mention.
```

Create `skills/planning/checklist.md`:

```markdown
# Planning checklist

Before you share a plan, confirm each item:

- [ ] The goal is stated in one sentence, with any assumptions named.
- [ ] Steps are in the order they must happen, and dependencies between them are
      explicit.
- [ ] Every step has at least one acceptance check that someone else could
      verify without asking you.
- [ ] Risks or steps that could fail are called out, with what to do if they do.
- [ ] The plan says what is out of scope.
- [ ] The **Open decisions** section lists every unmade choice and who owns it,
      or says that there are none.
```

In the host module `agent.ts`, **insert** this import below the existing
`corePlugin` import:

```ts
// Declares a Skill from a root directory or URL. Using it also installs the
// Skills plugin, so no separate plugin import is needed.
import { defineSkill } from "@copilotz/copilotz/skills";
```

**Add** the `planning` entry to `agentResources.skills`, creating the map after
the existing `agents` property when absent and preserving every existing agent
and Skill. With no other Skills, the map is:

```ts
// Skills that agents may be granted. The key must equal the `name` in the
// Skill's front matter.
skills: {
  // The root is resolved relative to this module, not to the directory the
  // process was started from. Declaring it reads no files.
  planning: defineSkill({
    root: new URL("./skills/planning/", import.meta.url),
  }),
},
```

In `assistant.ts`, **append** `planning` to `assistant.capabilities.skills`,
keeping existing grants. With no earlier Skill grants:

```ts
skills: ["planning"],
```

The declaration lives in the host module because the host decides where files
live. The grant lives in the pure agent definition because it states what the
agent may use.

## Reference

### Roots

`defineSkill({ root, fetch? })` accepts a string or `URL`:

| Root form                                        | Location read                                       |
| ------------------------------------------------ | --------------------------------------------------- |
| `new URL("./skills/planning/", import.meta.url)` | beside the declaring module (recommended for local) |
| `"./skills/planning/"`                           | relative to the process's current working directory |
| `"/srv/skills/planning/"`                        | that exact absolute path                            |
| `"file:///srv/skills/planning/"`                 | that exact path                                     |
| `"https://skills.example.com/planning/"`         | that HTTP(S) location                               |

- A trailing slash is added to URL roots if it is missing.
- Root URLs may not contain credentials, query strings or fragments, and only
  `file:`, `http:` and `https:` schemes are accepted. For authenticated HTTP
  reads, pass your own `fetch` function in the declaration.
- A relative path root is resolved, and its real path pinned, on the first read
  in each application scope.
- `defineSkill` performs no I/O. An invalid root is rejected when it is
  declared, but a missing directory is reported only when a turn reads it.

### Lazy loading and the reader tools

1. **Catalog.** When a turn is prepared for an agent granted the Skill, the root
   reader loads and parses `SKILL.md`. The prompt catalog shows each Skill's
   name and description, plus a note that it is read with `load_skill` and that
   supporting files named in its instructions can be read with
   `read_skill_resource`. The body is not sent. `list_skills` returns the same
   entries with `compatibility` when present.
2. **Body.** The model calls `load_skill`, which returns the instructions from
   the same parsed snapshot.
3. **Supporting files.** A root is never listed as a directory, so `load_skill`
   returns no file inventory for it. The model learns file paths from the body
   and calls `read_skill_resource` with a path relative to the root.

Granting a root-backed Skill gives the agent all three readers: `list_skills`,
`load_skill` and `read_skill_resource`. Other Skill forms can derive fewer; see
[Agent Capabilities](./agent-capabilities.md) for the exact rules. Do not add
the readers to `capabilities.tools`. They reach only the Skills granted to that
agent, and each settled call appends a durable Event such as
`copilotz.skills.load_skill.completed` or `.failed`.

### Front matter

- `name` must equal the `resources.skills` key. A mismatch is an error when the
  Skill is loaded, so mismatched instructions never reach the model.
- `description` (up to 1,024 characters) should say **when** the Skill applies;
  with the name, it is what the catalog shows before loading.
- `compatibility`, `license` and `metadata` are descriptive; `load_skill`
  returns `compatibility` with the body.
- `allowed-tools` is passed to the model as a description only. It grants
  nothing; tools come only from `capabilities.tools`.

Supporting files are returned as text. A Skill never executes anything,
including files that look like scripts.

### Cache and limits

| Behavior                      | Value                                          |
| ----------------------------- | ---------------------------------------------- |
| `SKILL.md` snapshot freshness | 5 minutes per application scope                |
| Cached snapshots per scope    | at most 64                                     |
| Cached bytes per scope        | at most 4 MiB, counted as described below      |
| Root `SKILL.md` size          | at most 1,000,000 bytes                        |
| Local root file reads         | at most 1,000,000 bytes per file               |
| Reader tool text limit        | 1,000,000 bytes by default, configurable below |

Each cached snapshot counts its raw Markdown, its parsed body and its serialized
manifest toward the 4 MiB budget. When either the entry or byte limit is
exceeded, the least recently used snapshot is evicted; a fresh lookup counts as
a use.

`resources.skillConfig.default.maximumTextBytes` replaces the reader tool limit
and must be a positive safe integer. Lowering it bounds reader tool results;
initial catalog parsing still uses the fixed root manifest limit. Raising it
helps HTTP-root and bundled supporting files, but cannot lift the fixed
1,000,000-byte caps on local root reads or on a root's `SKILL.md`.

The catalog and the body come from one parsed snapshot of `SKILL.md`, reused
until it expires or is evicted. Editing the file does not refresh a cached
snapshot, and nothing polls for changes; there is no guarantee that one turn
keeps the same snapshot throughout. Supporting files are read fresh on every
request. Reads honor cancellation.

### Containment guarantees

- Paths are normalized; paths that escape the root are rejected.
- Local reads reject any symbolic link along the path, check that the real path
  stays inside the root, open the file read-only (asking the host not to follow
  links where it supports that flag) and accept only regular files.
- HTTP path segments are URL-encoded. Redirects are followed manually, at most
  five times, and only while they stay on the root's origin and beneath its
  path. A runtime that cannot inspect redirects (an opaque redirect) fails
  rather than following blindly.
- A failed read is an error; a local path is never retried as an HTTP URL.

### Hosts and deployment

- **Deno, Node and Bun** read local and HTTP(S) roots.
- **Browsers** read HTTP(S) roots only, with CORS headers when the root is on
  another origin.
- **Cloudflare Workers** have no ordinary filesystem, and `import.meta.url` is
  often unusable for files. Use an HTTP(S) root the deployment can reach, or a
  bundled Skill.
- `import.meta.url` is unavailable in CommonJS and in some bundle
  configurations. Check what it resolves to in the built output.

Skill directories are runtime assets. Bundling or compiling JavaScript does not
copy them: include them in the container image, served assets or deployment
yourself (for `deno compile`, use `--include` for the directory). In
filesystem-authored projects, a Skill resource leaf default-exports the same
`defineSkill({ root })` call and is composed by the normal build; see
[Chapter 22](./getting-started/part-6-evolve-and-reuse/22-organize-and-share-plugins.md).

### Embedded and bundled Skills

The same `defineSkill` also accepts a Skill without a root: `markdown` holding
the full `SKILL.md` text, and an optional `files` map from relative paths to
text. Use it for small Skills that ship inside a module; registration rules and
the name match are the same.

When a host cannot read a root, a Deno build host can freeze validated Skill
directories into a generated plugin with `buildOpenSkillsPlugin` from
`@copilotz/copilotz/skills/deno` (options `root`, `output`, `id`, `version`).
The generated module calls the same `defineSkill` in its advanced
`manifest`/`files`/`read` form, with an explicit file list and lazy file chunks,
and imports Copilotz rather than embedding a copy. Rebuild it after editing the
source directories.

## What this unlocks

- Instructions that people edit, review and version as Markdown.
- Small turns: only names and descriptions are sent until a Skill applies.
- One Skill granted to many agents, from a local directory or a host-owned
  HTTP(S) location, with the same declaration.
- A clear authority split: Skills guide the model, while only tool grants let it
  act.

## Next steps

- [Chapter 11: Package Instructions as Skills](./getting-started/part-3-add-agent-behavior/11-package-skills.md)
  walks through the example and how to check it.
- [Agent Capabilities](./agent-capabilities.md) explains grants for tools,
  agents and Skills.
- [Chapter 22: Organize and Share Plugins](./getting-started/part-6-evolve-and-reuse/22-organize-and-share-plugins.md)
  ships Skill assets with a built application.
