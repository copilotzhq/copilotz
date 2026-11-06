/**
 * Visitors who spoke: the web lines' visitors that sent a message, each a
 * contact now. One record each, by its contact: the line it came by, its
 * chat, the tags of the networks it first came from (HMACs: never the
 * address), until when, and whether it's been erased (`ended`: its cookie is
 * no one from then, though it says who it was). Only the system reads or
 * writes them: the web lines' `who` asks who a cookie's secret is
 * (`actor`), and nobody else, a contact included, sees one.
 *
 * A browser that came in and said nothing yet has no record: its secret
 * stands on its own (see shared/secret.ts), and its contact, chat and record
 * are made with its first message (`contact.sending`). Records past their
 * time go (`contact.prune`), and so does a contact made for a first message
 * that never went in (`spoke: false`, still, minutes later).
 */
import { type Actor, defineCollection, type Infer } from "../../../../runtime/mod.ts";
import { contactOf, visitOf } from "../shared/secret.ts";
import { keyringOf, siteOf } from "../shared/lines.ts";

const visitorSchema = {
  type: "object",
  properties: {
    /** The web line it came by. */
    line: { type: "string" },
    /** Its chat. */
    thread: { type: "string" },
    /** The tags of the networks it first came from: what its messages are counted by. */
    tags: { type: "array", items: { type: "string" } },
    /** Whether its first message went in: until then, a contact made for it may go. */
    spoke: { type: "boolean" },
    /** Erased (`contact.forget`): its cookie is no one. */
    ended: { type: "boolean" },
    expires: { type: "string" },
    at: { type: "string" },
  },
  required: ["line", "thread", "tags", "spoke", "expires", "at"],
} as const;

export const visitor = defineCollection({
  schema: visitorSchema,
  indexes: [["expires"], ["spoke"]],
  queries: {
    /**
     * Who a visitor's secret is, while it lasts and its line is still the
     * app's, with its line (`web`) and its networks' tags (`from`), what its
     * messages and connections count by. One that hasn't spoken yet (no
     * record) is who its secret says: nothing is kept for it. Once it's
     * spoken, the contact it is, while that's still there (erased, it's no
     * one at once). The system's alone: the web lines' `who` asks.
     */
    actor: async (visitors, params: { secret?: unknown }, ctx): Promise<Actor | null> => {
      const ring = keyringOf(ctx);
      const visit = ring ? await visitOf(ring, params?.secret) : undefined;
      const line = visit ? siteOf(ctx, visit.line) : undefined;
      if (!visit || !line || visit.issued + line.days * 86_400_000 < Date.now()) return null;
      const contact = await contactOf(ring!, visit);
      const found = await visitors.findOne({ _id: contact }) as Visitor | null;
      if (!found) return { kind: "contact", id: contact, web: line.name, from: visit.tags };
      if (found.ended || found.line !== line.name) return null;
      const there = await ctx.db.collection("contact").findOne({ _id: contact });
      return there ? { kind: "contact", id: contact, web: line.name, from: found.tags } : null;
    },
  },
});

export type Visitor = Infer<typeof visitorSchema> & { _id: string };
