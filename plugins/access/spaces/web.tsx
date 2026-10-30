/**
 * Spaces' web front end. In the sidebar, the spaces you reach as a tree:
 * each a link to its page, with what other front ends show under it once
 * unfolded (`spaceSidebar`: its latest chats), making a new one, and those
 * archived, apart and folded; over it, invitations to you, to join or
 * decline (and on home, through chat's `home` resource). A space's page
 * (`/space/<id>`): its header, then the tabs front ends add (`spaceTabs`),
 * of which this one adds Members (who's in it, by kind: people, agents as
 * chat shows them, spaces; inviting, and the invitations waiting; requests
 * to join) and Settings (its name, which agent answers its new chats,
 * archiving it, leaving it). Adding to a space is one surface
 * (`space.invite`): People, then the kinds other front ends add
 * (`spaceInvite`: team's Agents). And the side panel beside a chat (the
 * web shell's `panel`): the chat's space, its tabs compact. A message
 * refused for naming agents that don't answer in its space (chat's
 * `refusals`, `not_here`): who, and adding them there to send it.
 *
 * In the command palette (the web shell's `palette`): spaces to go to, what
 * to do with the one you're in, a new one, and invitations; and the space
 * picker every "Move to…" opens (`space.pick`, a step's View). The resource
 * kinds are in contract.ts. Add it beside the web shell.
 *
 * Where the app serves many orgs, two sections of the org's page (the web
 * shell's `orgSettings`): About (its name, renamed by its owners; your role;
 * what its owners and admins can see) and Members (its people and their
 * roles; for its owners and admins, inviting by email, the invitations
 * waiting, changing roles and taking someone out, handing over the spaces
 * only they managed). Owners and admins reach every space; the sidebar
 * lists the ones they're in, and the rest of the org's apart.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { invitationsView } from "./views/web/invitations.tsx";
import { invitedView } from "./views/web/invited.tsx";
import { invitingView } from "./views/web/inviting.tsx";
import { membersView } from "./views/web/members.tsx";
import { notHereView } from "./views/web/not-here.tsx";
import { orgAboutView } from "./views/web/org-about.tsx";
import { orgMembersView } from "./views/web/org-members.tsx";
import { spacesPaletteView } from "./views/web/palette.tsx";
import { spacePanelView } from "./views/web/panel.tsx";
import { spacePickView } from "./views/web/pick.tsx";
import { settingsView } from "./views/web/settings.tsx";
import { spaceView } from "./views/web/space.tsx";
import { spacesView } from "./views/web/spaces.tsx";

export const spacesWeb: Plugin = definePlugin({
  name: "spaces-web",
  requires: ["spaces", "web-shell"],
  views: {
    spaces: { web: spacesView },
    space: { web: spaceView },
    "space.panel": { web: spacePanelView },
    "space.members": { web: membersView },
    "space.settings": { web: settingsView },
    "space.invite": { web: invitingView },
    "space.pick": { web: spacePickView },
    "spaces.palette": { web: spacesPaletteView },
    invitations: { web: invitationsView },
    "invitations.home": { web: invitedView },
    "space.not-here": { web: notHereView },
    "org.about": { web: orgAboutView },
    "org.members": { web: orgMembersView },
  },
  resources: {
    sidebar: {
      invitations: { view: "invitations", order: 3 },
      spaces: { title: "Spaces", view: "spaces", order: 10 },
    },
    spaceTabs: {
      members: { title: "Members", view: "space.members", icon: "users", order: 80 },
      settings: { title: "Settings", view: "space.settings", icon: "settings", order: 90 },
    },
    panel: { view: "space.panel", on: ["thread"], title: "Space" },
    palette: { spaces: { view: "spaces.palette", order: 10 } },
    home: { invitations: { view: "invitations.home", order: 10 } },
    refusals: { not_here: { view: "space.not-here" } },
    orgSettings: {
      about: { title: "About", view: "org.about", icon: "info", order: 10 },
      members: {
        title: "Members",
        view: "org.members",
        icon: "users",
        order: 20,
        roles: ["owner", "admin", "member"],
      },
    },
  },
});
