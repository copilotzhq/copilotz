/**
 * Sending, as `push.send` and the plugin's Processors do it: whether a person
 * is looking at the app (a tab of theirs showing it, said lately), and a
 * notice to each of their devices, encrypted for it and signed with the
 * app's key; a device its push service says is gone is forgotten.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { LookingDoc } from "../collections/looking.ts";
import { LOOKING_FOR } from "../collections/looking.ts";
import type { SubscriptionDoc } from "../collections/subscription.ts";
import type { PushNotice, PushSettings } from "../contract.ts";
import { settingsOf } from "./settings.ts";
import { encrypt, vapid } from "./webpush.ts";

export type Sent = { sent: number; removed: number; failed: number };

/** A tab of theirs shows the app, and said so in the last minute and a half. */
export async function looking(ctx: Context, person: string, now = Date.now()): Promise<boolean> {
  const since = new Date(now - LOOKING_FOR).toISOString();
  const tabs = await ctx.as().db.collection<LookingDoc>("pushLooking")
    .find({ person, visible: true }).toArray();
  return tabs.some((t) => t.at >= since);
}

export async function deliver(
  ctx: Context,
  person: string,
  notice: PushNotice,
  ttl = 86400,
): Promise<Sent> {
  const { publicKey, privateKey, contact } = settingsOf(ctx) as PushSettings;
  const done: Sent = { sent: 0, removed: 0, failed: 0 };
  if (!publicKey || !privateKey || !contact) return done;
  const devices = ctx.as().db.collection<SubscriptionDoc>("pushSubscription");
  const mine = await devices.find({ person }).toArray();
  if (!mine.length) return done;
  const body = new TextEncoder().encode(JSON.stringify(notice));
  await Promise.all(mine.map(async (device) => {
    try {
      const answer = await ctx.fetch(device.endpoint, {
        method: "POST",
        headers: {
          authorization: await vapid(device.endpoint, { publicKey, privateKey, contact }),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(ttl),
          urgency: "high",
          ...(notice.tag ? { topic: topicOf(notice.tag) } : {}),
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
}

/** A push service's Topic (RFC 8030 §5.4): up to 32 URL-safe characters; a newer one replaces an undelivered older. */
function topicOf(tag: string): string {
  const safe = tag.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe.length <= 32 ? safe : safe.slice(0, 16) + hash(safe);
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0").repeat(2);
};

/** A message's words for a notification: one line, at most a few dozen words. */
export const gist = (text: string | undefined, max = 180) => {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1).trimEnd() + "…" : line;
};

/** Where a chat opens in the app. */
export const chatUrl = (thread: string, space?: string) =>
  `/thread/${encodeURIComponent(thread)}${space ? `?in=${encodeURIComponent(space)}` : ""}`;
