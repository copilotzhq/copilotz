/** The command palette's words: the app's to change (see ../words.ts). */
import { defineWords } from "../words.ts";

export const say = defineWords("palette", {
  // The field
  searchOrCommand: "Search, or type a command",
  search: "Search",
  commandPalette: "Command palette",
  commands: "Commands",
  back: "Back",
  cancel: "Cancel",
  // The list
  nothingFound: "Nothing found for “{search}”",
  nothingYet: "Nothing here yet",
  results: { one: "{count} result", other: "{count} results" },
  noResults: "No results",
  // The foot
  toMove: "to move",
  toChoose: "to choose",
  toGoBack: "to go back",
  toClose: "to close",
  // A dialog an item opened
  done: "Done",
});
