/**
 * Who has been welcomed here (collection `welcome`, its `_id` the person's
 * id): home shows the app's welcome (the `welcome` resource's steps) to each
 * person once, the first time they come to it, and they've seen it once
 * they've gone through it or closed it. Changed only through `chat.welcomed`.
 *
 * Query `seen` `{}`, for front ends: whether the person asking has been
 * welcomed.
 */
import { defineCollection, people, personOf } from "../../../../runtime/mod.ts";

const welcomeSchema = {
  type: "object",
  properties: { at: { type: "string" } },
  required: ["at"],
} as const;

export const welcome = defineCollection({
  schema: welcomeSchema,
  queries: {
    seen: {
      allow: people,
      run: async (welcomed, _: unknown, ctx) => {
        const person = personOf(ctx.actor);
        return { seen: !person || !!await welcomed.findOne({ _id: person }) };
      },
    },
  },
});
