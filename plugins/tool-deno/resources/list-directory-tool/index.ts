/**
 * Defines the data-only List Directory Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/tools";
import { listDirectoryAction } from "../../actions/list-directory/index.ts";

export const listDirectoryTool = defineTool(
  "list_directory",
  listDirectoryAction,
  {
    name: "List Directory",
    description:
      "List files and folders in the current workspace, optionally traversing recursively. Common noise directories (node_modules, .git, dist, build, etc.) are excluded by default.",
  },
);
