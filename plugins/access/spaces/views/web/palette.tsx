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
import { inviteAbout, inviteTitle } from "./invite-dialog.tsx";
import { archiveStep, leaveStep, newSpaceStep, renameStep } from "./steps.ts";
import { spacePath, tabsOf } from "./tabs.ts";
import { apart, aRole, ownersOf, spaceName, whoOf } from "./who.ts";
import { say } from "./words.ts";
import { namesIn } from "../../shared/names.ts";

/** How many spaces show with nothing typed, and while searching. */
const SHOWN = { idle: 6, searching: 8 };

/** The words a phrase gives to find an item by (its keywords), apart. */
const keywords = (key: Parameters<typeof say>[0]) => say(key).split(/\s+/).filter(Boolean);

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
      title: say("invitations"),
      order: 5,
      items: invitations.flatMap((i): PaletteItem[] => [
        {
          key: `invitation:${i._id}`,
          label: say("joinNamed", { name: i.name }),
          icon: "mail",
          description: say("invitedYouAs", { by: whoOf(i.by, names).name, role: aRole(i.role) }),
          keywords: keywords("keysAcceptInvitation"),
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
            label: say("declineInvitation", { name: i.name }),
            icon: "close" as const,
            keywords: keywords("keysInvitation"),
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
        label: say("inviteToNamed", { name }),
        icon: "invite",
        keywords: keywords("keysInvite"),
        run: (palette) =>
          palette.dialog({
            title: inviteTitle(name),
            description: inviteAbout(),
            view: "space.invite",
            item: { _id: here._id },
            hints: { in: here._id },
          }),
      });
    }
    if (manage) {
      items.push({
        key: "space:rename",
        label: say("renameNamed", { name }),
        icon: "pencil",
        step: renameStep(here, call),
      });
      items.push(
        here.archived
          ? {
            key: "space:restore",
            label: say("restoreNamed", { name }),
            icon: "restore",
            keywords: keywords("keysRestore"),
            run: () => call("space.archive", { space: here._id, archived: false }),
          }
          : {
            key: "space:archive",
            label: say("archiveNamedMore", { name }),
            icon: "archive",
            step: archiveStep(here, call),
          },
      );
    }
    items.push({
      key: "space:leave",
      label: say("leaveNamedMore", { name }),
      icon: "signout",
      tone: "destructive",
      step: leaveStep(here, call),
    });
    if (searching) {
      // Its tabs, and their sections (Memories: in Settings).
      for (const tab of tabsOf(ctx.resources.spaceTabs)) {
        for (const part of [tab, ...tab.sections]) {
          items.push({
            key: `space:tab:${part.key}`,
            label: part.title,
            ...(part.icon ? { icon: part.icon } : {}),
            description: part === tab ? name : say("tabIn", { name, tab: tab.title }),
            href: spacePath(here._id, part.key, part === tab && tab.sections.length > 0),
          });
        }
      }
    }
    groups.push({ title: say("thisSpace"), order: 10, items });
  }

  const { active, archived } = apart(spaces);
  groups.push({
    title: say("spacesGroup"),
    order: 20,
    limit: searching ? SHOWN.searching : SHOWN.idle,
    items: [...active, ...(searching ? archived : [])].map((s) => ({
      key: `space:${s._id}`,
      label: spaceName(s, ctx.viewer?.name, names),
      ...markOf(s),
      description: s.archived
        ? say("archived")
        : s._id === here?._id
        ? say("youreHere")
        : s.kind === "personal"
        ? say("justYou")
        : undefined,
      keywords: s.kind === "personal" ? keywords("keysPersonal") : [],
      href: spacePath(s._id),
    })),
  });

  groups.push({
    title: say("createGroup"),
    order: 40,
    items: [{
      key: "space:new",
      label: say("newSpaceMore"),
      icon: "plus",
      keywords: keywords("keysNewSpace"),
      step: newSpaceStep(call),
    }],
  });
  return groups;
};
