/**
 * Each cloud computer's state, as its desks show it: as a record is made, or
 * its state or size changes, the computers plugin is told
 * (`computer.mark`: `{ kind: "cloud", state, size }`), so a space's members
 * see how anyone's cloud computer shared into it is (asleep, waking, awake),
 * as its owner does. In order, per computer.
 */
import type { Event, ProcessorDef } from "../../../../runtime/mod.ts";
import type { CloudComputer } from "../contract.ts";

export const markProcessor: ProcessorDef = {
  on: ["cloudComputer.created", "cloudComputer.updated"],
  // A computer used (each few seconds) or metered changes neither: no job for it.
  where: { $or: [{ changed: { $exists: false } }, { changed: { $in: ["state", "size"] } }] },
  key: (event: Event) => String(event.data._id),
  run: async (ctx, event) => {
    const doc = event.data.doc as CloudComputer;
    await ctx.call("computer.mark", {
      computer: doc._id,
      status: { kind: "cloud", state: doc.state, size: doc.size },
    });
  },
};
