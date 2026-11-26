/**
 * `push.send` `{ person, notice }`: a notification to every device the
 * person turned them on for, each encrypted for that browser and signed with
 * the app's key. A device its push service says is gone (404, 410) is
 * forgotten; one that fails otherwise is kept for the next. Only the app's
 * own code sends (Processors, other Actions): no actor may.
 *
 * Unrecorded: a notice carries what someone wrote.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { SubscriptionDoc } from "../collections/subscription.ts";
import type { PushNotice, PushSettings } from "../contract.ts";
import { settingsOf } from "../shared/settings.ts";
import { encrypt, vapid } from "../shared/webpush.ts";

export type Sent = { sent: number; removed: number; failed: number };

export const sendAction = defineAction({
  description: "Sends a notification to a person's devices",
  record: false,
  input: {
    type: "object",
    properties: {
      person: { type: "string", minLength: 1 },
      notice: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          body: { type: "string", maxLength: 1000 },
          url: { type: "string", maxLength: 1000 },
          tag: { type: "string", maxLength: 200 },
        },
        required: ["title"],
        additionalProperties: false,
      },
      /** Seconds the push service keeps it for a device that's off (a day by default). */
      ttl: { type: "integer", minimum: 0, maximum: 2419200 },
    },
    required: ["person", "notice"],
    additionalProperties: false,
  },
  allow: () => false,
  run: async (ctx, input): Promise<Sent> => {
    const { publicKey, privateKey, contact } = settingsOf(ctx) as PushSettings;
    const done: Sent = { sent: 0, removed: 0, failed: 0 };
    if (!publicKey || !privateKey || !contact) return done;
    const devices = ctx.db.collection<SubscriptionDoc>("pushSubscription");
    const mine = await devices.find({ person: input.person }).toArray();
    const body = new TextEncoder().encode(JSON.stringify(input.notice satisfies PushNotice));
    await Promise.all(mine.map(async (device) => {
      try {
        const answer = await ctx.fetch(device.endpoint, {
          method: "POST",
          headers: {
            authorization: await vapid(device.endpoint, { publicKey, privateKey, contact }),
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: String(input.ttl ?? 86400),
            urgency: "high",
          },
          body: await encrypt(body, device.keys),
        });
        await answer.body?.cancel();
        if (answer.ok) done.sent++;
        else if (answer.status === 404 || answer.status === 410) {
          await devices.deleteOne({ _id: device._id });
          done.removed++;
        } else done.failed++;
      } catch {
        done.failed++;
      }
    }));
    return done;
  },
});
