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
 * ```ts
 * resources: {
 *   sidebar: { spaces: { title: "Spaces", view: "spaces" } },
 *   panel: { view: "space.panel", on: ["thread"], title: "Space" },
 *   palette: { spaces: { view: "spaces.palette", order: 10 } },
 * }
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { defaultView } from "./views/default.tsx";
import { shellView } from "./views/shell.tsx";

export type { Section } from "./views/shell.tsx";
export type { Panel } from "./shared/panel.ts";
export type { PaletteSource } from "./shared/palette.ts";

export const webShell: Plugin = definePlugin({
  name: "web-shell",
  views: {
    shell: { web: shellView },
    "*": { web: defaultView },
  },
});

export default webShell;
