/**
 * A computer came: it's online (at every desk it has), told its secret if it
 * hasn't been (and its code is spent), and says what machine it is: named
 * what its person called it, here or on it (`connect --name`), else after
 * the machine.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import { mirror } from "../shared/desks.ts";
import { failed } from "../shared/failed.ts";
import { type Enrolled, type Failed, type Info, WORK } from "../shared/workloads.ts";

export const readyAction = defineAction({
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  run: async (ctx, input) => {
    const computers = ctx.db.collection<Computer>("computer");
    const known = await computers.findOne({ _id: input.id });
    if (!known) return null;
    if (known.pending) {
      const told = await ctx.workers.call<Record<string, unknown> | Failed>(
        "computer",
        input.id,
        WORK.enrolled,
        { id: input.id, secret: known.pending } satisfies Enrolled,
      );
      // Not kept: it's told again when it next comes.
      if (failed(told)) throw failed(told);
      await computers.updateOne({ _id: input.id }, { $unset: { pending: "" } });
      await ctx.db.collection("enrollment").deleteMany({ computer: input.id });
    }
    const info = await ctx.workers.call<Info | Failed>("computer", input.id, WORK.info, {});
    const said = failed(info) ? undefined : info as Info;
    const now = {
      online: true,
      seen: new Date().toISOString(),
      ...(said ? { info: said } : {}),
      ...(known.name || !said ? {} : { name: said.name ?? said.hostname }),
    };
    await computers.updateOne({ _id: input.id }, { $set: now });
    // Every space it's in shows it.
    await mirror(ctx, input.id, now);
    return null;
  },
});
