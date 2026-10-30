/**
 * Team: agents people make, beside those the app declares in code. A
 * person makes one (`agent.create`: a name to call it by, what it does,
 * instructions they can have written for them with `agent.draft`, a model,
 * tools, an emoji), changes it (`agent.update`) or removes it
 * (`agent.delete`). Chat meets them through its `agentSources` resource
 * (`agent.define`): they work like any agent, where they work.
 *
 * With the access plugin, an agent belongs to the space it was made in
 * (`in`): only that space's managers change it, and it's read wherever
 * it's a member; adding it to a space is the spaces plugin's (`member.set`,
 * by a manager who has met it). Without it, every agent is everyone's.
 *
 * ```ts
 * plugins: [models, chat, ...access, team, app]
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import {
  createAgentAction,
  deleteAgentAction,
  draftAgentAction,
  updateAgentAction,
} from "./actions/agent.ts";
import { defineAgentsAction } from "./actions/define.ts";
import { agent } from "./collections/agent.ts";

export * from "./contract.ts";

export const team: Plugin = definePlugin({
  name: "team",
  requires: ["chat"],
  collections: { agent },
  actions: {
    "agent.create": createAgentAction,
    "agent.update": updateAgentAction,
    "agent.delete": deleteAgentAction,
    "agent.draft": draftAgentAction,
    "agent.define": defineAgentsAction,
  },
  resources: {
    // Chat asks it what an agent not in the app's code is.
    agentSources: { team: { action: "agent.define" } },
    // With the access plugin: an agent belongs where it was made, its managers change it,
    // and it's read where it works.
    shared: { agent: { member: "agent", write: "manage" } },
  },
});

export default team;
