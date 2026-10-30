/**
 * A connected number, as Processors use it: its document, the Graph API
 * with its token, and sending text from it. What Meta refuses about its
 * token is noted on the number (`problem`), for those who manage it to
 * see, and cleared once it works again.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { WhatsAppNumber } from "../collections/number.ts";
import type { WhatsAppSecret } from "../collections/secret.ts";
import { type Graph, sendText, tokenRefused } from "./graph.ts";
import { settingsOf } from "./settings.ts";

export type Connected = { number: WhatsAppNumber; graph: Graph };

/** A number and its Graph API, read as the system (its token); null once it's disconnected. */
export async function connected(ctx: Context, id: string): Promise<Connected | null> {
  const db = ctx.as().db;
  const [number, own] = await Promise.all([
    db.collection<WhatsAppNumber>("whatsapp_number").findOne({ _id: id }),
    db.collection<WhatsAppSecret>("whatsapp_secret").findOne({ _id: id }),
  ]);
  if (!number || !own) return null;
  return {
    number,
    graph: { base: settingsOf(ctx).graph, phoneId: number.phoneId, token: own.token },
  };
}

/** Sends text from the number, noting on it when Meta refuses its token; returns WhatsApp's id. */
export async function send(ctx: Context, on: Connected, to: string, text: string): Promise<string> {
  const numbers = ctx.as().db.collection("whatsapp_number");
  try {
    const id = await sendText(on.graph, to, text);
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
