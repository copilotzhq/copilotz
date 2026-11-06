/**
 * Boards' web front end, for the browser:
 *
 * - **A space's Board tab** (spaces' `spaceTabs`): its boards; with one, the
 *   board itself; with none, what a board is for and one made in a click.
 *   Beside a chat (the side panel), the same, compact: columns stacked.
 * - **A board's page** (`/board/<id>`, kind `board`; `?card=` opens a card):
 *   its name renamed in place, what it's for, filters (owner, label, words),
 *   "New card", and its columns side by side, cards dragged within and
 *   across them by pointer (touch too) or moved by keyboard, a quick add at
 *   each column's foot, columns added, renamed, moved and removed.
 * - **A card's details:** a dialog (a sheet on a phone): its title, column,
 *   owner, labels, due date and Markdown description, deleting it.
 * - **The command palette** (the web shell's `palette`): a board to go to, a
 *   new card on the one open, a new board.
 * - **In a conversation** (chat's `toolViews`): an agent's call to a board's
 *   tool, as what it changed, linking to the board.
 *
 * The empty tab's line about agents is the app's: `boardsText: { agentHint: "…" }` (a resource).
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, boardsWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { boardInlineView, boardPageView } from "./views/web/board-page.tsx";
import { boardsTabView } from "./views/web/boards-tab.tsx";
import { boardsPaletteView } from "./views/web/palette.tsx";
import { boardStepView } from "./views/web/step.tsx";

export const boardsWeb: Plugin = definePlugin({
  name: "boards-web",
  requires: ["web-shell"],
  views: {
    board: boardPageView,
    "board.inline": boardInlineView,
    "boards.tab": boardsTabView,
    "boards.palette": boardsPaletteView,
    "board.step": boardStepView,
  },
  resources: {
    spaceTabs: { board: { title: "Board", view: "boards.tab", icon: "check-circle", order: 20 } },
    palette: { boards: { view: "boards.palette", order: 30 } },
    toolViews: {
      list_boards: "board.step",
      read_board: "board.step",
      create_board: "board.step",
      create_card: "board.step",
      update_card: "board.step",
      move_card: "board.step",
    },
  },
});
