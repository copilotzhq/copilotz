/**
 * Blocking a caller, by those who manage a line's space:
 *
 * - `voice.block`: the caller behind a call's chat (a caller who abuses the
 *   line), for good or for so many `days`. Their calls are rejected as busy,
 *   before they're answered, even once their contact is erased (the block is
 *   kept by the number's hash: collections/blocked.ts). Blocking a caller
 *   whose number was hidden blocks every hidden number on the line. The
 *   number must still be known (a call kept, and not erased); blocking them
 *   again changes the same block. It gives the block's id.
 * - `voice.unblock`: lifts a block, by its id, whatever is left of the call
 *   that made it.
 */
import { type Context, defineAction, failure, inPerson } from "../../../../runtime/mod.ts";
import { must } from "../../../access/spaces/contract.ts";
import type { VoiceBlock } from "../collections/blocked.ts";
import type { VoiceCall } from "../collections/call.ts";
import { blockedKey } from "../shared/caller.ts";

const manage = (ctx: Context, space: string) =>
  must(ctx, "manage", space, "Only those who manage this space block a caller.");

export const blockAction = defineAction({
  description: "Blocks the caller behind a phone call's chat (for so many days, or for good)",
  input: {
    type: "object",
    properties: {
      thread: { type: "string" },
      days: { type: "number", exclusiveMinimum: 0, maximum: 3650 },
    },
    required: ["thread"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const system = ctx.as().db;
    const [call] = await system.collection<VoiceCall>("voice_call")
      .find({ thread: input.thread }, { sort: { at: -1 }, limit: 1 });
    if (!call) throw failure("not_found", "No phone call here.");
    await manage(ctx, call.in);
    if (call.erased) throw failure("not_found", "This caller's number isn't known any more.");
    const key = await blockedKey(call.line, call.from);
    const blocks = system.collection<Omit<VoiceBlock, "_id">>("voice_blocked");
    const found = await blocks.findOne({ key });
    const _id = found?._id ?? `b-${crypto.randomUUID()}`;
    await blocks.replaceOne({ _id }, {
      line: call.line,
      in: call.in,
      thread: input.thread,
      key,
      ...(input.days
        ? { until: new Date(Date.now() + input.days * 86_400_000).toISOString() }
        : {}),
      at: new Date().toISOString(),
    }, { upsert: true });
    return { block: _id };
  },
});

export const unblockAction = defineAction({
  description: "Lifts a block on a caller, by its id",
  input: {
    type: "object",
    properties: { block: { type: "string" } },
    required: ["block"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const blocks = ctx.as().db.collection<VoiceBlock>("voice_blocked");
    const found = await blocks.findOne({ _id: input.block });
    if (!found) throw failure("not_found", "No such block.");
    await manage(ctx, found.in);
    await blocks.deleteOne({ _id: found._id });
    return { lifted: found._id };
  },
});
