/**
 * What memory offers in the command palette (kind `memory.palette`, the web
 * shell's `palette` resource): moving a memory to another space. Where the
 * person is in a space that has memories, "Move a memory…" picks one of
 * them (`memory.pick`), then where it goes; on a memory's own page, "Move
 * this memory…" goes straight to where.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { PaletteGroup, PaletteItem } from "../../../../../hosts/web/mod.ts";
import type { Memory } from "../../collections/memory.ts";
import { moveStep } from "./move.ts";

export const memoryPaletteView = (
  _: unknown,
  ctx: ViewContext<ReactNode>,
): PaletteGroup[] | null => {
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  const page = (ctx.hints.page ?? {}) as { kind?: string; id?: string };
  const open = page.kind === "memory" && page.id
    ? ctx.db.collection<Memory>("memory").findOne({ _id: page.id }).value
    : null;
  // Whether the space has any, to offer moving one.
  const some = here
    ? ctx.db.collection("memory").query<Memory[]>("list", { in: here, limit: 1 }).value
    : [];
  if (open === undefined || some === undefined) return null;
  const items: PaletteItem[] = [];
  if (open) {
    items.push({
      key: "memory:move",
      label: "Move this memory to another space…",
      icon: "sparkles",
      keywords: ["memory", "space"],
      step: moveStep(open, ctx.call),
    });
  } else if (here && some.length) {
    items.push({
      key: "memory:move-one",
      label: "Move a memory to another space…",
      icon: "sparkles",
      keywords: ["memory", "memories", "space"],
      step: {
        title: "Move a memory…",
        placeholder: "Find a memory",
        view: "memory.pick",
        hints: { in: here },
      },
    });
  }
  return items.length ? [{ title: open ? "This memory" : "This space", order: 10, items }] : null;
};
