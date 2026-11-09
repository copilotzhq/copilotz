/**
 * What boards' Actions read first, as whoever calls them: a board, a card,
 * and whether someone is in a space (a card's assignee has to be). What the
 * caller doesn't reach, the rules keep out of sight, so it reads as missing.
 */
import { nameOf, namesFor } from "copilotz/plugins/access/contract";
import type { Board, Card } from "../contract.ts";
import { invalid, notFound } from "./errors.ts";

type Reads = {
  db: {
    collection<T>(name: string): {
      findOne(filter: Record<string, unknown>): Promise<T | null>;
    };
  };
};

export async function boardOf(ctx: Reads, id: string): Promise<Board> {
  const found = await ctx.db.collection<Board>("board").findOne({ _id: id });
  if (!found) {
    throw notFound(
      "No such board here: it may have been deleted, or it's in a space you're not in.",
    );
  }
  return found;
}

export async function cardOf(ctx: Reads, id: string): Promise<Card> {
  const found = await ctx.db.collection<Card>("card").findOne({ _id: id });
  if (!found) throw notFound("No such card here: it may have been deleted or moved away.");
  return found;
}

/**
 * Throws unless `who` (`person:ana`, `agent:north`) is a member of `space`:
 * cards go to those there. Who isn't, it names (a person by their name).
 */
export async function inSpace(
  ctx: Reads & Parameters<typeof namesFor>[0],
  space: string,
  who: string,
): Promise<void> {
  const found = await ctx.db.collection("member").findOne({ space, member: who });
  if (!found) {
    if (who.startsWith("agent:")) throw invalid(`The agent ${nameOf(who)} isn't in this space.`);
    throw invalid(`${nameOf(who, await namesFor(ctx, [who]))} isn't in this space.`);
  }
}
