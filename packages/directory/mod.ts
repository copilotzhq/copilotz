/**
 * The directory (`@copilotz/directory`), for apps that serve many orgs behind
 * one address (see design/tenancy.md): a runtime of its own, beside identity and the ways to
 * sign in, in front of every org's. It knows who signs in (the identity
 * plugin's people, by their sign-in method), which orgs each belongs to,
 * invitations to orgs by email, where each org lives, the hosts orgs claimed
 * (a preview's, an app's: `orgHost.resolve` says whose), and platform staff.
 * An org's own data (its people's roles, spaces, conversations) lives in the
 * org: each is a runtime of its own, opened on its first use and closed when
 * idle (the app's `runtimes(open)`, in `directory.orgs`), with
 * `directory.member(dir, org)` among its plugins.
 *
 * Its runtime is the app's `fetch`: its routes answer what's the
 * directory's, and hand everything else, untouched, to the org's runtime
 * (routes/forward.ts):
 *
 * - `/o/<org>/…`: that org, by its address (its page's `/connect` and
 *   socket, its API, its webhooks, its computers);
 * - anything else: the org the browser is in (its `org` cookie), going in
 *   first when a page needs it to; for someone signed in nowhere, the
 *   lobby (`directory.lobby`: the sign-in page);
 * - a host an org claimed (with the app's own named, `hosts`): that
 *   org's routes by host alone; `GET /__copilotz/hosts/resolve` says whose
 *   a host is, for the app's front.
 *
 * Its own: `GET /orgs`, `POST /orgs`, `POST /orgs/enter`, `POST
 * /orgs/invites/answer` (routes/orgs.ts), `POST /signout` out of every org
 * (routes/signout.ts), and staff's `/console/orgs…` and `/console/codes…`
 * (routes/console.ts). People sign in at the directory, with its plugins'
 * routes (`/signin/google`, `/signin/dev`); its session is identity's, in the
 * `dir` cookie (`__Host-dir` wherever it's Secure); which org a browser is in,
 * `org`; each org's session, `s_<org>`. Today's names, so nobody signs in
 * again.
 *
 * ```ts
 * import { identity, googleSignIn } from "copilotz/plugins/access";
 * import { directory } from "@copilotz/directory";
 *
 * const dir = await createRuntime({ store, plugins: [identity, googleSignIn, directory,
 *   definePlugin({ name: "d", resources: {
 *     directory: { staff: ["you@example.com"], orgs, lobby },
 *     hosts: { "app.example.com": true },
 *   } })] });
 * const orgs = runtimes(async (id) => {
 *   const org = await dir.query("org.info", { org: id });
 *   return org && await createRuntime({ store: storeOf(org), plugins: [...app, directory.member(dir, org)] });
 * });
 * Deno.serve(dir.fetch);
 * ```
 */
import { definePlugin, type Plugin } from "copilotz";
import { answerInviteRoute, enterOrgRoute, orgsRoute } from "./routes/orgs.ts";
import { signOutRoute } from "./routes/signout.ts";
import { codesRoute, consoleOrgsRoute, operateRoute, revokeCodeRoute } from "./routes/console.ts";
import { addressedRoute, claimedRoute, currentRoute, resolveRoute } from "./routes/forward.ts";
import { RESOLVE } from "./shared/http.ts";
import { member } from "./shared/member.ts";
import {
  createOrgAction,
  deleteOrgAction,
  enterOrgAction,
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
export type { DirectorySettings, Operations, OrgInfo } from "./shared/settings.ts";

const plugin: Plugin = definePlugin({
  name: "directory",
  requires: ["identity"],
  collections: { org, membership, invite, staff, orgHost, creditCode },
  actions: {
    "org.create": createOrgAction,
    "org.mine": myOrgsAction,
    "org.enter": enterOrgAction,
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
  routes: {
    "/orgs": orgsRoute,
    "/orgs/enter": enterOrgRoute,
    "/orgs/invites/answer": answerInviteRoute,
    // Out of every org, in place of identity's own.
    "/signout": signOutRoute,
    "/console/orgs": consoleOrgsRoute,
    "/console/orgs/:org": operateRoute,
    "/console/orgs/:org/:what": operateRoute,
    "/console/codes": codesRoute,
    "/console/codes/revoke": revokeCodeRoute,
    [RESOLVE]: resolveRoute,
    "/o/:org": addressedRoute,
    "/o/:org/*": addressedRoute,
    "/*": currentRoute,
    // Every host but the app's own (`hosts`): those orgs claimed.
    "*://*:*/*": claimedRoute,
  },
  // Its session is identity's, in today's cookie: `dir` (`__Host-dir` wherever it's Secure).
  resources: { cookies: { names: { session: "dir" } } },
});

/**
 * The directory plugin, and what each org's runtime gets of it:
 * `directory.member(dir, org)` (see shared/member.ts), with the org as
 * `org.info` says it.
 */
export const directory: Plugin & { member: typeof member } = Object.assign(plugin, { member });

export default directory;
