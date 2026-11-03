/**
 * Tiers' web front end, for the browser. The org page's "Agents' models"
 * section (the web shell's `orgSettings`, at `/org?tab=models`): the tiers as
 * cards, with what each is good for, each agent's model, what a typical
 * reply comes to and which is in use and why; choosing one, and Customize, a
 * model per agent. Owners and admins change it; members read it, and are told
 * who can. On a space's Members tab (spaces' `spaceAgents`): the space's tier
 * above its agents, and on each of the app's agents the model it uses there
 * and where that comes from, with Change for its managers. Models are chosen
 * with team's picker (`model.pick`). Add it beside them:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, teamWeb, tiersWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { tiersOrgView } from "./views/web/org.tsx";
import { tiersAgentView, tiersSpaceView } from "./views/web/space.tsx";

export const tiersWeb: Plugin = definePlugin({
  name: "tiers-web",
  requires: ["web-shell", "spaces-web", "team-web"],
  views: {
    "tiers.org": { web: tiersOrgView },
    "tiers.space": { web: tiersSpaceView },
    "tiers.agent": { web: tiersAgentView },
  },
  resources: {
    orgSettings: {
      models: {
        title: "Agents' models",
        view: "tiers.org",
        icon: "sparkles",
        order: 22,
        roles: ["owner", "admin", "member"],
      },
    },
    spaceAgents: { tiers: { view: "tiers.space", row: "tiers.agent", order: 10 } },
  },
});

export default tiersWeb;
