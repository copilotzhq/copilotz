/**
 * `read_skill`, for agents: a skill's instructions, or one of its files, as
 * it needs them. Offered where the agent has a skill (the app's, or one of
 * the conversation's space).
 */
import { type Tool, tool } from "../../chat/contract.ts";
import type { SkillFile } from "../collections/skill-file.ts";
import { SKILL_MD } from "../shared/check.ts";
import { appSkills, skillsFor, skillsShown } from "../shared/skills.ts";

/** "2.1 KB", for a file's length. */
const size = (chars: number) =>
  chars < 1000 ? `${chars} characters` : `${(chars / 1000).toFixed(1)} KB`;

const readSkill = tool({
  offer: (agent, thread, ctx) => !!skillsShown(ctx, agent, thread)?.length,
  description: "Read one of your skills (listed under Skills in your instructions): what to do, " +
    "step by step, for the kind of task it's for. Read it before such a task, then follow it. " +
    "With file, read one of the files it lists (a template, a reference).",
  input: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, description: "The skill's name, as listed." },
      file: { type: "string", description: "One of its files, by the path it lists." },
    },
    required: ["name"],
  },
  run: async ({ name, file }, ctx) => {
    const listed = await skillsFor(ctx, ctx.agent, ctx.thread);
    const found = listed.find((s) => s.name === name.trim());
    if (!found) {
      return `No skill "${name}" here.` +
        (listed.length ? ` Yours: ${listed.map((s) => s.name).join(", ")}.` : "");
    }
    const path = file?.trim() || SKILL_MD;
    const text = found.source === "app"
      ? path === SKILL_MD
        ? appSkills(ctx)[found.name]?.instructions
        : appSkills(ctx)[found.name]?.files?.[path]
      : (await ctx.db.collection<SkillFile>("skillFile").findOne({ _id: `${found._id}:${path}` }))
        ?.text;
    if (text === undefined) {
      return `"${found.name}" has no file "${path}".` +
        (found.files.length
          ? ` Its files: ${found.files.map((f) => f.path).join(", ")}.`
          : " It has no files besides its instructions.");
    }
    if (path !== SKILL_MD) return `${found.name}/${path}:\n\n${text}`;
    return [
      `The ${found.name} skill. Follow it for this task.`,
      text,
      ...(found.files.length
        ? [
          `Its files, to read with read_skill and file when it says to: ${
            found.files.map((f) => `${f.path} (${size(f.size)})`).join(", ")
          }.`,
        ]
        : []),
    ].join("\n\n");
  },
});

export const tools: Record<string, Tool> = { read_skill: readSkill };
