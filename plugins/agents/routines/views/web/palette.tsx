/**
 * What routines offer in the command palette (kind `routine.palette`, the
 * web shell's `palette` resource), for where the person is and what's typed:
 *
 * - **This routine**, on a routine's page: run it now, pause or resume it,
 *   change it, open its last chat, delete it (its maker, or those who
 *   manage its space);
 * - **This space:** its Routines tab;
 * - **Routines**, while searching: the space's, to open;
 * - **Create:** a new routine where they are, if they may write there, in a
 *   dialog (`routine.new`).
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  go,
  type PaletteGroup,
  type PaletteItem,
  type PaletteStep,
} from "../../../../../hosts/web/mod.ts";
import type { Listed, Routine } from "../../collections/routine.ts";
import { describe, localZone } from "../../shared/schedule.ts";
import { routinePath, routinesTab, threadPath } from "./routines.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Place = { _id: string; name: string; kind: string; can?: string[]; archived?: string };

const placeName = (p: Pick<Place, "name" | "kind">) => p.kind === "personal" ? "Personal" : p.name;

/** Deleting a routine, once they've read what it means; then its space's routines. */
const deleteStep = (r: Routine, call: Call): PaletteStep => ({
  title: `Delete “${r.name}”?`,
  confirm: true,
  note: "It stops running, and its runs go. The chats it posted in stay.",
  items: () => [{
    title: "",
    items: [
      {
        key: "routine:delete",
        label: "Delete it",
        icon: "trash",
        tone: "destructive",
        run: async () => {
          await call("routine.delete", { routine: r._id });
          go(routinesTab(r.in));
        },
      },
      { key: "routine:keep", label: "Keep it", icon: "close", run: (p) => p.back() },
    ],
  }],
});

export const routinePaletteView = (
  _: unknown,
  ctx: ViewContext<ReactNode>,
): PaletteGroup[] | null => {
  const searching = !!String(ctx.hints.search ?? "").trim();
  const page = (ctx.hints.page ?? {}) as { kind?: string; id?: string };
  const opened = page.kind === "routine" && page.id
    ? ctx.db.collection<Routine>("routine").findOne({ _id: page.id }).value
    : null;
  const here = opened?.in ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : undefined);
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const listed = here
    ? ctx.db.collection("routine").query<Listed[]>("list", { in: here }).value
    : [];
  if (opened === undefined || !places || !listed) return null;
  const place = places.find((p) => p._id === here);
  const zone = localZone();
  const groups: PaletteGroup[] = [];
  const open = opened ? listed.find((r) => r._id === opened._id) : undefined;
  if (open) {
    const items: PaletteItem[] = [];
    if (open.editable) {
      items.push({
        key: "routine:run",
        label: `Run “${open.name}” now`,
        icon: "play",
        keywords: ["run", "now", "send"],
        run: () => ctx.call("routine.run", { routine: open._id }),
      });
      items.push(
        open.paused
          ? {
            key: "routine:resume",
            label: "Resume it",
            icon: "play",
            run: () => ctx.call("routine.resume", { routine: open._id }),
          }
          : {
            key: "routine:pause",
            label: "Pause it",
            icon: "pause",
            run: () => ctx.call("routine.pause", { routine: open._id }),
          },
      );
      items.push({
        key: "routine:edit",
        label: "Edit it",
        icon: "pencil",
        keywords: ["change", "schedule", "message"],
        href: routinePath(open._id, true),
      });
    }
    if (open.last?.thread) {
      items.push({
        key: "routine:chat",
        label: "Open its last chat",
        icon: "chat",
        href: threadPath(open.last.thread, open.in),
      });
    }
    if (open.editable) {
      items.push({
        key: "routine:delete-step",
        label: "Delete it…",
        icon: "trash",
        tone: "destructive",
        step: deleteStep(open, ctx.call),
      });
    }
    groups.push({ title: "This routine", order: 10, items });
  } else if (here && place) {
    groups.push({
      title: "This space",
      order: 10,
      items: [{
        key: "routine:tab",
        label: "Routines",
        icon: "refresh",
        description: listed.length ? `${listed.length}` : "Messages to agents on a schedule",
        keywords: ["routines", "schedule", "scheduled", "recurring", "remind", "cron"],
        href: routinesTab(here),
      }],
    });
  }
  if (searching && listed.length) {
    groups.push({
      title: "Routines",
      order: 36,
      limit: 6,
      items: listed.map((r) => ({
        key: `routine:${r._id}`,
        label: r.name,
        icon: "refresh" as const,
        description: describe(r.schedule, { here: zone }),
        keywords: [r.text, r.agent],
        href: routinePath(r._id),
      })),
    });
  }
  if (here && place && place.can?.includes("write") && !place.archived) {
    groups.push({
      title: "Create",
      order: 40,
      items: [{
        key: "routine:new",
        label: "New routine…",
        icon: "refresh",
        description: placeName(place),
        keywords: ["routine", "schedule", "recurring", "every", "remind", "cron"],
        run: (palette) =>
          palette.dialog({
            title: `New routine in ${placeName(place)}`,
            description: "It asks an agent here on a schedule, as you.",
            view: "routine.new",
            item: { _id: here },
            hints: { in: here },
            size: "lg",
          }),
      }],
    });
  }
  return groups;
};
