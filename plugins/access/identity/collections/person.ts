/** People: who signs in. Their id is what everything they do records. */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const personSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    email: { type: "string" },
    picture: { type: "string" },
    /** Where each sign-in method knows them: `{ google: "1234" }`. */
    accounts: { type: "object", additionalProperties: { type: "string" } },
    at: { type: "string" },
  },
  required: ["at"],
} as const;

export const person = defineCollection({ schema: personSchema, indexes: [["email"]] });

export type Person = Infer<typeof personSchema> & { _id: string };
