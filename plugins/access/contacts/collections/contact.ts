/**
 * Contacts: people outside the org who talk to its agents (a WhatsApp
 * customer), one record each, `in` the space of the line they first came
 * by: that space's members read it, as they read the contact's chats there.
 * Its id says nothing about them (`c-…`): it ends up in memberships, in
 * messages' `from`, in events. The contact reads its own record, and so does
 * the agent working for them (it's shared with them on its own, as their
 * chats are), and no one else's.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";
import { namesOf } from "../../spaces/contract.ts";

const contactSchema = {
  type: "object",
  properties: {
    /** The space of the line it first came by. */
    in: { type: "string" },
    /** Where it first came from: `whatsapp`. */
    via: { type: "string" },
    /** What it's called: its WhatsApp profile's name. */
    name: { type: "string" },
    at: { type: "string" },
  },
  required: ["in", "via", "at"],
} as const;

/** How a contact shows as an actor, in a message's `from` and among names. */
export const CONTACT = "contact:";

export const contact = defineCollection({
  schema: contactSchema,
  queries: {
    /**
     * Names by id (`{ ids }`, each `contact:<id>`), as the asker reads them:
     * the spaces' `names` resource asks here for ids that start so.
     */
    names: {
      allow: (actor) => actor.kind === "person" || actor.kind === "agent",
      run: async (contacts, params: { ids?: unknown }) => {
        const given = Array.isArray(params?.ids) ? params.ids : [];
        const ids = [
          ...new Set(
            given.filter((id): id is string => typeof id === "string" && id.startsWith(CONTACT))
              .map((id) => id.slice(CONTACT.length)),
          ),
        ].slice(0, 500);
        if (!ids.length) return {};
        const named = namesOf(await contacts.find({ _id: { $in: ids } }) as Contact[]);
        return Object.fromEntries(
          Object.entries(named).map(([id, name]) => [`${CONTACT}${id}`, name]),
        );
      },
    },
  },
});

export type Contact = Infer<typeof contactSchema> & { _id: string };
