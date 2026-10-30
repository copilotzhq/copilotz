/** Work that waits before writing anything: an action, and a processor delivery. */
import { defineAction, definePlugin } from "../../mod.ts";

export default definePlugin({
  name: "slow",
  events: {
    "slow.go": { schema: { type: "object" } },
    "slow.done": { schema: { type: "object" } },
  },
  processors: {
    // Waits, then writes: a delivery in flight with nothing written yet.
    "slow.react": {
      on: "slow.go",
      run: async (ctx, event) => {
        await new Promise((resolve) => setTimeout(resolve, Number(event.data.ms)));
        await ctx.emit("slow.done");
      },
    },
  },
  actions: {
    "slow.start": defineAction({
      input: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
      run: (ctx, input) => ctx.emit("slow.go", { ms: input.ms }),
    }),
    "slow.call": defineAction({
      input: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
      run: (_ctx, input) => new Promise((resolve) => setTimeout(() => resolve("done"), input.ms)),
    }),
  },
});
