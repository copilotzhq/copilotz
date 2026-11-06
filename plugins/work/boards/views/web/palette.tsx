/// <reference lib="dom" />
/**
 * What boards offer in the command palette (kind `boards.palette`, the web
 * shell's `palette` resource), for where the person is and what's typed:
 *
 * - **This board**, on a board's page: a new card on it (its title typed,
 *   then the column it goes in), its space's boards, deleting it;
 * - **This space:** its Board tab;
 * - **Boards**, while searching: every board the person reaches, to go to;
 * - **Create:** a new board where they are, if they may write there (its
 *   name typed).
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import {
  go,
  type PaletteGroup,
  type PaletteItem,
  type PaletteStep,
} from "../../../../../hosts/web/mod.ts";
import type { Board } from "../../contract.ts";
import { boardPath, boardsTab } from "../../contract.ts";
import { Glyph } from "./glyphs.tsx";
import { placeName, placesOf } from "./load.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

const mark = <Glyph name="board" size={18} />;

/** A new card on a board: its title typed, then the column it goes in. */
const newCardStep = (board: Board, call: Call): PaletteStep => ({
  title: `New card on ${board.name}`,
  placeholder: "What's the outcome?",
  filter: false,
  items: (typed) => {
    const title = typed.trim();
    if (!title) {
      return [{
        title: "",
        items: [{
          key: "board:new-card:hint",
          label: "Type the card's title, then choose its column",
          icon: "compose",
          disabled: true,
        }],
      }];
    }
    return [{
      title: "Add it to",
      items: board.columns.map((c) => ({
        key: `board:new-card:${c.id}`,
        label: `“${title.length > 48 ? `${title.slice(0, 47)}…` : title}” in ${c.name}`,
        icon: "plus" as const,
        run: () =>
          call("card.create", { board: board._id, title: title.slice(0, 300), column: c.id }),
      })),
    }];
  },
});

/** A new board in a space: its name typed. */
const newBoardStep = (space: string, where: string, call: Call): PaletteStep => ({
  title: `New board in ${where}`,
  placeholder: "Its name",
  filter: false,
  items: (typed) => {
    const name = typed.trim();
    return [{
      title: "",
      items: [
        name
          ? {
            key: "board:create",
            label: `Make the board “${name.slice(0, 80)}”`,
            leading: mark,
            run: async () => {
              const { board } = await call<{ board: string }>("board.create", {
                in: space,
                name: name.slice(0, 80),
              });
              go(boardPath(board, space));
            },
          }
          : {
            key: "board:create:hint",
            label: "Type the board's name",
            icon: "compose",
            disabled: true,
          },
      ],
    }];
  },
});

/** Deleting a board, once they've read that its cards go too. */
const deleteStep = (board: Board, call: Call): PaletteStep => ({
  title: `Delete ${board.name}?`,
  confirm: true,
  note: "Its cards go with it, for everyone in the space. It can't be brought back.",
  items: () => [{
    title: "",
    items: [
      {
        key: "board:delete",
        label: `Delete ${board.name}`,
        icon: "trash",
        tone: "destructive",
        run: async () => {
          await call("board.delete", { board: board._id });
          go(boardsTab(board.in));
        },
      },
      { key: "board:keep", label: "Keep it", icon: "close", run: (p) => p.back() },
    ],
  }],
});

export const boardsPaletteView = (
  _: unknown,
  ctx: ViewContext<ReactNode>,
): PaletteGroup[] | null => {
  const searching = !!String(ctx.hints.search ?? "").trim();
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  const page = (ctx.hints.page ?? {}) as { kind?: string; id?: string };
  const places = placesOf(ctx);
  const open = page.kind === "board" && page.id
    ? ctx.db.collection<Board>("board").findOne({ _id: page.id }).value
    : null;
  // Every board the person reaches, only while searching.
  const all = searching ? ctx.db.collection<Board>("board").find({}).value : [];
  if (!places || open === undefined || !all) return null;
  const groups: PaletteGroup[] = [];
  const space = open?.in ?? here;
  const place = places.find((p) => p._id === space);
  const can = !!place?.can?.includes("write") && !place.archived;
  if (open) {
    const items: PaletteItem[] = [];
    if (can) {
      items.push({
        key: "board:new-card",
        label: "New card on this board…",
        icon: "plus",
        keywords: ["card", "task", "add", open.name],
        step: newCardStep(open, ctx.call),
      });
    }
    items.push({
      key: "board:space",
      label: `${placeName(place)}'s boards`,
      leading: mark,
      href: boardsTab(open.in),
    });
    if (can) {
      items.push({
        key: "board:delete-step",
        label: `Delete ${open.name}…`,
        icon: "trash",
        tone: "destructive",
        step: deleteStep(open, ctx.call),
      });
    }
    // What's open comes first: before the space it's in.
    groups.push({ title: "This board", order: 8, items });
  } else if (here && place) {
    groups.push({
      title: "This space",
      order: 10,
      items: [{
        key: "board:tab",
        label: "Board",
        leading: mark,
        description: "Where the work stands",
        keywords: ["board", "boards", "kanban", "cards", "tasks"],
        href: boardsTab(here),
      }],
    });
  }
  if (searching && all.length) {
    groups.push({
      title: "Boards",
      order: 32,
      limit: 6,
      items: all.filter((b) => !b.archived).map((b) => ({
        key: `board:${b._id}`,
        label: b.name,
        leading: mark,
        description: placeName(places.find((p) => p._id === b.in)),
        keywords: [b.description ?? "", "board"],
        href: boardPath(b._id, b.in),
      })),
    });
  }
  if (space && place && can) {
    groups.push({
      title: "Create",
      order: 40,
      items: [{
        key: "board:new",
        label: "New board…",
        leading: mark,
        description: placeName(place),
        keywords: ["board", "kanban", "project"],
        step: newBoardStep(space, placeName(place), ctx.call),
      }],
    });
  }
  return groups;
};
