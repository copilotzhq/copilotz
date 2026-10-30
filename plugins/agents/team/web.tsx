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
 * open. Chat's front end shows agents in chats; spaces' adds them. Add it
 * beside them:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, teamWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { agentView } from "./views/web/agent.tsx";
import { agentAddView } from "./views/web/agent-add.tsx";
import { agentPaletteView } from "./views/web/agent-palette.tsx";

export const teamWeb: Plugin = definePlugin({
  name: "team-web",
  requires: ["team", "web-shell"],
  views: {
    agent: { web: agentView },
    "agent.add": { web: agentAddView },
    "agent.palette": { web: agentPaletteView },
  },
  resources: {
    spaceInvite: {
      agents: { title: "Agents", view: "agent.add", order: 20, personal: true },
    },
    palette: { agents: { view: "agent.palette", order: 25 } },
  },
});
