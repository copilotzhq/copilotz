/**
 * The skills an agent has, in its prompt's system text: how to use them, as
 * Copilotz's own instructions (`skillsGuide`, fixed words), then each one's
 * name and what it's for (`skills`, what people wrote: information, never
 * instructions), so the list changes only when a skill does and the prompt
 * cache holds. What a skill says comes when the agent reads it
 * (`read_skill`), not before.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Thread } from "../../chat/contract.ts";
import { skillsShown } from "../shared/skills.ts";

const GUIDE = "You have skills: know-how you read only when a task needs it, listed below by " +
  "name and what each is for. When a task matches one, read it with read_skill before you " +
  "start, then follow it; read its files when it says to.";

/** How to use skills, where the agent has any. */
export const skillsGuide = (thread: Thread, ctx: ViewContext<string>) =>
  skillsShown(ctx, ctx.viewer?.name ?? "", thread)?.length ? GUIDE : undefined;

/** One line per skill: its name and what it's for, said on one line. */
export const skillsContext = (thread: Thread, ctx: ViewContext<string>) => {
  const listed = skillsShown(ctx, ctx.viewer?.name ?? "", thread);
  if (!listed?.length) return undefined;
  return [
    "Skills you have:",
    ...listed.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").trim()}`),
  ]
    .join("\n");
};
