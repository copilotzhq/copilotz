/// <reference lib="dom" />
/**
 * What skills offer in the command palette (kind `skill.palette`, the web
 * shell's `palette` resource), for where the person is and what's typed:
 *
 * - **This skill**, on a skill's page: change it or delete it (those who
 *   manage its space), back to its space's skills;
 * - **This space:** its Skills tab;
 * - **Skills**, while searching: those where the person is, to read;
 * - **Create:** a new skill where they are, if they manage it, in a dialog
 *   (`skill.new`).
 *
 * And `skill.new` itself: the form, in that dialog.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  go,
  type PaletteGroup,
  type PaletteItem,
  type PaletteStep,
  Skeleton,
} from "../../../../../hosts/web/mod.ts";
import type { Shown } from "../../shared/skills.ts";
import { SkillForm } from "./form.tsx";
import { blank, skillPath, skillsTab } from "./skills.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;
type Place = { _id: string; name: string; kind: string; can?: string[]; archived?: string };

const placeName = (p: Pick<Place, "name" | "kind">) => p.kind === "personal" ? "Personal" : p.name;

/** Deleting a skill, once they've read what it means; then its space's skills. */
const deleteStep = (skill: Shown, space: string, call: Call): PaletteStep => ({
  title: `Delete ${skill.name}?`,
  confirm: true,
  note: "Agents here no longer see it. Chats that used it stay as they are.",
  items: () => [{
    title: "",
    items: [
      {
        key: "skill:delete",
        label: `Delete ${skill.name}`,
        icon: "trash",
        tone: "destructive",
        run: async () => {
          await call("skill.delete", { skill: skill._id });
          go(skillsTab(space));
        },
      },
      { key: "skill:keep", label: "Keep it", icon: "close", run: (p) => p.back() },
    ],
  }],
});

export const skillPaletteView = (
  _: unknown,
  ctx: ViewContext<ReactNode>,
): PaletteGroup[] | null => {
  const searching = !!String(ctx.hints.search ?? "").trim();
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  const page = (ctx.hints.page ?? {}) as { kind?: string; id?: string };
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const listed = ctx.db.collection("skill").query<Shown[]>("list", here ? { in: here } : {}).value;
  if (!places || !listed) return null;
  const place = places.find((p) => p._id === here);
  const manage = !!place?.can?.includes("manage") && !place.archived;
  const groups: PaletteGroup[] = [];
  const open = page.kind === "skill" ? listed.find((s) => s._id === page.id) : undefined;
  if (open && here) {
    const items: PaletteItem[] = [];
    if (manage && open.source === "space") {
      items.push({
        key: "skill:edit",
        label: `Edit ${open.name}`,
        icon: "pencil",
        keywords: ["change", "instructions", "files"],
        href: skillPath(open._id, here, true),
      });
    }
    items.push({
      key: "skill:all",
      label: `${placeName(place!)}'s skills`,
      icon: "tool",
      href: skillsTab(here),
    });
    if (manage && open.source === "space") {
      items.push({
        key: "skill:delete-step",
        label: `Delete ${open.name}…`,
        icon: "trash",
        tone: "destructive",
        step: deleteStep(open, here, ctx.call),
      });
    }
    groups.push({ title: "This skill", order: 10, items });
  } else if (here && place) {
    groups.push({
      title: "This space",
      order: 10,
      items: [{
        key: "skill:tab",
        label: "Skills",
        icon: "tool",
        description: listed.length ? `${listed.length}` : "What agents know how to do",
        keywords: ["skills", "know-how", "instructions", "skill.md"],
        href: skillsTab(here),
      }],
    });
  }
  if (searching && listed.length) {
    groups.push({
      title: "Skills",
      order: 35,
      limit: 6,
      items: listed.map((s) => ({
        key: `skill:${s._id}`,
        label: s.name,
        icon: "tool" as const,
        description: s.source === "app" ? "The app's" : "Made here",
        keywords: [s.description],
        href: skillPath(s._id, here),
      })),
    });
  }
  if (here && place && manage) {
    groups.push({
      title: "Create",
      order: 40,
      items: [{
        key: "skill:new",
        label: "New skill…",
        icon: "tool",
        description: placeName(place),
        keywords: ["skill", "skill.md", "know-how", "upload"],
        run: (palette) =>
          palette.dialog({
            title: `New skill in ${placeName(place)}`,
            description: "Agents here see its name and what it's for, and read the rest when a " +
              "task fits.",
            view: "skill.new",
            item: { _id: here },
            hints: { in: here },
            size: "lg",
          }),
      }],
    });
  }
  return groups;
};

/** A new skill in a space (kind `skill.new`, item `{ _id }`): the form, in the palette's dialog. */
export const newSkillView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const places = ctx.db.collection("space").query<Place[]>("reached", {}).value;
  const style = <style href="skills-web" precedence="copilotz">{STYLE}</style>;
  if (!places) return <Skeleton height={320} radius="xl" />;
  return (
    <>
      {style}
      <SkillForm
        space={space}
        was={blank()}
        call={ctx.call}
        compact
        done={(skill) => {
          document.querySelector<HTMLDialogElement>("dialog[open]")?.close();
          go(skillPath(skill, space));
        }}
      />
    </>
  );
};
