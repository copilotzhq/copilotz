/**
 * The voice plugin's tool: `end_call` hangs up once the agent's answer is
 * said, so a call that's done costs no more minutes. It's offered to the
 * agent answering a call, while the call goes on (in that call's chat), and
 * to nobody anywhere else: an agent needn't list it.
 */
import { tool } from "../../../agents/chat/contract.ts";
import type { VoiceCall } from "../collections/call.ts";

export const endCall = tool({
  description: "Ends the phone call once the caller has what they need and you've said goodbye. " +
    "What you answer now is said first; then the call ends.",
  input: { type: "object", properties: {}, additionalProperties: false },
  // Where a call is going on, for whoever answers it.
  offer: (_agent, thread, ctx) =>
    !!ctx.db.collection<VoiceCall>("voice_call").findOne({ thread: thread._id, state: "live" })
      .value,
  run: async (_input, ctx) => {
    const calls = ctx.as().db.collection<VoiceCall>("voice_call");
    const [call] = await calls.find({ thread: ctx.thread, state: "live" }, { limit: 1 });
    if (!call) return "There's no call going on in this conversation.";
    await calls.updateOne({ _id: call._id }, {
      $set: { end: { reason: "agent", after: ctx.trigger } },
    });
    return "The call ends once your answer is said.";
  },
});
