---
title: "Chapter 11: Package Instructions as Skills"
description: "Move reusable instructions into a Skill directory that the agent discovers by name and loads, with its supporting files, only when a task needs it."
section: Getting Started
order: 110
status: stable
---

# Chapter 11: Package Instructions as Skills

> Part 3 — Add Agent Behavior · Track: H, optional · Requires: Chapter 8 ·
> Needs: Deno 2.9+ or Node 24+, an `OPENAI_API_KEY` for the live example, and
> permission to read local files

## The pain

The assistant from Chapter 8 plans work differently every time it is asked.
Sometimes it lists acceptance checks, sometimes it forgets them, and it rarely
says which decisions are still open. The team has a planning method that works.
The obvious fix is to paste that method into the agent's `role`.

That does not scale. The role is sent on every turn, including turns that have
nothing to do with planning. A second method, for example for code review, makes
it longer again. A checklist that the team updates has to be edited inside a
TypeScript string, and another agent or application cannot reuse it without
copying the text.

## The problem

Instructions like these are **content with their own lifecycle**. They need:

- a name and a one-line description, so the agent can tell when they apply;
- a full body that is read only when they do apply;
- supporting files, such as a checklist, that are read only when the body points
  to them;
- a home outside the code, so people can edit, review and share them as files.

Putting everything in the prompt costs tokens on every turn. Putting it behind
custom Actions means writing file-reading code, path checks and size limits
yourself, and that code would then be able to read any file the process can.

## The solution

Package the method as a **Skill**: a directory whose `SKILL.md` holds the name,
description and instructions, next to any supporting files. Declare it once with
`defineSkill` from `@copilotz/copilotz/skills`, giving it one **root**, and
grant it to the agent by name.

The Skill is read in three lazy stages, all from that one root:

1. **Catalog.** When a turn is prepared for an agent that is granted the Skill,
   the root reader loads and parses `SKILL.md` and caches the result. Only the
   front matter's name and description are offered to the model; the body is not
   sent.
2. **Body.** When the model decides the Skill applies, it calls the `load_skill`
   tool, which returns the instructions parsed from the same cached `SKILL.md`
   snapshot.
3. **Supporting files.** A root is not listed as a directory, so `load_skill`
   returns no file inventory for it. The model learns about supporting files
   from the instructions, which name them, and calls `read_skill_resource` with
   a path relative to the root. Paths that leave the root are rejected.

Supporting files are read as text. A Skill never executes anything, including
files that look like scripts. It defines no custom executable Actions; it only
installs the standard reader Actions described below.

### Create the Skill directory

Create `skills/planning/` in the project directory, next to `agent.ts`. It holds
two files. They are runtime assets, not TypeScript: the application reads them
while it runs, so they must be present wherever the application runs.

Create `skills/planning/SKILL.md`:

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

The body names `checklist.md` explicitly. That is how the model finds it: a
root-backed Skill has no listed inventory, so a supporting file the instructions
never mention is unlikely to be read. Bundled Skills can carry an explicit file
list; the [Skills reference](../../skills.md) covers them.

The front matter is the part the catalog shows. `name` must equal the Skill's
registration key, and `description` should say **when** to use the Skill, so the
model can choose it without loading the body. `compatibility` is optional and
descriptive. If you add `allowed-tools`, it is also only a description that
`load_skill` passes along to the model: it grants nothing. Tools still come only
from the agent's own `capabilities.tools`.

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

### Declare the Skill in `agent.ts`

`agent.ts` is the host composition module from Chapter 8. It decides where the
Skill's files live on this host, so the declaration belongs here rather than in
the pure `assistant.ts`. Make two insertions and leave everything else in the
file unchanged. If your `agent.ts` already has entries from Chapters 9 or 10,
keep them too.

**Insert** this import below the existing `corePlugin` import:

```ts
// Declares a Skill from a root directory or URL. Using it also installs the
// Skills plugin, so no separate plugin import is needed.
import { defineSkill } from "@copilotz/copilotz/skills";
```

**Add** the `planning` entry to `agentResources.skills`, creating the map after
the existing `agents` property when absent. Preserve every agent in that
property and every other Skill already registered. With no other Skills, the new
map is:

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

`defineSkill` performs no I/O when it is called. Files are read only when an
authorized turn needs them, and only from inside the root.

`new URL("./skills/planning/", import.meta.url)` points at the directory next to
`agent.ts`, wherever the process is started from. A plain string root such as
`root: "./skills/planning/"` is also accepted, but it is resolved against the
process's current working directory, so the same command run from another
directory would look in the wrong place.

The Skill does not have to be local. A host-owned HTTPS location that serves the
same two files works with the same import and the same call:

```ts
// Alternative root: a location your own host serves. The trailing slash marks
// it as a directory; SKILL.md and checklist.md must be served beneath it.
planning: defineSkill({ root: "https://skills.example.com/planning/" }),
```

`skills.example.com` is a placeholder; nothing is published there. Root URLs may
not contain credentials, query strings or fragments.

### Grant the Skill in `assistant.ts`

In `assistant.ts`, **append** `planning` to `assistant.capabilities.skills`,
keeping every existing Skill grant. Leave `tools` and `agents` unchanged. With
no earlier Skill grants, the resulting list is:

```ts
skills: ["planning"],
```

Granting a Skill also gives the agent the reader tools it needs for that Skill:
`list_skills`, `load_skill` and `read_skill_resource`. Do not add them to
`tools` yourself. Those readers can reach only the Skills granted to this agent,
and granting a Skill grants no other tool.

### Show Skill activity in `chat.ts`

To see the readers at work, **insert** this block into the `printReply` function
in `chat.ts`, inside the `if (!isStreamOutput(output))` branch, directly before
its `continue;`:

```ts
// The Skill readers are Actions, and each appends a recorded Event when
// a call settles, such as `copilotz.skills.load_skill.completed`. Only
// the type is printed; the instructions are in the model's context.
if (output.durable && output.type.startsWith("copilotz.skills.")) {
  console.log(`event ${output.type}`);
}
```

### What stays fixed, and where it works

The catalog metadata and the body come from one parsed snapshot of `SKILL.md`,
which the application reuses while it stays in a bounded, time-limited cache.
Editing the file on disk does not refresh a snapshot that is already cached; a
later lookup reads the file again once the entry has expired or been evicted.
Supporting files are separate reads, made each time they are requested. Cache
durations, size limits and other numbers are listed in the
[Skills reference](../../skills.md).

Local roots work on Deno, Node and Bun. Browsers need an HTTP(S) root, served
with CORS headers when it is on another origin. Cloudflare Workers have no
ordinary filesystem and no usable `import.meta.url` for files, so use a bundled
Skill or an HTTP(S) root that the deployment allows, and deploy the assets with
the application. Bundling Skills is a build step on the build host;
[Chapter 22](../part-6-evolve-and-reuse/22-organize-and-share-plugins.md) shows
how to package and ship runtime assets, and you do not need it here.

## Check it works

From the project directory, in the terminal where you exported `OPENAI_API_KEY`,
ask explicitly for the Skill:

```sh
# Deno: -A grants environment, network and file read access.
deno run -A chat.ts "Use the planning skill and its checklist to plan adding tags to our notes."
# Node 24+:
node chat.ts "Use the planning skill and its checklist to plan adding tags to our notes."
```

The output looks something like this. Wording and IDs change on every run:

```text
accepted operation 01K2…
event copilotz.skills.load_skill.completed
event copilotz.skills.read_skill_resource.completed
Goal: let the team tag notes so they can be grouped…
…
Open decisions
- …
settled operation 01K2…: completed
```

Check these facts rather than the exact text:

- The reply is a plan with steps, an acceptance check per step and an **Open
  decisions** section, which is what `SKILL.md` asks for.
- Usually an `event copilotz.skills.load_skill.completed` line appears, and
  often `event copilotz.skills.read_skill_resource.completed` after it. The
  model chooses which readers to call, so neither is guaranteed on every run. A
  line ending in `.failed` means a reader call was rejected, for example because
  the requested file does not exist.
- The last line is `settled operation <same ID>: completed`, and the command
  exits with status 0.

Settlement alone does not prove the Skill was used. The model can receive a
reader's error and still write a reply, so a `.failed` line can appear in an
operation that completes. Read the `event` lines alongside the reply.

Then try an unrelated prompt: `deno run -A chat.ts "Say hello!"`. Normally the
reply is a greeting and no `copilotz.skills.` lines appear, because only the
catalog entry was offered. The grant and the description guide the model; they
do not force or forbid a reader call, so check the event lines rather than
assuming their absence.

If the resource key and the front matter `name` no longer match, loading the
Skill is rejected with an error, before any mismatched instructions reach the
model.

## What this unlocks

The team's planning method now lives in files that the agent finds by name. You
can:

- edit, review and version instructions as Markdown, without touching code;
- keep turns small, because only names and descriptions are sent until a Skill
  applies;
- add supporting files that are read on demand and never leave the root;
- grant the same Skill to other agents, or serve it from a host-owned HTTPS
  location, with the same `defineSkill` call;
- keep tools and Skills separate: a Skill guides the model, while only explicit
  tool grants let it act.

## Next steps

- Optional, with Chapter 8 alone:
  [Chapter 12: Collaborate With Specialists](./12-collaborate-with-specialists.md)
  adds a reviewer agent that the assistant can ask for help.
- Reference: [Skills](../../skills.md) covers root forms, bundled Skills,
  limits, caching and the reader tools.
- Later:
  [Chapter 22: Organize and Share Plugins](../part-6-evolve-and-reuse/22-organize-and-share-plugins.md)
  shows how to deploy Skill assets with a built application.
