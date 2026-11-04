/**
 * A space's agents (with the chat plugin): `space.agent` says which agent
 * answering there answers its new chats (its managers choose); `space.roster`
 * says who answers there, for chat (its `roster` resource): the agents
 * that are editors there, and that one. As the asker: a space they don't
 * reach has nobody for them, unless they're present there through a document
 * of it (a contact, in its chat): who answers isn't content, and only agents
 * are listed, so it's read for them as the system.
 */
import { type Context, defineAction, people } from "../../../../runtime/mod.ts";
import { rosterIn } from "../shared/agents.ts";
import { must, present } from "../shared/can.ts";

export const agentAction = defineAction({
  description: "Chooses the agent that answers a space's new chats: one working there",
  input: {
    type: "object",
    properties: { space: { type: "string" }, agent: { type: "string" } },
    required: ["space", "agent"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    await must(ctx, "manage", input.space, `You don't manage "${input.space}".`);
    const system = ctx.as();
    if (!(await rosterIn(system, input.space)).includes(input.agent)) {
      throw Object.assign(
        new Error(`"${input.agent}" doesn't answer in this space: add it as an editor first.`),
        { code: "invalid" },
      );
    }
    await system.db.collection("space").updateOne({ _id: input.space }, {
      $set: { agent: input.agent },
    });
    return { agent: input.agent };
  },
});

export const rosterAction = defineAction({
  description: "Who works in a space: its agents, and the one answering its new chats",
  input: {
    type: "object",
    properties: { space: { type: "string" } },
    required: ["space"],
    additionalProperties: false,
  },
  record: false,
  run: async (ctx, input) => {
    let reader: Context = ctx;
    const find = () =>
      reader.db.collection<{ agent?: string }>("space").findOne({ _id: input.space });
    let space = await find();
    if (!space && await present(ctx, input.space)) {
      reader = ctx.as();
      space = await find();
    }
    if (!space) return { agents: [] };
    const agents = await rosterIn(reader, input.space);
    const answers = space.agent && agents.includes(space.agent) ? space.agent : agents[0];
    return { agents, ...(answers ? { default: answers } : {}) };
  },
});
