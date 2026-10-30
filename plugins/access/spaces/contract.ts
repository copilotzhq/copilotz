/**
 * The spaces plugin's contract: what plugins built on spaces may import from
 * it: the shapes of its documents (a space, a membership, a request to join,
 * an invitation) and of the resource kinds its web front end reads. They
 * reach the rest by name: its collections (`space`, `member`, `request`,
 * `invitation`), its queries `space.reached` (each space with what the asker
 * may do there) and `invitation.mine` (those to the asker's email), and its
 * Actions (`space.create`, `space.personal`, `space.rename`, `space.can`,
 * `space.leave`, `space.archive`, `space.agent`, `member.set`,
 * `member.remove`, `invitation.send`, `invitation.accept`,
 * `invitation.decline`, `request.grant`, `request.deny`).
 *
 * On the web, a space is a page (`/space/<id>`): a header, then tabs. Other
 * front ends add to it, to the sidebar, and to who can be added to a space,
 * through three resource kinds:
 *
 * - `spaceTabs`: a tab on a space's page, and in its side panel beside a
 *   chat. Its View gets item `{ _id }` (the space's id) and hints
 *   `{ in, mode }`: `page`, the tab's content under the space's header (the
 *   page is its frame: no title of its own), or `panel`, the same View,
 *   compact. Lowest `order` first; the address says which tab is open
 *   (`/space/<id>?tab=chats`), the first when it says none.
 * - `spaceSidebar`: what a space shows under it in the sidebar once it's
 *   unfolded (its latest chats): a View with item `{ _id }` and hints
 *   `{ in, path }`, the address open, to mark what's current.
 * - `spaceInvite`: a kind of member to add, a tab in the space's invite
 *   surface (`space.invite`) beside People: a View with item `{ _id }` and
 *   hints `{ in }`, for those who manage the space; `personal: true` when
 *   it joins a Personal space too (agents do; people don't). The words for
 *   the roles agents work in are `AGENT_ROLES`.
 *
 * ```ts
 * resources: {
 *   spaceTabs: { notes: { title: "Notes", view: "notes", icon: "note", order: 50 } },
 *   spaceSidebar: { chats: { view: "chats.recent", title: "chats" } },
 *   spaceInvite: { agents: { title: "Agents", view: "agent.add", personal: true } },
 * }
 * ```
 */
import type { IconName } from "../../../hosts/web/mod.ts";

export type { Reached, Space } from "./collections/space.ts";
export type { Member } from "./collections/member.ts";
export type { Invitation } from "./collections/invitation.ts";
export type { Request } from "./collections/request.ts";
export type { Verb } from "./shared/reach.ts";
export { PERSONAL } from "./shared/personal.ts";
export { AGENT_ROLES } from "./views/web/who.ts";

/** A `spaceTabs` resource: a tab on a space's page and in its side panel. */
export type SpaceTab = {
  title: string;
  /** The View it shows: item `{ _id }`, hints `{ in, mode: "page" | "panel" }`. */
  view: string;
  icon?: IconName;
  order?: number;
};

/** A `spaceSidebar` resource: a View under a space in the sidebar, item `{ _id }`, hints `{ in, path }`. */
export type SpaceSidebar = {
  view: string;
  /** What it shows, as the fold says it: "Show Launch's chats". */
  title?: string;
  order?: number;
};

/** A `spaceInvite` resource: a kind of member added to a space, a tab of its invite surface. */
export type SpaceInvite = {
  title: string;
  /** The View it shows: item `{ _id }`, hints `{ in }`. */
  view: string;
  order?: number;
  /** Whether it's added to a Personal space too. */
  personal?: boolean;
};
