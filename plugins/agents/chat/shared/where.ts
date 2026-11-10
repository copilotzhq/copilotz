/**
 * Where a tool works: the space its call names (`in`, a space's id), when the
 * agent's work reaches it, else where its conversation is. An agent reaches
 * other spaces from its person's Personal space, all they reach; anywhere
 * else, only where it works and what that draws on (design/work.md). The
 * rules hold either way: this only says so in words a model can act on,
 * instead of an empty answer.
 */
import type { Context } from "../../../../runtime/mod.ts";

/** What a tool may do in a space: read it, or write in it (add to it, change what's there). */
export type WorkVerb = "read" | "write";

/**
 * `{ in }`: where the tool works, the space named or its conversation's. A
 * string: why it can't, for the tool to return as it is.
 */
export async function workIn(
  ctx: Context & { in?: string },
  named: unknown,
  verb: WorkVerb = "read",
): Promise<{ in: string } | string> {
  const here = ctx.in;
  if (typeof named !== "string" || !named.trim() || named === here) {
    return here ? { in: here } : "This conversation isn't in a space.";
  }
  const can = await ctx.call<{ can: boolean }>("space.can", { space: named, verb })
    .then((answer) => answer.can, () => false);
  if (can) return { in: named };
  return `You can't ${verb === "read" ? "read" : "change anything in"} the space "${named}" ` +
    "from this conversation. From your person's Personal space you reach every space they " +
    "do; from any other, only that space and what it draws on. To have work done elsewhere, " +
    "send it to whoever answers there (send_message's space or thread).";
}
