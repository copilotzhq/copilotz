/**
 * Defines the data-only Show File Diff Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/tools";
import { showFileDiffAction } from "../../actions/show-file-diff/index.ts";

export const showFileDiffTool = defineTool(
  "show_file_diff",
  showFileDiffAction,
  {
    name: "Show File Diff",
    description:
      "Show the difference between the current file and a previously captured in-process snapshot.",
  },
);
