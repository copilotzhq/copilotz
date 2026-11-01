/**
 * A person's phone and a connected number:
 *
 * - `whatsapp.link`: a six-digit code to send the number from WhatsApp,
 *   which links the phone it comes from to them (see processors/receive.ts).
 *   Only someone in the number's space gets one; it works once, for minutes,
 *   and a new one replaces it.
 * - `whatsapp.unlink`: that phone is theirs no more; it's a stranger to the
 *   number again.
 * - `whatsapp.move`: where their messages from there go (a space they may
 *   write in); a new conversation starts there with the next one.
 */
import { defineAction, failure, inPerson } from "../../../../runtime/mod.ts";
import type { WhatsAppNumber } from "../collections/number.ts";
import { settingsOf } from "../shared/settings.ts";
import { may } from "../../../access/spaces/contract.ts";

const which = {
  type: "object",
  properties: { number: { type: "string" } },
  required: ["number"],
  additionalProperties: false,
} as const;

/** Six random digits. */
const digits = () =>
  String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");

export const linkAction = defineAction({
  description: "A code to send a WhatsApp number from your phone, to link it to you",
  input: which,
  // Its answer links a phone to them: kept out of the log.
  record: false,
  allow: inPerson,
  run: async (ctx, input) => {
    // Only someone who reaches its space: read as them, under the rules.
    const number = await ctx.db.collection<WhatsAppNumber>("whatsapp_number")
      .findOne({ _id: input.number });
    if (!number) throw failure("not_found", "No such number here.");
    const person = ctx.actor!.id;
    const codes = ctx.db.collection("whatsapp_code");
    await codes.deleteMany({ number: number._id, person });
    const expires = new Date(Date.now() + settingsOf(ctx).codeMinutes * 60_000).toISOString();
    for (let tries = 0;; tries++) {
      const code = digits();
      try {
        await codes.insertOne({
          _id: `${number._id}:${code}`,
          number: number._id,
          code,
          person,
          expires,
          at: new Date().toISOString(),
        });
        return { code, expires, phone: number.phone };
      } catch (error) {
        // Someone else's code, just now: another.
        if ((error as { code?: string }).code !== "duplicate_key" || tries > 5) throw error;
      }
    }
  },
});

export const unlinkAction = defineAction({
  description: "Unlinks your phone from a WhatsApp number",
  input: which,
  allow: inPerson,
  run: async (ctx, input) => {
    // Their own only: the rules keep a person to their phones.
    const gone = await ctx.db.collection("whatsapp_phone").deleteMany({ number: input.number });
    return { unlinked: gone.acknowledged ? gone.deletedCount : 0 };
  },
});

export const moveAction = defineAction({
  description: "Where your messages from WhatsApp go: a space you may write in",
  input: {
    type: "object",
    properties: { number: { type: "string" }, space: { type: "string" } },
    required: ["number", "space"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    if (!await may(ctx, "write", input.space)) {
      throw failure("forbidden", "You can't write in that space.");
    }
    const moved = await ctx.db.collection("whatsapp_phone").updateMany(
      { number: input.number, person: ctx.actor!.id },
      { $set: { space: input.space }, $unset: { thread: "" } },
    );
    if (!moved.acknowledged || !moved.matchedCount) {
      throw failure("not_found", "Your phone isn't linked to that number.");
    }
    return { space: input.space };
  },
});
