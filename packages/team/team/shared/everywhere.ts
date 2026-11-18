/**
 * The org's team works in every space: one joins the org's spaces in use
 * (Personal ones too), as an editor, and leaves every space it works in, through
 * the spaces plugin's Actions (`member.set`, `member.remove`), as the person
 * running the org, who manages them all. Nothing without the spaces plugin.
 */
import type { Context } from "copilotz";

type Seat = { space: string; on?: string };

/** Where the agent works now: the spaces it's a member of. */
async function seatsOf(ctx: Context, agent: string): Promise<string[]> {
  const seats = await ctx.db.collection<Seat>("member").find({ member: `agent:${agent}` });
  return seats.filter((s) => !s.on).map((s) => s.space);
}

/** The agent joins every space in use it isn't in. */
export async function joinEverywhere(ctx: Context, agent: string): Promise<void> {
  if (!ctx.resources.roster) return;
  const seated = new Set(await seatsOf(ctx, agent));
  const spaces = await ctx.db.collection<{ _id: string; archived?: string }>("space").find({});
  for (const space of spaces) {
    if (space.archived || seated.has(space._id)) continue;
    await ctx.call("member.set", {
      space: space._id,
      member: { kind: "agent", id: agent },
      role: "editor",
    });
  }
}

/** The agent leaves every space it works in. */
export async function leaveEverywhere(ctx: Context, agent: string): Promise<void> {
  if (!ctx.resources.roster) return;
  for (const space of await seatsOf(ctx, agent)) {
    await ctx.call("member.remove", { space, member: { kind: "agent", id: agent } });
  }
}
