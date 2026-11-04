/**
 * `mcp.prune`: what's past goes: counters whose window is over, and receipts
 * older than a call cut short is run again for (see collections/). The
 * plugin's schedule calls it every ten minutes; nobody outside may.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { RERUN_MS } from "../collections/receipt.ts";

export const pruneAction = defineAction({
  description: "Drops MCP's counters and receipts that are past",
  input: { type: "object", additionalProperties: false },
  record: false,
  run: async (ctx) => {
    const now = Date.now();
    const system = ctx.as().db;
    await system.collection("mcp_rate").deleteMany({ until: { $lte: now } });
    await system.collection("mcp_receipt").deleteMany({ at: { $lt: now - RERUN_MS } });
  },
});
