/**
 * Invitations: a space's managers invite someone by email, with a role, and
 * they join once they accept, signed in with that email. Sending one says
 * nothing about whether the address has an account here: until they accept,
 * nobody but them knows. One per address and space; inviting again changes
 * it. Its managers see a space's invitations; the person sees those to their
 * email (`mine`). Every one is an event (`invitation.created`), for whatever
 * sends the email.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const invitationSchema = {
  type: "object",
  properties: {
    space: { type: "string" },
    /** The space's name when they were invited: what they see before they're in. */
    name: { type: "string" },
    /** Lowercased. */
    email: { type: "string" },
    role: { type: "string" },
    /** Who invited them: `person:ana`. */
    by: { type: "string" },
    at: { type: "string" },
  },
  required: ["space", "name", "email", "role", "by", "at"],
} as const;

export const invitation = defineCollection({
  schema: invitationSchema,
  indexes: [["space"], ["email"]],
  queries: {
    /** The invitations to the email the person signed in with, newest first. */
    mine: {
      allow: (actor) => actor.kind === "person",
      run: async (invitations, _, ctx) => {
        const { email } = await ctx.call<{ email: string | null }>("person.email", {
          person: ctx.actor!.id,
        });
        return email ? await invitations.find({ email }, { sort: { at: -1 } }) : [];
      },
    },
  },
});

export type Invitation = Infer<typeof invitationSchema> & { _id: string };
