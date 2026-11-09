/**
 * Boards: kanban boards in a space, for people and agents, the team's
 * operational source of truth: one real outcome per card, with its owner,
 * what done looks like, an honest column, and any blocker.
 *
 * - **Boards** (`board`) live in a space, with their columns in order (a new
 *   one starts with Backlog, To do, Doing, Blocked, In review and Done);
 *   **cards** (`card`) are on a board, in a column, at an order there. Both
 *   are shared in spaces, so the spaces plugin's rules keep every read and
 *   write to what the actor reaches: everyone there reads them, its editors
 *   change them.
 * - **People** use the Actions: `board.create`, `board.update` (its name,
 *   description and columns: added, renamed, reordered, removed when empty
 *   or with their cards moved elsewhere), `board.delete` (with its cards),
 *   `card.create`, `card.update` (`null` clears a field), `card.move` (to a
 *   column, before or after a card, or at its top or bottom) and
 *   `card.delete`. What several documents must agree on commits together.
 *   Nothing outside writes either directly (the REST API, a browser's
 *   socket): only these Actions keep a board's columns and its cards' order
 *   agreeing.
 * - **Agents** get tools wherever their conversation is in a space:
 *   `list_boards`, `read_board`, `create_board`, `create_card`,
 *   `update_card`, `move_card`, naming people and agents as people do.
 *
 * Its front end is `boardsWeb` (web.tsx).
 *
 * ```ts
 * plugins: [models, chat, ...access, boards]
 * ```
 */
import { definePlugin, failure, type Plugin } from "copilotz";
import { createBoardAction } from "./actions/create-board.ts";
import { createCardAction } from "./actions/create-card.ts";
import { deleteBoardAction } from "./actions/delete-board.ts";
import { deleteCardAction } from "./actions/delete-card.ts";
import { moveCardAction } from "./actions/move-card.ts";
import { updateBoardAction } from "./actions/update-board.ts";
import { updateCardAction } from "./actions/update-card.ts";
import { board } from "./collections/board.ts";
import { card } from "./collections/card.ts";
import { tools } from "./resources/tools.ts";

export * from "./contract.ts";

export const boards: Plugin = definePlugin({
  name: "boards",
  requires: ["chat", "spaces"],
  collections: { board, card },
  actions: {
    "board.create": createBoardAction,
    "board.update": updateBoardAction,
    "board.delete": deleteBoardAction,
    "card.create": createCardAction,
    "card.update": updateCardAction,
    "card.move": moveCardAction,
    "card.delete": deleteCardAction,
  },
  resources: {
    // Boards and their cards live in spaces: each reaches only those who reach the space.
    shared: { board: {}, card: {} },
    tools,
  },
  // Only the Actions change them: a write from outside (`direct`) could leave a card in a column
  // its board doesn't have, or two at one place.
  guard: (_actor, { collection, access, direct }) => {
    if ((collection === "board" || collection === "card") && direct && access === "write") {
      throw failure("forbidden", "Boards and cards change through their Actions.", {
        public: true,
      });
    }
    return undefined;
  },
});

export default boards;
