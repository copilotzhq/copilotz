/**
 * `cloud.touch` `{ computer, view? }`: a cloud computer was just used (run
 * as the system; the computers plugin calls it with every piece of work,
 * through the `computerWake` resource), so it stays warm `warmMinutes` more.
 * `view`: a person has it open (its terminal, a preview), which keeps it
 * awake too, up to `viewMinutes` past its last use. Inline and cheap: it
 * writes at most every few seconds, and nothing for a computer that isn't
 * a cloud computer.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { recordsOf } from "../shared/records.ts";
import { after } from "../shared/time.ts";

/** Uses closer together than this are one: the warm window is minutes. */
const GRAIN_MS = 10_000;

export const touchAction = defineAction({
  record: false,
  input: {
    type: "object",
    properties: { computer: { type: "string" }, view: { type: "boolean" } },
    required: ["computer"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const now = new Date().toISOString();
    const field = input.view ? "viewed" : "used";
    await recordsOf(ctx).updateOne(
      {
        _id: input.computer,
        $or: [{ [field]: { $exists: false } }, { [field]: { $lt: after(now, -GRAIN_MS) } }],
      },
      { $set: { [field]: now } },
    );
    return null;
  },
});
