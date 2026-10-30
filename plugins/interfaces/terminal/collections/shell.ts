/**
 * The shell's state: one document per person, where they are. `open` is
 * what the screen shows (a kind and its item: a conversation, a board…);
 * `listed` is what the last numbered list showed, for picking one by number.
 * It's ordinary data: the screen follows it, and on a store that persists,
 * you continue where you left off.
 */
import { defineCollection } from "../../../../runtime/mod.ts";

export const shell = defineCollection({
  schema: {
    type: "object",
    properties: {
      open: {
        type: "object",
        properties: { kind: { type: "string" }, item: { type: "object" } },
        required: ["kind", "item"],
      },
      listed: { type: "array", items: { type: "string" } },
      /** The space you work in: new conversations go there (see the access plugin). */
      space: { type: "string" },
    },
  },
  queries: {
    /** This person's state (empty until they go somewhere). */
    mine: {
      allow: (actor, params: { person: string }) => actor.id === params.person,
      run: async (shells, params: { person: string }) =>
        await shells.findOne({ _id: params.person }) ?? { _id: params.person },
    },
  },
});
