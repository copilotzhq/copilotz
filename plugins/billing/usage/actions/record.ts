/**
 * `usage.record`: an app's own use (an API call, a tool's), rated and
 * appended to the ledger. Run inline, in the caller's job: the record rides
 * its next write and is kept even if the job fails.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { recordUse, type Use } from "../shared/use.ts";

export const recordAction = defineAction({
  description: "Records a use in the ledger, rated",
  record: false,
  input: {
    type: "object",
    properties: {
      meter: { type: "string" },
      subject: { type: "string" },
      catalog: { type: "string" },
      quantities: { type: "object", additionalProperties: { type: "number" } },
      tags: { type: "object", additionalProperties: { type: "string" } },
      at: { type: "string" },
    },
    required: ["meter", "subject", "quantities"],
    additionalProperties: false,
  },
  run: (ctx, input) => recordUse(ctx, input as Use),
});
