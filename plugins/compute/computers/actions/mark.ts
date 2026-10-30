/**
 * `computer.mark` `{ computer, status }`: what the app says of a computer it
 * keeps (a cloud computer: `{ kind: "cloud", state, size }`), kept on it and
 * every desk of it, so a space's members see how it is (asleep, awake…), not
 * only that it's offline. Only the system calls it: the plugin that keeps
 * such computers, as they change.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { mirror } from "../shared/desks.ts";

export const markAction = defineAction({
  input: {
    type: "object",
    properties: {
      computer: { type: "string" },
      status: {
        type: "object",
        properties: {
          kind: { type: "string" },
          state: { type: "string" },
          size: { type: "string" },
        },
        required: ["kind"],
        additionalProperties: false,
      },
    },
    required: ["computer", "status"],
    additionalProperties: false,
  },
  // No `allow`: only the system (another plugin's processor) marks computers.
  run: async (ctx, input) => {
    const { matchedCount } = await ctx.as().db.collection("computer").updateOne(
      { _id: input.computer },
      { $set: { status: input.status } },
    );
    if (matchedCount) await mirror(ctx, input.computer, { status: input.status });
    return { marked: matchedCount > 0 };
  },
});
