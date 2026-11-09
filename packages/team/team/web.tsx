/**
 * Team's web front end, for the browser: making and changing agents. Each
 * agent has a page (`/agent/<id>`, kind `agent`): who it is, where it works
 * among the person's spaces, what it's told; changed in place and deleted
 * by those who manage where it belongs, the app's own read only (a manager
 * starts a new one from it). Adding an agent to a space (`agent.add`: one
 * the person has met, or a new one made there, its instructions written
 * for them if they like) is the Agents tab of spaces' invite surface
 * (spaces' `spaceInvite` resource, named here; Personal spaces too). In
 * the command palette (`agent.palette`): agents to go to, adding one,
 * making one, having one answer new chats, and what to do with the one
 * open. Chat's front end shows agents in chats; spaces' adds them. Other
 * front ends choose a model with the same picker (`model.pick`: item
 * `{ value }`, hints `{ action, input, look? }`, calling `action` with what's
 * chosen). Add it beside them:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, teamWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "copilotz";
import { agentView } from "./views/web/agent.tsx";
import { agentAddView } from "./views/web/agent-add.tsx";
import { agentPaletteView } from "./views/web/agent-palette.tsx";
import { modelPickView } from "./views/web/model-pick.tsx";

export const teamWeb: Plugin = definePlugin({
  name: "team-web",
  requires: ["team", "web-shell"],
  views: {
    agent: agentView,
    "agent.add": agentAddView,
    "agent.palette": agentPaletteView,
    "model.pick": modelPickView,
  },
  resources: {
    spaceInvite: {
      agents: { title: "Agents", view: "agent.add", order: 20, personal: true },
    },
    palette: { agents: { view: "agent.palette", order: 25 } },
  },
});
