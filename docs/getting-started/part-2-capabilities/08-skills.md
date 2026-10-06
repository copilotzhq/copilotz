---
title: "Ch 8: Skills"
description: "Give agents task-specific instructions with progressive disclosure and explicit grants."
section: Getting Started
order: 80
status: stable
---

# Chapter 8: Skills

## The pain

Adding every checklist and workflow to the assistant's permanent instructions
makes each turn carry information it may never use. A skill gives a task a short
catalog description and lets the assistant load its instructions when needed.

## The solution

A skill is a directory with a SKILL.md manifest and optional supporting files.
Declare the directory and grant the skill explicitly to an agent.

Create `skills/planning/SKILL.md` in the guide project:

```markdown
---
name: planning
description: Plan a Notes feature with a short acceptance checklist.
---

When planning a Notes feature, read `checklist.md` with `read_skill_resource`.
Use it to write a short plan and acceptance criteria before saving any notes.
```

Create `skills/planning/checklist.md` beside it:

```markdown
- Describe who needs the feature and the result they should get.
- List the smallest useful change and its acceptance criteria.
- Identify any existing notes or application capabilities the plan depends on.
```

Add this import to the existing `assistant.ts`:

```ts
// Use the same public Skills entrypoint on every supported runtime.
import { defineSkill } from "@copilotz/copilotz/skills";
```

Inside the existing `resources` object, add this sibling property:

```ts
// Register the directory under the Skills resource family.
skills: {
  // Match this resource key to the SKILL.md name and the Agent grant.
  planning: defineSkill({
    // Resolve the directory beside assistant.ts instead of from the launch directory.
    root: new URL("./skills/planning/", import.meta.url),
  }),
},
```

Inside `resources.agents.assistant`, extend the existing capability grant. Keep
the Agent's current model connection and any other capabilities:

```ts
// Preserve the Agent's existing capabilities and add this Skill grant.
capabilities: {
  // Keep the Notes Action available; retain any other tools already granted.
  tools: ["saveNote"],
  // Authorize the Skill whose resource key and manifest name are planning.
  skills: ["planning"],
},
```

Replace the `content` of the existing `message()` call, then run `assistant.ts`
with either host configured at the start of the guide:

```ts
// Ask for the task described by the Skill's catalog entry.
content: "Use the planning skill to plan a searchable Notes feature.",
```

Run the existing message and output loop. It uses the same model connection as
the earlier chapters and the two local files you created above:

```sh
# Allow Deno to read the Skill directory and call the configured model.
deno run -A assistant.ts
# Or run the same ESM project with Node 24+.
node assistant.ts
```

The assistant sees the planning description, calls `load_skill` for its
instructions, then reads `checklist.md` on demand. You do not import either
Markdown file into the JavaScript or list supporting files in the declaration.

### Use the filesystem convention loader

For a conventional plugin, place `SKILL.md` and `checklist.md` beside
`resources/skills/planning/index.ts`. That leaf contains:

```ts
// Export the same resource declaration used by direct application composition.
import { defineSkill } from "@copilotz/copilotz/skills";

// Keep the root beside the manifest after deployment.
export default defineSkill({ root: new URL("./", import.meta.url) });
```

The build-host loader includes this declaration in the generated plugin. Keep
the Skill directory and its Markdown files in the deployed artifact; JavaScript
bundling alone does not copy them. See
[Convention-first authoring](../../convention-authoring.md).

## Breaking it down

The skill key must match its SKILL.md front-matter name. No Skills plugin needs
to be imported or registered. Authorized turn preparation loads the front-matter
catalog; `load_skill` returns instructions and `read_skill_resource` retrieves
root-relative supporting paths. The runtime checks the final access policy on
every agent-bound read. The Skill grant supplies `list_skills`, `load_skill`,
and `read_skill_resource` automatically; do not add those reader aliases to
`capabilities.tools`. Front-matter tool hints do not grant permissions.

A root may be a local path, a file URL, or an HTTP(S) URL. The same Skills
import works across runtimes. Local files need a filesystem-capable host and
must be included in deployment. Browser roots must be served over HTTP with
appropriate CORS. `new URL("./skills/planning/", import.meta.url)` is an
optional ESM pattern; use an explicit deployed path or HTTP URL when module URLs
are unsuitable.

Reads are bounded and cancellable. Manifest/body snapshots are cached together
for five minutes on access, scoped to the app and bounded by count and bytes.
Supporting files remain dynamic and need no declared inventory. For inline
Markdown or a frozen portable bundle, see [Skills](../../skills.md).

## What this unlocks

The assistant discovers authorized workflows without carrying every body in its
permanent instructions. Supporting files remain dynamic under the declared root,
and both direct composition and filesystem-generated plugins use the same
resource declaration.

## What's next

Skills add task instructions. In
[Chapter 9: Agent Collaboration](./09-agent-collaboration.md), let the assistant
consult another Agent in the same conversation.
