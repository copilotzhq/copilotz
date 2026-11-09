/**
 * `member(dir, org)`: the plugin each org's runtime gets from the directory
 * (`dir`, its runtime) that serves it, beside the app's own plugins:
 *
 * - **Which org it is** (`resources.org`: its id, name, kind and address,
 *   `/o/<org>`), and **where it's served** (`page.base`: its page, its
 *   `/connect` and its socket at its address).
 * - **Its cookies' names** (`resources.cookies`): identity's session goes by
 *   `s_<org>`, any other cookie by `<name>_<org>` (`visitor_<org>`), so one
 *   org's never reads another's. Today's names.
 * - **The app's own hosts** (`resources.hosts`, the directory's): a host an
 *   org claimed reaches only its host routes.
 * - **How it reaches the directory** (`resources.directory`): invitations,
 *   who leaves, its name, the hosts it claims, and gift codes.
 * - **Its `/enter`**, which only the directory's handoff opens (see
 *   routes/enter.ts).
 */
import {
  definePlugin,
  forbidden,
  type HostsSettings,
  ownHost,
  type Plugin,
  type Runtime,
} from "copilotz";
import { enterRoute } from "../routes/enter.ts";
import { baseOf, sessionOf } from "./http.ts";
import type { OrgInfo } from "./settings.ts";
import { forget, HANDOFF, plainHost } from "./state.ts";

/** What an org's runtime is given of the directory: `dir`, the directory's runtime, and the org. */
export function member(
  dir: Pick<Runtime, "call" | "describe">,
  org: Pick<OrgInfo, "id" | "name" | "kind">,
): Plugin {
  const resources = dir.describe().resources;
  const hosts = resources.hosts as HostsSettings | undefined;
  const base = baseOf(org.id);
  const ask = <R = unknown>(action: string, input: Record<string, unknown> = {}) =>
    dir.call<R>(action, { org: org.id, ...input });
  return definePlugin({
    name: "directory-member",
    // Its `/enter` starts identity's session, and sets identity's cookie.
    requires: ["identity"],
    routes: { [HANDOFF]: enterRoute(resources, org) },
    resources: {
      org: { id: org.id, name: org.name, kind: org.kind, base },
      page: { base },
      cookies: { names: { session: sessionOf(org.id) }, suffix: `_${org.id}` },
      ...(hosts ? { hosts } : {}),
      directory: {
        invite: (invite: { email: string; role: string; by: string; from?: string }) =>
          ask("invite.send", invite).then(() => {}),
        invites: () => ask<{ invites: unknown[] }>("invite.org").then((r) => r.invites),
        cancel: (email: string) => ask("invite.cancel", { email }).then(() => {}),
        leave: (person: string) => ask("org.leave", { person }).then(() => {}),
        rename: (name: string) =>
          ask("org.rename", { name }).then(() => forget(resources, { org: org.id })),
        /**
         * Makes a host the org's: its requests are its routes' by host (a
         * preview's), or, with a `target`, the front sends them there (an
         * app's service). Refused for the app's own hosts, and another org's.
         */
        claimHost: async (host: string, claim: { target?: string } = {}) => {
          const name = plainHost(host);
          if (ownHost(hosts, name)) throw forbidden(`${name} is the app's own`);
          await ask("host.claim", {
            host: name,
            ...(claim.target ? { target: claim.target } : {}),
          });
          forget(resources, { host: name });
        },
        /** The host is no longer the org's. */
        releaseHost: async (host: string) => {
          const name = plainHost(host);
          await ask("host.release", { host: name });
          forget(resources, { host: name });
        },
        /** A gift code's credits, for this org. */
        claimCode: (code: string, person: string) =>
          ask<{ id: string; amount: number; expires?: string; note?: string }>("code.claim", {
            code,
            person,
          }),
      },
    },
  });
}
