/**
 * What computers offer in the command palette (kind `computer.palette`, the
 * web shell's `palette` resource): moving one of the person's computers to
 * another space, from the space it's in (under This space) or from its own
 * page (under This computer: from each space it works in). Only a computer's
 * owner moves it.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { PaletteGroup, PaletteItem } from "../../../../../hosts/web/mod.ts";
import type { Reached } from "../../../../access/spaces/contract.ts";
import type { Desk } from "../../collections/desk.ts";
import { moveStep } from "./move.ts";
import { nameOf } from "./names.ts";

export const computerPaletteView = (
  _: unknown,
  ctx: ViewContext<ReactNode>,
): PaletteGroup[] | null => {
  const me = ctx.viewer?.name;
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  const page = (ctx.hints.page ?? {}) as { kind?: string; id?: string };
  const computer = page.kind === "computer" ? page.id : undefined;
  const desks = computer
    ? ctx.db.collection("desk").query<Desk[]>("of", { computer }).value
    : here
    ? ctx.db.collection("desk").query<Desk[]>("here", { in: here }).value
    : [];
  const spaces = computer ? ctx.db.collection("space").query<Reached[]>("reached", {}).value : [];
  if (!desks || !spaces) return null;
  const called = (id: string) => {
    const space = spaces.find((s) => s._id === id);
    return space?.kind === "personal" ? "Personal" : space?.name ?? "its space";
  };
  const items: PaletteItem[] = desks.filter((d) => d.owner === me).map((d) => {
    const name = nameOf(d);
    return {
      key: `computer:move:${d._id}`,
      label: computer ? `Move ${name} from ${called(d.in)} to…` : `Move ${name} to another space…`,
      icon: "computer",
      keywords: ["move", "space", "computer"],
      step: moveStep({ desk: d._id, name, from: d.in, call: ctx.call }),
    };
  });
  if (!items.length) return null;
  return [{ title: computer ? "This computer" : "This space", order: 10, items }];
};
