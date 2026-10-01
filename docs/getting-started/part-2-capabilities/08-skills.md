---
title: "Ch 8: Skills"
description: "Give agents task-specific instructions with progressive disclosure and explicit grants."
section: Getting Started
order: 80
status: stable
---

# Chapter 8: Skills

## The pain

An Agent may have many useful procedures, but putting every procedure in its
role makes each request longer and blurs which instructions apply. Adding
another Tool for every procedure can make tool selection harder too.

## The solution

A Skill packages task instructions and optional supporting text. The Skills
plugin shows an Agent only metadata for explicitly granted Skills; it reads the
full instructions when the Agent chooses to load them. That keeps the agent's
ordinary prompt focused and makes the grant visible in configuration.

### Add one inline Skill

This complete `skills-plugin.ts` file creates a small portable Skill and
registers it in a reusable plugin. Inline Skills need no filesystem discovery or
Deno build step.

```ts
// Import the generic plugin composer from Copilotz's runtime entrypoint.
import { definePlugin } from "@copilotz/copilotz";
// Import Skills authoring and the plugin that owns progressive disclosure.
import { defineInlineSkill, skillsPlugin } from "@copilotz/copilotz/skills";

// Define one small procedure together with a supporting reference file.
const supportTriage = defineInlineSkill({
  // Match the directory name to the required Skill manifest name.
  directoryName: "support-triage",
  // Supply the standard Skill markdown and the procedure loaded on demand.
  markdown: `---
name: support-triage
description: Triage a support request and choose the next safe step.
---
# Support triage

Identify the customer's requested outcome, then check relevant records before
promising a change. Ask a clarifying question when the request is ambiguous.
`,
  // Supporting files stay lazy until a granted Agent requests one.
  files: {
    "references/triage-checklist.md": `# Triage checklist

1. Summarize the customer's goal.
2. Check the current record through an authorized application Tool.
3. Explain the next step without claiming an unverified result.
`,
  },
});

// Package the Skill under the plugin dependency that supplies its reader Tools.
export const supportSkillsPlugin = definePlugin({
  // Keep a stable package-style identity for this reusable plugin.
  id: "@example/support-skills",
  // Version the Skill and supporting text together.
  version: "1.0.0",
  // Skills owns the catalog and the grant-checked read Actions.
  plugins: [skillsPlugin],
  // Register under the same identity the Skill manifest and Agent grant use.
  resources: { skills: { "support-triage": supportTriage } },
});
```

In the project's existing `assistant.ts`, add the plugin to `plugins` and add
`"support-triage"` to the assistant's `capabilities.skills` array. Keep its
existing `capabilities.tools` entries. This is an exact patch to those two
properties; `supportSkillsPlugin` itself does not grant the Skill to an Agent.

The map key and Skill manifest `name` must both be `support-triage`, matching
the Agent grant. The plugin derives `list_skills`, `load_skill`, and, because
this example has a reference file, `read_skill_resource`. You do not need to add
those mechanism Tools to `capabilities.tools`.

### Keep the host boundary explicit

If a Skill is authored as a directory, package it during development with
`buildOpenSkillsPlugin` from `@copilotz/copilotz/skills/deno`, then import the
generated portable plugin at application runtime. Filesystem discovery belongs
to that host build, not to the runtime Agent. A browser or worker consumes the
same generated plugin without gaining filesystem access.

Skill `allowed-tools` metadata describes compatibility; it never grants a
Copilotz Tool. Files under `scripts/` are inert text. Running one still requires
a separately installed and explicitly granted executor.

## What this unlocks

Agents can use the same curated procedure for recurring kinds of work, while
loading supporting details only when needed. The capability remains explicit per
Agent, and adding a Skill plugin does not expand another Agent's grants.

## What's next

Skills guide one Agent through a procedure. Some tasks need a separate
specialist's answer in the conversation.
[Chapter 9: Agent collaboration](09-agent-collaboration.md) shows public
Agent-to-Agent Ask and the participant setup it requires.
