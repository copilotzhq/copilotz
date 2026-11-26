/**
 * A device's push subscription: one per browser a person turned
 * notifications on in (`_id`, from its endpoint), whose (`person`), a word
 * for the device (`device`: "iPhone", "Mac"), and when it was saved. The
 * endpoint and the browser's keys are private fields: no actor's read, no
 * View and no event gets them, only this plugin's Actions (whoever holds an
 * endpoint and its keys can send to that device). The query `mine` lists the
 * person's own devices, never their endpoints.
 */
import { defineCollection, type Infer, people, personOf } from "../../../../runtime/mod.ts";

const subscriptionSchema = {
  type: "object",
  properties: {
    person: { type: "string" },
    device: { type: "string" },
    at: { type: "string" },
  },
  required: ["person", "at"],
} as const;

export const pushSubscription = defineCollection({
  schema: subscriptionSchema,
  private: ["endpoint", "keys"],
  queries: {
    /** `mine` `{}`: the person's devices with notifications on: each one's id, word and date. */
    mine: {
      allow: people,
      run: async (subscriptions, _: unknown, ctx) => {
        const person = personOf(ctx.actor);
        if (!person) return [];
        const found = await subscriptions.find({ person }) as SubscriptionDoc[];
        return found.map((s) => ({
          id: s._id,
          ...(s.device ? { device: s.device } : {}),
          at: s.at,
        }));
      },
    },
  },
});

export type SubscriptionDoc = Infer<typeof subscriptionSchema> & {
  _id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
};
