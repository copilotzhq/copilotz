/**
 * `agent.define`: what agents people made are, by name, for chat (its
 * `agentSources` resource): those the asker meets (the rules say: where
 * they belong, or work in a space the asker reaches). Unrecorded, so
 * chat's queries and Views ask it too.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Agent } from "../../chat/contract.ts";
import type { AgentDoc } from "../collections/agent.ts";
import { definitionOf } from "../shared/definition.ts";

export const defineAgentsAction = defineAction({
  description: "What agents people made are, by name: those the asker meets",
  input: {
    type: "object",
    properties: { names: { type: "array", items: { type: "string" } } },
    required: ["names"],
    additionalProperties: false,
  },
  record: false,
  run: async (ctx, input) => {
    const found: Record<string, Agent> = {};
    if (!input.names.length) return found;
    const made = await ctx.db.collection<AgentDoc>("agent").find({ _id: { $in: input.names } });
    for (const doc of made) found[doc._id] = definitionOf(doc);
    return found;
  },
});
