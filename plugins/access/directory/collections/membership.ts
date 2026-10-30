/**
 * Who belongs to which org, for routing: listing someone's orgs and letting
 * them in. Their role is the org's to keep (its `*` memberships), not here.
 * `entered` is when they last went in, so signing in returns them there.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const membershipSchema = {
  type: "object",
  properties: {
    org: { type: "string" },
    person: { type: "string" },
    /** The role they join with, the first time they enter (an invitation's). */
    role: { type: "string" },
    entered: { type: "string" },
    at: { type: "string" },
  },
  required: ["org", "person", "at"],
} as const;

export const membership = defineCollection({
  schema: membershipSchema,
  indexes: [["person"], ["org"]],
});

export type Membership = Infer<typeof membershipSchema> & { _id: string };
