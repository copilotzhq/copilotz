/**
 * An org's own key for a model provider (`_id`, the provider's id): sealed, in
 * a private field, as an account's tokens are, with its last characters to tell
 * it apart. Nobody reads the collection: `modelKey.list` says what's kept, and
 * `modelKey.open` opens one for a model call.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const modelKeySchema = {
  type: "object",
  properties: {
    hint: { type: "string" },
    by: { type: "string" },
    at: { type: "string" },
  },
  required: ["by", "at"],
} as const;

export const modelKey = defineCollection({ schema: modelKeySchema, private: ["sealed"] });

export type ModelKeyDoc = Infer<typeof modelKeySchema> & { _id: string; sealed: unknown };
