/**
 * Skills: know-how an agent reads only when it needs it. A skill is what a
 * SKILL.md says: a name, when it's for, then instructions, with files it
 * may read besides (references, templates, scripts).
 *
 * - **From code**, the `skills` resource, plain objects:
 *   `skills: { planning: { description, instructions, files?: { "templates.md": "…" } } }`.
 *   The plugin ships one, opt-in: `planning` (`resources: { skills: { planning } }`).
 * - **Made by people:** a space's skills (`skill`), which its managers make,
 *   change and delete (`skill.create`, `skill.update`, `skill.delete`) and
 *   everyone there, and their agents, use. Without the access plugin, every
 *   skill is everyone's.
 * - **What agents see:** each turn's system text lists the name and purpose
 *   of each skill the agent has in that conversation (the app's and its
 *   space's, by name, so the prompt cache holds until one changes), and
 *   `read_skill { name, file? }` reads one when a task calls for it. An
 *   agent definition may name the skills it gets (`skills: ["planning"]`);
 *   without it, all of them.
 *
 * Built on chat's extension points (a `context` and a tool it offers), so
 * chat pays nothing without it.
 *
 * ```ts
 * plugins: [models, chat, ...access, skills, app]
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { createAction } from "./actions/create.ts";
import { deleteAction } from "./actions/delete.ts";
import { updateAction } from "./actions/update.ts";
import { skill } from "./collections/skill.ts";
import { skillFile } from "./collections/skill-file.ts";
import { tools } from "./resources/tools.ts";
import { problems } from "./shared/check.ts";
import { appSkills } from "./shared/skills.ts";
import { skillsContext } from "./views/context.ts";

export * from "./contract.ts";
export { planning } from "./resources/planning.ts";

export const skills: Plugin = definePlugin({
  name: "skills",
  requires: ["chat"],
  collections: { skill, skillFile },
  actions: {
    "skill.create": createAction,
    "skill.update": updateAction,
    "skill.delete": deleteAction,
  },
  views: { "context:skills": { llm: skillsContext } },
  resources: {
    // In the stable system text: the skills an agent has, by name.
    context: { skills: { place: "system" } },
    tools,
    // With the access plugin: a space's skills are its managers' to change, everyone's there to use.
    shared: { skill: { write: "manage" }, skillFile: { write: "manage" } },
  },
  // The app's skills are what a SKILL.md could say, so a mistake stops the runtime from starting.
  check(merged) {
    for (const [name, declared] of Object.entries(appSkills(merged))) {
      const files = Object.entries(declared.files ?? {}).map(([path, text]) => ({ path, text }));
      const wrong = typeof declared.description !== "string" ||
          typeof declared.instructions !== "string" ||
          files.some((f) => typeof f.text !== "string")
        ? { shape: "it needs a description and instructions, and its files are text" }
        : problems({ name, ...declared, files });
      const [problem] = Object.values(wrong);
      if (problem) throw new Error(`Skill "${name}": ${problem}`);
    }
  },
});

export default skills;
