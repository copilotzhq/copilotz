/**
 * Where you are, for agents (the chat plugin's `where` context): the space a
 * conversation is in, who its members are, and what it draws on, so an agent
 * knows who will see what it writes there.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Member } from "../collections/member.ts";
import { nameOf, namesIn } from "../shared/names.ts";

type Space = { _id: string; name: string; kind: string; owner?: string };

const who = (key: string) => {
  const [kind, ...rest] = key.split(":");
  return { kind, id: rest.join(":") };
};

/** `a shared space`, `an org space`. */
const kindOf = (kind: string) => `${/^[aeiou]/i.test(kind) ? "an" : "a"} ${kind} space`;

export const whereView = (thread: { in?: string }, ctx: ViewContext<string>) => {
  if (!thread.in) return undefined;
  const space = ctx.db.collection<Space>("space").findOne({ _id: thread.in }).value;
  const members = ctx.db.collection<Member>("member").find({ space: thread.in }).value ?? [];
  const sources =
    ctx.db.collection<Member>("member").find({ member: `space:${thread.in}` }).value ??
      [];
  if (!space) return undefined;
  // People by name.
  const names = namesIn(ctx, [
    ...(space.owner ? [space.owner] : []),
    ...members.filter((m) => m.member.startsWith("person:")).map((m) => m.member),
  ]);
  if (space.kind === "personal") {
    const owner = nameOf(space.owner ?? "", names);
    return `This conversation is in ${owner}'s Personal space: only ${owner} sees what's here.`;
  }
  const people = members.map((m) => ({ ...who(m.member), role: m.role }))
    .filter((m) => m.kind !== "space")
    .map((m) =>
      m.kind === "agent" && m.id === "*"
        ? `every agent (${m.role})`
        : `${m.kind === "person" ? nameOf(m.id, names) : m.id} (${
          m.kind === "person" ? "" : `${m.kind}, `
        }${m.role})`
    );
  return [
    `This conversation is in ${space.name} (${kindOf(space.kind)}). What you write here, its ` +
    `members see.`,
    people.length ? `Its members: ${people.join(", ")}.` : "",
    sources.length
      ? `It draws on: ${sources.map((s) => `${s.space} (${s.role})`).join(", ")}.`
      : "",
  ].filter(Boolean).join("\n");
};
