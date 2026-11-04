/**
 * Visitors: the browsers that came in by one of the app's web lines, each a
 * contact. One record a visitor, by the hash of the secret their browser
 * keeps (never the secret): the contact it is, the line it came by, until
 * when. Only the system reads or writes them: the web host asks who a
 * secret is (`actor`), and nobody else, a contact included, sees one.
 * Erasing the contact (`contact.forget`) erases its visitors with it.
 */
import { type Actor, defineCollection, type Infer } from "../../../../runtime/mod.ts";
import { hashOf } from "../shared/secret.ts";

const visitorSchema = {
  type: "object",
  properties: {
    /** The contact it is. */
    contact: { type: "string" },
    /** The web line it came by. */
    line: { type: "string" },
    expires: { type: "string" },
    at: { type: "string" },
  },
  required: ["contact", "line", "expires", "at"],
} as const;

export const visitor = defineCollection({
  schema: visitorSchema,
  indexes: [["contact"]],
  queries: {
    /**
     * Who a visitor's secret is: its contact, while it lasts and the contact
     * is still there (erased, it's no one at once). The system's alone: the
     * web host asks, once per connection.
     */
    actor: async (visitors, params: { secret?: unknown }, ctx): Promise<Actor | null> => {
      if (typeof params?.secret !== "string") return null;
      const found = await visitors.findOne({ _id: await hashOf(params.secret) }) as
        | Visitor
        | null;
      if (!found || found.expires < new Date().toISOString()) return null;
      const contact = await ctx.db.collection("contact").findOne({ _id: found.contact });
      return contact ? { kind: "contact", id: found.contact } : null;
    },
  },
});

export type Visitor = Infer<typeof visitorSchema> & { _id: string };
