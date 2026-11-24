/**
 * `agent.define`: what agents people made are, by name, for chat (its
 * `agentSources` resource): those the asker meets (the rules say: where
 * they belong, or work in a space the asker reaches), and the org's
 * versions of the app's agents (what it changed), whoever asks: an app's
 * agent is the org's version of it for everyone it talks with, contacts
 * too. Unrecorded, so chat's queries and Views ask it too; there, as a read,
 * it reads only what the asker reads, and a turn gives its prompt the agent
 * it found (chat's turn).
 */
import { defineAction } from "copilotz";
import { type Agent, agentsOf } from "copilotz/plugins/agents/contract";
import { ORG } from "copilotz/plugins/access/contract";
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
    const app = input.names.filter((name) => declared[name]);
    const others = input.names.filter((name) => !declared[name]);
    // One of the app's: the org's version of it, over the app's (chat merges them). It's that
    // agent for everyone it talks with, a contact too, so it's read as the system; who may
    // change it is the rules' (agent.update).
    const versions = app.length
      ? await ctx.as().db.collection<AgentDoc>("agent").find({ _id: { $in: app }, in: ORG })
      : [];
    // One people made: as the asker meets it (the rules).
    const made = others.length
      ? await ctx.db.collection<AgentDoc>("agent").find({ _id: { $in: others } })
      : [];
    for (const doc of [...versions, ...made]) found[doc._id] = definitionOf(doc, declared[doc._id]);
    return found;
  },
});
