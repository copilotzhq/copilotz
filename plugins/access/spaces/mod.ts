/**
 * Spaces: who reaches what, for every collection that shares its documents.
 *
 * - **Spaces** hold documents (a document of a shared collection is `in` one)
 *   and have members: people, agents, or other spaces, each with a role.
 *   A space that's a member of another draws on it. Everyone has a Personal
 *   space (`space.personal`); shared spaces are for working with others,
 *   and those who manage one rename it (`space.rename`).
 * - **Invitations:** people join a shared space by accepting an invitation
 *   to the email they sign in with (`invitation.send`, `invitation.accept`,
 *   `invitation.decline`); sending one never says if the address has an
 *   account. A request someone makes to join is granted (`request.grant`).
 * - **Agents are members:** each one on its own (`agent:maya`), a viewer
 *   or an editor. A new space starts with the app's default agents, the
 *   first answering its new chats (`space.agent` changes which); a manager
 *   adds any agent they've met. Chat asks who works in a space through its
 *   `roster` resource (`space.roster`): only they answer there.
 * - **Reach:** an actor reaches the spaces they're a member of, and the
 *   spaces those draw on, with what the roles along the path allow. An agent
 *   acting for someone (`actor.for`) reaches what both reach.
 * - **Rules** (the runtime's guard): reads of a shared collection only see
 *   what's reached; inserts and what writes leave must be in a space you may
 *   write; a document shared on its own is reached through its own members.
 *   A query naming a space it reaches is sent to the store as it is.
 * - **Labels:** what a job read goes with what it writes: an answer that
 *   used what not everyone in its space can see carries those sources (in
 *   a collection with `labels: true`), and only those who reach them all
 *   read it until someone who does `share`s it. An agent writing it
 *   anywhere else is refused (`needs_share`).
 * - **Where you are:** with the chat plugin, agents are told the space a
 *   conversation is in, its members and what it draws on (`where` context),
 *   and each turn, the other spaces they can read for their person
 *   (`elsewhere` context), to look in when what they need isn't here.
 *
 * Collections opt in through the `shared` resource:
 *
 * ```ts
 * resources: { shared: { note: {} } }            // documents say where: `in`
 * resources: { shared: { board: { field: "space" } } }
 * resources: { roles: { commenter: ["read"] } }  // more roles, as verbs
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { agentAction, rosterAction } from "./actions/agents.ts";
import { createAction } from "./actions/create.ts";
import { archiveAction } from "./actions/archive.ts";
import { canAction } from "./actions/can.ts";
import { leaveAction } from "./actions/leave.ts";
import {
  acceptInvitationAction,
  declineInvitationAction,
  sendInvitationAction,
} from "./actions/invitation.ts";
import { removeMemberAction, setMemberAction } from "./actions/member.ts";
import {
  inviteToOrgAction,
  joinOrgAction,
  orgInvitesAction,
  orgMeAction,
  orgPeopleAction,
  orgRoleAction,
  orgSummaryAction,
  removeFromOrgAction,
  renameOrgAction,
  uninviteAction,
} from "./actions/org.ts";
import { personalAction } from "./actions/personal.ts";
import { renameAction } from "./actions/rename.ts";
import { shareAction } from "./actions/share.ts";
import { labels } from "./shared/labels.ts";
import { invitation } from "./collections/invitation.ts";
import { member } from "./collections/member.ts";
import { request } from "./collections/request.ts";
import { denyAction, grantAction } from "./actions/request.ts";
import { tools } from "./resources/tools.ts";
import { space } from "./collections/space.ts";
import { rules } from "./shared/rules.ts";
import { agentGoneProcessor } from "./processors/agent-gone.ts";
import { elsewhereView } from "./views/elsewhere.ts";
import { whereView } from "./views/where.ts";

export type { Invitation } from "./collections/invitation.ts";
export type { DirectoryPort } from "./actions/org.ts";
export type { Member } from "./collections/member.ts";
export type { Reached, Space } from "./collections/space.ts";
export type { SpaceInvite, SpaceSidebar, SpaceTab } from "./contract.ts";
export type { Request } from "./collections/request.ts";
export {
  memberKey,
  ORG,
  ORG_ROLES,
  type OrgRole,
  orgRoleOf,
  type Reach,
  reachOf,
  ROLES,
  type Verb,
} from "./shared/reach.ts";
export type { Shared } from "./shared/rules.ts";

export const spaces: Plugin = definePlugin({
  name: "spaces",
  // Invitations match people by the email they signed in with.
  requires: ["identity"],
  collections: { space, member, request, invitation },
  actions: {
    "space.create": createAction,
    "space.personal": personalAction,
    "space.rename": renameAction,
    "space.can": canAction,
    "space.leave": leaveAction,
    "space.archive": archiveAction,
    "space.agent": agentAction,
    "space.roster": rosterAction,
    "member.set": setMemberAction,
    "member.remove": removeMemberAction,
    "org.join": joinOrgAction,
    "org.role": orgRoleAction,
    "org.remove": removeFromOrgAction,
    "org.me": orgMeAction,
    "org.people": orgPeopleAction,
    "org.invite": inviteToOrgAction,
    "org.invites": orgInvitesAction,
    "org.uninvite": uninviteAction,
    "org.summary": orgSummaryAction,
    "org.rename": renameOrgAction,
    "invitation.send": sendInvitationAction,
    "invitation.accept": acceptInvitationAction,
    "invitation.decline": declineInvitationAction,
    share: shareAction,
    "request.grant": grantAction,
    "request.deny": denyAction,
  },
  guard: rules,
  labels,
  // Where a conversation is, in agents' prompts (with the chat plugin), and
  // each turn, where else they can read for their person.
  views: {
    "context:where": { llm: whereView },
    "context:elsewhere": { llm: elsewhereView },
  },
  resources: {
    context: { where: { place: "system" }, elsewhere: { place: "turn" } },
    tools,
    // Who works in a space, for chat: its agents.
    roster: { spaces: { action: "space.roster" } },
  },
  processors: { "spaces.agentGone": agentGoneProcessor },
});

export default spaces;
