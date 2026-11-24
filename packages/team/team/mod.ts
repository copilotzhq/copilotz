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
 * The org's team (with the access plugin): the app's default agents, then
 * those the org made for itself (`in: "*"`), which work in every space. Its
 * owners and admins change the app's ones (the org's version of each), take
 * them off the team (`agent.delete`) and back (`agent.restore`), or back to
 * the app's (`agent.reset`). An agent proposes one (`propose_agent`, the
 * tool an app gives agents it lets): its person sees it and says yes or no.
 *
 * ```ts
 * plugins: [models, chat, ...access, team, app]
 * ```
 */
import { definePlugin, failure, type Plugin } from "copilotz";
import {
  createAgentAction,
  deleteAgentAction,
  draftAgentAction,
  resetAgentAction,
  restoreAgentAction,
  sketchAgentAction,
  updateAgentAction,
} from "./actions/agent.ts";
import { defineAgentsAction } from "./actions/define.ts";
import { agent } from "./collections/agent.ts";
import { proposeAgent } from "./resources/propose.ts";

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
    "agent.sketch": sketchAgentAction,
    "agent.restore": restoreAgentAction,
    "agent.reset": resetAgentAction,
    "agent.define": defineAgentsAction,
  },
  resources: {
    // Its settings: how long an agent's instructions may be (shared/limits.ts).
    team: {},
    // Agents propose agents, for their person to approve (an app gives it to those it lets).
    tools: { propose_agent: proposeAgent },
    // Chat asks it what an agent not in the app's code is.
    agentSources: { team: { action: "agent.define" } },
    // With the access plugin: an agent belongs where it was made, its managers change it,
    // and it's read where it works.
    shared: { agent: { member: "agent", write: "manage" } },
  },
  // An agent is a member of spaces, with its tools and model: its Actions check what it's given.
  guard: (_actor, { collection, access, direct }) => {
    if (collection === "agent" && direct && access === "write") {
      throw failure("forbidden", "Agents change through their Actions.", { public: true });
    }
    return undefined;
  },
});

export default team;
