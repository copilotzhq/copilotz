/**
 * `whatsapp.disconnect`: those who manage its space disconnect a number.
 * Its credentials go, and so do the phones linked to it and their codes;
 * the conversations people had there stay, theirs.
 *
 * `whatsapp.webhook`: the webhook to set up in Meta's dashboard for a
 * number, for those who manage its space: where it is, and its verify token.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { WhatsAppNumber } from "../collections/number.ts";
import type { WhatsAppSecret } from "../collections/secret.ts";
import { mustManage } from "./connect.ts";
import { HOOKS } from "./hook.ts";

const notHere = () => Object.assign(new Error("No such number here."), { code: "not_found" });

const which = {
  type: "object",
  properties: { number: { type: "string" } },
  required: ["number"],
  additionalProperties: false,
} as const;

export const disconnectAction = defineAction({
  description: "Disconnects a WhatsApp number from its space",
  input: which,
  allow: (actor) => actor.kind === "person" && !actor.key,
  run: async (ctx, input) => {
    const found = await ctx.db.collection<WhatsAppNumber>("whatsapp_number")
      .findOne({ _id: input.number });
    if (!found) throw notHere();
    await mustManage(ctx, found.in, "disconnect its number");
    const system = ctx.as();
    await system.transaction(async (tx) => {
      await tx.db.collection("whatsapp_number").deleteOne({ _id: found._id });
      await tx.db.collection("whatsapp_secret").deleteOne({ _id: found._id });
      await tx.db.collection("whatsapp_phone").deleteMany({ number: found._id });
      await tx.db.collection("whatsapp_code").deleteMany({ number: found._id });
    });
    return { disconnected: found._id };
  },
});

export const webhookAction = defineAction({
  description: "Where a WhatsApp number's webhook is, and its verify token, for Meta's dashboard",
  input: which,
  // Its answer is the verify token: kept out of the log.
  record: false,
  allow: (actor) => actor.kind === "person" && !actor.key,
  run: async (ctx, input) => {
    const found = await ctx.db.collection<WhatsAppNumber>("whatsapp_number")
      .findOne({ _id: input.number });
    if (!found) throw notHere();
    await mustManage(ctx, found.in, "see its webhook");
    const own = await ctx.as().db.collection<WhatsAppSecret>("whatsapp_secret")
      .findOne({ _id: found._id });
    return { path: `${HOOKS}${found._id}`, verify: own?.verify ?? "" };
  },
});
