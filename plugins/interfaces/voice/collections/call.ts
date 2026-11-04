/**
 * Phone calls to the app's lines, by Twilio's id for each (`CA…`): one
 * small record a call, kept as the call goes.
 *
 * - **ringing:** Twilio asked what to do with it, and was told to open its
 *   socket with a one-time ticket (`ticket` is that ticket's hash, gone once
 *   it's used; it lasts until `until`).
 * - **live:** its socket is open: the caller is a contact (`contact`),
 *   talking in a chat (`thread`). It holds its place among the line's calls
 *   at once until `until` (the line's longest call, and a little).
 * - **over:** it ended (`over`), after `seconds`, for `reason`: `hangup`
 *   (the caller, or Twilio), `agent` (it said goodbye), `idle`, `limit`
 *   (the line's longest call), `setup` or `error`; with what Twilio said
 *   about it, when it said something (`twilio`).
 *
 * The caller's number (`from`) and the ticket are private, and nothing
 * outside reads this collection: no rule lets anyone but the plugin's own
 * code. No events, so neither goes into the log; neither does every change
 * of a call.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const callSchema = {
  type: "object",
  properties: {
    /** The line it came by, and that line's space. */
    line: { type: "string" },
    in: { type: "string" },
    /** The caller's number, as Twilio gives it (`+5511…`), and the line's. */
    from: { type: "string" },
    to: { type: "string" },
    state: { type: "string", enum: ["ringing", "live", "over"] },
    ticket: { type: "string" },
    /** Its place among the calls at once is kept until then. */
    until: { type: "string" },
    /** Twilio's id for its socket's session (`VX…`). */
    session: { type: "string" },
    contact: { type: "string" },
    thread: { type: "string" },
    /** What the caller last cut short (a message), and what they heard of it. */
    cut: {
      type: "object",
      properties: { message: { type: "string" }, heard: { type: "string" } },
      required: ["message", "heard"],
    },
    /** The agent ended it (`end_call`): it ends once its answer to `after` is said. */
    end: {
      type: "object",
      properties: { reason: { type: "string" }, after: { type: "string" } },
      required: ["reason"],
    },
    reason: { type: "string" },
    seconds: { type: "number" },
    /** What Twilio said when its relay ended: its status, and its error's code. */
    twilio: {
      type: "object",
      properties: { status: { type: "string" }, error: { type: "string" } },
    },
    /** When Twilio first asked, when its socket opened, and when it ended. */
    at: { type: "string" },
    started: { type: "string" },
    over: { type: "string" },
  },
  required: ["line", "in", "to", "state", "until", "at"],
} as const;

export const call = defineCollection({
  schema: callSchema,
  events: false,
  private: ["from", "ticket"],
  indexes: [["line", "at"], ["thread"], ["contact"]],
});

export type VoiceCall = Infer<typeof callSchema> & { _id: string };
