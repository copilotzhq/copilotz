/**
 * Elsewhere, for agents (the chat plugin's `elsewhere` context, each turn):
 * the other spaces an agent can read for the person it works for, so it
 * knows where to look (a tool given a space, such as `recall` with `in`)
 * when what it needs isn't here. Each turn, not in the system text: a new
 * space or member anywhere never costs a conversation its prompt cache.
 */
import type { Actor, ViewContext } from "../../../../runtime/mod.ts";
import type { Member } from "../collections/member.ts";
import { nameOf, namesIn } from "../shared/names.ts";

type Space = { _id: string; name: string; kind: string; owner?: string; archived?: string };

/** At most this many, the person's own first: the rest are named by count. */
const LISTED = 30;

export const elsewhereView = (thread: { in?: string }, ctx: ViewContext<string>) => {
  // Only an agent working for someone: the system reaches everything.
  const person = ctx.actor?.kind === "agent" ? ctx.actor.for as Actor | undefined : undefined;
  if (!person) return undefined;
  const spaces = ctx.db.collection<Space>("space").query<Space[]>("reached", {}).value;
  // What this space draws on, its members see already: reading there marks nothing.
  const drawn = thread.in
    ? ctx.db.collection<Member>("member").find({ member: `space:${thread.in}` }).value
    : [];
  if (!spaces || !drawn) return undefined;
  const near = new Set([thread.in, ...drawn.map((m) => m.space)]);
  // Archived spaces are put away: agents aren't told of them.
  const others = spaces.filter((s) => !near.has(s._id) && !s.archived)
    .sort((a, b) => Number(b.kind === "personal") - Number(a.kind === "personal"));
  if (!others.length) return undefined;
  // People by name.
  const names = namesIn(ctx, [person.id, ...others.flatMap((s) => s.owner ? [s.owner] : [])]);
  const who = nameOf(person.id, names);
  const line = (s: Space) =>
    `- ${s.name}${
      s.kind === "personal" && s.owner ? ` (${nameOf(s.owner, names)}'s own)` : ""
    } [in: ${s._id}]`;
  return [
    `Other spaces you can read for ${who}, for tools that take a space (\`in\`) when ` +
    `what you need isn't here. What you read in one marks your answer: here, only those who ` +
    `can see that space read it, until ${who} shares it.`,
    ...others.slice(0, LISTED).map(line),
    ...(others.length > LISTED ? [`- and ${others.length - LISTED} more`] : []),
  ].join("\n");
};
