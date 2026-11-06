/**
 * The boards plugin's contract: what other code may import from it. The
 * shapes of its documents (a `board` and its `card`s, both living `in` a
 * space) and where a board is on the web. The rest is reached by name: its
 * collections (`board`, `card`), its Actions (`board.create`,
 * `board.update`, `board.delete`, `card.create`, `card.update`,
 * `card.move`, `card.delete`) and the tools agents use them with
 * (`list_boards`, `read_board`, `create_board`, `create_card`,
 * `update_card`, `move_card`).
 */

/** A column of a board: its id (kept when it's renamed) and its name. */
export type Column = { id: string; name: string };

/** A board in a space: its columns in order, left to right. */
export type Board = {
  _id: string;
  /** The space it's in. */
  in: string;
  name: string;
  description?: string;
  columns: Column[];
  /** When it was archived: listed apart until it's brought back. */
  archived?: string;
  /** Who made it (`person:ana`, `agent:north`), and when. */
  by?: string;
  at: string;
  /** Who changed it last, and when. */
  updatedBy?: string;
  updated?: string;
};

/** One real outcome on a board: in a column, at an order within it (lowest first). */
export type Card = {
  _id: string;
  /** Its board's space. */
  in: string;
  board: string;
  /** Its column's id. */
  column: string;
  /** Where it sits in its column: lowest first; new places take midpoints between neighbours. */
  order: number;
  title: string;
  /** Markdown: what it is, how we'll know it's done, what blocks it. */
  description?: string;
  /** Who owns it: `person:<id>` or `agent:<name>`. */
  assignee?: string;
  labels?: string[];
  /** When it's due: `YYYY-MM-DD`. */
  due?: string;
  by?: string;
  at: string;
  updatedBy?: string;
  updated?: string;
};

/** Where a card goes in its column: before or after another card, or at the top or bottom. */
export type Place =
  | { before: string }
  | { after: string }
  | { at: "top" | "bottom" };

/** A board's page; `space`, where the person is working (the sidebar marks it). */
export const boardPath = (board: string, space?: string, card?: string) => {
  const query = [
    ...(space ? [`in=${encodeURIComponent(space)}`] : []),
    ...(card ? [`card=${encodeURIComponent(card)}`] : []),
  ];
  return `/board/${encodeURIComponent(board)}${query.length ? `?${query.join("&")}` : ""}`;
};

/** A space's Board tab. */
export const boardsTab = (space: string) => `/space/${encodeURIComponent(space)}?tab=board`;
