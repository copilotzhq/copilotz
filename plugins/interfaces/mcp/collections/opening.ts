/**
 * Conversations being opened, by their chat's id: noted with a new
 * conversation's first call, before its contact and chat are made, and gone
 * once the chat is shared with the contact. The two are separate writes
 * (`chat.open`, then `member.set`), so an owner that stops between them (a
 * deploy, a crash) leaves a chat its contact can't reach, which is also what
 * a contact its people took out of its chat looks like. This tells them
 * apart: a chat out of its contact's reach is over, unless its opening is
 * noted here, asked again within 15 minutes (as a call begun and never done
 * is), and the contact is still there (not erased); then the opening goes
 * on, as itself. An opening cut short just after the share is done by the
 * conversation's next call, which finds its chat shared. No events, no
 * personal data (the id is an HMAC); what's older than that goes
 * (`mcp.prune`).
 */
import { defineCollection } from "../../../../runtime/mod.ts";

export const opening = defineCollection({
  schema: {
    type: "object",
    properties: {
      /** When its first call began (ms). */
      at: { type: "integer" },
    },
    required: ["at"],
  },
  events: false,
  indexes: [["at"]],
});
