/**
 * The web shell: the web's root View, which the web host observes for the
 * address it's at (`hosts/web`). A sidebar of what features put there (the
 * `sidebar` resource: `{ title?, view, order? }`, each shown as its View,
 * under its title if it has one), who's signed in, and the main area: the
 * address `/<kind>/<id>` shows that kind's View for that document, `/` the
 * `home` View, with the address's parameters as `hints.query`
 * (`?tab=files`). What's shown hears where the person works (`hints.in`,
 * from `?in=`; on a space's page, `/space/<id>`, that space); the sidebar's
 * Views, the address too (`hints.path`). On a phone, the sidebar is a
 * drawer. Any kind without a web View of its own shows field by field.
 *
 * The shell owns one side panel, beside the pages that offer it (the `panel`
 * resource): its View gets item `{ _id }` and hints `{ in, mode: "panel" }`,
 * the space the person works in, and is shown only while it's open. A
 * button at the page's top right opens and closes it (a page keeps its
 * header clear of it by `--copilotz-inset-end`); the person drags it wider,
 * and this browser keeps it as they left it. On a phone, it's a sheet.
 *
 * And the command palette (⌘K, Ctrl+K elsewhere, or Search in the sidebar),
 * which front ends fill through the `palette` resource: a View each, given
 * hints `{ search, in, path, page, query }` (what's typed; the space; the
 * address; the page open, `{ kind, id }`; its parameters), that returns the
 * groups of items it offers there (`PaletteGroup[]`, from `hosts/web`): a
 * place to go, something to do (an Action), or a step of its own, such as
 * "Move to…" then a space. Groups with the same heading are one. By
 * custom, their `order`: 10 for what's open ("This chat", "This space"), 20
 * and 30 for where to go ("Spaces", "Chats"), 40 for making something
 * ("Create"), 90 for the shell's own ("General": the panel, signing out).
 *
 * Who's signed in has a menu of what front ends put there (the `userMenu`
 * resource: `{ label, icon?, href, order? }`, pages of the person's own,
 * such as Connected accounts), then signing out.
 *
 * Where the app serves many orgs (`hosts/orgs`; the web host's `useOrgs`),
 * the shell is where you are among them: the org switcher at the top of the
 * sidebar (your orgs, Personal first; invitations, answered in place; a new
 * org; going into one shows a short transition, then its home), the user
 * menu at its foot, and orgs in the palette. In an org as platform staff, a
 * line in the warning colour runs along the top, and the switcher says so.
 * The org's page (`/org`) is made of sections front ends add (the
 * `orgSettings` resource: `{ title, view, icon?, order?, roles? }`, each a
 * View given item `{ _id }` and hints `{ org, role, staff, mode }`), and
 * staff's console (`/console`) lists every org, to enter, rename, suspend,
 * move, export or delete. The resource kinds' shapes are in contract.ts.
 *
 * ```ts
 * resources: {
 *   sidebar: { spaces: { title: "Spaces", view: "spaces" } },
 *   panel: { view: "space.panel", on: ["thread"], title: "Space" },
 *   palette: { spaces: { view: "spaces.palette", order: 10 } },
 *   orgSettings: { members: { title: "Members", view: "org.members", icon: "users", order: 20 } },
 *   userMenu: { accounts: { label: "Connected accounts", icon: "lock", href: "/accounts" } },
 * }
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { consoleView } from "./views/console.tsx";
import { defaultView } from "./views/default.tsx";
import { orgView } from "./views/org.tsx";
import { shellView } from "./views/shell.tsx";

export type { Section } from "./views/shell.tsx";
export type { Panel } from "./shared/panel.ts";
export type { PaletteSource } from "./shared/palette.ts";
export type { OrgSection } from "./shared/orgs.ts";
export type { UserMenuEntry } from "./shared/menu.ts";

export const webShell: Plugin = definePlugin({
  name: "web-shell",
  views: {
    shell: { web: shellView },
    org: { web: orgView },
    console: { web: consoleView },
    "*": { web: defaultView },
  },
});

export default webShell;
