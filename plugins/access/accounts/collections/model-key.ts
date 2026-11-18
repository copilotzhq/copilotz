/**
 * An org's own key for a model provider (`_id`, the provider's id), or a
 * person's own (`person:<id>:<provider>`, with `person` and `provider`):
 * sealed, in a private field, as an account's tokens are, with its last
 * characters to tell it apart. Nobody reads the collection: `modelKey.list`
 * says what the org keeps, the query `mine` what the person asking keeps
 * (never the key), and `modelKey.open` opens one for a model call.
 */
import { defineCollection, type Infer, people, personOf } from "../../../../runtime/mod.ts";

const modelKeySchema = {
  type: "object",
  properties: {
    hint: { type: "string" },
    /** A person's own: whose, and for which provider. */
    person: { type: "string" },
    provider: { type: "string" },
    by: { type: "string" },
    at: { type: "string" },
  },
  required: ["by", "at"],
} as const;

export const modelKey = defineCollection({
  schema: modelKeySchema,
  private: ["sealed"],
  queries: {
    /** `mine` `{}`: the person's own keys: each provider, and its last characters. */
    mine: {
      allow: people,
      run: async (keys, _: unknown, ctx) => {
        const person = personOf(ctx.actor);
        if (!person) return [];
        const found = await keys.find({ person }) as ModelKeyDoc[];
        return found.map((k) => ({
          provider: k.provider ?? k._id,
          ...(k.hint ? { hint: k.hint } : {}),
          at: k.at,
        }));
      },
    },
  },
});

export type ModelKeyDoc = Infer<typeof modelKeySchema> & { _id: string; sealed: unknown };
