/**
 * Callers a line's people blocked (`voice.block`), each block by an id of
 * its own (`b-…`): the line, its space, the chat it was made from, until
 * when (none: until lifted, `voice.unblock`), and the caller's key (`key`: a
 * hash of their number, with the line; see shared/caller.ts), which is how
 * their calls are found and rejected as busy, before they're answered. Kept
 * apart from the calls, so erasing a contact (`contact.forget`), or a call's
 * record going, doesn't let them in again, nor keeps a block from being
 * lifted. Blocking a caller whose number was hidden blocks every hidden
 * number on the line.
 *
 * The space's members read its blocks (the spaces plugin's `shared`), never
 * their key (private): a hash anyone could match to a number by trying them
 * all. Only its managers change them. No events.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const blockSchema = {
  type: "object",
  properties: {
    line: { type: "string" },
    in: { type: "string" },
    thread: { type: "string" },
    key: { type: "string" },
    until: { type: "string" },
    at: { type: "string" },
  },
  required: ["line", "in", "key", "at"],
} as const;

export const blocked = defineCollection({
  schema: blockSchema,
  events: false,
  private: ["key"],
  indexes: [["key"]],
});

export type VoiceBlock = Infer<typeof blockSchema> & { _id: string };
