/**
 * The web shell's contract: the shapes of the resource kinds it reads, for
 * front ends that fill them. `sidebar` (a section of the sidebar), `panel`
 * (the side panel beside a page), `palette` (what the command palette lists),
 * `userMenu` (a page of the person's own, in their menu) and `orgSettings`
 * (a section of the org's page, `/org`, when the app
 * serves many orgs: members, usage, about), each a View of the front end's
 * own, and the words for org roles.
 *
 * ```ts
 * resources: {
 *   orgSettings: { usage: { title: "Usage", view: "usage.org", icon: "chart", order: 30 } },
 * }
 * ```
 */
export type { Section } from "./views/shell.tsx";
export type { Panel } from "./shared/panel.ts";
export type { PaletteSource } from "./shared/palette.ts";
export type { UserMenuEntry } from "./shared/menu.ts";
export { ORG_ROLES, orgRoleName, type OrgSection, runs, type Standing } from "./shared/orgs.ts";
