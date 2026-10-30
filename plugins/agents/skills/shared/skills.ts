/**
 * Skills as agents and front ends know them: the app's (its `skills`
 * resource) and a space's (the `skill` collection), each said the same way
 * (`Shown`), and which of them an agent has where a conversation is: the
 * app's and its space's, by name, those its definition names (`skills`), or
 * all. The app's win a name both have.
 */
import type { Context, Resources, ViewContext } from "../../../../runtime/mod.ts";
import { agentsOf } from "../../chat/contract.ts";
import type { SkillDoc } from "../collections/skill.ts";

/** A `skills` resource: know-how an agent reads only when it needs it. */
export type Skill = {
  /** When it's for: what agents see beside its name, to decide whether to read it. */
  description: string;
  /** What to do, in Markdown: what reading it gives them. */
  instructions: string;
  /** Files it may read besides, by path: references, templates, scripts. */
  files?: Record<string, string>;
};

/** A skill, the app's or a space's, as agents are told of it and front ends list it. */
export type Shown = {
  /** A space's skill's id; the app's are `app:<name>`. */
  _id: string;
  name: string;
  description: string;
  /** Declared in code (`app`), or made in a space. */
  source: "app" | "space";
  in?: string;
  /** How long its instructions are. */
  size: number;
  /** Its other files: each one's path and length. */
  files: { path: string; size: number }[];
  by?: string;
  at?: string;
  updated?: string;
};

/** The app's skills: its `skills` resource. */
export const appSkills = (ctx: { resources: Resources }): Record<string, Skill> =>
  Object.fromEntries(
    Object.entries((ctx.resources.skills ?? {}) as Record<string, Skill | null>)
      .filter((entry): entry is [string, Skill] => !!entry[1]),
  );

export const shownApp = (name: string, skill: Skill): Shown => ({
  _id: `app:${name}`,
  name,
  description: skill.description,
  source: "app",
  size: skill.instructions.length,
  files: Object.entries(skill.files ?? {}).map(([path, text]) => ({ path, size: text.length }))
    .sort((a, b) => a.path.localeCompare(b.path)),
});

export const shownSpace = (doc: SkillDoc): Shown => ({
  _id: doc._id,
  name: doc.name,
  description: doc.description,
  source: "space",
  ...(doc.in ? { in: doc.in } : {}),
  size: doc.size,
  files: doc.files,
  ...(doc.by ? { by: doc.by } : {}),
  at: doc.at,
  ...(doc.updated ? { updated: doc.updated } : {}),
});

/** The skills `agent` may use: those its definition names (`skills`), or all of them. */
const allowedFor = (ctx: { resources: Resources }, agent: string): string[] | undefined =>
  (agentsOf(ctx)[agent] as { skills?: string[] } | undefined)?.skills;

/** The app's skills and a space's, by name, as `agent` may use them; the app's win a name. */
function merged(
  ctx: { resources: Resources },
  agent: string,
  space: SkillDoc[],
): Shown[] {
  const allowed = allowedFor(ctx, agent);
  const app = Object.entries(appSkills(ctx)).map(([name, s]) => shownApp(name, s));
  const taken = new Set(app.map((s) => s.name));
  return [...app, ...space.filter((doc) => !taken.has(doc.name)).map(shownSpace)]
    .filter((s) => !allowed || allowed.includes(s.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** How a View reads a space's skills: the same read wherever it's made, so a render makes it once. */
const spaceRead = (space: string) => [{ in: space }, { sort: { name: 1 as const } }] as const;

/**
 * The skills `agent` has in `thread`, inside a View (its prompt): undefined
 * while it reads. Without a space, only the app's: it reads nothing.
 */
export function skillsShown(
  ctx: ViewContext,
  agent: string,
  thread: { in?: string },
): Shown[] | undefined {
  if (!thread.in) return merged(ctx, agent, []);
  const read = ctx.db.collection<SkillDoc>("skill").find(...spaceRead(thread.in));
  return read.value ? merged(ctx, agent, read.value) : undefined;
}

/** The skills `agent` has in the thread a tool runs in. */
export async function skillsFor(ctx: Context, agent: string, thread: string): Promise<Shown[]> {
  const found = await ctx.db.collection<{ in?: string }>("thread").findOne({ _id: thread });
  const space = found?.in
    ? await ctx.db.collection<SkillDoc>("skill").find(...spaceRead(found.in))
    : [];
  return merged(ctx, agent, space);
}
