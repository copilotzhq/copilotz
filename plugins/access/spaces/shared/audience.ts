/**
 * Who sees what's written somewhere, and whether they all reach what a
 * work may read (its bound, reach.ts). Labels ask it of every write an
 * agent's work makes (a write beyond its bound is a share: `needs_approval`),
 * and so does code handing work's answer somewhere itself (chat, an answer
 * going back where work was handed over from: `beyond`, in the contract).
 *
 * - **Where it shows.** A conversation shared on its own with someone
 *   outside its space (a contact's chat, `thread:<id>`) shows to them;
 *   anything else, to its space.
 * - **Covered.** Everyone there reaches all the work may read: each space
 *   the work reaches is that place, one it draws on, or (its own Personal
 *   space) one its person reaches; a conversation's, one everyone it's shared
 *   with reaches.
 * - **Who'd see it.** A space's people: its members and those of the spaces
 *   drawing on it; a Personal space, its person; a conversation shared with
 *   contacts, its contacts, by name.
 */
import { type Actor, type ReadContext, whereOf } from "../../../../runtime/mod.ts";
import type { Member } from "../collections/member.ts";
import { nameOf, namesFor, namesOf, PROFILE } from "./names.ts";
import { PERSONAL } from "./personal.ts";
import { CHAT, coverOf, docKey, homeOf, narrows, ORG, reachOf, sharedWith } from "./reach.ts";

/** Somewhere a write would show that not everyone reaches all its work may read. */
export type Beyond = {
  /** Where it shows: a space, or a conversation shared on its own (`thread:<id>`). */
  to: string;
  /** As people say it: "Launch", "Bob's Personal space"; a contact's chat, its contacts' names. */
  named: string;
  /** How many would see it: a space's people; a conversation's contacts. */
  people: number;
  /** It goes to contacts: a conversation shared with someone outside the org. */
  contacts?: true;
};

/**
 * Where what's written to `to` (a space, or a conversation: `thread:<id>`)
 * shows: the conversation, when it's shared on its own with someone outside
 * its space; else its space.
 */
export async function shownAt(to: string, ctx: ReadContext): Promise<string> {
  if (!to.startsWith(`${CHAT}:`)) return to;
  if ((await sharedWith(to, ctx)).length) return to;
  return await homeOf(to, ctx) ?? to;
}

/** Whether everyone who reaches `cover` (a place's, `coverOf`) reaches all `actor`'s work may read. */
export async function covers(
  actor: Actor,
  cover: Set<string>,
  ctx: ReadContext,
): Promise<boolean> {
  if (!narrows(actor) || whereOf(actor) === undefined) return true;
  for (const [key, held] of await reachOf(actor, ctx)) {
    if (key === ORG || cover.has(key) || (held.home && cover.has(held.home))) continue;
    return false;
  }
  return true;
}

/** Whether everyone `target` shows to reaches all that `actor`'s work may read. */
export const covered = async (actor: Actor, target: string, ctx: ReadContext) =>
  await covers(actor, await coverOf(target, ctx), ctx);

/** The people who read `space`: its own, and those of the spaces drawing on it, each once. */
async function peopleOf(space: string, ctx: ReadContext): Promise<Set<string>> {
  const members = ctx.db.collection<Member>("member");
  const people = new Set<string>();
  const seen = new Set<string>([space]);
  let frontier = [space];
  for (let depth = 0; frontier.length && depth < 8; depth++) {
    const found = await members.find(
      frontier.length === 1 ? { space: frontier[0] } : { space: { $in: frontier } },
    );
    frontier = [];
    for (const m of found) {
      if (m.member.startsWith("person:")) people.add(m.member);
      else if (m.member.startsWith("space:")) {
        const drawing = m.member.slice("space:".length);
        if (seen.has(drawing)) continue;
        seen.add(drawing);
        frontier.push(drawing);
      }
    }
  }
  return people;
}

/** Names, joined as people say them: "Maria", "Maria and João", "Maria, João and Ana". */
const listed = (names: string[]) =>
  names.length < 2 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** `target` as people say it, and who'd see what's written there. */
export async function audienceOf(target: string, ctx: ReadContext): Promise<Omit<Beyond, "to">> {
  if (target.startsWith(`${CHAT}:`)) {
    const outside = (await sharedWith(target, ctx)).filter((m) => m.startsWith("contact:"));
    if (outside.length) {
      const names = await namesFor(ctx, outside);
      return {
        named: listed(outside.map((id) => names[id] ?? "a contact")),
        people: outside.length,
        contacts: true,
      };
    }
    return { named: "this conversation", people: 0 };
  }
  const space = await ctx.db.collection<{ name: string; kind: string; owner?: string }>("space")
    .findOne({ _id: target });
  if (!space) return { named: "another space", people: 0 };
  if (space.kind === PERSONAL && space.owner) {
    const names = namesOf(
      await ctx.db.collection<{ _id: string; name?: string }>(PROFILE).find({ _id: space.owner }),
    );
    return { named: `${nameOf(space.owner, names)}'s Personal space`, people: 1 };
  }
  return { named: space.name, people: (await peopleOf(target, ctx)).size };
}

/**
 * Whether writing to `to` (a space, or a conversation: `thread:<id>`) as
 * `actor` shows its work to someone who can't see all it may read: where,
 * as people say it, and who'd see it. Undefined when everyone there could,
 * or the work isn't narrowed (a person's own, the system's).
 */
export async function beyond(
  actor: Actor,
  to: string,
  ctx: ReadContext,
): Promise<Beyond | undefined> {
  if (!narrows(actor) || whereOf(actor) === undefined) return undefined;
  const target = await shownAt(to, ctx);
  if (await covered(actor, target, ctx)) return undefined;
  return { to: target, ...await audienceOf(target, ctx) };
}

/** A conversation's key, as `to` takes it: `thread:<id>`. */
export const conversation = (thread: string) => docKey(CHAT, thread);
