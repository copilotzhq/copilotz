/**
 * Memberships: who (a person, an agent, or another space) is a member of a
 * space, with what role. A space that's a member of another draws on it:
 * its members reach the other space too, with the role along that path.
 * They're documents, so every change is an event and reads are cached.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const memberSchema = {
  type: "object",
  properties: {
    /** Who: `person:ana`, `agent:north`, `space:marketing`. */
    member: { type: "string" },
    /** Where: a space's id, or a document's when it's shared on its own (`on` its collection). */
    space: { type: "string" },
    role: { type: "string" },
    on: { type: "string" },
  },
  required: ["member", "space", "role"],
} as const;

export const member = defineCollection({
  schema: memberSchema,
  indexes: [["member"], ["space"]],
});

export type Member = Infer<typeof memberSchema> & { _id: string };
