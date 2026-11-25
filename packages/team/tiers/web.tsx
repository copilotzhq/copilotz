/**
 * Tiers' web front end, for the browser.
 *
 * - **The org page's Agents section** (the web shell's `orgSettings`, at
 *   `/org?tab=models`): the tiers as cards, each with what a typical message
 *   comes to and each kind of work's model; making one the default,
 *   customizing one (each kind's model and fallbacks), making new ones,
 *   taking them away, the members' cap; and the org's team under them.
 * - **Beside the send button** (chat's `composerControls`): the tier a chat
 *   runs on, to switch it there, or on home the person's default.
 * - **On a space's Members tab** (spaces' `spaceAgents`): the tier new chats
 *   there start on, for its managers to change, and on each agent its model
 *   there and its kind of work.
 * - **For a new org** (`tiers.setup`, a step of chat's `welcome` for its
 *   owners and admins): the tiers as one short choice.
 * - **For team's front end** (`agentKinds`): where to read the kinds of work,
 *   so making an agent asks for its kind instead of a model.
 * - **For computers' front end** (`planList`): the plans Your AI shows, from
 *   `modelChoice.harnesses` in the person's order, and saving their order
 *   with `tiers.harnesses`.
 *
 * Models are chosen with team's picker (`model.pick`). Add it beside them:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, teamWeb, tiersWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "copilotz";
import { tiersComposerView } from "./views/web/composer.tsx";
import { tiersOrgView } from "./views/web/org.tsx";
import { tiersSetupView } from "./views/web/setup.tsx";
import { tiersAgentView, tiersSpaceView } from "./views/web/space.tsx";

export const tiersWeb: Plugin = definePlugin({
  name: "tiers-web",
  requires: ["web-shell", "spaces-web", "team-web"],
  views: {
    "tiers.org": tiersOrgView,
    "tiers.space": tiersSpaceView,
    "tiers.agent": tiersAgentView,
    "tiers.setup": tiersSetupView,
    "tiers.composer": tiersComposerView,
  },
  resources: {
    orgSettings: {
      models: {
        title: "Agents",
        view: "tiers.org",
        icon: "sparkles",
        order: 22,
        roles: ["owner", "admin", "member"],
      },
    },
    spaceAgents: { tiers: { view: "tiers.space", row: "tiers.agent", order: 10 } },
    composerControls: { tiers: { view: "tiers.composer", order: 10 } },
    agentKinds: { query: "modelChoice.offered" },
    // Your AI's plans: the app's, in the person's order, and saving their order (computers' front end).
    planList: { query: "modelChoice.harnesses", order: "tiers.harnesses" },
    // Chat's welcome, for who runs the org: choosing its tier as they start.
    welcome: {
      tiers: {
        title: "How hard should your agents think?",
        description: "Pick the default for new chats. Anyone can switch a chat's tier as they " +
          "write, and you can change this any time in your org's settings.",
        view: "tiers.setup",
        order: 30,
        roles: ["owner", "admin"],
      },
    },
  },
});

export default tiersWeb;
