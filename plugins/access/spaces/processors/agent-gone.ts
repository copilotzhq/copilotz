/**
 * An agent people made is removed (`agent.deleted`, with the chat plugin):
 * it leaves every space it worked in, and where it answered new chats,
 * the next agent there does.
 */
import type { ProcessorDef } from "../../../../runtime/mod.ts";
import type { Member } from "../collections/member.ts";
import { unseat } from "../shared/agents.ts";

export const agentGoneProcessor: ProcessorDef = {
  on: "agent.deleted",
  run: async (ctx, event) => {
    const id = String(event.data._id);
    const system = ctx.as();
    const members = system.db.collection<Member>("member");
    const seats = await members.find({ member: `agent:${id}` });
    for (const seat of seats) await members.deleteOne({ _id: seat._id });
    await unseat(system, id, seats.map((m) => m.space));
  },
};
