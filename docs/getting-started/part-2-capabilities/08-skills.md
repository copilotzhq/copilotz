---
title: "Ch 8: Skills"
description: "Give agents task-specific instructions with progressive disclosure and explicit grants."
section: Getting Started
order: 80
status: stable
---

# Chapter 8: Skills

A skill is a directory with a SKILL.md manifest and optional supporting files.
Declare the directory and grant the skill explicitly to an agent.

```ts
import { createCopilotz } from "@copilotz/copilotz";
import { defineAgent } from "@copilotz/copilotz/core";
import { defineSkill } from "@copilotz/copilotz/skills";

const app = await createCopilotz({
  resources: {
    skills: { planning: defineSkill({ root: "./skills/planning/" }) },
    agents: {
      planner: defineAgent({
        id: "planner",
        name: "Planner",
        role: "planner",
        models: [{ connection: "default", model: "your-model" }],
        instructions: "Use the planning skill.",
        capabilities: { skills: ["planning"] },
      }),
    },
  },
});
```

The skill key must match its SKILL.md front-matter name. No Skills plugin needs
to be imported or registered. Authorized turn preparation loads the front-matter
catalog; `load_skill` returns instructions and `read_skill_resource` retrieves
root-relative supporting paths. The runtime checks the final access policy on
every agent-bound read. Front-matter tool hints do not grant permissions.

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
