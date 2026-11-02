/**
 * The directory: routing only, for apps that serve many orgs (see
 * design/tenancy.md). It knows who signs in (the identity plugin's people,
 * by their sign-in method), which orgs each belongs to, invitations to orgs
 * by email, where each org lives, the hosts orgs claimed (a preview's, an
 * app's: `orgHost.resolve` says whose), and platform staff. An org's own data
 * (its people's roles, spaces, conversations) lives in the org.
 *
 * It runs in a runtime of its own, beside identity and a sign-in method;
 * the orgs host calls its Actions, as the system, for people it has
 * verified (`hosts/orgs`).
 *
 *   createRuntime({ store, plugins: [identity, googleSignIn, directory, { name: "d",
 *     resources: { directory: { staff: ["you@example.com"] } } }] })
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import {
  createOrgAction,
  deleteOrgAction,
  enterOrgAction,
  getOrgAction,
  leaveOrgAction,
  listOrgsAction,
  myOrgsAction,
  placeOrgAction,
  renameOrgAction,
  reportOrgAction,
  suspendOrgAction,
} from "./actions/org.ts";
import {
  answerInviteAction,
  cancelInviteAction,
  myInvitesAction,
  orgInvitesAction,
  sendInviteAction,
} from "./actions/invite.ts";
import { claimHostAction, releaseHostAction } from "./actions/host.ts";
import {
  claimCodeAction,
  createCodeAction,
  listCodesAction,
  revokeCodeAction,
} from "./actions/code.ts";
import { creditCode } from "./collections/credit-code.ts";
import { invite } from "./collections/invite.ts";
import { membership } from "./collections/membership.ts";
import { org } from "./collections/org.ts";
import { orgHost } from "./collections/org-host.ts";
import { staff } from "./collections/staff.ts";

export type { Org } from "./collections/org.ts";
export type { Membership } from "./collections/membership.ts";
export type { Invite } from "./collections/invite.ts";
export type { OrgHost } from "./collections/org-host.ts";
export type { CreditCode } from "./collections/credit-code.ts";
export type { DirectorySettings } from "./shared/settings.ts";

export const directory: Plugin = definePlugin({
  name: "directory",
  requires: ["identity"],
  collections: { org, membership, invite, staff, orgHost, creditCode },
  actions: {
    "org.create": createOrgAction,
    "org.mine": myOrgsAction,
    "org.enter": enterOrgAction,
    "org.get": getOrgAction,
    "org.leave": leaveOrgAction,
    "org.rename": renameOrgAction,
    "org.suspend": suspendOrgAction,
    "org.report": reportOrgAction,
    "org.list": listOrgsAction,
    "org.place": placeOrgAction,
    "org.delete": deleteOrgAction,
    "invite.send": sendInviteAction,
    "invite.mine": myInvitesAction,
    "invite.org": orgInvitesAction,
    "invite.answer": answerInviteAction,
    "invite.cancel": cancelInviteAction,
    "host.claim": claimHostAction,
    "host.release": releaseHostAction,
    "code.create": createCodeAction,
    "code.claim": claimCodeAction,
    "code.list": listCodesAction,
    "code.revoke": revokeCodeAction,
  },
});

export default directory;
