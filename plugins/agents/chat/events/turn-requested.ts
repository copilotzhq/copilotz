/** `turn.requested`: an agent is to take a turn in a thread, started by a message (its trigger). */
import type { EventDef } from "../../../../runtime/mod.ts";

export const turnRequested: EventDef = {
  description: "An agent is to take a turn in a thread, because of a message",
  schema: {
    type: "object",
    properties: {
      thread: { type: "string" },
      agent: { type: "string" },
      /** The message it answers. */
      trigger: { type: "string" },
      /** Agent messages in a row before the trigger (see the chat resource's maxHops). */
      hops: { type: "integer" },
    },
    required: ["thread", "agent", "trigger", "hops"],
  },
};
