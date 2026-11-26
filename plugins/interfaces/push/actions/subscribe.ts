/**
 * Turning notifications on and off, in person, for one device at a time:
 *
 * - `push.subscribe` `{ endpoint, keys: { p256dh, auth }, device? }`: the
 *   browser's subscription (`PushSubscription.toJSON()`), made with the
 *   app's public key. The same browser again is the same device, its keys
 *   renewed; a device another person had (a shared computer) becomes this
 *   person's.
 * - `push.unsubscribe` `{ endpoint }` (this browser) or `{ id }` (another of
 *   their devices, from the list): only their own.
 * - `push.key` `{}`: the public key to subscribe with, or `null` when the
 *   app has no key pair (push is off).
 *
 * All unrecorded: an endpoint and its keys are in no event, as input or answer.
 */
import { defineAction, inPerson, invalid, people } from "../../../../runtime/mod.ts";
import type { SubscriptionDoc } from "../collections/subscription.ts";
import { publicKeyOf, subscriptionId } from "../shared/settings.ts";

/** A push service's address: https, as every browser's is. */
const endpointOf = (endpoint: string) => {
  try {
    const url = new URL(endpoint);
    if (url.protocol === "https:") return url.href;
  } catch { /* said below */ }
  throw invalid("That isn't a push subscription's endpoint.");
};

/** A browser's key, base64url: what RFC 8291 encrypts to (a P-256 point) and its secret. */
const B64URL = "^[A-Za-z0-9_-]+={0,2}$";

export const subscribeAction = defineAction({
  description: "Turns notifications on for this device",
  record: false,
  input: {
    type: "object",
    properties: {
      endpoint: { type: "string", minLength: 1, maxLength: 2048 },
      keys: {
        type: "object",
        properties: {
          p256dh: { type: "string", pattern: B64URL, minLength: 80, maxLength: 100 },
          auth: { type: "string", pattern: B64URL, minLength: 16, maxLength: 32 },
        },
        required: ["p256dh", "auth"],
        additionalProperties: false,
      },
      expirationTime: { type: ["number", "null"] },
      device: { type: "string", maxLength: 60 },
    },
    required: ["endpoint", "keys"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    if (!publicKeyOf(ctx)) throw invalid("Notifications aren't set up in this app.");
    const endpoint = endpointOf(input.endpoint);
    const _id = await subscriptionId(endpoint);
    const device = input.device?.replace(/[\s\p{Cc}]+/gu, " ").trim();
    await ctx.as().db.collection<SubscriptionDoc>("pushSubscription").replaceOne(
      { _id },
      {
        _id,
        person: ctx.actor!.id,
        endpoint,
        keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
        ...(device ? { device } : {}),
        at: new Date().toISOString(),
      },
      { upsert: true },
    );
    return { id: _id };
  },
});

export const unsubscribeAction = defineAction({
  description: "Turns notifications off for one of your devices: this one, or one in your list",
  record: false,
  input: {
    type: "object",
    properties: {
      endpoint: { type: "string", maxLength: 2048 },
      id: { type: "string", maxLength: 64 },
    },
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const _id = input.id ?? (input.endpoint ? await subscriptionId(input.endpoint) : undefined);
    if (!_id) throw invalid("Say which device: its endpoint or its id.");
    const { deletedCount } = await ctx.as().db.collection("pushSubscription")
      .deleteOne({ _id, person: ctx.actor!.id });
    return { removed: deletedCount > 0 };
  },
});

export const keyAction = defineAction({
  description: "The app's public key for push notifications, or null when they're off",
  allow: people,
  run: (ctx) => ({ key: publicKeyOf(ctx) ?? null }),
});
