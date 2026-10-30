/**
 * Skills' web front end, for the browser: a space's Skills tab (spaces'
 * `spaceTabs`: its own skills and the app's, each opening its page; those
 * who manage it write one from a SKILL.md or field by field), a skill's
 * page (`/skill/<id>`: what it says, its files as tabs, changed in place
 * and deleted by its managers), the command palette's (the web shell's
 * `palette`: the tab, a skill to read, a new one, and what to do with the
 * one open), and an agent reading one, in a conversation (chat's
 * `toolViews`). Add it beside the web shell:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, skillsWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { skillsView } from "./views/web/list.tsx";
import { skillView } from "./views/web/page.tsx";
import { newSkillView, skillPaletteView } from "./views/web/palette.tsx";
import { skillStepView } from "./views/web/step.tsx";

export const skillsWeb: Plugin = definePlugin({
  name: "skills-web",
  requires: ["web-shell"],
  views: {
    skills: { web: skillsView },
    skill: { web: skillView },
    "skill.new": { web: newSkillView },
    "skill.palette": { web: skillPaletteView },
    "skill.step": { web: skillStepView },
  },
  resources: {
    spaceTabs: { skills: { title: "Skills", view: "skills", icon: "tool", order: 60 } },
    palette: { skills: { view: "skill.palette", order: 45 } },
    toolViews: { read_skill: "skill.step" },
  },
});
