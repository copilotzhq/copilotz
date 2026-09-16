import type { ToolDefinition } from "@copilotz/copilotz/core";
/**
 * Defines the data-only Search Files Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/core";
import { searchFilesAction } from "../../../actions/search-files/index.ts";

export const searchFilesTool: ToolDefinition<typeof searchFilesAction> =
  defineTool({
    ...searchFilesAction,
    ...{
      name: "Search Files",
      description:
        "Search for files by name pattern in the current workspace. Common noise directories (node_modules, .git, dist, etc.) are excluded by default.",
    },
  });

export default searchFilesTool;
