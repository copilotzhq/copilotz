/** Usage's terminal commands: `/usage` for the open conversation, `/usage all` for everything. */
import { command, type Commands } from "../../../../hosts/terminal/mod.ts";
import type { PriceTotals } from "../shared/totals.ts";

export const commands: Commands = {
  "/usage": command({
    description: "What was used and what it was charged, by model",
    usage: "[all]",
    async run(rest, term) {
      const { open } = await term.state();
      const thread = open?.kind === "thread" ? open.item._id : undefined;
      const all = rest === "all" || !thread;
      const totals = await term.runtime.query<PriceTotals[]>("usage.totals", {
        filter: all ? {} : { "tags.thread": thread },
        by: ["meter", "subject"],
      });
      await term.show("usage.totals", {
        totals,
        scope: all ? "everything" : "this conversation; /usage all for everything",
      });
    },
  }),
};
