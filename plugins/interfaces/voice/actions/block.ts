/**
 * `voice.block`: those who manage a line's space block the caller of one of
 * its calls' chats (a caller who abuses the line), or let them in again.
 * A blocked caller's calls are rejected as busy, before they're answered,
 * even once their contact is erased (the block is kept by the number's hash:
 * collections/blocked.ts). Blocking a caller whose number was hidden blocks
 * every hidden number on the line. The number must still be known: a call
 * kept less than the plugin's `keep` days, and not erased.
 */
import { defineAction, failure, inPerson } from "../../../../runtime/mod.ts";
import { must } from "../../../access/spaces/contract.ts";
import type { VoiceCall } from "../collections/call.ts";
import { blockedKey } from "../shared/caller.ts";

export const blockAction = defineAction({
  description: "Blocks the caller behind a phone call's chat, or lets them in again",
  input: {
    type: "object",
    properties: { thread: { type: "string" }, blocked: { type: "boolean" } },
    required: ["thread", "blocked"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const system = ctx.as().db;
    const [call] = await system.collection<VoiceCall>("voice_call")
      .find({ thread: input.thread }, { sort: { at: -1 }, limit: 1 });
    if (!call) throw failure("not_found", "No phone call here.");
    await must(ctx, "manage", call.in, "Only those who manage this space block a caller.");
    if (call.erased) {
      throw failure("not_found", "This caller's number isn't known any more.");
    }
    const _id = await blockedKey(call.line, call.from);
    const blocks = system.collection("voice_blocked");
    if (input.blocked) {
      await blocks.replaceOne({ _id }, { line: call.line, at: new Date().toISOString() }, {
        upsert: true,
      });
    } else await blocks.deleteOne({ _id });
    return { blocked: input.blocked };
  },
});
