/** `shell.print`: what a command printed, for the screen to print once. */
import { defineAction } from "../../../../runtime/mod.ts";

/** Printed things kept per person: the screen has long printed older ones. */
const KEPT = 50;
let last = 0;
const now = () => new Date(last = Math.max(Date.now(), last + 1)).toISOString();

export const printAction = defineAction({
  description: "Prints text, or an item through its kind's View, on a person's screen",
  input: {
    type: "object",
    properties: {
      person: { type: "string" },
      text: { type: "string" },
      kind: { type: "string" },
      item: {},
      hints: { type: "object" },
    },
    required: ["person"],
    additionalProperties: false,
  },
  record: false,
  allow: (actor, input) => actor.id === input.person,
  run: async (ctx, input) => {
    const output = ctx.db.collection("output");
    await output.insertOne({ ...input, at: now() });
    const old = await output.find({ person: input.person }, { sort: { at: -1 }, skip: KEPT });
    if (old.length) await output.deleteMany({ _id: { $in: old.map((o) => o._id) } });
  },
});
