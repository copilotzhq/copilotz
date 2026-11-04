/**
 * A connected number, as Processors use it: its document (a line the app
 * declares, kept as its settings say), the Graph API with its token, and
 * sending from it (text, or any part). What Meta refuses
 * about its token is noted on the number (`problem`), for those who manage
 * it to see, and cleared once it works again.
 */
import type { Actor, Context } from "../../../../runtime/mod.ts";
import type { WhatsAppNumber } from "../collections/number.ts";
import type { WhatsAppSecret } from "../collections/secret.ts";
import { type Graph, sendPart, tokenRefused } from "./graph.ts";
import { sendable } from "./media.ts";
import type { WaPart } from "./parts.ts";
import { linesOf, settingsOf, type WhatsAppLine } from "./settings.ts";

export type Connected = { number: WhatsAppNumber; graph: Graph };

/**
 * A number and its Graph API, read as the system (its token); null once it's
 * disconnected. A line the app declares (its settings' `lines`) is kept as
 * they say first: written when it isn't yet, or changed.
 */
export async function connected(ctx: Context, id: string): Promise<Connected | null> {
  const db = ctx.as().db;
  let [number, own] = await Promise.all([
    db.collection<WhatsAppNumber>("whatsapp_number").findOne({ _id: id }),
    db.collection<WhatsAppSecret>("whatsapp_secret").findOne({ _id: id }),
  ]);
  const line = linesOf(ctx)[id];
  if (line) [number, own] = await kept(ctx, id, line, number, own);
  if (!number || !own) return null;
  return {
    number,
    graph: { base: settingsOf(ctx).graph, phoneId: number.phoneId, token: own.token },
  };
}

/** A declared line's documents, as its settings say: written only when they don't yet. */
async function kept(
  ctx: Context,
  id: string,
  line: WhatsAppLine,
  number: WhatsAppNumber | null,
  own: WhatsAppSecret | null,
): Promise<[WhatsAppNumber, WhatsAppSecret]> {
  const said = {
    in: line.in,
    phoneId: line.phoneId,
    phone: line.phone ?? line.phoneId,
    ...(line.name ? { name: line.name } : {}),
    open: true,
    declared: true,
    ...(line.agent ? { agent: line.agent } : {}),
    ...(line.gap !== undefined ? { gap: line.gap } : {}),
    ...(line.rate !== undefined ? { rate: line.rate } : {}),
    ...(line.quiet !== undefined ? { quiet: line.quiet } : {}),
    ...(line.language ? { language: line.language } : {}),
    by: "app",
  } as const;
  const secret = { token: line.token, secret: line.secret, verify: line.verify };
  // Its space, when the app declares that too (the spaces plugin's `spaces`): made, or kept, first.
  const space = ((ctx.resources.spaces ?? {}) as Record<string, { name?: string } | null>)[line.in];
  if (space) {
    const found = await ctx.as().db.collection<{ name?: string; declared?: boolean }>("space")
      .findOne({ _id: line.in });
    if (!found?.declared || found.name !== space.name) {
      await ctx.as().call("space.keep", { id: line.in });
    }
  }
  const same = (a: Record<string, unknown> | null, b: Record<string, unknown>) =>
    !!a && Object.keys(b).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k])) &&
    ["agent", "gap", "rate", "quiet", "language", "name"].every((k) => (k in b) || !(k in a));
  const system = ctx.as().db;
  if (!same(number, said)) {
    const at = number?.at ?? new Date().toISOString();
    await system.collection("whatsapp_number").replaceOne({ _id: id }, { ...said, at }, {
      upsert: true,
    });
    number = { _id: id, ...said, at } as WhatsAppNumber;
  }
  if (!same(own, secret)) {
    await system.collection("whatsapp_secret").replaceOne({ _id: id }, secret, { upsert: true });
    own = { _id: id, ...secret };
  }
  return [number!, own!];
}

/**
 * Sends text or a part from the number, noting on it when Meta refuses its
 * token; returns WhatsApp's id.
 */
export async function send(
  ctx: Context,
  on: Connected,
  to: string,
  what: string | WaPart,
  /** Who it's for (a person, a contact): what it sends of theirs, they must read. */
  reader?: Actor,
): Promise<string> {
  const numbers = ctx.as().db.collection("whatsapp_number");
  const part: WaPart = typeof what === "string" ? { type: "text", text: what } : what;
  try {
    const id = await sendPart(
      on.graph,
      to,
      part,
      (media, linked) => sendable(ctx, on.graph, media, reader, linked),
    );
    if (on.number.problem) {
      await numbers.updateOne({ _id: on.number._id }, { $unset: { problem: "" } });
      delete on.number.problem;
    }
    return id;
  } catch (error) {
    if (tokenRefused(error)) {
      const problem = "Meta refused its access token: replace it with a new one.";
      if (on.number.problem !== problem) {
        await numbers.updateOne({ _id: on.number._id }, { $set: { problem } });
        on.number.problem = problem;
      }
      // Trying again won't help until someone gives it a new token.
      throw Object.assign(error as Error, { final: true });
    }
    throw error;
  }
}
