/**
 * Invitations to orgs, by email: pending until the person with that verified
 * email accepts one (or declines it). Nobody learns whether an email has an
 * account: an invitation waits either way.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const inviteSchema = {
  type: "object",
  properties: {
    org: { type: "string" },
    email: { type: "string" },
    role: { type: "string", enum: ["admin", "member", "guest"] },
    /** Who sent it, and their name, for the invited to see. */
    by: { type: "string" },
    from: { type: "string" },
    at: { type: "string" },
  },
  required: ["org", "email", "role", "by", "at"],
} as const;

export const invite = defineCollection({ schema: inviteSchema, indexes: [["email"], ["org"]] });

export type Invite = Infer<typeof inviteSchema> & { _id: string };
