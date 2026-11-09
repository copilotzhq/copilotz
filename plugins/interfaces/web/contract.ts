/**
 * The web shell's contract: the shapes of the resource kinds it reads, for
 * front ends that fill them. `sidebar` (a section of the sidebar), `panel`
 * (the side panel beside a page), `palette` (what the command palette lists),
 * `userMenu` (a page of the person's own, in their menu), `orgs` (where the
 * app serves many orgs, the switcher and what goes with it: see `OrgsSlot`)
 * and `orgSettings` (a section of the org's page, `/org`, which the front end
 * that fills `orgs` shows: members, usage, about), each a View of the front
 * end's own; the words for org roles; and the person's standing in the org
 * (`useStanding`: spaces' `org.me`, asked once per page), with `orgsChanged`,
 * which a front end that changed the org (renamed it) says so with.
 *
 * The web sites' settings (`resources.web`) have their shapes here too (`DeclaredSite`, `WebSettings`,
 * `WEB_LIMITS`). See lines.ts.
 *
 * ```ts
 * resources: {
 *   orgSettings: { usage: { title: "Usage", view: "usage.org", icon: "chart", order: 30 } },
 *   orgs: { switcher: "orgs.switcher", overlay: "orgs.overlay", use: useShellOrgs },
 * }
 * ```
 */
export type { Section } from "./views/shell.tsx";
export type { Panel } from "./shared/panel.ts";
export type { PaletteSource } from "./shared/palette.ts";
export type { UserMenuEntry } from "./shared/menu.ts";
export {
  onOrgsChanged,
  ORG_ROLES,
  orgRoleName,
  orgsChanged,
  type OrgSection,
  type OrgsShown,
  type OrgsSlot,
  runs,
  type Standing,
} from "./shared/orgs.ts";
export { restand, useStanding } from "./shared/standing.ts";
export {
  type DeclaredSite,
  LIMITS as WEB_LIMITS,
  type WebLimits,
  type WebSettings,
} from "./shared/lines.ts";
