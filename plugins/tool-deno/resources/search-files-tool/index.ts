/**
 * Defines the data-only Search Files Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/tools";
import { searchFilesAction } from "../../actions/search-files/index.ts";

export const searchFilesTool = defineTool("search_files", searchFilesAction, {
  name: "Search Files",
  description:
    "Search for files by name pattern in the current workspace. Common noise directories (node_modules, .git, dist, etc.) are excluded by default.",
});
