/**
 * The skills an agent has, in its prompt (chat's `skills` context, in the
 * system text): each one's name and what it's for, by name, so the list
 * changes only when a skill does and the prompt cache holds. What a skill
 * says comes when the agent reads it (`read_skill`), not before.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Thread } from "../../chat/contract.ts";
import { skillsShown } from "../shared/skills.ts";

const GUIDE = "Skills you have: know-how you read only when a task needs it. When a task " +
  "matches one, read it with read_skill before you start, then follow it; read its files " +
  "when it says to.";

/** One line per skill: its name and what it's for, said on one line. */
export const skillsContext = (thread: Thread, ctx: ViewContext<string>) => {
  const listed = skillsShown(ctx, ctx.viewer?.name ?? "", thread);
  if (!listed?.length) return undefined;
  return [GUIDE, ...listed.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").trim()}`)]
    .join("\n");
};
