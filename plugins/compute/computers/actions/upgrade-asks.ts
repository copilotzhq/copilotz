/**
 * `computer.upgradeAsks`: what computers asked and what was let there, as
 * they kept it before chat kept every ask, kept as chat keeps it now (see
 * shared/upgrade.ts). It runs by itself once, as the runtime first starts
 * with it (computers' `computer.upgradeAsks` schedule: a deploy), and
 * operators call it (`POST /maintenance/actions/computer.upgradeAsks`), with
 * `dryRun` to see first what it would change. Safe to run again: it logs one
 * line of counts each time it changes something (or, called, always).
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { isMaintenance } from "../../../interfaces/maintenance/contract.ts";
import { upgradeAsks } from "../shared/upgrade.ts";

export const upgradeAsksAction = defineAction({
  description: "Keeps computers' old asks and yeses as chat keeps them",
  input: {
    type: "object",
    properties: {
      /** Only reads, and says what it would change: how many, and which. */
      dryRun: { type: "boolean" },
    },
    additionalProperties: false,
  },
  allow: isMaintenance,
  run: (ctx, input) =>
    upgradeAsks(ctx, {
      dryRun: input.dryRun === true,
      // On its own, on a deploy: it says what it did, and nothing when there was nothing to do.
      quiet: ctx.scheduled !== undefined,
    }),
});
