/**
 * The space picker (kind `space.pick`), the one every "Move to…" opens: a
 * command palette step's list of the spaces something can go to, those the
 * person may write in and still uses (archived ones aside), but the one it's
 * in (`hints.from`). A space chosen is handed to the step that asked (its
 * `pick`, given the space, `Reached`), which moves it there. Last, making a
 * new space, to move it into that: named as it's typed, when no space is.
 *
 * ```ts
 * openPalette({
 *   title: "Move “Plan” to…",
 *   view: "space.pick",
 *   hints: { from: note.in },
 *   pick: (space) => call("note.move", { note: note._id, to: space._id }),
 * });
 * ```
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { Avatar, type PaletteControl, type PaletteGroup } from "../../../../../hosts/web/mod.ts";
import type { Reached } from "../../contract.ts";
import { newSpaceStep } from "./steps.ts";
import { destinations, spaceName } from "./who.ts";

export const spacePickView = (
  _: unknown,
  ctx: ViewContext<ReactNode>,
): PaletteGroup[] | null => {
  const spaces = ctx.db.collection("space").query<Reached[]>("reached", {}).value;
  if (!spaces) return null;
  const from = typeof ctx.hints.from === "string" ? ctx.hints.from : undefined;
  const typed = String(ctx.hints.search ?? "").trim();
  const there = destinations(spaces, from);
  const call = ctx.call;
  const made = async (name: string, palette: PaletteControl) => {
    const { space } = await call<{ space: string }>("space.create", { name });
    return await palette.pick({
      _id: space,
      name,
      kind: "shared",
      can: ["read", "write", "manage"],
    });
  };
  const known = there.some((s) => spaceName(s).toLowerCase() === typed.toLowerCase());
  return [
    {
      title: "Spaces",
      items: there.map((s) => {
        const personal = s.kind === "personal";
        return {
          key: `pick:${s._id}`,
          label: spaceName(s),
          ...(personal
            ? { icon: "person" as const, description: "Just you", keywords: ["personal"] }
            : { leading: <Avatar name={s.name} kind="space" size={26} />, description: "Shared" }),
          run: (palette) => palette.pick(s),
        };
      }),
    },
    {
      title: "",
      order: 99,
      items: [
        typed && !known && typed.length <= 60
          ? {
            key: "pick:new",
            label: `New space “${typed}”`,
            icon: "plus" as const,
            run: (palette: PaletteControl) => made(typed, palette),
          }
          : {
            key: "pick:new",
            label: "New space…",
            icon: "plus" as const,
            keywords: ["create", "make"],
            step: newSpaceStep(call, (space, palette) => palette.pick(space)),
          },
      ],
    },
  ];
};
