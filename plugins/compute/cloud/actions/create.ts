/**
 * `cloud.create` `{ size, in?, name? }`: a cloud computer for the person
 * asking, in a space they may work in (their Personal space unless they
 * say), shared into others as any computer is. Who may, and when: see
 * shared/may.ts (`cloud.may` asks it). Its record and secret are made directly (`computer.provision`),
 * its agents asking their person only what the settings' `approve` says
 * (nothing by default: publishing is always asked), then its disk, in the
 * first placement; its first wake formats it. Answers `{ computer }`.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import { hostFor } from "../shared/host.ts";
import { diskOf } from "../shared/names.ts";
import { mayCreate } from "../shared/may.ts";
import { forbidden, invalid } from "../shared/people.ts";
import { recordsOf } from "../shared/records.ts";
import { settingsOf } from "../shared/settings.ts";

export const createAction = defineAction({
  description: "Makes a cloud computer, in a space (your Personal space unless you say)",
  input: {
    type: "object",
    properties: {
      size: { type: "string" },
      in: { type: "string" },
      name: { type: "string", minLength: 1, maxLength: 100 },
    },
    required: ["size"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const set = settingsOf(ctx);
    const size = set.sizes[input.size];
    if (!size) {
      throw invalid(`No size "${input.size}": ${Object.keys(set.sizes).join(", ") || "none"}`);
    }
    const may = await mayCreate(ctx);
    if (may.why === "admins") {
      throw forbidden("Only the org's owners and admins make cloud computers here.");
    }
    if (may.why === "budget") {
      throw Object.assign(
        new Error("This month's budget for cloud computers is spent: no more can be made."),
        { code: "budget" },
      );
    }
    const now = new Date().toISOString();
    const placement = set.placements[0];
    if (!placement) throw invalid("The app has no placement for cloud computers.");
    const host = await hostFor(ctx, placement);
    const owner = ctx.actor!.id;
    const { id } = await ctx.call<{ id: string }>("computer.provision", {
      owner,
      name: input.name ?? `${size.label} cloud computer`,
      ...(input.in ? { in: input.in } : {}),
      approve: set.approve,
    });
    const disk = diskOf(id);
    try {
      await host.createDisk(placement, disk, set.diskGb);
    } catch (error) {
      // No disk, no computer.
      await ctx.as().call("computer.forget", { computer: id });
      throw error;
    }
    await recordsOf(ctx).insertOne({
      _id: id,
      owner,
      size: input.size,
      placement,
      disk,
      diskGb: set.diskGb,
      state: "asleep",
      ready: false,
      stored: now,
      at: now,
    });
    return { computer: id };
  },
});
