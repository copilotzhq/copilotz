/**
 * Where an agent's work goes: the computer in the conversation's space (its
 * desk there: the space's default, else one online), its folder, and who
 * answers what it asks (the person it works for, unless the computer's owner
 * keeps that to themselves). Agents use a space's computers only in its
 * conversations, and none when it has none.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { Thread } from "../../../agents/chat/contract.ts";
import type { Desk } from "../collections/desk.ts";
import { personOf } from "./person.ts";
import type { Scope } from "./workloads.ts";
import { nameOf, namesFor } from "../../../access/spaces/contract.ts";

export type Where = { desk: Desk; person: string; answerer: string; scope: Scope };

/** The desks a space's agents may use, the one they use first. */
export async function desksIn(ctx: Context, space: string): Promise<Desk[]> {
  const desks = await ctx.as().db.collection<Desk>("desk").find({ in: space }, {
    sort: { seen: -1 },
  });
  return desks.sort((a, b) => Number(!!b.default) - Number(!!a.default));
}

/** Where an agent works in a thread; or why it can't (no person, no computer here, offline). */
export async function whereFor(
  ctx: Context,
  thread: string,
  who: string,
): Promise<Where | { missing: string }> {
  const person = personOf(ctx.actor);
  if (!person) return { missing: "There's no person this work is for, so no computer to use." };
  // Read as the agent (for its person): a conversation they don't reach has no computer for them.
  const found = await ctx.db.collection<Thread>("thread").findOne({ _id: thread });
  if (!found) {
    return { missing: "There's no computer for this conversation: it isn't one of yours." };
  }
  const space = found.in;
  if (!space) {
    return { missing: "This conversation isn't in a space, so there's no computer here." };
  }
  const desks = await desksIn(ctx, space);
  const desk = desks.find((d) => d.online);
  if (!desk) {
    // People by name.
    const names = await namesFor(ctx, [person, ...(desks[0] ? [desks[0].owner] : [])]);
    return {
      missing: desks.length
        ? `This space's computer, ${desks[0].name ?? "theirs"}, is offline: ${
          nameOf(desks[0].owner, names)
        } can start it again (on it: deno task computer).`
        : `There's no computer in this space: ${
          nameOf(person, names)
        } can connect one, or add one of ` +
          "theirs, from the space (in the terminal: /computer connect or /computer share).",
    };
  }
  return {
    desk,
    person,
    answerer: desk.answers === "owner" ? desk.owner : person,
    scope: { space: space, folder: desk.folder, who },
  };
}
