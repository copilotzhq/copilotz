/**
 * Elsewhere, for agents (the chat plugin's `elsewhere` context, each turn):
 * the other spaces an agent can read for the person it works for, so it
 * knows where to look (a tool given a space, such as `recall` with `in`)
 * when what it needs isn't here, and the spaces it can hand work to, with who
 * answers there. Each turn, not in the system text: a new
 * space or member anywhere never costs a conversation its prompt cache.
 */
import type { Actor, ViewContext } from "../../../../runtime/mod.ts";
import { agentsShown, SEND } from "../../../agents/chat/contract.ts";
import type { Member } from "../collections/member.ts";
import { nameOf, namesIn } from "../shared/names.ts";

type Space = { _id: string; name: string; kind: string; owner?: string; archived?: string };

/** At most this many, the person's own first: the rest are named by count. */
const LISTED = 30;

type Handoff = { _id: string; name: string; kind: string; agents: string[] };

export const elsewhereView = (thread: { in?: string }, ctx: ViewContext<string>) => {
  // Only an agent working for someone: the system reaches everything.
  const person = ctx.actor?.kind === "agent" ? ctx.actor.for as Actor | undefined : undefined;
  if (!person) return undefined;
  const spaces = ctx.db.collection<Space>("space").query<Space[]>("reached", {}).value;
  // What this space draws on, its members see already: reading there marks nothing.
  const drawn = thread.in
    ? ctx.db.collection<Member>("member").find({ member: `space:${thread.in}` }).value
    : [];
  const handoffs = ctx.db.collection("space").query<Handoff[]>("handoffs", {}).value;
  const name = ctx.viewer?.name ?? "";
  const agent = agentsShown(ctx, [name]);
  if (!spaces || !drawn || !handoffs || !agent) return undefined;
  const near = new Set([thread.in, ...drawn.map((m) => m.space)]);
  // Archived spaces are put away: agents aren't told of them.
  const others = spaces.filter((s) => !near.has(s._id) && !s.archived)
    .sort((a, b) => Number(b.kind === "personal") - Number(a.kind === "personal"));
  const hands = (agent[name]?.tools ?? []).includes(SEND)
    ? handoffs.flatMap((s) => {
      const there = s.agents.filter((a) => a !== name);
      return s._id !== thread.in && there.length ? [{ ...s, agents: there }] : [];
    })
    : [];
  if (!others.length && !hands.length) return undefined;
  // People by name.
  const names = namesIn(ctx, [person.id, ...others.flatMap((s) => s.owner ? [s.owner] : [])]);
  const who = nameOf(person.id, names);
  const line = (s: Space) =>
    `- ${s.name}${
      s.kind === "personal" && s.owner ? ` (${nameOf(s.owner, names)}'s own)` : ""
    } [in: ${s._id}]`;
  return [
    ...(others.length
      ? [
        `Other spaces you can read for ${who}, for tools that take a space (\`in\`) when ` +
        `what you need isn't here. What you read in one marks your answer: here, only those who ` +
        `can see that space read it, until ${who} shares it.`,
        ...others.slice(0, LISTED).map(line),
        ...(others.length > LISTED ? [`- and ${others.length - LISTED} more`] : []),
      ]
      : []),
    ...(hands.length
      ? [
        `Spaces you can hand work to for ${who}, with send_message's \`space\`, when it belongs ` +
        `to their team:`,
        ...hands.slice(0, LISTED).map((s) =>
          `- ${s.kind === "personal" ? "Personal" : s.name} [space: ${s._id}]: ${
            s.agents.join(", ")
          }`
        ),
      ]
      : []),
  ].join("\n");
};
