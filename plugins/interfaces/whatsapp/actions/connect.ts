/**
 * Connecting a WhatsApp Business number to a space, by those who manage it,
 * with what Meta's dashboard gives: the number's phone number id, an access
 * token (a system user's, which doesn't expire) and the Meta app's secret.
 * The token is tried first (Meta says what the number is, or why not). The
 * webhook to set up in Meta's dashboard is then the number's own, with a
 * verify token made for it (`whatsapp.webhook` says them again).
 *
 * `whatsapp.credentials` replaces a number's token or secret (a new token,
 * a rotated secret). Neither is recorded: their input is credentials, which
 * go only into `whatsapp_secret`.
 */
import { type Context, defineAction, failure, inPerson } from "../../../../runtime/mod.ts";
import type { WhatsAppNumber } from "../collections/number.ts";
import type { WhatsAppSecret } from "../collections/secret.ts";
import { type Graph, numberInfo } from "../shared/graph.ts";
import { settingsOf } from "../shared/settings.ts";
import { HOOKS } from "./hook.ts";
import { must } from "../../../access/spaces/contract.ts";

/** Throws unless the caller manages `space`. */
export async function mustManage(ctx: Context, space: string, what: string) {
  await must(ctx, "manage", space, `Only those who manage this space ${what}.`);
}

/** What Meta says the number is, with this token: or why it can't. */
async function checked(ctx: Context, phoneId: string, token: string) {
  const graph: Graph = { base: settingsOf(ctx).graph, phoneId, token };
  try {
    return await numberInfo(graph);
  } catch (error) {
    throw failure(
      "invalid",
      `Meta didn't accept that phone number id and token. ${(error as Error).message}`,
    );
  }
}

/** A verify token: random, URL-safe. */
const verifyToken = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export const connectAction = defineAction({
  description: "Connects a WhatsApp Business number to a space you manage",
  input: {
    type: "object",
    properties: {
      in: { type: "string", minLength: 1 },
      phoneId: { type: "string", pattern: "^[0-9]{5,30}$" },
      token: { type: "string", minLength: 20, maxLength: 1000 },
      secret: { type: "string", minLength: 16, maxLength: 200 },
      /** Where the app is: what people open to link their phone. */
      url: { type: "string", maxLength: 300 },
    },
    required: ["in", "phoneId", "token", "secret"],
    additionalProperties: false,
  },
  record: false,
  allow: inPerson,
  run: async (ctx, input) => {
    await mustManage(ctx, input.in, "connect a number to it");
    const numbers = ctx.as().db.collection<WhatsAppNumber>("whatsapp_number");
    if (await numbers.findOne({ phoneId: input.phoneId })) {
      throw failure("invalid", "That number is connected already: disconnect it there first.");
    }
    const info = await checked(ctx, input.phoneId, input.token.trim());
    const id = crypto.randomUUID();
    const verify = verifyToken();
    await ctx.transaction(async (tx) => {
      // As the person: the rules say they manage the space.
      await tx.db.collection("whatsapp_number").insertOne({
        _id: id,
        in: input.in,
        phoneId: input.phoneId,
        phone: info.display_phone_number ?? input.phoneId,
        ...(info.verified_name ? { name: info.verified_name } : {}),
        ...(input.url ? { url: input.url.replace(/\/+$/, "") } : {}),
        by: `person:${ctx.actor!.id}`,
        at: new Date().toISOString(),
      });
      await tx.db.collection("whatsapp_secret").insertOne({
        _id: id,
        token: input.token.trim(),
        secret: input.secret.trim(),
        verify,
      });
    });
    return { number: id, path: `${HOOKS}${id}`, verify };
  },
});

export const credentialsAction = defineAction({
  description: "Replaces a connected WhatsApp number's access token or app secret",
  input: {
    type: "object",
    properties: {
      number: { type: "string" },
      token: { type: "string", minLength: 20, maxLength: 1000 },
      secret: { type: "string", minLength: 16, maxLength: 200 },
    },
    required: ["number"],
    additionalProperties: false,
  },
  record: false,
  allow: inPerson,
  run: async (ctx, input) => {
    const found = await ctx.db.collection<WhatsAppNumber>("whatsapp_number")
      .findOne({ _id: input.number });
    if (!found) throw failure("not_found", "No such number here.");
    await mustManage(ctx, found.in, "change its number");
    const token = input.token?.trim();
    if (token) await checked(ctx, found.phoneId, token);
    const system = ctx.as().db;
    await system.collection<WhatsAppSecret>("whatsapp_secret").updateOne({ _id: found._id }, {
      $set: {
        ...(token ? { token } : {}),
        ...(input.secret ? { secret: input.secret.trim() } : {}),
      },
    });
    if (token && found.problem) {
      await system.collection("whatsapp_number").updateOne({ _id: found._id }, {
        $unset: { problem: "" },
      });
    }
    return { number: found._id };
  },
});
