/**
 * `agent.define`: what agents people made are, by name, for chat (its
 * `agentSources` resource): those the asker meets (the rules say: where
 * they belong, or work in a space the asker reaches), and the org's
 * versions of the app's agents (what it changed). Unrecorded, so chat's
 * queries and Views ask it too.
 */
import { defineAction } from "copilotz";
import { type Agent, agentsOf } from "copilotz/plugins/agents/contract";
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
    const declared = agentsOf(ctx);
    const made = await ctx.db.collection<AgentDoc>("agent").find({ _id: { $in: input.names } });
    // One of the app's: the org's version of it, over the app's (chat merges them).
    for (const doc of made) found[doc._id] = definitionOf(doc, declared[doc._id]);
    return found;
  },
});
