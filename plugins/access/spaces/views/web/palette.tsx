/**
 * What spaces offer in the command palette (kind `spaces.palette`, the web
 * shell's `palette` resource), for where the person is (`hints.in`) and
 * what's typed (`hints.search`):
 *
 * - **Invitations** to them: join one (its page opens), or decline it.
 * - **This space:** invite someone (the invite dialog), rename it, archive
 *   or restore it (for those who manage it), leave it; while searching, its
 *   tabs too ("Members"), to go to.
 * - **Spaces:** each space to go to, those in use; while searching, the
 *   archived ones too, marked.
 * - **Create:** a new space, named in the next step.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Avatar, go, type PaletteGroup, type PaletteItem } from "../../../../../hosts/web/mod.ts";
import type { Invitation, Reached } from "../../contract.ts";
import { INVITE_ABOUT, inviteTitle } from "./invite-dialog.tsx";
import { archiveStep, leaveStep, newSpaceStep, renameStep } from "./steps.ts";
import { spacePath, tabsOf } from "./tabs.ts";
import { apart, aRole, ownersOf, spaceName, whoOf } from "./who.ts";
import { namesIn } from "../../shared/names.ts";

/** How many spaces show with nothing typed, and while searching. */
const SHOWN = { idle: 6, searching: 8 };

/** A space's mark, as the palette shows it before its name. */
const markOf = (space: Reached): Pick<PaletteItem, "icon" | "leading"> =>
  space.kind === "personal"
    ? { icon: "person" }
    : { leading: <Avatar name={space.name} kind="space" size={26} /> };

export const spacesPaletteView = (
  _: unknown,
  ctx: ViewContext<ReactNode>,
): PaletteGroup[] | null => {
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  const invitations = ctx.db.collection("invitation").query<Invitation[]>("mine", {}).value;
  if (!spaces) return null;
  const names = namesIn(ctx, [
    ...(invitations ?? []).map((i) => i.by),
    ...ownersOf(spaces, ctx.viewer?.name),
  ]);
  const searching = !!String(ctx.hints.search ?? "").trim();
  const here = spaces.find((s) => s._id === ctx.hints.in);
  const call = ctx.call;
  const groups: PaletteGroup[] = [];

  if (invitations?.length) {
    groups.push({
      title: "Invitations",
      order: 5,
      items: invitations.flatMap((i): PaletteItem[] => [
        {
          key: `invitation:${i._id}`,
          label: `Join ${i.name}`,
          icon: "mail",
          description: `${whoOf(i.by, names).name} invited you, as ${aRole(i.role)}`,
          keywords: ["invitation", "accept"],
          run: async () => {
            const joined = await call<{ space: string }>("invitation.accept", {
              invitation: i._id,
            });
            go(spacePath(joined.space));
          },
        },
        ...(searching
          ? [{
            key: `invitation:${i._id}:decline`,
            label: `Decline the invitation to ${i.name}`,
            icon: "close" as const,
            keywords: ["invitation"],
            run: () => call("invitation.decline", { invitation: i._id }),
          }]
          : []),
      ]),
    });
  }

  if (here && here.kind !== "personal") {
    const name = here.name;
    const manage = here.can.includes("manage");
    const items: PaletteItem[] = [];
    if (manage && !here.archived) {
      items.push({
        key: "space:invite",
        label: `Invite someone to ${name}…`,
        icon: "invite",
        keywords: ["people", "member", "email", "add"],
        run: (palette) =>
          palette.dialog({
            title: inviteTitle(name),
            description: INVITE_ABOUT,
            view: "space.invite",
            item: { _id: here._id },
            hints: { in: here._id },
          }),
      });
    }
    if (manage) {
      items.push({
        key: "space:rename",
        label: `Rename ${name}…`,
        icon: "pencil",
        step: renameStep(here, call),
      });
      items.push(
        here.archived
          ? {
            key: "space:restore",
            label: `Restore ${name}`,
            icon: "restore",
            keywords: ["unarchive", "archived"],
            run: () => call("space.archive", { space: here._id, archived: false }),
          }
          : {
            key: "space:archive",
            label: `Archive ${name}…`,
            icon: "archive",
            step: archiveStep(here, call),
          },
      );
    }
    items.push({
      key: "space:leave",
      label: `Leave ${name}…`,
      icon: "signout",
      tone: "destructive",
      step: leaveStep(here, call),
    });
    if (searching) {
      for (const tab of tabsOf(ctx.resources.spaceTabs)) {
        items.push({
          key: `space:tab:${tab.key}`,
          label: tab.title,
          ...(tab.icon ? { icon: tab.icon } : {}),
          description: name,
          href: spacePath(here._id, tab.key),
        });
      }
    }
    groups.push({ title: "This space", order: 10, items });
  }

  const { active, archived } = apart(spaces);
  groups.push({
    title: "Spaces",
    order: 20,
    limit: searching ? SHOWN.searching : SHOWN.idle,
    items: [...active, ...(searching ? archived : [])].map((s) => ({
      key: `space:${s._id}`,
      label: spaceName(s, ctx.viewer?.name, names),
      ...markOf(s),
      description: s.archived
        ? "Archived"
        : s._id === here?._id
        ? "You're here"
        : s.kind === "personal"
        ? "Just you"
        : undefined,
      keywords: s.kind === "personal" ? ["personal", "mine"] : [],
      href: spacePath(s._id),
    })),
  });

  groups.push({
    title: "Create",
    order: 40,
    items: [{
      key: "space:new",
      label: "New space…",
      icon: "plus",
      keywords: ["create", "make", "shared"],
      step: newSpaceStep(call),
    }],
  });
  return groups;
};
